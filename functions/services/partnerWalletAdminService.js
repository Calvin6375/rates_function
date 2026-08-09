/**
 * @fileoverview Platform admin manual credit/debit of B2B partner wallets
 * (mirrors C2B POST /customer-wallets/:id/credit).
 */

const walletService = require("./walletService");
const partnerService = require("./partnerService");
const transactionService = require("./transactionService");

const VALID_CURRENCIES = Object.freeze(["USD", "KES", "USDT"]);

/**
 * @param {unknown} amount
 * @returns {number}
 */
function parsePositiveAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error("amount must be a positive number");
    err.statusCode = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  return n;
}

/**
 * @param {unknown} currency
 * @returns {string}
 */
function parseCurrency(currency) {
  const cur = String(currency || "KES").toUpperCase();
  if (!VALID_CURRENCIES.includes(cur)) {
    const err = new Error(
        `Invalid currency. Must be one of: ${VALID_CURRENCIES.join(", ")}`,
    );
    err.statusCode = 400;
    err.code = "INVALID_CURRENCY";
    throw err;
  }
  return cur;
}

/**
 * @param {string} partnerId
 * @returns {Promise<Object>}
 */
async function getPartnerWalletForAdmin(partnerId) {
  const partner = await partnerService.getPartner(partnerId);
  if (!partner) {
    const err = new Error("Partner not found");
    err.statusCode = 404;
    err.code = "PARTNER_NOT_FOUND";
    throw err;
  }
  const wallet = await walletService.getOrCreatePartnerWallet(partnerId);
  return {
    partnerId: String(partnerId),
    partnerName: partner.name || null,
    walletId: wallet.walletId,
    balances: wallet.balances || {USD: 0, KES: 0, USDT: 0},
  };
}

/**
 * Manually credit a partner wallet (super-admin / platform admin).
 *
 * @param {Object} params
 * @param {string} params.partnerId
 * @param {number} params.amount
 * @param {string} [params.currency]
 * @param {string} [params.description]
 * @param {string} params.actorUid
 * @returns {Promise<Object>}
 */
async function creditPartnerWallet(params) {
  const {
    partnerId,
    amount,
    currency = "KES",
    description = "Admin wallet top-up",
    actorUid,
  } = params;

  if (!partnerId || !actorUid) {
    const err = new Error("partnerId and actorUid are required");
    err.statusCode = 400;
    throw err;
  }

  const amt = parsePositiveAmount(amount);
  const cur = parseCurrency(currency);
  const partner = await partnerService.getPartner(partnerId);
  if (!partner) {
    const err = new Error("Partner not found");
    err.statusCode = 404;
    err.code = "PARTNER_NOT_FOUND";
    throw err;
  }

  await walletService.getOrCreatePartnerWallet(partnerId);
  const {previousBalance, newBalance} = await walletService.updatePartnerWalletBalance(
      partnerId,
      cur,
      amt,
  );

  const {transactionId} = await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.b2b_admin_topup,
    partnerId: String(partnerId),
    userId: actorUid,
    amount: amt,
    currency: cur,
    status: transactionService.STATUSES.completed,
    metadata: {
      source: "platform_admin",
      direction: "credit",
      description: String(description || "Admin wallet top-up"),
      actorUid,
      partnerName: partner.name || null,
      previousBalance,
      newBalance,
    },
    logLegacy: false,
  });

  const wallet = await walletService.getPartnerWallet(partnerId);

  return {
    partnerId: String(partnerId),
    partnerName: partner.name || null,
    wallet: {
      walletId: wallet?.walletId || null,
      balances: wallet?.balances || {USD: 0, KES: 0, USDT: 0},
    },
    transaction: {
      transactionId,
      type: "credit",
      amount: amt,
      currency: cur,
      description: String(description || "Admin wallet top-up"),
      previousBalance,
      newBalance,
    },
  };
}

/**
 * Manually debit a partner wallet (platform admin).
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function debitPartnerWallet(params) {
  const {
    partnerId,
    amount,
    currency = "KES",
    description = "Admin wallet debit",
    actorUid,
  } = params;

  if (!partnerId || !actorUid) {
    const err = new Error("partnerId and actorUid are required");
    err.statusCode = 400;
    throw err;
  }

  const amt = parsePositiveAmount(amount);
  const cur = parseCurrency(currency);
  const partner = await partnerService.getPartner(partnerId);
  if (!partner) {
    const err = new Error("Partner not found");
    err.statusCode = 404;
    err.code = "PARTNER_NOT_FOUND";
    throw err;
  }

  await walletService.getOrCreatePartnerWallet(partnerId);
  let previousBalance;
  let newBalance;
  try {
    ({previousBalance, newBalance} = await walletService.updatePartnerWalletBalance(
        partnerId,
        cur,
        -amt,
    ));
  } catch (e) {
    if (String(e.message || "").includes("Insufficient")) {
      const err = new Error(e.message);
      err.statusCode = 400;
      err.code = "INSUFFICIENT_BALANCE";
      throw err;
    }
    throw e;
  }

  const {transactionId} = await transactionService.createTransactionRecord({
    type: transactionService.TRANSACTION_TYPES.b2b_admin_topup,
    partnerId: String(partnerId),
    userId: actorUid,
    amount: amt,
    currency: cur,
    status: transactionService.STATUSES.completed,
    metadata: {
      source: "platform_admin",
      direction: "debit",
      description: String(description || "Admin wallet debit"),
      actorUid,
      partnerName: partner.name || null,
      previousBalance,
      newBalance,
    },
    logLegacy: false,
  });

  const wallet = await walletService.getPartnerWallet(partnerId);

  return {
    partnerId: String(partnerId),
    partnerName: partner.name || null,
    wallet: {
      walletId: wallet?.walletId || null,
      balances: wallet?.balances || {USD: 0, KES: 0, USDT: 0},
    },
    transaction: {
      transactionId,
      type: "debit",
      amount: amt,
      currency: cur,
      description: String(description || "Admin wallet debit"),
      previousBalance,
      newBalance,
    },
  };
}

module.exports = {
  VALID_CURRENCIES,
  getPartnerWalletForAdmin,
  creditPartnerWallet,
  debitPartnerWallet,
};
