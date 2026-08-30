/**
 * @fileoverview Safari Card payout lifecycle — reserve, initiate, finalize, idempotency.
 */

const admin = require("../../admin");
const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const walletService = require("../walletService");
const transactionService = require("../transactionService");
const fiatReservationService = require("../ledger/fiatReservationService");
const intasendDisbursement = require("../intasend/intasendDisbursementProvider");
const { resolveRecipientUserId } = require("../../libs/sendMoney");
const { calculatePayoutFee } = require("./safariCardPayoutFeeService");
const {
  validateCreatePayoutRequest,
  validateBeneficiaryRequest,
} = require("./safariCardPayoutValidation");
const {
  PAYOUT_TYPES,
  PAYOUT_STATUS,
  TERMINAL_STATUSES,
  ERROR_CODES,
  payoutError,
  serializePayoutForClient,
  mapIntaSendStatus,
  providerTxRecipientPatch,
} = require("../../utils/safariCardPayoutTypes");
const { buildSafariCardTransactionMetadata } =
  require("../../utils/safariCardTransactionEnrichment");
const { maskSensitive } = require("../intasend/intasendClient");

const PAYOUTS_COL = config.collections.safariCardPayouts;
const IDEMPOTENCY_COL = config.collections.safariCardPayoutIdempotency;
const RESERVATION_PURPOSE = "safari_card_payout";

/**
 * @param {string} userId
 * @param {string} clientRequestId
 * @returns {string}
 */
function idempotencyDocId(userId, clientRequestId) {
  return `scpi_${userId}_${clientRequestId}`;
}

/**
 * @param {string} payoutId
 * @returns {Promise<Object|null>}
 */
async function getPayoutById(payoutId) {
  const doc = await collection(PAYOUTS_COL).doc(payoutId).get();
  if (!doc.exists) {
    return null;
  }
  return { payoutId: doc.id, ...doc.data() };
}

/**
 * @param {string} userId
 * @param {string} clientRequestId
 * @returns {Promise<Object|null>}
 */
async function findPayoutByIdempotency(userId, clientRequestId) {
  const idemDoc = await collection(IDEMPOTENCY_COL)
      .doc(idempotencyDocId(userId, clientRequestId))
      .get();
  if (!idemDoc.exists) {
    return null;
  }
  const payoutId = idemDoc.data()?.payoutId;
  if (!payoutId) {
    return null;
  }
  return getPayoutById(payoutId);
}

/**
 * Lookup TruePay user by phone (phoneNumber / phone, with/without +).
 * @param {string} phoneDigits - e.g. 254712345678
 * @returns {Promise<string|null>}
 */
async function lookupUserIdByPhone(phoneDigits) {
  if (!phoneDigits) return null;
  const viaSendMoney = await resolveRecipientUserId(null, phoneDigits);
  if (viaSendMoney) return viaSendMoney;

  const variants = [phoneDigits, `+${phoneDigits}`];
  const users = admin.firestore().collection(config.collections.users);
  for (const field of ["phoneNumber", "phone"]) {
    for (const value of variants) {
      const snap = await users.where(field, "==", value).limit(1).get();
      if (!snap.empty) return snap.docs[0].id;
    }
  }
  return null;
}

/**
 * @param {{ userId?: string|null, phoneNumber?: string|null, name?: string|null }} recipient
 * @returns {Promise<{ userId: string, phoneNumber: string|null, name: string|null }>}
 */
