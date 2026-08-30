/**
 * @fileoverview Wallet service: user wallet balances, partner wallets, balance updates, RTDB sync.
 * User wallets: source of truth remains Firestore users collection (backwards compatible).
 * Partner wallets: stored in wallets collection with ownerType: 'partner'.
 */

const admin = require("../admin");
const config = require("../config");
const { collection, serverTimestamp } = require("../libs/firestore");
const { ref } = require("../libs/realtime");
const { syncBalanceToRealtimeDatabase } = require("../utils/firestore");

const ledgerService = require("./ledger/ledgerService");
const fiatLedgerService = require("./ledger/fiatLedgerService");
const fiatReservationService = require("./ledger/fiatReservationService");
const circleRailAdapter = require("./circle/circleRailAdapter");

const OWNER_TYPES = Object.freeze({ user: "user", partner: "partner" });
const DEFAULT_BALANCES = { USD: 0, KES: 0, USDT: 0 };

/** Fiat currencies projected to RTDB `wallet/{uid}/fiat/*` (parity with sync). */
const STANDARD_FIAT_CURRENCIES = Object.freeze([
  "USD", "KES", "TZS", "ETB", "GBP", "EUR", "NGN", "GHS",
]);
/** Crypto currencies projected to RTDB `wallet/{uid}/crypto/*`. */
const STANDARD_CRYPTO_CURRENCIES = Object.freeze(["USDT", "USDC"]);

/**
 * Read a currency balance from a users/{uid} document body.
 * @param {Object} data
 * @param {string} currency
 * @returns {number}
 */
function readUserCurrencyBalance(data, currency) {
  const code = String(currency || "").toUpperCase();
  const wallets = data && data.wallets && typeof data.wallets === "object" ? data.wallets : {};
  const balanceField = `${code.toLowerCase()}Balance`;
  return Number(data?.[balanceField] ?? data?.[code] ?? wallets[code] ?? 0) || 0;
}

/**
 * Build fiat/crypto balance maps from Firestore user doc + USDC ledger value.
 * Does not read RTDB. Shape mirrors what Flutter WalletRepository used to list
 * from `wallet/{uid}/fiat` and `wallet/{uid}/crypto`.
 *
 * @param {Object|null|undefined} userData
 * @param {{ usdc?: number }} [opts]
 * @returns {{ fiat: Record<string, number>, crypto: Record<string, number> }}
 */
function buildAccountBalancesFromUserData(userData, opts = {}) {
  const data = userData && typeof userData === "object" ? userData : {};
  const wallets = data.wallets && typeof data.wallets === "object" ? data.wallets : {};
  const fiat = {};

  for (const code of STANDARD_FIAT_CURRENCIES) {
    fiat[code] = readUserCurrencyBalance(data, code);
  }

  for (const rawKey of Object.keys(wallets)) {
    const code = String(rawKey || "").toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(code)) continue;
    if (STANDARD_CRYPTO_CURRENCIES.includes(code)) continue;
    if (fiat[code] === undefined) {
      fiat[code] = Number(wallets[rawKey] ?? 0) || 0;
    }
  }

  const crypto = {
    USDT: Number(data.usdtBalance ?? data.USDT ?? wallets.USDT ?? 0) || 0,
    USDC: Number(opts.usdc ?? 0) || 0,
  };

  return {fiat, crypto};
}

/**
 * @param {Record<string, number>} map
 * @param {"fiat"|"crypto"} type
 * @returns {Array<{ currency: string, balance: number, type: string }>}
 */
function mapToAccountList(map, type) {
  return Object.keys(map)
      .sort()
      .map((currency) => ({
        currency,
        balance: Number(map[currency]) || 0,
        type,
      }));
}

/**
 * Get user wallet balances from Firestore (users collection).
 * Preserves existing structure for consumer app.
 *
 * @param {string} userId - Firebase user ID
 * @returns {Promise<{ USD: number, KES: number, USDT: number }|null>}
 */
async function getUserWalletBalances(userId) {
  const userDoc = await admin.firestore().collection(config.collections.users).doc(userId).get();
  if (!userDoc.exists) return null;
  const d = userDoc.data();
  return {
    USD: Number(d.usdBalance ?? d.USD ?? 0),
    KES: Number(d.kesBalance ?? d.KES ?? 0),
    USDT: Number(d.usdtBalance ?? d.USDT ?? 0),
  };
}

