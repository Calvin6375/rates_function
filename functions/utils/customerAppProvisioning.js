/**
 * @fileoverview Optional Institution + Channel for C2B customer tagging.
 */

const INSTITUTION_CUSTOMER_APP = "Customer App";
const CHANNEL_C2B = "C2B";

/**
 * Parse optional Customer App / C2B tagging (PascalCase or camelCase JSON).
 *
 * @param {Object|null|undefined} body
 * @return {Object|null} institution+channel, or null if both omitted
 */
function parseCustomerAppProvisioningFields(body) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const rawInst =
      body.Institution !== undefined ? body.Institution : body.institution;
  const rawCh = body.Channel !== undefined ? body.Channel : body.channel;
  const hasInst =
    rawInst !== undefined && rawInst !== null && String(rawInst).trim() !== "";
  const hasCh =
    rawCh !== undefined && rawCh !== null && String(rawCh).trim() !== "";
  if (!hasInst && !hasCh) {
    return null;
  }
  if (hasInst !== hasCh) {
    throw new Error("Institution and Channel must both be provided together");
  }
  const institution = String(rawInst).trim();
  const channel = String(rawCh).trim();
  if (institution !== INSTITUTION_CUSTOMER_APP) {
    const want = INSTITUTION_CUSTOMER_APP;
    throw new Error(`Invalid Institution "${institution}" (expected ${want})`);
  }
  if (channel !== CHANNEL_C2B) {
    throw new Error(`Invalid Channel "${channel}" (expected ${CHANNEL_C2B})`);
  }
  return {institution, channel};
}

module.exports = {
  INSTITUTION_CUSTOMER_APP,
  CHANNEL_C2B,
  parseCustomerAppProvisioningFields,
};
