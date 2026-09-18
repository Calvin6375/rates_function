/**
 * @fileoverview Sweep credited customer USDC to the company treasury.
 * Mainnet Avalanche only. Fuji / testnet wallets are never swept.
 * Does not debit or credit the user ledger. Off-ramp spends from treasury.
 */

const {ethers} = require("ethers");
const {collection, serverTimestamp} = require("../../libs/firestore");
const evmRpcService = require("./evm/evmRpcService");
const {
  getNetworkConfig,
  normalizeNetworkName,
  isMainnetNetwork,
  MAINNET_NETWORK,
} = require("./evm/networkConfig");
const {isValidEvmAddress, normalizeAddress} = require("./evm/fujiNetwork");
const {fromUsdcUnits, toUsdcUnits} = require("./evm/usdcUnits");
const {CODES} = require("./cryptoErrors");

const COLLECTION = "cryptoSweeps";
const ASSET = "USDC";
const PROVIDER = "turnkey";
const STATUS = Object.freeze({
  pending: "pending",
  complete: "complete",
  failed: "failed",
});
const GAS_TOPUP_WEI = ethers.parseEther("0.05");
const MAX_PER_RUN = 10;
const MAX_OUTSTANDING_WALLETS = 500;

/**
 * @param {string} [networkName]
 * @returns {string}
 */
function getTreasuryAddress(networkName) {
  const network = getNetworkConfig(networkName);
  if (!isValidEvmAddress(network.treasuryAddress)) {
    throw new Error("Treasury address is not configured");
  }
  return ethers.getAddress(network.treasuryAddress);
}

/**
 * @param {string} networkName
 * @param {string} referenceId
 * @returns {string}
 */