/**
 * Get or create partner wallet document in wallets collection.
 *
 * @param {string} partnerId - Partner ID
 * @returns {Promise<{ walletId: string, balances: Object }>}
 */
async function getOrCreatePartnerWallet(partnerId) {
  const col = collection("wallets");
  const snapshot = await col.where("ownerType", "==", OWNER_TYPES.partner).where("ownerId", "==", partnerId).limit(1).get();
  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    const data = doc.data();
    return {
      walletId: doc.id,
      balances: data.balances || { ...DEFAULT_BALANCES },
    };
  }
  const walletId = `wallet_partner_${partnerId}_${Date.now()}`;
  await col.doc(walletId).set({
    ownerType: OWNER_TYPES.partner,
    ownerId: partnerId,
    balances: { ...DEFAULT_BALANCES },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { walletId, balances: { ...DEFAULT_BALANCES } };
}

/**
 * Get partner wallet by partner ID
 *
 * @param {string} partnerId
 * @returns {Promise<{ walletId: string, balances: Object }|null>}
 */
async function getPartnerWallet(partnerId) {
  const snapshot = await collection("wallets")
    .where("ownerType", "==", OWNER_TYPES.partner)
    .where("ownerId", "==", partnerId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  const data = doc.data();
  return {
    walletId: doc.id,
    balances: data.balances || { ...DEFAULT_BALANCES },
  };
}

/**
 * Update partner wallet balance (single currency). Uses Firestore transaction.
 *
 * @param {string} partnerId - Partner ID
 * @param {string} currency - USD | KES | USDT
 * @param {number} delta - Positive for credit, negative for debit
 * @param {Object} [options] - { allowNegative: boolean }
 * @returns {Promise<{ previousBalance: number, newBalance: number }>}
 */
async function updatePartnerWalletBalance(partnerId, currency, delta, options = {}) {
  const col = collection("wallets");
  const snapshot = await col.where("ownerType", "==", OWNER_TYPES.partner).where("ownerId", "==", partnerId).limit(1).get();
  if (snapshot.empty) {
    const { walletId } = await getOrCreatePartnerWallet(partnerId);
    const docRef = col.doc(walletId);
    const current = 0;
    const newBalance = Math.max(0, current + delta) || (options.allowNegative ? current + delta : 0);
    if (newBalance < 0 && !options.allowNegative) throw new Error("Insufficient partner wallet balance");
    await docRef.update({
      [`balances.${currency}`]: newBalance,
      updatedAt: serverTimestamp(),
    });
    return { previousBalance: current, newBalance };
  }
  const docRef = snapshot.docs[0].ref;
  let result;
  await admin.firestore().runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    if (!doc.exists) throw new Error("Partner wallet not found");
    const data = doc.data();
    const balances = data.balances || { ...DEFAULT_BALANCES };
    const current = Number(balances[currency] ?? 0);
    const newBalance = current + delta;
    if (newBalance < 0 && !options.allowNegative) throw new Error("Insufficient partner wallet balance");
    tx.update(docRef, {
      [`balances.${currency}`]: newBalance,
      updatedAt: serverTimestamp(),
    });
    result = { previousBalance: current, newBalance };
  });
  return result;
}

/**
 * Sync user balances to Realtime DB (for Flutter app). Delegates to existing util.
 *
 * @param {string} userId - User ID
 * @param {string} [currency='USD'] - Currency that was updated (triggers full sync of all)
 */
async function syncUserBalanceToRealtime(userId, currency = "USD") {
  await syncBalanceToRealtimeDatabase(userId, currency);
}

/**
 * Cache rates in Realtime DB for frontend (e.g. wallet/rates).
 *
 * @param {Object} rates - Key-value of rate data to cache
 */
async function cacheRatesInRealtime(rates) {
  const r = ref("wallet/rates");
  await r.set(rates);
}

/**
 * Get Circle USDC balance for a user.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getCryptoBalance(userId) {
  const wallet = await circleRailAdapter.getWallet(userId);
  if (!wallet) return 0;
  return ledgerService.getAvailableBalance(userId, "USDC");
}

/**
 * Aggregate fiat + crypto balances for a user.
 *
 * @param {string} userId
 * @returns {Promise<{ fiat: { USD: number, KES: number, USDT: number }, crypto: { USDC: number } }|null>}
 */