async function resolveSafariTapWalletRecipient(recipient) {
  const hintUid = recipient?.userId ? String(recipient.userId).trim() : "";
  const phone = recipient?.phoneNumber ? String(recipient.phoneNumber).trim() : "";

  let userId = null;
  if (hintUid) {
    userId = await resolveRecipientUserId(hintUid, null);
  }
  if (!userId && phone) {
    userId = await lookupUserIdByPhone(phone);
  }
  if (!userId) {
    throw payoutError(
        ERROR_CODES.RECIPIENT_NOT_FOUND,
        "No SafariTap wallet found for this recipient",
        404,
    );
  }

  const userDoc = await admin.firestore().collection(config.collections.users).doc(userId).get();
  const data = userDoc.exists ? (userDoc.data() || {}) : {};
  // Prefer profile name over client-supplied label (avoids wrong "verified name").
  const profileName = data.name ||
    [data.firstName, data.lastName].filter(Boolean).join(" ").trim() ||
    null;
  const name = profileName || recipient?.name || null;

  return {
    userId,
    phoneNumber: phone || data.phoneNumber || data.phone || null,
    name,
  };
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function validateBeneficiary(params) {
  const parsed = validateBeneficiaryRequest(params);

  if (parsed.provider === "SAFARITAP_WALLET") {
    const resolved = await resolveSafariTapWalletRecipient({
      userId: parsed.userId,
      phoneNumber: parsed.phoneNumber,
      name: parsed.name,
    });
    return {
      valid: true,
      account: parsed.account,
      accountType: parsed.accountType,
      bankCode: null,
      beneficiaryName: resolved.name,
      recipientUserId: resolved.userId,
      phoneNumber: resolved.phoneNumber,
      provider: "truepay",
      providerStatus: "valid",
    };
  }

  const result = await intasendDisbursement.validateAccount({
    account: parsed.account,
    provider: parsed.provider,
    accountType: parsed.accountType,
    bankCode: parsed.bankCode,
  });

  const valid = !!(result && (result.name || result.status === "valid"));
  return {
    valid,
    account: parsed.account,
    accountType: parsed.accountType,
    bankCode: parsed.bankCode,
    beneficiaryName: result?.name || null,
    provider: "intasend",
    providerStatus: result?.status || null,
  };
}

/**
 * Build IntaSend provider + transaction payload from payout record.
 * @param {Object} payout
 * @returns {{ provider: string, transaction: Object }}
 */
function buildProviderPayload(payout) {
  if (payout.type === PAYOUT_TYPES.SAFARITAP_WALLET) {
    throw payoutError(
        ERROR_CODES.UNSUPPORTED_PAYOUT_TYPE,
        "SAFARITAP_WALLET transfers do not use an external provider",
    );
  }

  const requestReferenceId = payout.payoutId;
  const base = {
    amount: payout.amount,
    narrative: payout.narrative,
    requestReferenceId,
  };

  if (payout.type === PAYOUT_TYPES.MPESA_B2C) {
    return {
      provider: intasendDisbursement.DISBURSEMENT_PROVIDERS.MPESA_B2C,
      transaction: intasendDisbursement.buildMpesaB2cTransaction({
        ...base,
        name: payout.recipient?.name || "Safari Card Customer",
        account: payout.recipient.phoneNumber,
      }),
    };
  }

  if (payout.type === PAYOUT_TYPES.MPESA_B2B) {
    return {
      provider: intasendDisbursement.DISBURSEMENT_PROVIDERS.MPESA_B2B,
      transaction: intasendDisbursement.buildMpesaB2bTransaction({
        ...base,
        name: payout.recipient?.name || "Safari Card Merchant",
        account: payout.recipient.account,
        accountType: payout.recipient.accountType,
        accountReference: payout.recipient.accountReference,
      }),
    };
  }

  return {
    provider: intasendDisbursement.DISBURSEMENT_PROVIDERS.PESALINK,
    transaction: intasendDisbursement.buildBankTransaction({
      ...base,
      name: payout.recipient?.accountName || "Safari Card Beneficiary",
      account: payout.recipient.accountNumber,
      bankCode: payout.recipient.bankCode,
    }),
  };
}

/**
 * Synchronous SafariTap wallet → wallet transfer (internal ledger).
 * @param {string} senderId
 * @param {Object} parsed - validateCreatePayoutRequest result
 * @param {{ amount: number, fee: number, totalDebit: number, currency: string }} feeBreakdown
 * @returns {Promise<Object>}
 */
async function createInternalWalletPayout(senderId, parsed, feeBreakdown) {
  const resolved = await resolveSafariTapWalletRecipient(parsed.recipient);
  if (resolved.userId === senderId) {
    throw payoutError(
        ERROR_CODES.SELF_TRANSFER,
        "Cannot send to your own SafariTap wallet",
        400,
    );
  }

  const payoutRef = collection(PAYOUTS_COL).doc();
  const payoutId = payoutRef.id;
  const requestId = payoutId;

  try {
    await fiatReservationService.reserveFunds({
      userId: senderId,
      amount: feeBreakdown.totalDebit,
      asset: parsed.currency,
      requestId,
      purpose: RESERVATION_PURPOSE,
      merchantPaymentId: payoutId,
    });
  } catch (err) {
    if (String(err.message || "").includes("Insufficient")) {
      throw payoutError(ERROR_CODES.INSUFFICIENT_BALANCE, err.message, 402);
    }
    throw err;
  }

  const recipient = {
    ...parsed.recipient,
    userId: resolved.userId,
    phoneNumber: resolved.phoneNumber || parsed.recipient.phoneNumber || null,
    name: resolved.name || parsed.recipient.name || "SafariTap User",
  };

  /** @type {Record<string, unknown>} */
  const payoutDoc = {
    payoutId,
    userId: senderId,
    recipientUserId: resolved.userId,
    type: parsed.type,
    status: PAYOUT_STATUS.PENDING,
    amount: feeBreakdown.amount,
    fee: feeBreakdown.fee,
    totalDebit: feeBreakdown.totalDebit,
    currency: parsed.currency,
    recipient,
    provider: "truepay",
    providerTrackingId: null,
    providerTransactionId: null,
    providerReference: null,
    reference: payoutId,
    narrative: parsed.narrative,
    idempotencyKey: `safari_card_payout:${senderId}:${parsed.clientRequestId}`,
    clientRequestId: parsed.clientRequestId,
    requestId,
    statusHistory: [{
      status: PAYOUT_STATUS.PENDING,
      at: new Date().toISOString(),
    }],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    completedAt: null,
    failedAt: null,
    failureReason: null,
  };

  const idempotencyRef = collection(IDEMPOTENCY_COL)
      .doc(idempotencyDocId(senderId, parsed.clientRequestId));

  await payoutRef.set(payoutDoc);
  await idempotencyRef.set({
    payoutId,
    userId: senderId,
    clientRequestId: parsed.clientRequestId,
    createdAt: serverTimestamp(),
  });

  try {
    return await finalizeInternalWalletTransfer({
      payoutId,
      requestId,
      senderId,
      recipientUserId: resolved.userId,
    });
  } catch (err) {
    await handlePayoutFailure({
      payoutId,
      requestId,
      failureReason: err.message || "Internal wallet transfer failed",
      providerPayload: null,
    });
    if (err.code && err.httpStatus) {
      throw err;
    }
    throw payoutError(
        ERROR_CODES.PAYOUT_FAILED,
        err.message || "SafariTap wallet transfer failed",
        500,
    );
  }
}

/**
 * Debit sender + credit recipient on the fiat ledger, then mark SUCCESS.
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function finalizeInternalWalletTransfer(params) {
  const { payoutId, requestId, senderId, recipientUserId } = params;
  const payout = await getPayoutById(payoutId);
  if (!payout) {
    throw payoutError(ERROR_CODES.NOT_FOUND, "Payout not found", 404);
  }
  if (payout.status === PAYOUT_STATUS.SUCCESS) {
    return serializePayoutForClient(payout);
  }

  const amount = Number(payout.amount);
  const totalDebit = Number(payout.totalDebit);
  const currency = payout.currency;
  const debitRef = `sc_payout_debit_${payoutId}`;
  const creditRef = `sc_payout_credit_${payoutId}`;

  let senderName = null;
  try {
    const senderDoc = await admin.firestore()
        .collection(config.collections.users)
        .doc(senderId || payout.userId)
        .get();
    if (senderDoc.exists) {
      const s = senderDoc.data() || {};
      senderName = s.name ||
        [s.firstName, s.lastName].filter(Boolean).join(" ").trim() ||
        null;
    }
  } catch (_err) {
    // non-critical for labels
  }

  const recipientName = payout.recipient?.name || null;

  const debitResult = await walletService.debitUserFiat(
      senderId || payout.userId,
      totalDebit,
      currency,
      {
        referenceId: debitRef,
        type: "withdrawal",
        source: "safaritap_wallet_transfer",
        metadata: {
          payoutId,
          type: payout.type,
          recipientUserId,
          recipientName,
          fee: Number(payout.fee || 0),
        },
      },
  );

  // creditUserFiat syncs recipient users→ledger UP before credit so dualWrite
  // cannot wipe an existing kesBalance when fiatLedger was still 0.
  const creditResult = await walletService.creditUserFiat(
      recipientUserId,
      amount,
      currency,
      {
        referenceId: creditRef,
        type: "funding",
        source: "safaritap_wallet_transfer",
        metadata: {
          payoutId,
          type: payout.type,
          senderUserId: senderId || payout.userId,
          senderName,
        },
      },
  );

  await fiatReservationService.confirmReservation(requestId || payout.requestId);

  const { transactionId } = await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.withdrawal,
    userId: payout.userId,
    amount,
    currency,
    status: transactionService.STATUSES.completed,
    metadata: {
      payoutId,
      ...buildSafariCardTransactionMetadata(payout, null, {
        previousBalance: debitResult.previousBalance,
        newBalance: debitResult.newBalance,
      }),
      provider: "truepay",
      source: "safaritap_wallet_transfer",
      recipientUserId,
      recipientName,
      merchantName: recipientName,
    },
    logLegacy: true,
  });

  await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.funding,
    userId: recipientUserId,
    amount,
    currency,
    status: transactionService.STATUSES.completed,
    metadata: {
      payoutId,
      provider: "truepay",
      source: "safaritap_wallet_transfer",
      senderUserId: senderId || payout.userId,
      senderName,
      previousBalance: creditResult.previousBalance,
      newBalance: creditResult.newBalance,
    },
    logLegacy: true,
  });

  await collection(PAYOUTS_COL).doc(payoutId).update({
    status: PAYOUT_STATUS.SUCCESS,
    transactionId,
    ledgerEntryId: debitResult.ledgerEntryId || null,
    creditLedgerEntryId: creditResult.ledgerEntryId || null,
    completedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    statusHistory: admin.firestore.FieldValue.arrayUnion({
      status: PAYOUT_STATUS.SUCCESS,
      at: new Date().toISOString(),
      source: "internal_wallet",
    }),
  });

  console.log("SafariTap wallet transfer completed", {
    payoutId,
    senderId: senderId || payout.userId,
    recipientUserId,
    amount,
    currency,
  });

  const updated = await getPayoutById(payoutId);
  return serializePayoutForClient(updated);
}

/**
 * @param {string} userId
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function createPayout(userId, body) {
  const parsed = validateCreatePayoutRequest(body);
  const existing = await findPayoutByIdempotency(userId, parsed.clientRequestId);
  if (existing) {
    return serializePayoutForClient(existing);
  }

  const feeBreakdown = calculatePayoutFee({
    userId,
    payoutType: parsed.type,
    amount: parsed.amount,
    currency: parsed.currency,
  });

  const available = await walletService.getFiatAvailableBalance(userId, parsed.currency);
  if (available < feeBreakdown.totalDebit) {
    throw payoutError(
        ERROR_CODES.INSUFFICIENT_BALANCE,
        `Insufficient ${parsed.currency} balance ` +
          `(available: ${available}, required: ${feeBreakdown.totalDebit})`,
        402,
    );
  }

  if (parsed.type === PAYOUT_TYPES.SAFARITAP_WALLET) {
    return createInternalWalletPayout(userId, parsed, feeBreakdown);
  }

  const payoutRef = collection(PAYOUTS_COL).doc();
  const payoutId = payoutRef.id;
  const requestId = payoutId;

  try {
    await fiatReservationService.reserveFunds({
      userId,
      amount: feeBreakdown.totalDebit,
      asset: parsed.currency,
      requestId,
      purpose: RESERVATION_PURPOSE,
      merchantPaymentId: payoutId,
    });
  } catch (err) {
    if (String(err.message || "").includes("Insufficient")) {
      throw payoutError(ERROR_CODES.INSUFFICIENT_BALANCE, err.message, 402);
    }
    throw err;
  }

  const idempotencyRef = collection(IDEMPOTENCY_COL)
      .doc(idempotencyDocId(userId, parsed.clientRequestId));

  /** @type {Record<string, unknown>} */
  const payoutDoc = {
    payoutId,
    userId,
    type: parsed.type,
    status: PAYOUT_STATUS.PENDING,
    amount: feeBreakdown.amount,
    fee: feeBreakdown.fee,
    totalDebit: feeBreakdown.totalDebit,
    currency: parsed.currency,
    recipient: parsed.recipient,
    provider: "intasend",
    providerTrackingId: null,
    providerTransactionId: null,
    providerReference: null,
    reference: payoutId,
    narrative: parsed.narrative,
    idempotencyKey: `safari_card_payout:${userId}:${parsed.clientRequestId}`,
    clientRequestId: parsed.clientRequestId,
    requestId,
    statusHistory: [{
      status: PAYOUT_STATUS.PENDING,
      at: new Date().toISOString(),
    }],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    completedAt: null,
    failedAt: null,
    failureReason: null,
  };

  await payoutRef.set(payoutDoc);
  await idempotencyRef.set({
    payoutId,
    userId,
    clientRequestId: parsed.clientRequestId,
    createdAt: serverTimestamp(),
  });

  let providerResult;
  try {
    const { provider, transaction } = buildProviderPayload({
      ...payoutDoc,
      payoutId,
    });

    providerResult = await intasendDisbursement.initiateAndApproveSendMoney({
      provider,
      currency: parsed.currency,
      transactions: [transaction],
      batchReference: payoutId,
    });
  } catch (providerErr) {
    await handlePayoutFailure({
      payoutId,
      requestId,
      failureReason: providerErr.message || "Provider initiation failed",
      providerPayload: null,
    });
    throw payoutError(
        ERROR_CODES.PROVIDER_ERROR,
        "Failed to initiate payout with provider",
        502,
    );
  }

  const trackingId = providerResult.tracking_id || null;
  const firstTx = Array.isArray(providerResult.transactions) ?
    providerResult.transactions[0] :
    null;
  const mappedStatus = mapIntaSendStatus(
      providerResult.status_code,
      firstTx?.status_code,
  );
  const nextStatus = mappedStatus === PAYOUT_STATUS.SUCCESS ?
    PAYOUT_STATUS.PROCESSING :
    (mappedStatus === PAYOUT_STATUS.UNKNOWN ? PAYOUT_STATUS.INITIATED : mappedStatus);

  await payoutRef.update({
    status: nextStatus,
    providerTrackingId: trackingId,
    providerTransactionId: firstTx?.transaction_id || null,
    providerReference: firstTx?.provider_reference || null,
    providerBatchStatus: providerResult.status || null,
    providerBatchStatusCode: providerResult.status_code || null,
    providerTxStatus: firstTx?.status || null,
    providerTxStatusCode: firstTx?.status_code || null,
    providerInitiatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...providerTxRecipientPatch(firstTx),
    statusHistory: admin.firestore.FieldValue.arrayUnion({
      status: nextStatus,
      at: new Date().toISOString(),
      trackingId,
    }),
  });

  console.log("Safari Card payout initiated", {
    payoutId,
    userId,
    type: parsed.type,
    amount: feeBreakdown.amount,
    trackingId: maskSensitive(trackingId),
    status: nextStatus,
  });

  if (mappedStatus === PAYOUT_STATUS.SUCCESS) {
    return finalizePayoutSuccess({
      payoutId,
      requestId,
      userId,
      providerPayload: providerResult,
    });
  }

  if (mappedStatus === PAYOUT_STATUS.FAILED || mappedStatus === PAYOUT_STATUS.CANCELLED) {
    await handlePayoutFailure({
      payoutId,
      requestId,
      failureReason: firstTx?.status_description ||
        providerResult.status ||
        "Provider reported failure",
      providerPayload: providerResult,
    });
    throw payoutError(ERROR_CODES.PAYOUT_FAILED, "Payout failed at provider", 502);
  }

  const updated = await getPayoutById(payoutId);
  return serializePayoutForClient(updated);
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function finalizePayoutSuccess(params) {
  const { payoutId, requestId, userId, providerPayload } = params;
  const payout = await getPayoutById(payoutId);
  if (!payout) {
    throw payoutError(ERROR_CODES.NOT_FOUND, "Payout not found", 404);
  }
  if (payout.status === PAYOUT_STATUS.SUCCESS) {
    return serializePayoutForClient(payout);
  }

  const debitRef = `sc_payout_debit_${payoutId}`;
  const debitResult = await walletService.debitUserFiat(
      userId || payout.userId,
      Number(payout.totalDebit),
      payout.currency,
      {
        referenceId: debitRef,
        type: "withdrawal",
        source: "safari_card_payout",
        metadata: {
          payoutId,
          providerTrackingId: payout.providerTrackingId,
          type: payout.type,
        },
      },
  );

  await fiatReservationService.confirmReservation(requestId || payout.requestId);

  const firstTx = providerPayload?.transactions?.[0] || null;

  const { transactionId } = await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.withdrawal,
    userId: payout.userId,
    amount: Number(payout.amount),
    currency: payout.currency,
    status: transactionService.STATUSES.completed,
    metadata: {
      payoutId,
      ...buildSafariCardTransactionMetadata(payout, firstTx, {
        previousBalance: debitResult.previousBalance,
        newBalance: debitResult.newBalance,
      }),
    },
    logLegacy: true,
  });

  await collection(PAYOUTS_COL).doc(payoutId).update({
    status: PAYOUT_STATUS.SUCCESS,
    transactionId,
    ledgerEntryId: debitResult.ledgerEntryId || null,
    providerTransactionId: firstTx?.transaction_id || payout.providerTransactionId,
    providerReference: firstTx?.provider_reference || payout.providerReference,
    completedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    statusHistory: admin.firestore.FieldValue.arrayUnion({
      status: PAYOUT_STATUS.SUCCESS,
      at: new Date().toISOString(),
    }),
  });

  const updated = await getPayoutById(payoutId);
  return serializePayoutForClient(updated);
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function handlePayoutFailure(params) {
  const { payoutId, requestId, failureReason, providerPayload } = params;
  const payout = await getPayoutById(payoutId);
  if (!payout || payout.status === PAYOUT_STATUS.SUCCESS) {
    return payout;
  }

  if (requestId || payout.requestId) {
    await fiatReservationService.releaseReservation(requestId || payout.requestId);
  }

  const firstTx = providerPayload?.transactions?.[0] || null;
  await collection(PAYOUTS_COL).doc(payoutId).update({
    status: PAYOUT_STATUS.FAILED,
    failureReason: failureReason || "Payout failed",
    providerTransactionId: firstTx?.transaction_id || payout.providerTransactionId,
    providerReference: firstTx?.provider_reference || payout.providerReference,
    failedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    statusHistory: admin.firestore.FieldValue.arrayUnion({
      status: PAYOUT_STATUS.FAILED,
      at: new Date().toISOString(),
      reason: failureReason || null,
    }),
  });

  if (payout.transactionId) {
    return payout;
  }

  await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.withdrawal,
    userId: payout.userId,
    amount: Number(payout.amount),
    currency: payout.currency,
    status: transactionService.STATUSES.failed,
    metadata: {
      payoutId,
      failureReason,
      provider: "intasend",
      type: payout.type,
      source: "safari_card_payout",
    },
    logLegacy: true,
  });

  return getPayoutById(payoutId);
}

