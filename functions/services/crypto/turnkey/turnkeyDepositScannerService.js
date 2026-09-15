/**
 * @fileoverview Manual Fuji USDC deposit scanner for known customer addresses.
 * Reuses evmRpcService logs/receipts and chainMonitorService.creditDeposit.
 */

const {collection} = require("../../../libs/firestore");
const evmRpcService = require("../evm/evmRpcService");
const {getFujiNetwork, normalizeAddress} = require("../evm/fujiNetwork");
const {fromUsdcUnits} = require("../evm/usdcUnits");
const chainMonitorService = require("../chainMonitorService");

const ASSET = "USDC";
const PROVIDER = "turnkey";
const SUPPORTED_NETWORK = "avalanche-fuji";
const EXPECTED_CHAIN_ID = 43113;
const MAX_BLOCK_RANGE = 2000;

class DepositScanError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DepositScanError";
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function assertBlockNumber(value, field) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new DepositScanError("INVALID_RANGE", `${field} must be a non-negative integer`);
  }
  return num;
}

/**
 * @param {unknown} fromBlock
 * @param {unknown} toBlock
 * @returns {{ fromBlock: number, toBlock: number }}
 */
function assertBlockRange(fromBlock, toBlock) {
  const from = assertBlockNumber(fromBlock, "fromBlock");
  const to = assertBlockNumber(toBlock, "toBlock");
  if (from > to) {
    throw new DepositScanError("INVALID_RANGE", "fromBlock must be <= toBlock");
  }
  if ((to - from) > MAX_BLOCK_RANGE) {
    throw new DepositScanError(
        "INVALID_RANGE",
        `Block range exceeds ${MAX_BLOCK_RANGE} blocks`,
    );
  }
  return {fromBlock: from, toBlock: to};
}

/**
 * @param {Object} wallet
 * @returns {boolean}
 */
function isLiveFujiUsdcWallet(wallet) {
  if (!wallet || !wallet.userId) return false;
  if (String(wallet.provider || "").toLowerCase() !== PROVIDER) return false;
  if (String(wallet.status || "").toLowerCase() !== "live") return false;
  if (String(wallet.network || "").toLowerCase() !== SUPPORTED_NETWORK) return false;
  if (String(wallet.asset || "").toUpperCase() !== ASSET) return false;
  return true;
}

/**
 * @param {string} address
 * @returns {Promise<{ wallet: Object|null, reason: string|null }>}
 */
async function resolveCustomerWallet(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return {wallet: null, reason: "unknown"};

  const snap = await collection("cryptoWallets")
      .where("addressLower", "==", normalized)
      .get();
  if (snap.empty) return {wallet: null, reason: "unknown"};

  const matches = snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
  const live = matches.filter(isLiveFujiUsdcWallet);
  if (!live.length) return {wallet: null, reason: "inactive"};
  const userIds = new Set(live.map((row) => String(row.userId)));
  if (userIds.size > 1) {
    return {wallet: null, reason: "ambiguous"};
  }
  return {wallet: live[0], reason: null};
}

/**
 * @param {Object} transfer
 * @param {Object|null} receipt
 * @param {Object|null} transaction
 * @param {number} currentBlock
 * @returns {string|null} ignore reason or null if valid
 */
function validateTransfer(transfer, receipt, transaction, currentBlock) {
  const network = getFujiNetwork();
  if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
    return "wrong-network";
  }
  if (transaction && Number(transaction.chainId) !== EXPECTED_CHAIN_ID) {
    return "wrong-network";
  }
  if (!receipt || Number(receipt.status) !== 1) {
    return "failed-tx";
  }
  if (!(transfer.value > 0n) || !(fromUsdcUnits(transfer.value) > 0)) {
    return "zero-amount";
  }
  const head = evmRpcService.confirmedHeadBlock(currentBlock, network.confirmations);
  if (Number(transfer.blockNumber) > head) {
    return "unconfirmed";
  }
  return null;
}

/**
 * @param {Object} log
 * @param {Object} network
 * @returns {boolean}
 */
function isConfiguredUsdcLog(log, network) {
  return normalizeAddress(log.address) === normalizeAddress(network.usdcContract);
}

/**
 * @param {Object} [input]
 */
