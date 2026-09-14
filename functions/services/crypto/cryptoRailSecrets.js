/**
 * @fileoverview Secret bindings shared by crypto Cloud Functions.
 */

const {defineSecret} = require("firebase-functions/params");
const config = require("../../config");

const circleApiKey = defineSecret(config.secrets.circleApiKey);
const circleEntitySecret = defineSecret(config.secrets.circleEntitySecret);
const turnkeyApiPublicKey = defineSecret(config.secrets.turnkeyApiPublicKey);
const turnkeyApiPrivateKey = defineSecret(config.secrets.turnkeyApiPrivateKey);
const turnkeyOrganizationId = defineSecret(config.secrets.turnkeyOrganizationId);

/**
 * Bind both rails so CRYPTO_RAIL_PROVIDER can switch without a secret-list redeploy.
 * @returns {Array}
 */
function getCryptoFunctionSecrets() {
  return [
    circleApiKey,
    circleEntitySecret,
    turnkeyApiPublicKey,
    turnkeyApiPrivateKey,
    turnkeyOrganizationId,
  ];
}

/**
 * @returns {Array}
 */
function getTurnkeyFunctionSecrets() {
  return [turnkeyApiPublicKey, turnkeyApiPrivateKey, turnkeyOrganizationId];
}

module.exports = {
  circleApiKey,
  circleEntitySecret,
  turnkeyApiPublicKey,
  turnkeyApiPrivateKey,
  turnkeyOrganizationId,
  getCryptoFunctionSecrets,
  getTurnkeyFunctionSecrets,
};