/**
 * @param {string} userId
 * @param {string} payoutId
 * @returns {Promise<Object|null>}
 */
async function getPayoutForUser(userId, payoutId) {
  const payout = await getPayoutById(payoutId);
  if (!payout || payout.userId !== userId) {
    return null;
  }
  return serializePayoutForClient(payout);
}

/**
 * @param {string} userId
 * @param {string} clientRequestId
 * @returns {Promise<Object|null>}
 */
async function getPayoutForUserByClientRequestId(userId, clientRequestId) {
  const payout = await findPayoutByIdempotency(userId, clientRequestId);
  if (!payout) {
    return null;
  }
  return serializePayoutForClient(payout);
}

/**
 * @param {string} userId
 * @param {number} [limit=20]
 * @returns {Promise<Object[]>}
 */
async function listPayoutsForUser(userId, limit = 20) {
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 20, 1), 50);
  const snap = await collection(PAYOUTS_COL)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(lim)
      .get();

  return snap.docs.map((doc) => serializePayoutForClient({ payoutId: doc.id, ...doc.data() }));
}

/**
 * @param {string} trackingId
 * @returns {Promise<Object|null>}
 */
async function findPayoutByTrackingId(trackingId) {
  if (!trackingId) {
    return null;
  }
  const snap = await collection(PAYOUTS_COL)
      .where("providerTrackingId", "==", trackingId)
      .limit(1)
      .get();
  if (snap.empty) {
    return null;
  }
  const doc = snap.docs[0];
  return { payoutId: doc.id, ...doc.data() };
}

