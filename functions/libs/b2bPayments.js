/**
 * @fileoverview B2B payment settlement via IntaSend webhooks (partner wallets).
 * Consumer top-up flow in payments.js is unchanged; this module runs first when a B2B mapping exists.
 */

const admin = require("../admin");
const config = require("../config");
const walletService = require("../services/walletService");
const transactionService = require("../services/transactionService");
const { executeWithIdempotency } = require("./idempotency");

const firestore = admin.firestore();
const B2B_PURPOSE = "b2b_payment_link";

/**
 * Resolve a B2B mapping document by primary or alias doc id.
 *
 * @param {string} docId
 * @returns {Promise<(Object & { mappingDocId: string })|null>}
 */
async function resolveB2bMappingDoc(docId) {
  if (!docId) {
    return null;
  }
  const mappingsCol = firestore.collection(config.collections.invoiceMappings);
  const direct = await mappingsCol.doc(docId).get();
  if (direct.exists) {
    const data = direct.data() || {};
    if (data.purpose === B2B_PURPOSE && data.partnerId) {
      if (data.aliasOf) {
        const primary = await mappingsCol.doc(data.aliasOf).get();
        if (primary.exists) {
          return { mappingDocId: primary.id, ...primary.data() };
        }
      }
      return { mappingDocId: direct.id, ...data };
    }
  }
  return null;
}

/**
 * @param {string} paymentId
 * @param {{ apiRef?: string|null }} [hints]
 * @returns {Promise<(Object & { mappingDocId: string })|null>}
 */
async function lookupB2bInvoiceMapping(paymentId, hints = {}) {
  if (!paymentId) {
    return null;
  }

  const mappingsCol = firestore.collection(config.collections.invoiceMappings);

  let found = await resolveB2bMappingDoc(paymentId);
  if (found) {
    return found;
  }

  const byCheckout = await mappingsCol
      .where("purpose", "==", B2B_PURPOSE)
      .where("checkoutId", "==", paymentId)
      .limit(1)
      .get();
  if (!byCheckout.empty) {
    const doc = byCheckout.docs[0];
    return { mappingDocId: doc.id, ...doc.data() };
  }

  const byInvoice = await mappingsCol
      .where("purpose", "==", B2B_PURPOSE)
      .where("invoiceId", "==", paymentId)
      .limit(1)
      .get();
  if (!byInvoice.empty) {
    const doc = byInvoice.docs[0];
    return { mappingDocId: doc.id, ...doc.data() };
  }

  const apiRef = hints.apiRef ? String(hints.apiRef).trim() : "";
  if (apiRef) {
    try {
      const byApiRef = await mappingsCol
          .where("purpose", "==", B2B_PURPOSE)
          .where("apiRef", "==", apiRef)
          .limit(1)
          .get();
      if (!byApiRef.empty) {
        const doc = byApiRef.docs[0];
        return { mappingDocId: doc.id, ...doc.data() };
      }
    } catch (err) {
      console.warn("lookupB2bInvoiceMapping apiRef query:", err.message);
    }
  }

  const ordersCol = firestore.collection(config.collections.orders);
  const orderQueries = await Promise.all([
    ordersCol.where("checkoutId", "==", paymentId).limit(5).get(),
    ordersCol.where("invoiceId", "==", paymentId).limit(5).get(),
  ]);
  for (const snap of orderQueries) {
    for (const doc of snap.docs) {
      const order = doc.data() || {};
      if (order.orderType !== B2B_PURPOSE) {
        continue;
      }
      const checkoutId = order.checkoutId || order.metadata?.checkoutId;
      if (checkoutId && checkoutId !== paymentId) {
        found = await resolveB2bMappingDoc(String(checkoutId));
        if (found) {
          return found;
        }
      }
    }
  }

  return null;
}

/**
 * Record a successful payment against a reusable org link (does not deactivate the link).
 *
 * @param {string} linkId
 * @param {Object} updates
 * @returns {Promise<void>}
 */
async function recordPaymentOnLink(linkId, updates) {
  if (!linkId) {
    return;
  }
  /** @type {Record<string, unknown>} */
  const patch = {
    lastPaidAt: admin.firestore.FieldValue.serverTimestamp(),
    paymentCount: admin.firestore.FieldValue.increment(1),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "active",
    ...updates,
  };
  await firestore.collection(config.collections.paymentLinks).doc(linkId).update(patch);
}

