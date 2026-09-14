/**
 * @fileoverview Dev-only Fuji USDC deposit processor. Validates a tx hash
 * against the configured Avalanche Fuji USDC/treasury addresses and credits
 * the built-in super-admin via the existing crypto ledger.
 */

const admin = require("../../admin");
const {collection, serverTimestamp} = require("../../libs/firestore");
const ledgerService = require("../ledger/ledgerService");
const evmRpcService = require("./evm/evmRpcService");
const {getFujiNetwork, normalizeAddress, isValidEvmAddress} = require("./evm/fujiNetwork");
const {fromUsdcUnits} = require("./evm/usdcUnits");
const {SUPER_ADMIN_EMAIL} = require("../../utils/accessControl");
const {createLogger} = require("../../utils/paymentOpsLogger");

const logger = createLogger({service: "testProcessUsdcDeposit"});

const ASSET = "USDC";
const PROVIDER = "turnkey";
const EXPECTED_CHAIN_ID = 43113;

class DepositValidationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DepositValidationError";
    this.code = code;
  }
}

/**
 * @param {unknown} txHash
 * @returns {string}
 */
function normalizeTxHash(txHash) {
  const value = String(txHash || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(value)) {
    throw new DepositValidationError("INVALID_TX_HASH", "Invalid transaction hash");
  }
  return value;
}

/**
 * @returns {Promise<{ uid: string }>}
 */
async function resolveBuiltInSuperAdmin() {
  try {
    const user = await admin.auth().getUserByEmail(SUPER_ADMIN_EMAIL);
    if (!user || !user.uid) {
      throw new Error("missing uid");
    }
    return {uid: user.uid};
  } catch (_err) {
    throw new DepositValidationError(
        "SUPER_ADMIN_NOT_FOUND",
        "Built-in super-admin account was not found",
    );
  }
}

/**
 * @param {{ transaction: Object|null, receipt: Object|null }} input
 * @returns {{
 *   txHash: string,
 *   logIndex: number,
 *   from: string,
 *   to: string,
 *   raw: string,
 *   amount: number,
 *   network: string,
 *   chainId: number,
 *   token: string,
 * }}
 */
function validateFujiUsdcDeposit({transaction, receipt}) {
  const network = getFujiNetwork();
  if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
    throw new DepositValidationError("WRONG_CHAIN", "Configured chain is not Avalanche Fuji");
  }
  if (!transaction) {
    throw new DepositValidationError("TX_NOT_FOUND", "Transaction was not found");
  }
  if (!receipt) {
    throw new DepositValidationError("RECEIPT_NOT_FOUND", "Transaction receipt was not found");
  }

  const chainId = Number(transaction.chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new DepositValidationError("WRONG_CHAIN", "Transaction is not on Avalanche Fuji");
  }
  if (Number(receipt.status) !== 1) {
    throw new DepositValidationError("TX_FAILED", "Transaction failed");
  }

  const expectedToken = normalizeAddress(network.usdcContract);
  const expectedRecipient = normalizeAddress(network.treasuryAddress);
  const transfers = [];
  for (const log of receipt.logs || []) {
    if (normalizeAddress(log.address) !== expectedToken) {
      continue;
    }
    const parsed = evmRpcService.parseUsdcTransferLog(log);
    if (parsed) transfers.push(parsed);
  }

  if (!transfers.length) {
    const anyTransfer = (receipt.logs || []).some((log) => evmRpcService.parseUsdcTransferLog(log));
    if (anyTransfer) {
      throw new DepositValidationError("WRONG_TOKEN", "Transfer is not from the configured USDC contract");
    }
    throw new DepositValidationError("TRANSFER_NOT_FOUND", "USDC Transfer event was not found");
  }

  const match = transfers.find((row) => row.to === expectedRecipient);
  if (!match) {
    throw new DepositValidationError("WRONG_RECIPIENT", "Transfer recipient is not the treasury address");
  }
  if (!(match.value > 0n)) {
    throw new DepositValidationError("INVALID_AMOUNT", "Transfer amount must be greater than zero");
  }

  const amount = fromUsdcUnits(match.value);
  if (!(amount > 0)) {
    throw new DepositValidationError("INVALID_AMOUNT", "Converted USDC amount must be greater than zero");
  }

  return {
    txHash: String(match.txHash || transaction.hash || "").toLowerCase(),
    logIndex: Number(match.logIndex),
    from: match.from,
    to: match.to,
    raw: match.value.toString(),
    amount,
    network: network.network,
    chainId: EXPECTED_CHAIN_ID,
    token: ASSET,
  };
}

