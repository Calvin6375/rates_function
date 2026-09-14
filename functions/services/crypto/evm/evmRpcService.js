/**
 * @fileoverview Avalanche Fuji JSON-RPC helpers (balances, gas, broadcast, logs).
 * Blockchain reads here are for gas, deposit detection, and reconciliation —
 * never for customer-facing ledger balances.
 */

const {ethers, Interface} = require("ethers");
const Decimal = require("decimal.js");
const {
  ERC20_TRANSFER_ABI,
  TRANSFER_EVENT_TOPIC,
  getFujiNetwork,
  isValidEvmAddress,
  normalizeAddress,
} = require("./fujiNetwork");
const {fromUsdcUnits} = require("./usdcUnits");
const {
  rpcFailure,
  broadcastFailure,
  insufficientGas,
  invalidAddress,
} = require("../cryptoErrors");

/** @type {import("ethers").JsonRpcProvider|null} */
let providerOverride = null;

/** @type {import("ethers").JsonRpcProvider|null} */
let cachedProvider = null;

const usdcInterface = new Interface(ERC20_TRANSFER_ABI);

const ERC20_TRANSFER_GAS_FALLBACK = 65000n;
const NATIVE_TRANSFER_GAS_FALLBACK = 21000n;
const GAS_LIMIT_BUFFER_BPS = 12000n; // 1.20x

/**
 * @param {import("ethers").JsonRpcProvider|null} provider
 */
function setProviderForTests(provider) {
  providerOverride = provider;
  cachedProvider = null;
}

/**
 * @returns {import("ethers").JsonRpcProvider}
 */
function getProvider() {
  if (providerOverride) return providerOverride;
  if (!cachedProvider) {
    const network = getFujiNetwork();
    cachedProvider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId);
  }
  return cachedProvider;
}

/**
 * @returns {void}
 */
function resetProvider() {
  cachedProvider = null;
}

/**
 * @param {string} address
 * @returns {Promise<{ avaxWei: bigint, avax: string, usdcUnits: bigint, usdc: number }>}
 */
async function getOnChainBalances(address) {
  if (!isValidEvmAddress(address)) {
    throw invalidAddress();
  }
  const network = getFujiNetwork();
  const provider = getProvider();
  try {
    const [avaxWei, usdcUnits] = await Promise.all([
      provider.getBalance(address),
      getUsdcBalanceUnits(address),
    ]);
    return {
      avaxWei,
      avax: ethers.formatEther(avaxWei),
      usdcUnits,
      usdc: fromUsdcUnits(usdcUnits),
      asset: network.nativeToken === "AVAX" ? "AVAX" : network.nativeToken,
      usdcContract: network.usdcContract,
    };
  } catch (err) {
    if (err.code === "INVALID_ADDRESS") throw err;
    throw rpcFailure(err.message || "balance read failed");
  }
}

/**
 * @param {string|bigint|number} raw
 * @param {number} decimals
 * @returns {string}
 */
function formatTokenBalance(raw, decimals) {
  const places = Number(decimals);
  const value = new Decimal(String(raw)).div(new Decimal(10).pow(places));
  if (!value.isFinite()) {
    throw new Error("Invalid token amount");
  }
  if (value.isZero()) return "0";
  return value.toFixed(places);
}

/**
 * Read-only ERC-20 balanceOf + decimals. Does not send a transaction.
 * @param {string} tokenAddress
 * @param {string} holderAddress
 * @returns {Promise<{ raw: string, decimals: number, balance: string }>}
 */
