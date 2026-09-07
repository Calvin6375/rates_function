/**
 * @fileoverview Reconcile B2B checkout sessions when IntaSend webhook is delayed or invoice_id mismatches checkout UUID.
 */

const admin = require("../admin");
const config = require("../config");
const paymentRailService = require("./paymentRailService");
const fundingRailService = require("./funding/fundingRailService");
const fundingWebhookService = require("./funding/fundingWebhookService");
const b2bPayments = require("../libs/b2bPayments");
const { lookupCheckoutMapping } = require("./b2bPaymentLinkCheckoutService");
const { FUNDING_PROVIDERS } = require("../utils/fundingTypes");

const firestore = admin.firestore();

/**
 * Register webhook invoice_id under an existing checkout mapping.
 *
 * @param {string} primaryCheckoutId
 * @param {string} aliasId
 * @param {Object} mapping
 */
async function registerMappingAlias(primaryCheckoutId, aliasId, mapping) {
  if (!primaryCheckoutId || !aliasId || aliasId === primaryCheckoutId) {
    return;
  }
  const mappingsCol = firestore.collection(config.collections.invoiceMappings);
  await mappingsCol.doc(String(aliasId)).set({
    ...mapping,
    checkoutId: primaryCheckoutId,
    aliasOf: primaryCheckoutId,
  }, { merge: true });
}

/**
 * Poll IntaSend and settle a pending B2B checkout if payment completed.
 *
 * @param {string} checkoutId
 * @returns {Promise<{ reconciled: boolean, mapping: Object|null }>}
 */
async function tryReconcileCheckoutSession(checkoutId) {
  if (!checkoutId) {
    return { reconciled: false, mapping: null };
  }

  let mapping = await lookupCheckoutMapping(checkoutId);
  if (!mapping || mapping.status === "completed") {
    return { reconciled: false, mapping };
  }

  const rail = String(mapping.rail || "").toLowerCase();
  if (rail === FUNDING_PROVIDERS.paystack || mapping.fundingOrderId) {
    const reference = mapping.checkoutId || checkoutId;
    try {
      const verified = await fundingRailService.verifyPayment(
          FUNDING_PROVIDERS.paystack,
          reference,
      );
      if (verified && verified.status === "success") {
        await fundingWebhookService.processFundingEvent({
          provider: FUNDING_PROVIDERS.paystack,
          event: verified,
        });
        mapping = await lookupCheckoutMapping(checkoutId);
        return { reconciled: mapping?.status === "completed", mapping };
      }
    } catch (err) {
      console.warn("tryReconcileCheckoutSession paystack:", err.message);
    }
    return { reconciled: false, mapping };
  }

  const idsToTry = [...new Set([
    checkoutId,
    mapping.checkoutId,
    mapping.invoiceId,
  ].filter(Boolean))];

  for (const id of idsToTry) {
    const remote = await paymentRailService.fetchIntaSendPaymentStatus(id);
    if (!remote) {
      continue;
    }

    const state = String(remote.state || remote.invoice?.state || "").toUpperCase();
    if (state !== "COMPLETE") {
      continue;
    }

    const paymentId =
      remote.invoice_id ||
      remote.invoice?.invoice_id ||
      id;

    if (paymentId && paymentId !== checkoutId) {
      await registerMappingAlias(checkoutId, paymentId, mapping);
    }

    const paymentData = {
      paymentId: String(paymentId),
      amount: Number(remote.net_amount || remote.value || mapping.amount || 0),
      currency: String(remote.currency || mapping.currency || "KES").toUpperCase(),
      completedAt: remote.updated_at || remote.created_at || new Date().toISOString(),
      account: remote.account ? String(remote.account) : null,
    };

    await b2bPayments.processB2bPaymentWebhook(
        paymentData,
        remote,
        {
          ...mapping,
          mappingDocId: mapping.mappingDocId || checkoutId,
        },
    );

    mapping = await lookupCheckoutMapping(checkoutId);
    return { reconciled: true, mapping };
  }

  return { reconciled: false, mapping };
}

module.exports = {
  tryReconcileCheckoutSession,
  registerMappingAlias,
};
