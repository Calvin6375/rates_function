/**
 * @fileoverview Tourist merchant settlement — reserve USD, FX to KES, Daraja B2B payout.
 * Never references funding providers (Paystack, IntaSend, etc.).
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const walletService = require("../walletService");
const rateService = require("../rateService");
const transactionService = require("../transactionService");
const fiatReservationService = require("../ledger/fiatReservationService");
const settlementRailService = require("./settlementRailService");
const merchantDirectoryService = require("./merchantDirectoryService");
const { recordEvent } = require("../ops/paymentTimelineService");
const paymentNotifications = require("../ops/paymentNotificationService");
const {
  MERCHANT_PAYMENT_STATUSES,
  SETTLEMENT_JOB_STATUSES,
  FUNDING_CURRENCY,
  TIMELINE_EVENT_TYPES,
} = require("../../utils/fundingTypes");

const MP_COL = config.collections.merchantPayments;
const SJ_COL = config.collections.settlementJobs;

/**
 * Convert USD to KES using existing Binance rate service.
 * @param {number} amountUsd
 * @returns {Promise<{ amountKes: number, fxRate: number }>}
 */
async function convertUsdToKes(amountUsd) {
  const rates = await rateService.getRates("KES", "USDT");
  const customerPrice = Number(rates.customerPrice || rates.marketPrice || 0);
  if (!customerPrice || customerPrice <= 0) {
    throw new Error("FX rate unavailable for USD → KES");
  }
  const amountKes = Number(amountUsd) * customerPrice;
  return { amountKes, fxRate: customerPrice };
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initiateMerchantPayment(params) {
  const {
    userId,
    merchantId,
    amountUsd,
    requestId,
    metadata = {},
  } = params;

  const numericUsd = Number(amountUsd);
  if (!userId || !merchantId || !requestId || !Number.isFinite(numericUsd) || numericUsd <= 0) {
    throw new Error("Invalid merchant payment parameters");
  }

  const merchant = await merchantDirectoryService.getMerchant(merchantId);
  if (!merchant || merchant.status !== "active") {
    throw new Error("Merchant not found or inactive");
  }

  const available = await walletService.getFiatAvailableBalance(userId, FUNDING_CURRENCY);
  if (available < numericUsd) {
    const err = new Error("Insufficient USD balance");
    err.statusCode = 402;
    throw err;
  }

  await fiatReservationService.reserveFunds({
    userId,
    amount: numericUsd,
    asset: FUNDING_CURRENCY,
    requestId,
    purpose: "merchant_settlement",
  });

  const { amountKes, fxRate } = await convertUsdToKes(numericUsd);

  const mpId = `mp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const correlationId = metadata.correlationId || mpId;
  await collection(MP_COL).doc(mpId).set({
    id: mpId,
    userId,
    merchantId,
    amountUsd: numericUsd,
    amountKes,
    fxRate,
    currency: FUNDING_CURRENCY,
    status: MERCHANT_PAYMENT_STATUSES.pending,
    settlementJobId: null,
    requestId,
    correlationId,
    metadata: typeof metadata === "object" ? metadata : {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const sjId = `sj_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const destination = merchantDirectoryService.merchantDestination(merchant);
  const darajaRail = settlementRailService.resolveSettlementRail();

  let darajaResult;
  try {
    darajaResult = await darajaRail.initiateB2BPayment({
      amountKes,
      reference: mpId,
      destination,
    });
  } catch (darajaErr) {
    await fiatReservationService.releaseReservation(requestId);
    await collection(MP_COL).doc(mpId).update({
      status: MERCHANT_PAYMENT_STATUSES.failed,
      updatedAt: serverTimestamp(),
    });
    throw darajaErr;
  }

  await collection(SJ_COL).doc(sjId).set({
    id: sjId,
    merchantPaymentId: mpId,
    provider: darajaRail.railId,
    amount: amountKes,
    currency: "KES",
    destination,
    status: SETTLEMENT_JOB_STATUSES.processing,
    providerReference: darajaResult.providerReference,
    retryCount: 0,
    lastError: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await collection(MP_COL).doc(mpId).update({
    settlementJobId: sjId,
    status: MERCHANT_PAYMENT_STATUSES.processing,
    updatedAt: serverTimestamp(),
  });

  await recordEvent({
    fundingOrderId: mpId,
    correlationId,
    eventType: TIMELINE_EVENT_TYPES.merchant_payment_created,
    status: MERCHANT_PAYMENT_STATUSES.processing,
    metadata: { merchantId, amountUsd: numericUsd, amountKes },
  });

  await recordEvent({
    fundingOrderId: mpId,
    correlationId,
    eventType: TIMELINE_EVENT_TYPES.reservation_created,
    metadata: { requestId, amountUsd: numericUsd },
  });

  await recordEvent({
    fundingOrderId: mpId,
    correlationId,
    eventType: TIMELINE_EVENT_TYPES.settlement_initiated,
    status: SETTLEMENT_JOB_STATUSES.processing,
    metadata: { settlementJobId: sjId, providerReference: darajaResult.providerReference },
  });

  if (darajaRail.isStubMode()) {
    return completeMerchantPayment({
      userId,
      mpId,
      sjId,
      merchantId,
      numericUsd,
      amountKes,
      fxRate,
      requestId,
      metadata,
      providerReference: darajaResult.providerReference,
    });
  }

  return {
    merchantPaymentId: mpId,
    settlementJobId: sjId,
    status: MERCHANT_PAYMENT_STATUSES.processing,
    amountUsd: numericUsd,
    amountKes,
    fxRate,
    providerReference: darajaResult.providerReference,
  };
}

/**
 * Complete merchant payment after Daraja success: debit ledger, confirm reservation.
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function completeMerchantPayment(params) {
  const {
    userId,
    mpId,
    sjId,
    merchantId,
    numericUsd,
    amountKes,
    fxRate,
    requestId,
    metadata,
    providerReference,
  } = params;

  const debitReferenceId = `mp_debit_${requestId}`;

  const { transactionId } = await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.merchant_payment,
    userId,
    amount: numericUsd,
    currency: FUNDING_CURRENCY,
    status: transactionService.STATUSES.processing,
    metadata: {
      merchantPaymentId: mpId,
      merchantId,
      amountKes,
      fxRate,
      ...metadata,
    },
    logLegacy: false,
  });

  const debitResult = await walletService.debitUserFiat(userId, numericUsd, FUNDING_CURRENCY, {
    referenceId: debitReferenceId,
    type: "merchant_settlement",
    source: "merchant_settlement",
    transactionRecordId: transactionId,
    metadata: { merchantPaymentId: mpId, merchantId },
  });

  await fiatReservationService.confirmReservation(requestId);
  await finalizeMerchantPayment(mpId, sjId, transactionId);

  await paymentNotifications.notifySettlementCompleted({
    userId,
    merchantPaymentId: mpId,
    amountUsd: numericUsd,
    amountKes,
  });

  return {
    merchantPaymentId: mpId,
    settlementJobId: sjId,
    status: MERCHANT_PAYMENT_STATUSES.completed,
    amountUsd: numericUsd,
    amountKes,
    fxRate,
    providerReference,
    newBalance: debitResult.newBalance,
    transactionRecordId: transactionId,
  };
}

/**
 * @param {string} merchantPaymentId
 * @param {string} settlementJobId
 * @param {string} transactionRecordId
 * @returns {Promise<void>}
 */
async function finalizeMerchantPayment(merchantPaymentId, settlementJobId, transactionRecordId) {
  await collection(MP_COL).doc(merchantPaymentId).update({
    status: MERCHANT_PAYMENT_STATUSES.completed,
    updatedAt: serverTimestamp(),
  });
  await collection(SJ_COL).doc(settlementJobId).update({
    status: SETTLEMENT_JOB_STATUSES.completed,
    updatedAt: serverTimestamp(),
  });
  await transactionService.updateTransactionStatus(transactionRecordId, transactionService.STATUSES.completed);
}

/**
 * @param {string} userId
 * @param {string} merchantPaymentId
 * @returns {Promise<Object|null>}
 */
async function getMerchantPaymentForUser(userId, merchantPaymentId) {
  const doc = await collection(MP_COL).doc(merchantPaymentId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (data.userId !== userId) return null;
  return serializeMerchantPayment(doc.id, data);
}

/**
 * @param {string} id
 * @param {Object} data
 * @returns {Object}
 */
function serializeMerchantPayment(id, data) {
  return {
    id,
    userId: data.userId,
    merchantId: data.merchantId,
    amountUsd: Number(data.amountUsd),
    amountKes: Number(data.amountKes),
    fxRate: Number(data.fxRate),
    status: data.status,
    settlementJobId: data.settlementJobId || null,
    metadata: data.metadata || {},
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

module.exports = {
  convertUsdToKes,
  initiateMerchantPayment,
  completeMerchantPayment,
  finalizeMerchantPayment,
  getMerchantPaymentForUser,
  serializeMerchantPayment,
};
