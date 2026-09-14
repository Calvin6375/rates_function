/**
 * @fileoverview Structured crypto-rail errors. Messages are client-safe.
 */

class CryptoRailError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} [httpStatus]
   */
  constructor(message, code, httpStatus = 400) {
    super(message);
    this.name = "CryptoRailError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const CODES = Object.freeze({
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INSUFFICIENT_GAS: "INSUFFICIENT_GAS",
  INVALID_ADDRESS: "INVALID_ADDRESS",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  UNSUPPORTED_ASSET: "UNSUPPORTED_ASSET",
  UNSUPPORTED_NETWORK: "UNSUPPORTED_NETWORK",
  TURNKEY_SIGNING: "TURNKEY_SIGNING_FAILURE",
  RPC_FAILURE: "RPC_FAILURE",
  BROADCAST_FAILURE: "BROADCAST_FAILURE",
  TX_REVERTED: "TRANSACTION_REVERTED",
  CONFIRMATION_TIMEOUT: "CONFIRMATION_TIMEOUT",
  DUPLICATE_IDEMPOTENCY: "DUPLICATE_IDEMPOTENCY",
  WALLET_PROVISIONING: "WALLET_PROVISIONING_FAILURE",
  WALLET_NOT_FOUND: "WALLET_NOT_FOUND",
  NOT_CONFIGURED: "NOT_CONFIGURED",
});

/**
 * @param {string} available
 * @param {string|number} requested
 * @returns {CryptoRailError}
 */
function insufficientBalance(available, requested) {
  return new CryptoRailError(
      `Insufficient USDC balance. Available: ${available}, requested: ${requested}`,
      CODES.INSUFFICIENT_BALANCE,
      400,
  );
}

/**
 * @returns {CryptoRailError}
 */
function insufficientGas() {
  return new CryptoRailError(
      "Insufficient AVAX gas",
      CODES.INSUFFICIENT_GAS,
      400,
  );
}

/**
 * @returns {CryptoRailError}
 */
function invalidAddress() {
  return new CryptoRailError(
      "Invalid destination address",
      CODES.INVALID_ADDRESS,
      400,
  );
}

/**
 * @returns {CryptoRailError}
 */
function invalidAmount() {
  return new CryptoRailError(
      "Invalid amount",
      CODES.INVALID_AMOUNT,
      400,
  );
}

/**
 * @param {string} asset
 * @returns {CryptoRailError}
 */
function unsupportedAsset(asset) {
  return new CryptoRailError(
      `Unsupported asset: ${asset}`,
      CODES.UNSUPPORTED_ASSET,
      400,
  );
}

/**
 * @param {string} network
 * @returns {CryptoRailError}
 */
function unsupportedNetwork(network) {
  return new CryptoRailError(
      `Unsupported network: ${network}`,
      CODES.UNSUPPORTED_NETWORK,
      400,
  );
}

/**
 * @param {string} detail
 * @returns {CryptoRailError}
 */
function turnkeySigningFailure(detail) {
  return new CryptoRailError(
      `Turnkey signing failure: ${detail}`,
      CODES.TURNKEY_SIGNING,
      500,
  );
}

/**
 * @param {string} detail
 * @returns {CryptoRailError}
 */
function rpcFailure(detail) {
  return new CryptoRailError(
      `RPC failure: ${detail}`,
      CODES.RPC_FAILURE,
      500,
  );
}

/**
 * @param {string} detail
 * @returns {CryptoRailError}
 */
function broadcastFailure(detail) {
  return new CryptoRailError(
      `Transaction broadcast failure: ${detail}`,
      CODES.BROADCAST_FAILURE,
      500,
  );
}

/**
 * @returns {CryptoRailError}
 */
function transactionReverted() {
  return new CryptoRailError(
      "Transaction reverted",
      CODES.TX_REVERTED,
      500,
  );
}

/**
 * @returns {CryptoRailError}
 */
function confirmationTimeout() {
  return new CryptoRailError(
      "Confirmation timeout",
      CODES.CONFIRMATION_TIMEOUT,
      500,
  );
}

/**
 * @returns {CryptoRailError}
 */
function duplicateIdempotency() {
  return new CryptoRailError(
      "Duplicate send request already in progress",
      CODES.DUPLICATE_IDEMPOTENCY,
      409,
  );
}

/**
 * @param {string} detail
 * @returns {CryptoRailError}
 */
function walletProvisioningFailure(detail) {
  return new CryptoRailError(
      `Wallet provisioning failure: ${detail}`,
      CODES.WALLET_PROVISIONING,
      500,
  );
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function publicErrorMessage(err) {
  if (!err) return "Unknown error";
  if (err instanceof CryptoRailError) return err.message;
  const raw = String(err.message || err);
  if (/insufficient usdc/i.test(raw)) return raw;
  if (/insufficient avax/i.test(raw)) return "Insufficient AVAX gas";
  if (/in progress/i.test(raw)) return "Duplicate send request already in progress";
  if (/idempotency/i.test(raw)) return raw;
  if (/invalid destination/i.test(raw) || /invalid address/i.test(raw)) {
    return "Invalid destination address";
  }
  if (/invalid amount/i.test(raw) || /invalid send/i.test(raw)) return raw;
  return raw;
}

module.exports = {
  CryptoRailError,
  CODES,
  insufficientBalance,
  insufficientGas,
  invalidAddress,
  invalidAmount,
  unsupportedAsset,
  unsupportedNetwork,
  turnkeySigningFailure,
  rpcFailure,
  broadcastFailure,
  transactionReverted,
  confirmationTimeout,
  duplicateIdempotency,
  walletProvisioningFailure,
  publicErrorMessage,
};