/**
 * @param {Object} paymentData
 * @param {Object} payload
 * @param {Object} mapping
 * @returns {Promise<{ success: boolean, duplicate?: boolean, partnerId?: string, error?: string }>}
 */
/**
 * KES figures for a collection. Foreign face amounts stay in their currency;
 * KES columns use the Paystack charge (or fxRate), never the raw face number.
 *
 * @param {Object} params
 * @returns {{ fxRate: number|null, kesEquivalent: number|null, kesSettled: number|null, amountKes: number|null, netCreditKes: number|null }}
 */
function kesSnapshotForCredit(params) {
  const creditAmount = Number(params.creditAmount);
  const netCredit = Number(params.netCredit);
  const currency = String(params.creditCurrency || "KES").toUpperCase();
  const roundMoney = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  if (currency === "KES") {
    const gross = roundMoney(creditAmount);
    const net = roundMoney(netCredit);
    return {
      fxRate: 1,
      kesEquivalent: gross,
      kesSettled: net,
      amountKes: gross,
      netCreditKes: net,
    };
  }

  const charged = Number(params.chargeAmountKes);
  const rate = Number(params.fxRate);
  let kesEquivalent = null;
  if (Number.isFinite(charged) && charged > 0) {
    kesEquivalent = roundMoney(charged);
  } else if (Number.isFinite(rate) && rate > 0 && Number.isFinite(creditAmount)) {
    kesEquivalent = roundMoney(creditAmount * rate);
  }
  let resolvedRate = Number.isFinite(rate) && rate > 0 ? rate : null;
  if (!resolvedRate && kesEquivalent != null && creditAmount > 0) {
    resolvedRate = kesEquivalent / creditAmount;
  }
  const kesSettled = kesEquivalent != null && creditAmount > 0 && Number.isFinite(netCredit) ?
    roundMoney(kesEquivalent * (netCredit / creditAmount)) :
    null;
  return {
    fxRate: resolvedRate,
    kesEquivalent,
    kesSettled,
    amountKes: kesEquivalent,
    netCreditKes: kesSettled,
  };
}

