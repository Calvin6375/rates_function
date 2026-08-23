/**
 * @fileoverview Merge Safari Card payout records into C2B transaction feed rows.
 */

const admin = require("../admin");
const config = require("../config");
const {
  serializeRecipientForClient,
  resolveMerchantName,
} = require("./safariCardPayoutTypes");
const { enrichTransactionForFeed } = require("./transactionFeedLabels");

const firestore = admin.firestore();
const PAYOUTS_COL = config.collections.safariCardPayouts;

/**
 * @param {Object|null} payout
 * @returns {Object|null}
 */
function buildSafariCardPayoutDetails(payout) {
  if (!payout) {
    return null;
  }
  return {
    mpesaReference: payout.providerReference || null,
    merchantName: resolveMerchantName(payout),
    fee: Number(payout.fee || 0),
    totalDebit: Number(payout.totalDebit || payout.amount || 0),
    recipient: serializeRecipientForClient(payout),
  };
}

/**
 * Metadata fields safe for client (no internal ids or provider noise).
 * @param {Object} meta
 * @returns {Object}
 */
function sanitizeSafariCardMetadata(meta) {
  const out = meta && typeof meta === "object" ? { ...meta } : {};
  delete out.payoutId;
  delete out.providerTrackingId;
  delete out.recipientType;
  delete out.type;
  delete out.clientRequestId;
  delete out.narrative;
  delete out.providerTransactionId;
  delete out.providerReference;
  if (out.recipient && typeof out.recipient === "object") {
    const recipient = { ...out.recipient };
    delete recipient.name;
    out.recipient = recipient;
  }
  return out;
}

/**
 * @param {Object} tx
 * @param {Object|null} payoutDetails
 * @returns {Object}
 */
function applySafariCardPayoutDetails(tx, payoutDetails) {
  const meta = tx.metadata && typeof tx.metadata === "object" ? { ...tx.metadata } : {};
  const merchantName =
    payoutDetails?.merchantName ||
    meta.merchantName ||
    meta.recipient?.name ||
    null;
  const mpesaReference =
    payoutDetails?.mpesaReference ||
    meta.mpesaReference ||
    meta.providerReference ||
    null;
  const recipient =
    payoutDetails?.recipient ||
    (meta.recipient ? sanitizeSafariCardMetadata({ recipient: meta.recipient }).recipient : null);

  const mergedMeta = sanitizeSafariCardMetadata({
    currency: meta.currency || tx.currency || null,
    provider: meta.provider || "intasend",
    source: "safari_card_payout",
    fee: payoutDetails?.fee ?? meta.fee ?? null,
    totalDebit: payoutDetails?.totalDebit ?? meta.totalDebit ?? null,
    mpesaReference,
    merchantName,
    recipient,
  });

  let displayNameOverride = merchantName;
  if (!displayNameOverride && recipient?.account_type === "TillNumber" && recipient.account) {
    displayNameOverride = `Till ${recipient.account}`;
  } else if (!displayNameOverride && recipient?.account_type === "PayBill" && recipient.account) {
    displayNameOverride = `Paybill ${recipient.account}`;
  }

  const enriched = enrichTransactionForFeed({
    ...tx,
    metadata: mergedMeta,
    merchantName,
    mpesaReference,
    fee: mergedMeta.fee,
    totalDebit: mergedMeta.totalDebit,
    recipient,
  });

  delete enriched.providerReference;
  delete enriched.providerTransactionId;
  delete enriched.narrative;
  delete enriched.clientRequestId;

  if (displayNameOverride) {
    enriched.displayName = displayNameOverride;
    enriched.title = displayNameOverride;
    enriched.label = displayNameOverride;
  }

  return enriched;
}

/**
 * @param {Object} tx
 * @returns {boolean}
 */
function isSafariCardPayoutTransaction(tx) {
  const meta = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
  return meta.source === "safari_card_payout" && Boolean(meta.payoutId);
}

/**
 * @param {Object} tx
 * @returns {Promise<Object>}
 */
async function enrichTransactionWithSafariCardPayout(tx) {
  if (!isSafariCardPayoutTransaction(tx)) {
    return enrichTransactionForFeed(tx);
  }

  const payoutId = String(tx.metadata.payoutId);
  const payoutDoc = await firestore.collection(PAYOUTS_COL).doc(payoutId).get();
  const payout = payoutDoc.exists ?
    { payoutId: payoutDoc.id, ...payoutDoc.data() } :
    null;
  return applySafariCardPayoutDetails(tx, buildSafariCardPayoutDetails(payout));
}

/**
 * @param {Array<Object>} transactions
 * @returns {Promise<Array<Object>>}
 */
async function enrichTransactionsWithSafariCardPayouts(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return transactions;
  }

  const payoutIds = [
    ...new Set(
        transactions
            .filter(isSafariCardPayoutTransaction)
            .map((tx) => String(tx.metadata.payoutId)),
    ),
  ];

  /** @type {Map<string, Object|null>} */
  const detailsByPayoutId = new Map();
  if (payoutIds.length > 0) {
    const refs = payoutIds.map((id) => firestore.collection(PAYOUTS_COL).doc(id));
    const docs = await firestore.getAll(...refs);
    for (const doc of docs) {
      const payout = doc.exists ? { payoutId: doc.id, ...doc.data() } : null;
      detailsByPayoutId.set(doc.id, buildSafariCardPayoutDetails(payout));
    }
  }

  return transactions.map((tx) => {
    if (!isSafariCardPayoutTransaction(tx)) {
      return enrichTransactionForFeed(tx);
    }
    const details = detailsByPayoutId.get(String(tx.metadata.payoutId)) || null;
    return applySafariCardPayoutDetails(tx, details);
  });
}

/**
 * Build metadata persisted on legacy transaction rows at payout completion.
 * @param {Object} payout
 * @param {Object|null} firstTx
 * @param {{ previousBalance: number, newBalance: number }} balances
 * @returns {Object}
 */
function buildSafariCardTransactionMetadata(payout, firstTx, balances) {
  const details = buildSafariCardPayoutDetails({
    ...payout,
    providerReference: firstTx?.provider_reference || payout.providerReference,
    recipient: {
      ...(payout.recipient || {}),
      ...(firstTx?.name ? { name: firstTx.name } : {}),
      ...(firstTx?.account ? { account: String(firstTx.account) } : {}),
      ...(firstTx?.account_type ? { accountType: firstTx.account_type } : {}),
      ...(firstTx?.account_reference ?
        { accountReference: firstTx.account_reference } :
        {}),
    },
  });

  return {
    currency: payout.currency,
    provider: "intasend",
    source: "safari_card_payout",
    fee: details?.fee ?? 0,
    totalDebit: details?.totalDebit ?? payout.amount,
    mpesaReference: details?.mpesaReference || null,
    merchantName: details?.merchantName || null,
    recipient: details?.recipient || null,
    previousBalance: balances.previousBalance,
    newBalance: balances.newBalance,
  };
}

module.exports = {
  isSafariCardPayoutTransaction,
  buildSafariCardPayoutDetails,
  buildSafariCardTransactionMetadata,
  applySafariCardPayoutDetails,
  enrichTransactionWithSafariCardPayout,
  enrichTransactionsWithSafariCardPayouts,
};