/**
 * @param {Object} validated
 * @param {string} userId
 * @param {string} referenceId
 */
async function recordCryptoTransaction(validated, userId, referenceId) {
  const existingTx = await collection("cryptoTransactions")
      .where("providerTransactionId", "==", referenceId)
      .limit(1)
      .get();
  if (!existingTx.empty) return;

  await collection("cryptoTransactions").add({
    userId,
    circleTransactionId: validated.txHash,
    providerTransactionId: referenceId,
    txHash: validated.txHash,
    logIndex: validated.logIndex,
    type: "deposit",
    amount: validated.amount,
    asset: ASSET,
    status: "complete",
    toAddress: validated.to,
    fromAddress: validated.from,
    provider: PROVIDER,
    network: validated.network,
    chainId: validated.chainId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * @param {unknown} txHash
 * @param {{ userId?: string }} [options]
 * @returns {Promise<Object>}
 */
async function testProcessUsdcDeposit(txHash, options = {}) {
  const hash = normalizeTxHash(txHash);
  logger.info("Fuji USDC deposit test started");

  const [transaction, receipt] = await Promise.all([
    evmRpcService.getTransaction(hash),
    evmRpcService.getTransactionReceipt(hash),
  ]);
  const validated = validateFujiUsdcDeposit({transaction, receipt});
  if (!isValidEvmAddress(validated.to)) {
    throw new DepositValidationError("WRONG_RECIPIENT", "Transfer recipient is not the treasury address");
  }

  const superAdmin = options.userId ?
    {uid: options.userId} :
    await resolveBuiltInSuperAdmin();
  const referenceId = `${validated.txHash}_${validated.logIndex}`;

  if (await ledgerService.hasLedgerEntry(referenceId)) {
    const balance = await ledgerService.getLedgerBalance(superAdmin.uid, ASSET);
    logger.info("Fuji USDC deposit already processed", {referenceId});
    return {
      success: true,
      alreadyProcessed: true,
      credited: false,
      txHash: validated.txHash,
      network: validated.network,
      token: validated.token,
      amount: validated.amount,
      recipient: validated.to,
      userId: superAdmin.uid,
      role: "super_admin",
      referenceId,
      balance,
    };
  }

  const appended = await ledgerService.appendTransaction({
    userId: superAdmin.uid,
    type: "deposit",
    asset: ASSET,
    amount: validated.amount,
    direction: "credit",
    source: PROVIDER,
    referenceId,
  });

  if (appended.duplicate) {
    return {
      success: true,
      alreadyProcessed: true,
      credited: false,
      txHash: validated.txHash,
      network: validated.network,
      token: validated.token,
      amount: validated.amount,
      recipient: validated.to,
      userId: superAdmin.uid,
      role: "super_admin",
      referenceId,
      entryId: appended.entryId,
      balance: appended.newBalance,
    };
  }

  await recordCryptoTransaction(validated, superAdmin.uid, referenceId);
  logger.info("Fuji USDC deposit credited", {
    referenceId,
    amount: validated.amount,
  });

  return {
    success: true,
    alreadyProcessed: false,
    credited: true,
    txHash: validated.txHash,
    network: validated.network,
    token: validated.token,
    amount: validated.amount,
    recipient: validated.to,
    userId: superAdmin.uid,
    role: "super_admin",
    referenceId,
    entryId: appended.entryId,
    balance: appended.newBalance,
  };
}

module.exports = {
  EXPECTED_CHAIN_ID,
  DepositValidationError,
  normalizeTxHash,
  validateFujiUsdcDeposit,
  resolveBuiltInSuperAdmin,
  testProcessUsdcDeposit,
};
