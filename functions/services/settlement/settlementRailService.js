/**
 * @fileoverview Settlement rail router — mirrors fundingRailService.
 */

const config = require("../../config");
const { registerSettlementProviders, resolveFromRegistry } = require("./settlementProviderInterface");
const darajaRail = require("./darajaRail");
const { SETTLEMENT_RAILS } = require("../../utils/fundingTypes");

/** @type {Record<string, Object>} */
const RAILS = registerSettlementProviders({
  [SETTLEMENT_RAILS.daraja_b2b]: darajaRail,
});

/**
 * @param {string} [railId]
 * @returns {Object}
 */
function resolveSettlementRail(railId) {
  return resolveFromRegistry(
      railId || SETTLEMENT_RAILS.daraja_b2b,
      RAILS,
  );
}

/**
 * @returns {string[]}
 */
function listSettlementRails() {
  return Object.keys(RAILS);
}

module.exports = {
  resolveSettlementRail,
  listSettlementRails,
  RAILS,
};
