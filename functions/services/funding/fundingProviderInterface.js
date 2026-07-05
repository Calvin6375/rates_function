/**
 * @fileoverview Funding Provider interface contract.
 *
 * Every external funding source (Paystack, IntaSend, Transak, Bridge, Stripe, …)
 * implements this interface. Wallet, ledger, settlement, and API layers must never
 * import provider-specific modules — they call fundingRailService only.
 *
 * Required methods:
 *   - providerId: string
 *   - initializePayment(params) → InitializePaymentResult
 *   - verifyPayment(providerReference) → NormalizedFundingEvent
 *   - normalizeWebhook(payload) → NormalizedFundingEvent | null
 *   - verifyWebhookSignature(req, rawBody) → boolean
 *
 * Optional:
 *   - refundPayment(params) → { success, refundId }
 */

const { FUNDING_PROVIDERS } = require("../../utils/fundingTypes");

/** @type {readonly string[]} */
const REQUIRED_METHODS = Object.freeze([
  "initializePayment",
  "verifyPayment",
  "normalizeWebhook",
  "verifyWebhookSignature",
]);

/**
 * Validate that an adapter implements the Funding Provider interface.
 * @param {Object} adapter
 * @param {string} expectedProviderId
 * @returns {void}
 */
function assertFundingProvider(adapter, expectedProviderId) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error(`Funding provider "${expectedProviderId}" adapter is missing`);
  }
  if (adapter.providerId !== expectedProviderId) {
    throw new Error(
        `Funding provider id mismatch: expected ${expectedProviderId}, got ${adapter.providerId}`,
    );
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(
          `Funding provider "${expectedProviderId}" missing required method: ${method}`,
      );
    }
  }
}

/**
 * @param {Record<string, Object>} registry
 * @returns {Record<string, Object>}
 */
function registerFundingProviders(registry) {
  const validated = {};
  for (const [id, adapter] of Object.entries(registry)) {
    if (!Object.values(FUNDING_PROVIDERS).includes(id) && id !== adapter.providerId) {
      // allow future providers not yet in enum if adapter declares providerId
    }
    assertFundingProvider(adapter, adapter.providerId || id);
    validated[id] = adapter;
  }
  return validated;
}

module.exports = {
  REQUIRED_METHODS,
  assertFundingProvider,
  registerFundingProviders,
};