function assertSupportedScanTarget(input = {}) {
  if (input.network && String(input.network).toLowerCase() !== SUPPORTED_NETWORK) {
    throw new DepositScanError("WRONG_NETWORK", "Scanner only supports Avalanche Fuji");
  }
  if (input.asset && String(input.asset).toUpperCase() !== ASSET) {
    throw new DepositScanError("WRONG_ASSET", "Scanner only supports USDC");
  }
}

/**
 * @param {{ fromBlock: unknown, toBlock: unknown, network?: unknown, asset?: unknown }} range
 * @returns {Promise<Object>}
 */
async function scanUsdcDeposits(range) {
  assertSupportedScanTarget(range);
  const {fromBlock, toBlock} = assertBlockRange(range.fromBlock, range.toBlock);
  const network = getFujiNetwork();
  if (Number(network.chainId) !== EXPECTED_CHAIN_ID || network.network !== SUPPORTED_NETWORK) {
    throw new DepositScanError("WRONG_NETWORK", "Scanner only supports Avalanche Fuji");
  }

  const currentBlock = await evmRpcService.getBlockNumber();
  const toAddress = range.toAddress ? normalizeAddress(range.toAddress) : null;
  const logs = await evmRpcService.getUsdcTransferLogs(fromBlock, toBlock, toAddress || undefined);
  const receiptCache = new Map();
  const txCache = new Map();

  let scannedEvents = 0;
  let matchedDeposits = 0;
  let creditedDeposits = 0;
  let alreadyProcessed = 0;
  let ignoredEvents = 0;
  const credits = [];

  for (const log of logs) {
    scannedEvents += 1;
    if (!isConfiguredUsdcLog(log, network)) {
      ignoredEvents += 1;
      continue;
    }
    const transfer = evmRpcService.parseUsdcTransferLog(log);
    if (!transfer) {
      ignoredEvents += 1;
      continue;
    }
    transfer.txHash = String(transfer.txHash || "").toLowerCase();
    if (toAddress && transfer.to !== toAddress) {
      ignoredEvents += 1;
      continue;
    }

    const txHash = transfer.txHash;
    if (!receiptCache.has(txHash)) {
      receiptCache.set(txHash, await evmRpcService.getTransactionReceipt(txHash));
    }
    if (!txCache.has(txHash)) {
      txCache.set(txHash, await evmRpcService.getTransaction(txHash));
    }
    const reason = validateTransfer(
        transfer,
        receiptCache.get(txHash),
        txCache.get(txHash),
        currentBlock,
    );
    if (reason) {
      ignoredEvents += 1;
      continue;
    }

    const resolved = await resolveCustomerWallet(transfer.to);
    if (!resolved.wallet) {
      ignoredEvents += 1;
      continue;
    }
    matchedDeposits += 1;

    const result = await chainMonitorService.creditDeposit(transfer, resolved.wallet);
    if (result.credited || result.duplicate) {
      credits.push({
        userId: resolved.wallet.userId,
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
        amount: fromUsdcUnits(transfer.value),
        credited: !!result.credited,
        alreadyProcessed: !!result.duplicate,
      });
    }
    if (result.credited) {
      creditedDeposits += 1;
    } else if (result.duplicate) {
      alreadyProcessed += 1;
    } else {
      ignoredEvents += 1;
    }
  }

  return {
    success: true,
    network: SUPPORTED_NETWORK,
    asset: ASSET,
    fromBlock,
    toBlock,
    scannedEvents,
    matchedDeposits,
    creditedDeposits,
    alreadyProcessed,
    ignoredEvents,
    credits,
  };
}

/**
 * Targeted recent-block scan for one customer address. Does not move the global cursor.
 * @param {string} toAddress
 * @param {number} [lookbackBlocks]
 * @returns {Promise<Object>}
 */
async function scanRecentUsdcDepositsForAddress(toAddress, lookbackBlocks = 80) {
  const currentBlock = await evmRpcService.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - Math.max(1, Number(lookbackBlocks) || 80));
  return scanUsdcDeposits({
    fromBlock,
    toBlock: currentBlock,
    toAddress,
    network: SUPPORTED_NETWORK,
    asset: ASSET,
  });
}

module.exports = {
  ASSET,
  SUPPORTED_NETWORK,
  EXPECTED_CHAIN_ID,
  MAX_BLOCK_RANGE,
  DepositScanError,
  assertBlockRange,
  assertSupportedScanTarget,
  isLiveFujiUsdcWallet,
  resolveCustomerWallet,
  validateTransfer,
  scanUsdcDeposits,
  scanRecentUsdcDepositsForAddress,
};