/**
 * @param {Object} providerPayload
 * @returns {Promise<{ handled: boolean, payout: Object|null }>}
 */
async function applyProviderStatusUpdate(providerPayload) {
  const trackingId = providerPayload?.tracking_id;
  if (!trackingId) {
    return { handled: false, payout: null };
  }

  const payout = await findPayoutByTrackingId(trackingId);
  if (!payout) {
    return { handled: false, payout: null };
  }

  if (TERMINAL_STATUSES.has(payout.status)) {
    return { handled: true, payout, duplicate: true };
  }

  const firstTx = Array.isArray(providerPayload.transactions) ?
    providerPayload.transactions[0] :
    null;
  const mapped = mapIntaSendStatus(
      providerPayload.status_code,
      firstTx?.status_code,
  );

  await collection(PAYOUTS_COL).doc(payout.payoutId).update({
    providerBatchStatus: providerPayload.status || null,
    providerBatchStatusCode: providerPayload.status_code || null,
    providerTxStatus: firstTx?.status || null,
    providerTxStatusCode: firstTx?.status_code || null,
    providerTransactionId: firstTx?.transaction_id || payout.providerTransactionId,
    providerReference: firstTx?.provider_reference || payout.providerReference,
    updatedAt: serverTimestamp(),
    ...providerTxRecipientPatch(firstTx),
  });

  if (mapped === PAYOUT_STATUS.SUCCESS) {
    const result = await finalizePayoutSuccess({
      payoutId: payout.payoutId,
      requestId: payout.requestId,
      userId: payout.userId,
      providerPayload,
    });
    return { handled: true, payout: result };
  }

  if (mapped === PAYOUT_STATUS.FAILED || mapped === PAYOUT_STATUS.CANCELLED) {
    const failed = await handlePayoutFailure({
      payoutId: payout.payoutId,
      requestId: payout.requestId,
      failureReason: firstTx?.status_description ||
        providerPayload.status ||
        mapped,
      providerPayload,
    });
    return { handled: true, payout: serializePayoutForClient(failed) };
  }

  await collection(PAYOUTS_COL).doc(payout.payoutId).update({
    status: mapped === PAYOUT_STATUS.UNKNOWN ? PAYOUT_STATUS.PROCESSING : mapped,
    statusHistory: admin.firestore.FieldValue.arrayUnion({
      status: mapped,
      at: new Date().toISOString(),
      source: "provider_update",
    }),
  });

  const updated = await getPayoutById(payout.payoutId);
  return { handled: true, payout: serializePayoutForClient(updated) };
}

module.exports = {
  validateBeneficiary,
  createPayout,
  getPayoutForUser,
  getPayoutForUserByClientRequestId,
  listPayoutsForUser,
  getPayoutById,
  findPayoutByIdempotency,
  findPayoutByTrackingId,
  applyProviderStatusUpdate,
  finalizePayoutSuccess,
  finalizeInternalWalletTransfer,
  handlePayoutFailure,
  buildProviderPayload,
  resolveSafariTapWalletRecipient,
};
