/**
 * @fileoverview Resolve Avalanche Fuji vs mainnet config by network name.
 */

const {getFujiNetwork} = require("./fujiNetwork");
const {getAvalancheNetwork} = require("./avalancheNetwork");

const {unsupportedNetwork} = require("../cryptoErrors");

const FUJI_NETWORK = "avalanche-fuji";
const MAINNET_NETWORK = "avalanche";
const SUPPORTED_NETWORKS = Object.freeze([FUJI_NETWORK, MAINNET_NETWORK]);

/**
 * @param {unknown} network
 * @returns {string}
 */
function normalizeNetworkName(network) {
  const value = String(network || FUJI_NETWORK).trim().toLowerCase();
  if (value === MAINNET_NETWORK) return MAINNET_NETWORK;
  return FUJI_NETWORK;
}

/**
 * Strict resolver for admin treasury reads. Unknown names are rejected
 * instead of silently falling back to Fuji.
 * @param {unknown} network
 * @returns {"avalanche-fuji"|"avalanche"}
 */
function assertSupportedNetwork(network) {
  const value = String(network || "").trim().toLowerCase();
  if (!SUPPORTED_NETWORKS.includes(value)) {
    throw unsupportedNetwork(network == null || network === "" ? "(empty)" : String(network));
  }
  return value;
}

/**
 * @param {unknown} network
 * @returns {boolean}
 */
function isMainnetNetwork(network) {
  return normalizeNetworkName(network) === MAINNET_NETWORK;
}

/**
 * @param {unknown} network
 * @returns {Object}
 */
function getNetworkConfig(network) {
  return isMainnetNetwork(network) ? getAvalancheNetwork() : getFujiNetwork();
}

/**
 * @param {unknown} network
 * @returns {string}
 */
function depositEventPrefix(network) {
  return isMainnetNetwork(network) ? "avax" : "avax-fuji";
}

module.exports = {
  FUJI_NETWORK,
  MAINNET_NETWORK,
  SUPPORTED_NETWORKS,
  normalizeNetworkName,
  assertSupportedNetwork,
  isMainnetNetwork,
  getNetworkConfig,
  depositEventPrefix,
};
