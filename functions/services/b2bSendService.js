/**
 * @fileoverview B2B Send — corridor quotes (rate + fees) and outbound payments.
 * Ops fulfills AED (etc.) bank transfers after partner wallet debit + admin alert.
 */

const config = require("../config");
const {collection, serverTimestamp} = require("../libs/firestore");
const walletService = require("./walletService");
const transactionService = require("./transactionService");
const partnerRecipientService = require("./partnerRecipientService");
const partnerService = require("./partnerService");
const productPricingService = require("./pricing/productPricingService");
const {
  createNotification,
  sendPushNotification,
  resolvePlatformAdminUserIds,
  NOTIFICATION_TYPES,
} = require("../utils/notifications");

const PAYMENTS_COL = config.collections.partnerSendPayments;
const CONFIG_DOC = "b2bSend";

/** Default corridors when config/b2bSend is empty (ops should overwrite in Firestore). */
const DEFAULT_CORRIDORS = Object.freeze({
  USD_AED: {
    fromCurrency: "USD",
    toCurrency: "AED",
    rail: "bank_transfer",
    rate: 3.6732,
    ourFeeFlat: 5,
    ourFeePercent: 0,
    paymentFeeFlat: 0,
    paymentFeePercent: 0,
    estimatedDelivery: "Within minutes",
    noChargesToRecipient: true,
  },
  KES_AED: {
    fromCurrency: "KES",
    toCurrency: "AED",
    rail: "bank_transfer",
    rate: 0.02825,
    ourFeeFlat: 0,
    ourFeePercent: 0.5,
    paymentFeeFlat: 0,
    paymentFeePercent: 0,
    estimatedDelivery: "Within minutes",
    noChargesToRecipient: true,
  },
  KES_USD: {
    fromCurrency: "KES",
    toCurrency: "USD",
    rail: "bank_transfer",
    rate: 0.0077,
    ourFeeFlat: 0,
    ourFeePercent: 0.5,
    paymentFeeFlat: 0,
    paymentFeePercent: 0,
    estimatedDelivery: "Within minutes",
    noChargesToRecipient: true,
  },
});

/**
 * @param {number} n
 * @param {number} [digits]
 * @returns {number}
 */