async function getErc20Balance(tokenAddress, holderAddress) {
  if (!isValidEvmAddress(tokenAddress) || !isValidEvmAddress(holderAddress)) {
    throw invalidAddress();
  }
  const provider = getProvider();
  try {
    const [rawResult, decimalsResult] = await Promise.all([
      provider.call({
        to: tokenAddress,
        data: usdcInterface.encodeFunctionData("balanceOf", [holderAddress]),
      }),
      provider.call({
        to: tokenAddress,
        data: usdcInterface.encodeFunctionData("decimals", []),
      }),
    ]);
    const [rawUnits] = usdcInterface.decodeFunctionResult("balanceOf", rawResult);
    const [decimalsRaw] = usdcInterface.decodeFunctionResult("decimals", decimalsResult);
    const raw = BigInt(rawUnits).toString();
    const decimals = Number(decimalsRaw);
    return {
      raw,
      decimals,
      balance: formatTokenBalance(raw, decimals),
    };
  } catch (err) {
    if (err && err.code === "INVALID_ADDRESS") throw err;
    throw rpcFailure(err.message || "ERC-20 balance read failed");
  }
}

/**
 * @param {string} address
 * @returns {Promise<bigint>}
 */
async function getUsdcBalanceUnits(address) {
  const network = getFujiNetwork();
  const provider = getProvider();
  const data = usdcInterface.encodeFunctionData("balanceOf", [address]);
  try {
    const result = await provider.call({
      to: network.usdcContract,
      data,
    });
    const [units] = usdcInterface.decodeFunctionResult("balanceOf", result);
    return BigInt(units);
  } catch (err) {
    throw rpcFailure(err.message || "USDC balanceOf failed");
  }
}

/**
 * @param {string} address
 * @returns {Promise<bigint>}
 */
async function getAvaxBalanceWei(address) {
  try {
    return await getProvider().getBalance(address);
  } catch (err) {
    throw rpcFailure(err.message || "AVAX balance failed");
  }
}

/**
 * @returns {Promise<number>}
 */
async function getBlockNumber() {
  try {
    return await getProvider().getBlockNumber();
  } catch (err) {
    throw rpcFailure(err.message || "getBlockNumber failed");
  }
}

/**
 * @param {string} txHash
 * @returns {Promise<import("ethers").TransactionReceipt|null>}
 */
async function getTransactionReceipt(txHash) {
  try {
    return await getProvider().getTransactionReceipt(txHash);
  } catch (err) {
    throw rpcFailure(err.message || "getTransactionReceipt failed");
  }
}

/**
 * @param {string} txHash
 * @returns {Promise<import("ethers").TransactionResponse|null>}
 */
async function getTransaction(txHash) {
  try {
    return await getProvider().getTransaction(txHash);
  } catch (err) {
    throw rpcFailure(err.message || "getTransaction failed");
  }
}

/**
 * @param {string} txHash
 * @returns {Promise<{ status: string, confirmations: number, receipt: Object|null }>}
 */
async function getTransactionStatus(txHash) {
  const receipt = await getTransactionReceipt(txHash);
  if (!receipt) {
    return {status: "pending", confirmations: 0, receipt: null};
  }
  const current = await getBlockNumber();
  const confirmations = Math.max(0, current - Number(receipt.blockNumber) + 1);
  if (receipt.status === 0) {
    return {status: "failed", confirmations, receipt};
  }
  const required = getFujiNetwork().confirmations;
  return {
    status: confirmations >= required ? "complete" : "pending",
    confirmations,
    receipt,
  };
}

/**
 * @param {Object} txRequest
 * @returns {Promise<bigint>}
 */
async function estimateGas(txRequest) {
  try {
    const estimated = await getProvider().estimateGas(txRequest);
    const buffered = (estimated * GAS_LIMIT_BUFFER_BPS) / 10000n;
    return buffered;
  } catch (err) {
    const isNative = !txRequest.data || txRequest.data === "0x";
    return isNative ? NATIVE_TRANSFER_GAS_FALLBACK : ERC20_TRANSFER_GAS_FALLBACK;
  }
}

/**
 * @returns {Promise<{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint }>}
 */
async function getFeeData() {
  try {
    const fee = await getProvider().getFeeData();
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas || 25_000_000_000n;
    const maxFeePerGas = fee.maxFeePerGas || (maxPriorityFeePerGas * 2n);
    return {maxFeePerGas, maxPriorityFeePerGas};
  } catch (err) {
    throw rpcFailure(err.message || "getFeeData failed");
  }
}

