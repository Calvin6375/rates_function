/**
 * @fileoverview Crypto rail factory. Circle and Turnkey are interchangeable.
 * Default remains `circle` so production can roll back without a code change.
 */

const config = require("../../config");
const circleService = require("../circle/circleService");
const circleRailAdapter = require("../circle/circleRailAdapter");
const turnkeyClient = require("./turnkey/turnkeyClient");

const PROVIDERS = Object.freeze({
  circle: "circle",
  turnkey: "turnkey",
});

/**
 * @returns {"circle"|"turnkey"}
 */
function getCryptoRailProviderName() {
  const raw = String(
      process.env.CRYPTO_RAIL_PROVIDER || config.cryptoRail?.provider || PROVIDERS.circle,
  ).toLowerCase();
  return raw === PROVIDERS.turnkey ? PROVIDERS.turnkey : PROVIDERS.circle;
}

/**
 * @param {string} [name]
 * @returns {boolean}
 */
function isRailConfigured(name) {
  const provider = name || getCryptoRailProviderName();
  if (provider === PROVIDERS.turnkey) {
    return turnkeyClient.isTurnkeyConfigured();
  }
  return circleService.isCircleConfigured();
}

/**
 * @returns {typeof circleRailAdapter|Object}
 */
function getCryptoRailAdapter() {
  if (getCryptoRailProviderName() === PROVIDERS.turnkey) {
    return require("./providers/turnkeyRailAdapter");
  }
  return circleRailAdapter;
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getWallet(userId) {
  return getCryptoRailAdapter().getWallet(userId);
}

/**
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function createWallet(userId) {
  return getCryptoRailAdapter().createWallet(userId);
}

/**
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getBalance(userId) {
  return getCryptoRailAdapter().getBalance(userId);
}

/**
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<Array<Object>>}
 */
async function listTransactions(userId, limit) {
  return getCryptoRailAdapter().listTransactions(userId, limit);
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function send(params) {
  return getCryptoRailAdapter().send(params);
}

module.exports = {
  PROVIDERS,
  getCryptoRailProviderName,
  isRailConfigured,
  getCryptoRailAdapter,
  getWallet,
  createWallet,
  getBalance,
  listTransactions,
  send,
};