async function getBalances(userId) {
  const fiat = await getUserWalletBalances(userId);
  if (!fiat) return null;
  const usdc = await getCryptoBalance(userId);
  return {
    fiat,
    crypto: {
      USDC: usdc,
    },
  };
}

/**
 * List C2B customer accounts (owned wallets) for HTTP clients.
 * Source of truth: Firestore users/{uid} + USDC ledger — never RTDB.
 *
 * @param {string} userId
 * @returns {Promise<{
 *   userId: string,
 *   fiat: Array<{ currency: string, balance: number, type: string }>,
 *   crypto: Array<{ currency: string, balance: number, type: string }>,
 *   accounts: Array<{ currency: string, balance: number, type: string }>,
 *   balances: { fiat: Record<string, number>, crypto: Record<string, number> },
 * }|null>}
 */
async function listCustomerAccounts(userId) {
  if (!userId) return null;

  const userDoc = await admin.firestore().collection(config.collections.users).doc(userId).get();
  if (!userDoc.exists) return null;

  const usdc = await getCryptoBalance(userId);
  const {fiat, crypto} = buildAccountBalancesFromUserData(userDoc.data(), {usdc});
  const fiatAccounts = mapToAccountList(fiat, "fiat");
  const cryptoAccounts = mapToAccountList(crypto, "crypto");

  return {
    userId,
    fiat: fiatAccounts,
    crypto: cryptoAccounts,
    accounts: [...fiatAccounts, ...cryptoAccounts],
    balances: {fiat, crypto},
  };
}

/**
 * Dual-write fiat balance to users document (Flutter backward compat).
 * Supports USD/KES specially, plus other ISO fiats on `wallets.{CCY}` / `{ccy}Balance`.
 * @param {string} userId
 * @param {string} asset USD | KES | GBP | …
 * @param {number} newBalance
 * @returns {Promise<{ previousBalance: number, newBalance: number }>}
 */