/**
 * @param {string} address
 * @returns {Promise<number>}
 */
async function getTransactionCount(address) {
  try {
    return await getProvider().getTransactionCount(address, "pending");
  } catch (err) {
    throw rpcFailure(err.message || "getTransactionCount failed");
  }
}

/**
 * @param {string} from
 * @param {bigint} gasLimit
 * @param {bigint} maxFeePerGas
 */
async function assertSufficientGas(from, gasLimit, maxFeePerGas) {
  const balance = await getAvaxBalanceWei(from);
  const cost = gasLimit * maxFeePerGas;
  if (balance < cost) {
    throw insufficientGas();
  }
}

/**
 * @param {string} signedTx
 * @returns {Promise<string>}
 */
async function broadcastTransaction(signedTx) {
  const hex = signedTx.startsWith("0x") ? signedTx : `0x${signedTx}`;
  try {
    const response = await getProvider().broadcastTransaction(hex);
    return response.hash;
  } catch (err) {
    throw broadcastFailure(err.message || "broadcast failed");
  }
}

/**
 * @param {number} fromBlock
 * @param {number} toBlock
 * @returns {Promise<Array<Object>>}
 */
async function getUsdcTransferLogs(fromBlock, toBlock) {
  const network = getFujiNetwork();
  try {
    return await getProvider().getLogs({
      address: network.usdcContract,
      fromBlock,
      toBlock,
      topics: [TRANSFER_EVENT_TOPIC],
    });
  } catch (err) {
    throw rpcFailure(err.message || "getLogs failed");
  }
}

/**
 * @param {Object} log
 * @returns {{ from: string, to: string, value: bigint, txHash: string, logIndex: number, blockNumber: number }|null}
 */
function parseUsdcTransferLog(log) {
  try {
    const parsed = usdcInterface.parseLog({
      topics: log.topics,
      data: log.data,
    });
    if (!parsed || parsed.name !== "Transfer") return null;
    return {
      from: normalizeAddress(parsed.args.from),
      to: normalizeAddress(parsed.args.to),
      value: BigInt(parsed.args.value),
      txHash: String(log.transactionHash || ""),
      logIndex: Number(log.index ?? log.logIndex ?? 0),
      blockNumber: Number(log.blockNumber),
    };
  } catch (_err) {
    return null;
  }
}

/**
 * @param {string} to
 * @param {bigint} amountUnits
 * @returns {string}
 */
function encodeUsdcTransfer(to, amountUnits) {
  return usdcInterface.encodeFunctionData("transfer", [to, amountUnits]);
}

/**
 * @param {Object} fields
 * @returns {string}
 */
function serializeUnsignedTransaction(fields) {
  const tx = ethers.Transaction.from({
    type: 2,
    chainId: fields.chainId,
    nonce: fields.nonce,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    maxFeePerGas: fields.maxFeePerGas,
    gasLimit: fields.gasLimit,
    to: fields.to,
    value: fields.value || 0n,
    data: fields.data || "0x",
  });
  return tx.unsignedSerialized;
}

/**
 * Highest block that has met the confirmation requirement.
 * @param {number} currentBlock
 * @param {number} confirmations
 * @returns {number}
 */
function confirmedHeadBlock(currentBlock, confirmations) {
  return currentBlock - Math.max(1, confirmations) + 1;
}

module.exports = {
  setProviderForTests,
  getProvider,
  resetProvider,
  getOnChainBalances,
  formatTokenBalance,
  getErc20Balance,
  getUsdcBalanceUnits,
  getAvaxBalanceWei,
  getBlockNumber,
  getTransactionReceipt,
  getTransaction,
  getTransactionStatus,
  estimateGas,
  getFeeData,
  getTransactionCount,
  assertSufficientGas,
  broadcastTransaction,
  getUsdcTransferLogs,
  parseUsdcTransferLog,
  encodeUsdcTransfer,
  serializeUnsignedTransaction,
  confirmedHeadBlock,
};
