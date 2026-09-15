/**
 * @fileoverview Resolve Avalanche Fuji vs mainnet config by network name.
 */

const {getFujiNetwork} = require("./fujiNetwork");
const {getAvalancheNetwork} = require("./avalancheNetwork");

const FUJI_NETWORK = "avalanche-fuji";
const MAINNET_NETWORK = "avalanche";

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
  normalizeNetworkName,
  isMainnetNetwork,
  getNetworkConfig,
  depositEventPrefix,
};