function sweepDocId(networkName, referenceId) {
  const cleaned = String(referenceId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${normalizeNetworkName(networkName)}_${cleaned}`.slice(0, 150);
}

/**
 * @param {Object} params
 * @returns {Promise<{ unsignedHex: string, gasLimit: bigint, maxFeePerGas: bigint }>}
 */
async function signAndBroadcast(params) {
  const adapter = require("./providers/turnkeyRailAdapter");
  return adapter.signAndBroadcast(params);
}

/**
 * @param {Object} params
 * @returns {Promise<{ enqueued: boolean, sweepId?: string, reason?: string }>}
 */
async function enqueueSweepAfterCredit(params = {}) {
  if (!isMainnetNetwork(params.network)) {
    return {enqueued: false, reason: "testnet"};
  }
  const networkName = MAINNET_NETWORK;
  const fromAddress = String(params.fromAddress || "");
  if (!isValidEvmAddress(fromAddress)) {
    return {enqueued: false, reason: "invalid-from"};
  }
  const treasury = getTreasuryAddress(networkName);
  if (normalizeAddress(fromAddress) === normalizeAddress(treasury)) {
    return {enqueued: false, reason: "already-treasury"};
  }
  const referenceId = String(params.depositReferenceId || "").trim();
  if (!referenceId) {
    return {enqueued: false, reason: "missing-reference"};
  }

  const id = sweepDocId(networkName, referenceId);
  const ref = collection(COLLECTION).doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    const status = String(existing.data().status || "");
    if (status === STATUS.complete) {
      return {enqueued: false, reason: "already-swept", sweepId: id};
    }
    if (status === STATUS.pending) {
      return {enqueued: false, reason: "already-pending", sweepId: id};
    }
  }

  await ref.set({
    status: STATUS.pending,
    type: params.type || "deposit",
    userId: params.userId || null,
    fromAddress: ethers.getAddress(fromAddress),
    toAddress: treasury,
    amount: params.amount,
    asset: ASSET,
    provider: PROVIDER,
    network: networkName,
    chainId: getNetworkConfig(networkName).chainId,
    depositReferenceId: referenceId,
    depositTxHash: params.depositTxHash || null,
    sweepTxHash: null,
    gasTxHash: null,
    lastError: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, {merge: true});
  return {enqueued: true, sweepId: id};
}

/**
 * Catch leftover customer USDC that was credited before sweep enqueue existed.
 * @param {string} [networkName]
 * @returns {Promise<{ enqueued: number }>}
 */
async function enqueueOutstandingSweeps(networkName = MAINNET_NETWORK) {
  if (!isMainnetNetwork(networkName)) {
    return {enqueued: 0, checked: 0, skipped: 0, reason: "testnet"};
  }
  const resolved = MAINNET_NETWORK;
  const network = getNetworkConfig(resolved);
  const treasury = getTreasuryAddress(resolved);
  const snap = await collection("cryptoWallets")
      .where("provider", "==", PROVIDER)
      .limit(MAX_OUTSTANDING_WALLETS)
      .get();

  let enqueued = 0;
  let checked = 0;
  let skipped = 0;
  for (const doc of snap.docs) {
    const wallet = doc.data() || {};
    if (normalizeNetworkName(wallet.network || "avalanche-fuji") !== resolved) {
      skipped += 1;
      continue;
    }
    if (String(wallet.status || "").toLowerCase() !== "live") {
      skipped += 1;
      continue;
    }
    if (String(wallet.asset || ASSET).toUpperCase() !== ASSET) {
      skipped += 1;
      continue;
    }
    if (!isValidEvmAddress(wallet.address)) {
      skipped += 1;
      continue;
    }
    if (normalizeAddress(wallet.address) === normalizeAddress(treasury)) {
      skipped += 1;
      continue;
    }

    checked += 1;
    const token = await evmRpcService.getErc20Balance(
        network.usdcContract,
        wallet.address,
        resolved,
    );
    if (BigInt(token.raw) <= 0n) continue;

    const result = await enqueueSweepAfterCredit({
      type: "outstanding",
      userId: wallet.userId,
      fromAddress: wallet.address,
      amount: fromUsdcUnits(token.raw),
      network: resolved,
      depositReferenceId: `outstanding_${normalizeAddress(wallet.address)}_${token.raw}`,
    });
    if (result.enqueued) enqueued += 1;
  }
  console.log("Outstanding sweep scan", {
    network: resolved,
    wallets: snap.size || snap.docs.length,
    checked,
    skipped,
    enqueued,
  });
  return {enqueued, checked, skipped};
}

/**
 * @param {string} fromAddress
 * @param {string} networkName
 * @returns {Promise<string|null>}
 */
async function fundCustomerGasIfNeeded(fromAddress, networkName) {
  const network = getNetworkConfig(networkName);
  const treasury = getTreasuryAddress(networkName);
  const fee = await evmRpcService.getFeeData(networkName);
  const sampleData = evmRpcService.encodeUsdcTransfer(treasury, 1n);
  const gasLimit = await evmRpcService.estimateGas({
    from: fromAddress,
    to: network.usdcContract,
    data: sampleData,
    value: 0n,
  }, networkName);
  const needed = gasLimit * fee.maxFeePerGas * 2n;
  const customerWei = await evmRpcService.getAvaxBalanceWei(fromAddress, networkName);
  if (customerWei >= needed) return null;

  const treasuryWei = await evmRpcService.getAvaxBalanceWei(treasury, networkName);
  const topup = GAS_TOPUP_WEI > needed ? GAS_TOPUP_WEI : needed * 2n;
  if (treasuryWei < topup) {
    const err = new Error("Treasury has insufficient AVAX to fund sweep gas");
    err.code = CODES.INSUFFICIENT_GAS;
    throw err;
  }

  return signAndBroadcast({
    fromAddress: treasury,
    toAddress: fromAddress,
    amount: ethers.formatEther(topup),
    asset: "AVAX",
    network: networkName,
  });
}

/**
 * @param {Object} sweep
 * @param {import("firebase-admin").firestore.DocumentReference} ref
 * @returns {Promise<{ swept: boolean, reason?: string, txHash?: string }>}
 */
async function processOneSweep(sweep, ref) {
  const networkName = normalizeNetworkName(sweep.network);
  const network = getNetworkConfig(networkName);
  const treasury = getTreasuryAddress(networkName);
  const fromAddress = sweep.fromAddress;
  if (normalizeAddress(fromAddress) === normalizeAddress(treasury)) {
    await ref.set({
      status: STATUS.complete,
      lastError: "already-treasury",
      updatedAt: serverTimestamp(),
    }, {merge: true});
    return {swept: false, reason: "already-treasury"};
  }

  const token = await evmRpcService.getErc20Balance(
      network.usdcContract,
      fromAddress,
      networkName,
  );
  const available = BigInt(token.raw);
  if (available <= 0n) {
    await ref.set({
      status: STATUS.complete,
      lastError: null,
      updatedAt: serverTimestamp(),
    }, {merge: true});
    return {swept: false, reason: "empty"};
  }

  let requested = available;
  if (sweep.amount != null) {
    try {
      requested = toUsdcUnits(sweep.amount);
    } catch (_err) {
      requested = available;
    }
  }
  const units = requested < available ? requested : available;
  const amount = fromUsdcUnits(units);

  let gasTxHash = sweep.gasTxHash || null;
  const fundedTxHash = await fundCustomerGasIfNeeded(fromAddress, networkName);
  if (fundedTxHash) {
    gasTxHash = fundedTxHash;
    await ref.set({gasTxHash, updatedAt: serverTimestamp()}, {merge: true});
  }

  const sweepTxHash = await signAndBroadcast({
    fromAddress,
    toAddress: treasury,
    amount,
    asset: ASSET,
    network: networkName,
  });

  await ref.set({
    status: STATUS.complete,
    sweepTxHash,
    gasTxHash,
    sweptAmount: amount,
    lastError: null,
    updatedAt: serverTimestamp(),
  }, {merge: true});

  console.log("USDC swept to treasury", {
    network: networkName,
    userId: sweep.userId,
    fromAddress,
    amount,
    sweepTxHash,
  });
  return {swept: true, txHash: sweepTxHash};
}

/**
 * @param {string} [networkName]
 * @returns {Promise<{ processed: number, swept: number, failed: number }>}
 */
async function processPendingSweeps(networkName = MAINNET_NETWORK) {
  if (networkName && !isMainnetNetwork(networkName)) {
    return {processed: 0, swept: 0, failed: 0, reason: "testnet"};
  }
  const page = await collection(COLLECTION)
      .where("status", "==", STATUS.pending)
      .limit(MAX_PER_RUN)
      .get();
  let swept = 0;
  let failed = 0;
  const expectedNetwork = MAINNET_NETWORK;

  for (const doc of page.docs) {
    const sweep = doc.data() || {};
    if (expectedNetwork && normalizeNetworkName(sweep.network) !== expectedNetwork) {
      continue;
    }
    try {
      const result = await processOneSweep(sweep, doc.ref);
      if (result.swept) swept += 1;
    } catch (err) {
      failed += 1;
      const retryable = err && err.code === CODES.INSUFFICIENT_GAS;
      await doc.ref.set({
        status: retryable ? STATUS.pending : STATUS.failed,
        lastError: String(err.message || err).slice(0, 300),
        updatedAt: serverTimestamp(),
      }, {merge: true});
      console.error("Treasury sweep failed", {
        sweepId: doc.id,
        error: err.message,
      });
    }
  }
  return {processed: page.size, swept, failed};
}

/**
 * Enqueue leftover customer USDC, then process pending sweeps.
 * @param {string} [networkName]
 * @returns {Promise<{ outstanding: { enqueued: number }, sweeps: Object }>}
 */
async function runSweepCycle(networkName = MAINNET_NETWORK) {
  if (!isMainnetNetwork(networkName)) {
    return {
      outstanding: {enqueued: 0, reason: "testnet"},
      sweeps: {processed: 0, swept: 0, failed: 0, reason: "testnet"},
    };
  }
  let outstanding = {enqueued: 0};
  try {
    outstanding = await enqueueOutstandingSweeps(MAINNET_NETWORK);
  } catch (err) {
    console.error("Outstanding sweep enqueue failed", {error: err.message});
  }
  let sweeps = {processed: 0, swept: 0, failed: 0};
  try {
    sweeps = await processPendingSweeps(MAINNET_NETWORK);
  } catch (err) {
    console.error("Treasury sweep processing failed", {error: err.message});
  }
  return {outstanding, sweeps};
}

module.exports = {
  COLLECTION,
  STATUS,
  getTreasuryAddress,
  enqueueSweepAfterCredit,
  enqueueOutstandingSweeps,
  processPendingSweeps,
  processOneSweep,
  runSweepCycle,
};