function roundMoney(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

/**
 * @returns {string}
 */
function generatePaymentId() {
  return `psend_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function corridorKey(from, to) {
  return `${String(from).toUpperCase()}_${String(to).toUpperCase()}`;
}

/**
 * Load corridor config from Firestore config/b2bSend with defaults.
 *
 * @returns {Promise<Object>}
 */
async function loadSendConfig() {
  try {
    const snap = await collection(config.collections.config).doc(CONFIG_DOC).get();
    if (!snap.exists) {
      return {corridors: {...DEFAULT_CORRIDORS}, source: "defaults"};
    }
    const data = snap.data() || {};
    const corridors = {
      ...DEFAULT_CORRIDORS,
      ...(data.corridors && typeof data.corridors === "object" ? data.corridors : {}),
    };
    return {
      corridors,
      source: "config/b2bSend",
      updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  } catch (err) {
    console.warn("b2bSendService.loadSendConfig:", err.message);
    return {corridors: {...DEFAULT_CORRIDORS}, source: "defaults"};
  }
}

/**
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {string} [rail]
 * @returns {Promise<Object>}
 */
async function resolveCorridor(fromCurrency, toCurrency, rail = "bank_transfer") {
  const from = String(fromCurrency || "").toUpperCase();
  const to = String(toCurrency || "").toUpperCase();
  if (!from || !to) {
    const err = new Error("fromCurrency and toCurrency are required");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }

  const cfg = await loadSendConfig();
  const key = corridorKey(from, to);
  let corridor = cfg.corridors[key] || null;

  if (!corridor) {
    // Try reverse lookup by fields
    corridor = Object.values(cfg.corridors).find((c) =>
      String(c.fromCurrency || "").toUpperCase() === from &&
      String(c.toCurrency || "").toUpperCase() === to &&
      (!rail || String(c.rail || "bank_transfer") === String(rail)),
    ) || null;
  }

  if (!corridor) {
    const err = new Error(
        `No send corridor configured for ${from} → ${to}` +
        (rail ? ` (${rail})` : "") +
        ". Ask a platform admin to set config/b2bSend.",
    );
    err.statusCode = 404;
    err.code = "CORRIDOR_NOT_FOUND";
    throw err;
  }

  const rate = Number(corridor.rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    const err = new Error(`Invalid rate for corridor ${from} → ${to}`);
    err.statusCode = 500;
    err.code = "INVALID_CORRIDOR_RATE";
    throw err;
  }

  let ourFeeFlat = Number(corridor.ourFeeFlat) || 0;
  let ourFeePercent = Number(corridor.ourFeePercent) || 0;
  let feeSource = cfg.source === "config/b2bSend" ? "config/b2bSend" : "defaults";

  // Product pricing overrides ourFee* only for KES-source corridors (flat is KES).
  const productKey = productPricingService.resolveSendProductKey(key);
  if (productKey && from === "KES") {
    try {
      const priced = await productPricingService.getProductPricing(productKey);
      if (
        priced &&
        priced.enabled &&
        (Number(priced.feePercent) > 0 || Number(priced.flatFeeKes) > 0)
      ) {
        ourFeeFlat = Number(priced.flatFeeKes) || 0;
        ourFeePercent = Number(priced.feePercent) || 0;
        feeSource = `product_pricing:${productKey}`;
      }
    } catch (err) {
      console.warn("b2bSendService.resolveCorridor pricing:", err.message);
    }
  }

  return {
    key,
    fromCurrency: from,
    toCurrency: to,
    rail: String(corridor.rail || rail || "bank_transfer"),
    rate,
    ourFeeFlat,
    ourFeePercent,
    paymentFeeFlat: Number(corridor.paymentFeeFlat) || 0,
    paymentFeePercent: Number(corridor.paymentFeePercent) || 0,
    estimatedDelivery: corridor.estimatedDelivery || "Within minutes",
    noChargesToRecipient: corridor.noChargesToRecipient !== false,
    configSource: cfg.source,
    feeSource,
    pricingProductKey: productKey,
  };
}

/**
 * Build quote breakdown matching the Send Payment summary UI.
 *
 * @param {Object} params
 * @param {string} params.partnerId
 * @param {number} params.amount - amount to send in fromCurrency
 * @param {string} params.fromCurrency
 * @param {string} params.toCurrency
 * @param {string} [params.rail]
 * @returns {Promise<Object>}
 */
async function quoteSend(params) {
  const {
    partnerId,
    amount,
    fromCurrency,
    toCurrency,
    rail = "bank_transfer",
  } = params;

  const sendAmount = Number(amount);
  if (!Number.isFinite(sendAmount) || sendAmount <= 0) {
    const err = new Error("amount must be a number > 0");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }

  const corridor = await resolveCorridor(fromCurrency, toCurrency, rail);
  const recipientGets = roundMoney(sendAmount * corridor.rate);
  const ourFee = roundMoney(
      corridor.ourFeeFlat + (sendAmount * corridor.ourFeePercent) / 100,
  );
  const paymentFee = roundMoney(
      corridor.paymentFeeFlat + (sendAmount * corridor.paymentFeePercent) / 100,
  );
  const totalFees = roundMoney(ourFee + paymentFee);
  const totalDeduction = roundMoney(sendAmount + totalFees);

  let availableBalance = 0;
  if (partnerId) {
    try {
      const wallet = await walletService.getOrCreatePartnerWallet(partnerId);
      availableBalance = Number(wallet.balances?.[corridor.fromCurrency] ?? 0);
    } catch (_e) {
      availableBalance = 0;
    }
  }

  return {
    corridor: corridor.key,
    rail: corridor.rail,
    fromCurrency: corridor.fromCurrency,
    toCurrency: corridor.toCurrency,
    rate: corridor.rate,
    rateLabel: `1 ${corridor.fromCurrency} = ${corridor.rate} ${corridor.toCurrency}`,
    live: true,
    youSend: sendAmount,
    exchangeRate: corridor.rate,
    recipientGets,
    fees: {
      ourFee,
      paymentFee,
      totalFees,
      currency: corridor.fromCurrency,
      ourFeeFlat: corridor.ourFeeFlat,
      ourFeePercent: corridor.ourFeePercent,
      paymentFeeFlat: corridor.paymentFeeFlat,
      paymentFeePercent: corridor.paymentFeePercent,
      feeSource: corridor.feeSource || "defaults",
      pricingProductKey: corridor.pricingProductKey || null,
    },
    noChargesToRecipient: corridor.noChargesToRecipient,
    totalDeduction,
    availableBalance,
    sufficientBalance: availableBalance >= totalDeduction,
    estimatedDelivery: corridor.estimatedDelivery,
    howItWorks: [
      `We debit ${corridor.fromCurrency} from your selected wallet.`,
      `Funds convert to ${corridor.toCurrency} at the live rate shown.`,
      `We deliver via ${corridor.rail.replace(/_/g, " ")} to the merchant account you entered.`,
    ],
    configSource: corridor.configSource,
    quotedAt: new Date().toISOString(),
  };
}

/**
 * @param {Object} payment
 * @returns {Promise<{ notificationId: string|null, pushCount: number }>}
 */
async function notifySendPaymentAdmins(payment) {
  const title = "New B2B send payment";
  const message =
    `${payment.fromCurrency} ${payment.totalDeduction} → ` +
    `${payment.toCurrency} ${payment.recipientGets} · ${payment.partnerName || payment.partnerId}`;

  const recipient = payment.recipientSnapshot || {};
  const meta = {
    paymentId: payment.id,
    partnerId: payment.partnerId,
    partnerName: payment.partnerName || "",
    fromCurrency: payment.fromCurrency,
    toCurrency: payment.toCurrency,
    youSend: payment.youSend,
    recipientGets: payment.recipientGets,
    totalDeduction: payment.totalDeduction,
    paymentReference: payment.paymentReference || "",
    recipientId: payment.recipientId || "",
    recipientName: recipient.displayName || "",
    recipientCurrency: recipient.currency || payment.toCurrency || "",
    deliveryMethod: recipient.deliveryMethod || "",
    bankName: recipient.bankName || "",
    accountName: recipient.accountName || "",
    accountNumber: recipient.accountNumber || "",
    country: recipient.country || "",
    action: "b2b_send",
  };

  let notificationId = null;
  try {
    const created = await createNotification({
      userId: null,
      type: NOTIFICATION_TYPES.B2B_SEND_ADMIN_ALERT,
      title,
      message,
      actionUrl: `/dashboard/send/${payment.id}`,
      metadata: meta,
      sendPush: false,
    });
    notificationId = created.notificationId;
  } catch (err) {
    console.warn("⚠️ Failed to save B2B send admin notification:", err.message);
  }

  const adminIds = await resolvePlatformAdminUserIds();
  let pushCount = 0;
  for (const adminId of adminIds) {
    try {
      await sendPushNotification(adminId, {
        notificationId: notificationId || "",
        type: NOTIFICATION_TYPES.B2B_SEND_ADMIN_ALERT,
        title,
        message,
        data: meta,
      });
      pushCount += 1;
    } catch (pushErr) {
      console.warn(`⚠️ B2B send admin push failed for ${adminId}:`, pushErr.message);
    }
  }

  return {notificationId, pushCount};
}

/**
 * @param {string} id
 * @param {Object} data
 * @returns {Object}
 */
function serializePayment(id, data) {
  return {
    id,
    partnerId: data.partnerId || null,
    partnerName: data.partnerName || null,
    status: data.status || "pending",
    rail: data.rail || "bank_transfer",
    corridor: data.corridor || null,
    fromCurrency: data.fromCurrency || null,
    toCurrency: data.toCurrency || null,
    youSend: Number(data.youSend) || 0,
    exchangeRate: Number(data.exchangeRate) || 0,
    recipientGets: Number(data.recipientGets) || 0,
    fees: data.fees || null,
    totalDeduction: Number(data.totalDeduction) || 0,
    paymentReference: data.paymentReference || null,
    recipientId: data.recipientId || null,
    recipientSnapshot: data.recipientSnapshot || null,
    transactionRecordId: data.transactionRecordId || null,
    notificationId: data.notificationId || null,
    requestedByUid: data.requestedByUid || null,
    failureReason: data.failureReason || null,
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    completedAt: data.completedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

/**
 * Create a Send payment: debit partner wallet, notify super admin, status pending.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createSendPayment(params) {
  const {
    partnerId,
    actorUid,
    amount,
    fromCurrency,
    toCurrency,
    rail = "bank_transfer",
    paymentReference = null,
    recipientId = null,
    recipient = null,
    saveRecipient = false,
  } = params;

  if (!partnerId || !actorUid) {
    const err = new Error("partnerId and actorUid are required");
    err.statusCode = 400;
    throw err;
  }

  let resolvedRecipientId = recipientId ? String(recipientId) : null;
  let recipientSnapshot = null;

  if (resolvedRecipientId) {
    recipientSnapshot = await partnerRecipientService.getRecipient(partnerId, resolvedRecipientId);
    if (!recipientSnapshot) {
      const err = new Error("Recipient not found");
      err.statusCode = 404;
      err.code = "RECIPIENT_NOT_FOUND";
      throw err;
    }
  } else if (recipient && typeof recipient === "object") {
    const input = partnerRecipientService.normalizeRecipientInput({
      ...recipient,
      currency: recipient.currency || toCurrency,
    });
    if (saveRecipient) {
      const created = await partnerRecipientService.createRecipient(
          partnerId,
          input,
          actorUid,
      );
      resolvedRecipientId = created.id;
      recipientSnapshot = created;
    } else {
      recipientSnapshot = {
        id: null,
        partnerId,
        ...input,
        status: "ephemeral",
      };
    }
  } else {
    const err = new Error("recipientId or recipient details are required");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }

  const to = String(toCurrency || recipientSnapshot.currency || "").toUpperCase();
  if (recipientSnapshot.currency && recipientSnapshot.currency !== to) {
    const err = new Error(
        `Recipient currency ${recipientSnapshot.currency} does not match toCurrency ${to}`,
    );
    err.statusCode = 400;
    err.code = "CURRENCY_MISMATCH";
    throw err;
  }

  const quote = await quoteSend({
    partnerId,
    amount,
    fromCurrency,
    toCurrency: to,
    rail,
  });

  if (!quote.sufficientBalance) {
    const err = new Error(
        `Insufficient ${quote.fromCurrency} balance. ` +
        `Need ${quote.totalDeduction}, available ${quote.availableBalance}`,
    );
    err.statusCode = 400;
    err.code = "INSUFFICIENT_BALANCE";
    throw err;
  }

  const partner = await partnerService.getPartner(partnerId);
  const paymentId = generatePaymentId();

  await walletService.getOrCreatePartnerWallet(partnerId);
  const debit = await walletService.updatePartnerWalletBalance(
      partnerId,
      quote.fromCurrency,
      -quote.totalDeduction,
  );

  const {transactionId} = await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.b2b_send,
    partnerId,
    userId: actorUid,
    amount: quote.totalDeduction,
    currency: quote.fromCurrency,
    status: transactionService.STATUSES.pending,
    metadata: {
      paymentId,
      corridor: quote.corridor,
      rail: quote.rail,
      youSend: quote.youSend,
      recipientGets: quote.recipientGets,
      toCurrency: quote.toCurrency,
      exchangeRate: quote.exchangeRate,
      fees: quote.fees,
      recipientId: resolvedRecipientId,
      recipientName: recipientSnapshot.displayName,
      paymentReference: paymentReference || null,
      previousBalance: debit.previousBalance,
      newBalance: debit.newBalance,
    },
    logLegacy: false,
  });

  const paymentData = {
    id: paymentId,
    partnerId: String(partnerId),
    partnerName: partner?.name || null,
    status: "pending",
    rail: quote.rail,
    corridor: quote.corridor,
    fromCurrency: quote.fromCurrency,
    toCurrency: quote.toCurrency,
    youSend: quote.youSend,
    exchangeRate: quote.exchangeRate,
    recipientGets: quote.recipientGets,
    fees: quote.fees,
    totalDeduction: quote.totalDeduction,
    paymentReference: paymentReference ? String(paymentReference).trim() : null,
    recipientId: resolvedRecipientId,
    recipientSnapshot: {
      displayName: recipientSnapshot.displayName,
      currency: recipientSnapshot.currency,
      deliveryMethod: recipientSnapshot.deliveryMethod,
      bankName: recipientSnapshot.bankName,
      accountName: recipientSnapshot.accountName,
      accountNumber: recipientSnapshot.accountNumber,
      country: recipientSnapshot.country || null,
    },
    transactionRecordId: transactionId,
    requestedByUid: actorUid,
    notificationId: null,
    failureReason: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    completedAt: null,
  };

  await collection(PAYMENTS_COL).doc(paymentId).set(paymentData);

  const notified = await notifySendPaymentAdmins(paymentData);
  if (notified.notificationId) {
    await collection(PAYMENTS_COL).doc(paymentId).set(
        {notificationId: notified.notificationId, updatedAt: serverTimestamp()},
        {merge: true},
    );
    paymentData.notificationId = notified.notificationId;
  }

  return {
    payment: serializePayment(paymentId, paymentData),
    quote,
    wallet: {
      currency: quote.fromCurrency,
      previousBalance: debit.previousBalance,
      newBalance: debit.newBalance,
    },
  };
}

/**
 * @param {string} partnerId
 * @param {string} paymentId
 * @returns {Promise<Object|null>}
 */
async function getSendPayment(partnerId, paymentId) {
  const doc = await collection(PAYMENTS_COL).doc(String(paymentId)).get();
  if (!doc.exists) return null;
  const data = doc.data() || {};
  if (String(data.partnerId) !== String(partnerId)) return null;
  return serializePayment(doc.id, data);
}

/**
 * @param {string} partnerId
 * @param {{ limit?: number, status?: string|null }} [opts]
 * @returns {Promise<{ payments: Object[] }>}
 */
async function listSendPayments(partnerId, opts = {}) {
  const lim = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const snap = await collection(PAYMENTS_COL)
      .where("partnerId", "==", String(partnerId))
      .limit(200)
      .get();

  let payments = snap.docs.map((d) => serializePayment(d.id, d.data() || {}));
  if (opts.status) {
    const st = String(opts.status).toLowerCase();
    payments = payments.filter((p) => String(p.status).toLowerCase() === st);
  }
  payments.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });
  return {payments: payments.slice(0, lim)};
}

/**
 * Platform admin: list pending send payments across partners.
 *
 * @param {{ limit?: number, status?: string }} [opts]
 * @returns {Promise<{ payments: Object[] }>}
 */
async function listPlatformSendPayments(opts = {}) {
  const lim = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const status = opts.status ? String(opts.status).toLowerCase() : "pending";
  const snap = await collection(PAYMENTS_COL)
      .where("status", "==", status)
      .limit(lim)
      .get();
  const payments = snap.docs.map((d) => serializePayment(d.id, d.data() || {}));
  payments.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });
  return {payments};
}

module.exports = {
  DEFAULT_CORRIDORS,
  loadSendConfig,
  resolveCorridor,
  quoteSend,
  createSendPayment,
  getSendPayment,
  listSendPayments,
  listPlatformSendPayments,
  serializePayment,
  notifySendPaymentAdmins,
};