async function dualWriteFiatBalance(userId, asset, newBalance) {
  const currency = String(asset).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Unsupported fiat dual-write currency: ${currency}`);
  }

  const userRef = admin.firestore().collection(config.collections.users).doc(userId);
  let result = { previousBalance: 0, newBalance };

  await admin.firestore().runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) {
      throw new Error(`User ${userId} not found`);
    }
    const data = doc.data();
    const wallets = (data.wallets && typeof data.wallets === "object") ? {...data.wallets} : {};

    const usdBalance = Number(data.usdBalance ?? data.USD ?? wallets.USD ?? 0);
    const kesBalance = Number(data.kesBalance ?? data.KES ?? wallets.KES ?? 0);
    const usdtBalance = Number(data.usdtBalance ?? data.USDT ?? wallets.USDT ?? 0);
    const balanceField = `${currency.toLowerCase()}Balance`;

    let previousBalance = 0;
    const update = { updatedAt: serverTimestamp() };

    if (currency === "USD") {
      previousBalance = usdBalance;
      update.usdBalance = newBalance;
      update.USD = newBalance;
      update.fiatBalance = newBalance;
      wallets.USD = newBalance;
      wallets.KES = kesBalance;
      wallets.USDT = usdtBalance;
    } else if (currency === "KES") {
      previousBalance = kesBalance;
      update.kesBalance = newBalance;
      update.KES = newBalance;
      wallets.USD = usdBalance;
      wallets.KES = newBalance;
      wallets.USDT = usdtBalance;
    } else if (currency === "USDT") {
      previousBalance = usdtBalance;
      update.usdtBalance = newBalance;
      update.USDT = newBalance;
      wallets.USD = usdBalance;
      wallets.KES = kesBalance;
      wallets.USDT = newBalance;
    } else {
      previousBalance = Number(
          data[balanceField] ?? data[currency] ?? wallets[currency] ?? 0,
      );
      update[balanceField] = newBalance;
      update[currency] = newBalance;
      wallets.USD = usdBalance;
      wallets.KES = kesBalance;
      wallets.USDT = usdtBalance;
      wallets[currency] = newBalance;
    }

    update.wallets = wallets;
    result = { previousBalance, newBalance };
    tx.update(userRef, update);
  });

  return result;
}

/**
 * @deprecated Use dualWriteFiatBalance(userId, "USD", balance)
 * @param {string} userId
 * @param {number} newUsdBalance
 * @returns {Promise<{ previousBalance: number, newBalance: number }>}
 */
async function dualWriteUsdBalance(userId, newUsdBalance) {
  return dualWriteFiatBalance(userId, "USD", newUsdBalance);
}

/**
 * Fiat assets that Safari Card / settlements debit via fiatLedger.
 * (USDT remains on the legacy users/crypto projection.)
 */
const FIAT_LEDGER_ASSETS = new Set([
  "USD", "KES", "TZS", "ETB", "GBP", "EUR", "NGN", "GHS",
]);

/**
 * Users-doc projection for a fiat currency (what /api/accounts shows).
 * @param {string} userId
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function getProjectedFiatBalance(userId, asset) {
  const code = String(asset || "").toUpperCase();
  const userDoc = await admin.firestore().collection(config.collections.users).doc(userId).get();
  if (!userDoc.exists) return 0;
  return readUserCurrencyBalance(userDoc.data(), code);
}

/**
 * Bring fiatLedger in line with users/{uid} projection.
 *
 * Default (**credit-only**): if users.*Balance &gt; ledger, credit the gap.
 * Never auto-debit the ledger when users is behind — that destroyed balances when
 * creditUserFiat dual-wrote a low ledger total over a higher users balance.
 *
 * Pass `allowDebit: true` after admin users-doc debits that intentionally lower projection.
 *
 * @param {string} userId
 * @param {string} asset
 * @param {{ allowDebit?: boolean }} [options]
 * @returns {Promise<{ synced: boolean, projected: number, ledgerBefore: number, ledgerAfter: number, gap: number }>}
 */
async function syncFiatLedgerFromUserProjection(userId, asset, options = {}) {
  const code = String(asset || "").toUpperCase();
  const allowDebit = options.allowDebit === true;
  if (!userId || !FIAT_LEDGER_ASSETS.has(code)) {
    return {synced: false, projected: 0, ledgerBefore: 0, ledgerAfter: 0, gap: 0};
  }

  const projected = await getProjectedFiatBalance(userId, code);
  const ledgerBefore = await fiatLedgerService.getLedgerBalance(userId, code);
  const gap = projected - ledgerBefore;

  if (!Number.isFinite(gap) || Math.abs(gap) < 0.000001) {
    return {synced: false, projected, ledgerBefore, ledgerAfter: ledgerBefore, gap: 0};
  }

  const cents = (n) => Math.round(Number(n) * 100);
  const referenceId =
    `user_projection_sync_${userId}_${code}_${cents(projected)}_${cents(ledgerBefore)}`;

  if (gap > 0) {
    const result = await fiatLedgerService.appendTransaction({
      userId,
      type: "funding",
      asset: code,
      amount: gap,
      direction: "credit",
      source: "user_projection_sync",
      referenceId,
      metadata: {
        reason: "Align fiatLedger with users projection (swap/legacy credits)",
        projected,
        ledgerBefore,
      },
    });
    return {
      synced: !result.duplicate,
      projected,
      ledgerBefore,
      ledgerAfter: result.newBalance,
      gap,
    };
  }

  if (!allowDebit) {
    console.warn("syncFiatLedgerFromUserProjection: users behind ledger; skip auto-debit", {
      userId,
      asset: code,
      projected,
      ledgerBefore,
      gap,
    });
    return {synced: false, projected, ledgerBefore, ledgerAfter: ledgerBefore, gap};
  }

  const result = await fiatLedgerService.appendTransaction({
    userId,
    type: "withdrawal",
    asset: code,
    amount: Math.abs(gap),
    direction: "debit",
    source: "user_projection_sync",
    referenceId,
    metadata: {
      reason: "Align fiatLedger down after admin/users debit",
      projected,
      ledgerBefore,
    },
  });
  return {
    synced: !result.duplicate,
    projected,
    ledgerBefore,
    ledgerAfter: result.newBalance,
    gap,
  };
}

/**
 * Get spendable fiat balance: sync users projection → ledger, then ledger − reservations.
 * @param {string} userId
 * @param {string} [asset="USD"]
 * @returns {Promise<number>}
 */
async function getFiatAvailableBalance(userId, asset = "USD") {
  const code = String(asset || "USD").toUpperCase();
  try {
    // Bidirectional: admin may have zeroed users.* while ledger still holds funds.
    await syncFiatLedgerFromUserProjection(userId, code, {allowDebit: true});
  } catch (err) {
    console.warn("getFiatAvailableBalance: projection sync failed", {
      userId,
      asset: code,
      error: err.message,
    });
  }
  return fiatReservationService.getAvailableBalance(userId, code);
}

/**
 * Credit user fiat via append-only ledger + dual-write to users doc.
 * @param {string} userId
 * @param {number} amount
 * @param {string} [currency="USD"]
 * @param {Object} [options]
 * @returns {Promise<{ previousBalance: number, newBalance: number, duplicate?: boolean, ledgerEntryId?: string }>}
 */
async function creditUserFiat(userId, amount, currency = "USD", options = {}) {
  const asset = String(currency).toUpperCase();
  const numericAmount = Number(amount);
  if (!userId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid fiat credit parameters");
  }

  const referenceId = options.referenceId;
  if (!referenceId) {
    throw new Error("referenceId is required for idempotent fiat credit");
  }

  // Align ledger to users.*Balance first (both directions), then apply credit.
  // - users > ledger (swap/legacy): credit gap so dualWrite does not wipe users
  // - users < ledger (admin debit to 0): debit gap so old ledger is not "resurrected"
  //   when dualWrite(ledger + amount) runs
  if (options.skipProjectionSync !== true) {
    await syncFiatLedgerFromUserProjection(userId, asset, {allowDebit: true});
  }

  const ledgerResult = await fiatLedgerService.appendTransaction({
    userId,
    type: options.type || "funding",
    asset,
    amount: numericAmount,
    direction: "credit",
    source: options.source || "funding",
    referenceId,
    fundingOrderId: options.fundingOrderId || null,
    transactionRecordId: options.transactionRecordId || null,
    metadata: options.metadata || {},
  });

  const dualWrite = await dualWriteFiatBalance(userId, asset, ledgerResult.newBalance);
  await syncUserBalanceToRealtime(userId, asset);

  return {
    previousBalance: dualWrite.previousBalance,
    newBalance: ledgerResult.newBalance,
    duplicate: ledgerResult.duplicate,
    ledgerEntryId: ledgerResult.entryId,
  };
}

/**
 * Debit user fiat via append-only ledger + dual-write to users doc.
 * @param {string} userId
 * @param {number} amount
 * @param {string} [currency="USD"]
 * @param {Object} [options]
 * @returns {Promise<{ previousBalance: number, newBalance: number, duplicate?: boolean, ledgerEntryId?: string }>}
 */
async function debitUserFiat(userId, amount, currency = "USD", options = {}) {
  const asset = String(currency).toUpperCase();
  const numericAmount = Number(amount);
  if (!userId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid fiat debit parameters");
  }

  const referenceId = options.referenceId;
  if (!referenceId) {
    throw new Error("referenceId is required for idempotent fiat debit");
  }

  if (options.skipProjectionSync !== true) {
    await syncFiatLedgerFromUserProjection(userId, asset, {allowDebit: true});
  }

  const ledgerResult = await fiatLedgerService.appendTransaction({
    userId,
    type: options.type || "merchant_settlement",
    asset,
    amount: numericAmount,
    direction: "debit",
    source: options.source || "settlement",
    referenceId,
    transactionRecordId: options.transactionRecordId || null,
    metadata: options.metadata || {},
  });

  const dualWrite = await dualWriteFiatBalance(userId, asset, ledgerResult.newBalance);
  await syncUserBalanceToRealtime(userId, asset);

  return {
    previousBalance: dualWrite.previousBalance,
    newBalance: ledgerResult.newBalance,
    duplicate: ledgerResult.duplicate,
    ledgerEntryId: ledgerResult.entryId,
  };
}

module.exports = {
  OWNER_TYPES,
  STANDARD_FIAT_CURRENCIES,
  STANDARD_CRYPTO_CURRENCIES,
  FIAT_LEDGER_ASSETS,
  buildAccountBalancesFromUserData,
  getUserWalletBalances,
  getCryptoBalance,
  getBalances,
  listCustomerAccounts,
  getProjectedFiatBalance,
  syncFiatLedgerFromUserProjection,
  getFiatAvailableBalance,
  creditUserFiat,
  debitUserFiat,
  getOrCreatePartnerWallet,
  getPartnerWallet,
  updatePartnerWalletBalance,
  syncUserBalanceToRealtime,
  cacheRatesInRealtime,
};
