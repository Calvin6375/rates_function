/**
 * @fileoverview SafariCoin service — MOCK PLACEHOLDER ONLY.
 * Do NOT integrate with any blockchain. All logic is in-memory/mock storage.
 * TODO: Replace with real blockchain integration when ready.
 *
 * Mock rate: 1 SFRC = 1 USD
 * Balances stored in Firestore: safariCoinWallets/{walletId}
 */

const { collection, serverTimestamp } = require("../libs/firestore");

/** Mock rate: 1 SFRC = 1 USD */
const MOCK_SFRC_USD_RATE = 1;

/**
 * Get or create a SafariCoin wallet document
 *
 * @param {string} walletId - Typically user ID or partner ID
 * @returns {Promise<{ walletId: string, balance: number }>}
 */
async function getOrCreateSafariCoinWallet(walletId) {
  const col = collection("safariCoinWallets");
  const ref = col.doc(walletId);
  const doc = await ref.get();
  if (doc.exists) {
    const data = doc.data();
    return { walletId: doc.id, balance: Number(data.balance ?? 0) };
  }
  await ref.set({
    balance: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { walletId, balance: 0 };
}

/**
 * Mint SafariCoin (mock). Increases balance for the given wallet.
 * TODO: replace with blockchain integration
 *
 * @param {string} walletId - Target wallet
 * @param {number} amount - Amount to mint (SFRC)
 * @returns {Promise<{ balance: number, amount: number }>}
 */
async function mintSafariCoin(walletId, amount) {
  const col = collection("safariCoinWallets");
  const ref = col.doc(walletId);
  const doc = await ref.get();
  const current = doc.exists ? Number(doc.data().balance ?? 0) : 0;
  const newBalance = current + Number(amount);
  await ref.set(
    {
      balance: newBalance,
      updatedAt: serverTimestamp(),
      ...(doc.exists ? {} : { createdAt: serverTimestamp() }),
    },
    { merge: true }
  );
  return { balance: newBalance, amount: Number(amount) };
}

/**
 * Burn SafariCoin (mock). Decreases balance.
 * TODO: replace with blockchain integration
 *
 * @param {string} walletId - Target wallet
 * @param {number} amount - Amount to burn (SFRC)
 * @returns {Promise<{ balance: number, amount: number }>}
 */
async function burnSafariCoin(walletId, amount) {
  const col = collection("safariCoinWallets");
  const ref = col.doc(walletId);
  const doc = await ref.get();
  const current = doc.exists ? Number(doc.data().balance ?? 0) : 0;
  const amt = Number(amount);
  if (current < amt) throw new Error("Insufficient SafariCoin balance");
  const newBalance = current - amt;
  await ref.set(
    {
      balance: newBalance,
      updatedAt: serverTimestamp(),
      ...(doc.exists ? {} : { createdAt: serverTimestamp() }),
    },
    { merge: true }
  );
  return { balance: newBalance, amount: amt };
}

/**
 * Convert amount in USD to SafariCoin (mock). Rate: 1 SFRC = 1 USD.
 * TODO: replace with blockchain integration
 *
 * @param {number} amountUsd - Amount in USD
 * @returns {Promise<{ amountUsd: number, amountSfrc: number, rate: number }>}
 */
async function convertToSafariCoin(amountUsd) {
  const usd = Number(amountUsd);
  const sfrc = usd * (1 / MOCK_SFRC_USD_RATE);
  return {
    amountUsd: usd,
    amountSfrc: sfrc,
    rate: MOCK_SFRC_USD_RATE,
  };
}

/**
 * Convert SafariCoin to USD (mock). Rate: 1 SFRC = 1 USD.
 * TODO: replace with blockchain integration
 *
 * @param {number} amountSfrc - Amount in SFRC
 * @returns {Promise<{ amountSfrc: number, amountUsd: number, rate: number }>}
 */
async function convertFromSafariCoin(amountSfrc) {
  const sfrc = Number(amountSfrc);
  const usd = sfrc * MOCK_SFRC_USD_RATE;
  return {
    amountSfrc: sfrc,
    amountUsd: usd,
    rate: MOCK_SFRC_USD_RATE,
  };
}

/**
 * Get SafariCoin balance for a wallet (mock).
 *
 * @param {string} walletId
 * @returns {Promise<number>}
 */
async function getSafariCoinBalance(walletId) {
  const { balance } = await getOrCreateSafariCoinWallet(walletId);
  return balance;
}

module.exports = {
  MOCK_SFRC_USD_RATE,
  getOrCreateSafariCoinWallet,
  mintSafariCoin,
  burnSafariCoin,
  convertToSafariCoin,
  convertFromSafariCoin,
  getSafariCoinBalance,
};