async function processB2bPaymentWebhook(paymentData, payload, mapping) {
  const { paymentId, amount, currency, completedAt, account } = paymentData;
  const partnerId = mapping.partnerId;
  const linkId = mapping.linkId || null;
  const rail = String(mapping.rail || payload.source || "").toLowerCase();

  if (!partnerId) {
    return { success: false, error: "B2B mapping missing partnerId" };
  }

  if (rail === "paystack") {
    const verifiedStatus = String(payload?.verifiedEvent?.status || "").toLowerCase();
    if (verifiedStatus !== "success") {
      return { success: false, error: "Paystack payment is not verified as success" };
    }
  }

  const paymentRecordRef = firestore.collection("payments").doc(paymentId);
  const existingPayment = await paymentRecordRef.get();
  if (existingPayment.exists) {
    const existingData = existingPayment.data() || {};
    if (existingData.partner_id === partnerId && existingData.processed_at) {
      return { success: true, duplicate: true, partnerId };
    }
  }

  const creditAmount = Number(amount) > 0 ? Number(amount) : Number(mapping.amount || 0);
  const creditCurrency = String(currency || mapping.currency || "KES").toUpperCase();

  const productPricingService = require("../services/pricing/productPricingService");
  const pricingProductKey = linkId ? "payment_links" : "checkout";
  let platformFee = 0;
  let feeSource = "none";
  let feePercent = 0;
  let flatFeeKes = 0;
  try {
    const priced = await productPricingService.computeProductFee({
      productKey: pricingProductKey,
      amount: creditAmount,
      currency: creditCurrency,
      forceRefresh: true,
    });
    if (priced.applied) {
      platformFee = Math.min(Number(priced.feeAmount) || 0, creditAmount);
      feeSource = priced.source;
      feePercent = Number(priced.feePercent) || 0;
      flatFeeKes = Number(priced.flatFee) || 0;
    }
  } catch (pricingErr) {
    console.warn("processB2bPaymentWebhook pricing:", pricingErr.message);
  }
  const netCredit = Math.max(0, creditAmount - platformFee);
  const kesSnap = kesSnapshotForCredit({
    creditAmount,
    creditCurrency,
    netCredit,
    fxRate: paymentData.fxRate,
    chargeAmountKes: paymentData.chargeAmountKes,
  });

  await paymentRecordRef.set({
    ...payload,
    partner_id: partnerId,
    link_id: linkId,
    purpose: B2B_PURPOSE,
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
    status: "processing",
  }, { merge: true });

  try {
    const result = await executeWithIdempotency(
        `processB2bPayment:${paymentId}`,
        async () => {
          await walletService.getOrCreatePartnerWallet(partnerId);
          const { previousBalance, newBalance } = await walletService.updatePartnerWalletBalance(
              partnerId,
              creditCurrency,
              netCredit,
          );

          const settlementMeta = {
            reference: mapping.bookingReference || null,
            bookingReference: mapping.bookingReference || null,
            payerName: mapping.payerName || null,
            partnerName: mapping.partnerName || null,
            linkId,
            orderId: mapping.orderId || null,
            invoiceId: paymentId,
            checkoutId: mapping.checkoutId || paymentId,
            rail: mapping.rail || "paystack",
            account: account || null,
            previousBalance,
            newBalance,
            source: mapping.rail || payload.source || "paystack",
            completedAt,
            platformFee,
            netCredit,
            feePercent,
            flatFeeKes,
            feeSource,
            pricingProductKey,
            fxRate: kesSnap.fxRate,
            amountKes: kesSnap.amountKes,
            kesEquivalent: kesSnap.kesEquivalent,
            netCreditKes: kesSnap.netCreditKes,
            kesSettled: kesSnap.kesSettled,
            chargeAmountKes: paymentData.chargeAmountKes ?? kesSnap.amountKes,
            fundingOrderId: mapping.fundingOrderId || payload.fundingOrderId || null,
          };
          let transactionId = mapping.transactionRecordId || null;
          if (transactionId) {
            const existing = await transactionService.getTransactionRecord(transactionId);
            if (existing && existing.status === transactionService.STATUSES.completed) {
              return { transactionId, previousBalance, newBalance, duplicate: true };
            }
            if (existing) {
              await transactionService.updateTransactionStatus(transactionId, transactionService.STATUSES.completed, {
                metadata: {
                  ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
                  ...settlementMeta,
                },
              });
            } else {
              transactionId = null;
            }
          }
          if (!transactionId) {
            const created = await transactionService.createTransactionRecord({
              type: transactionService.TRANSACTION_TYPES.b2b_payment,
              partnerId,
              amount: creditAmount,
              currency: creditCurrency,
              status: transactionService.STATUSES.completed,
              metadata: settlementMeta,
              logLegacy: false,
            });
            transactionId = created.transactionId;
          }

          if (linkId) {
            await recordPaymentOnLink(linkId, {
              lastTransactionId: transactionId,
              lastInvoiceId: paymentId,
              lastPaidAmount: creditAmount,
              lastPaidCurrency: creditCurrency,
              lastPayerName: mapping.payerName || null,
            });
          }

          if (mapping.orderId) {
            await firestore.collection(config.collections.orders).doc(mapping.orderId).update({
              status: "completed",
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              "metadata.transactionId": transactionId,
            });
          }

          await firestore.collection(config.collections.invoiceMappings)
              .doc(mapping.mappingDocId || paymentId)
              .set({
                status: "completed",
                transactionId,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
              }, { merge: true });

          await paymentRecordRef.update({
            status: "completed",
            balance_updated: true,
            transaction_id: transactionId,
            new_balance: newBalance,
            platform_fee: platformFee,
            net_credit: netCredit,
            fee_source: feeSource,
            pricing_product_key: pricingProductKey,
          });

          return { transactionId, previousBalance, newBalance };
        },
    );

    console.log("✅ B2B payment settled", {
      paymentId,
      partnerId,
      linkId,
      transactionId: result.transactionId,
    });

    return { success: true, partnerId };
  } catch (err) {
    console.error("❌ B2B payment settlement failed", {
      paymentId,
      partnerId,
      error: err.message,
    });
    await paymentRecordRef.update({
      status: "failed",
      error: err.message,
    });
    return { success: false, error: err.message, partnerId };
  }
}

module.exports = {
  B2B_PURPOSE,
  lookupB2bInvoiceMapping,
  processB2bPaymentWebhook,
  recordPaymentOnLink,
};
