/**
 * @fileoverview Funding rail router — resolves provider adapters by id.
 * Wallet, ledger, settlement, and API layers call this module only.
 */

const config = require("../../config");
const { registerFundingProviders } = require("./fundingProviderInterface");
const paystackRail = require("./paystackRail");
const transakRail = require("./transakRail");
const { FUNDING_PROVIDERS } = require("../../utils/fundingTypes");

/** @type {Record<string, Object>} */
const PROVIDERS = registerFundingProviders({
  [FUNDING_PROVIDERS.paystack]: paystackRail,
  [FUNDING_PROVIDERS.transak]: transakRail,
});

/**
 * @param {string} [providerId]
 * @returns {Object}
 */
function resolveProvider(providerId) {
  const id = String(providerId || config.funding.defaultProvider || FUNDING_PROVIDERS.paystack).toLowerCase();
  const adapter = PROVIDERS[id];
  if (!adapter) {
    throw new Error(`Unsupported funding provider: ${id}`);
  }
  return adapter;
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initializePayment(params) {
  const adapter = resolveProvider(params.provider);
  return adapter.initializePayment(params);
}

/**
 * @param {string} provider
 * @param {string} providerReference
 * @returns {Promise<Object>}
 */
async function verifyPayment(provider, providerReference, ctx = {}) {
  const adapter = resolveProvider(provider);
  if (adapter.verifyPayment.length >= 2) {
    return adapter.verifyPayment(providerReference, ctx);
  }
  return adapter.verifyPayment(providerReference);
}

/**
 * @param {string} provider
 * @param {Object} payload
 * @returns {Object|null}
 */
function normalizeWebhook(provider, payload) {
  const adapter = resolveProvider(provider);
  return adapter.normalizeWebhook(payload);
}

/**
 * @param {string} provider
 * @param {import("express").Request} req
 * @param {Buffer|string} rawBody
 * @returns {boolean}
 */
function verifyWebhookSignature(provider, req, rawBody) {
  const adapter = resolveProvider(provider);
  return adapter.verifyWebhookSignature(req, rawBody);
}

/**
 * @returns {string[]}
 */
function listProviders() {
  return Object.keys(PROVIDERS);
}

module.exports = {
  resolveProvider,
  initializePayment,
  verifyPayment,
  normalizeWebhook,
  verifyWebhookSignature,
  listProviders,
  PROVIDERS,
};
