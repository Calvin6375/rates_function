/**
 * @fileoverview Settlement provider registry — mirrors fundingProviderInterface.
 */

const { SETTLEMENT_RAILS } = require("../../utils/fundingTypes");

/**
 * @param {Record<string, Object>} adapters
 * @returns {Record<string, Object>}
 */
function registerSettlementProviders(adapters) {
  const registered = {};
  for (const [id, adapter] of Object.entries(adapters || {})) {
    if (!adapter || typeof adapter.initiateB2BPayment !== "function") {
      throw new Error(`Invalid settlement adapter: ${id}`);
    }
    registered[String(id).toLowerCase()] = adapter;
  }
  return registered;
}

/**
 * @param {string} railId
 * @param {Record<string, Object>} registry
 * @returns {Object}
 */
function resolveFromRegistry(railId, registry) {
  const id = String(railId || SETTLEMENT_RAILS.daraja_b2b).toLowerCase();
  const adapter = registry[id];
  if (!adapter) {
    throw new Error(`Unsupported settlement rail: ${id}`);
  }
  return adapter;
}

module.exports = {
  registerSettlementProviders,
  resolveFromRegistry,
};
