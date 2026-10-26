/**
 * @fileoverview Provider-independent Avalanche Fuji monitor:
 * - credit confirmed USDC deposits
 * - finalize or fail pending outbound sends
 *
 * Turnkey does not notify on incoming transfers. This layer watches the chain.
 */

const {collection, serverTimestamp} = require("../../libs/firestore");
const ledgerService = require("../ledger/ledgerService");
const reservationService = require("../ledger/reservationService");
const evmRpcService = require("./evm/evmRpcService");
const {normalizeAddress} = require("./evm/fujiNetwork");
const {
  depositEventPrefix,
  getNetworkConfig,
  isMainnetNetwork,
  normalizeNetworkName,
} = require("./evm/networkConfig");
const {fromUsdcUnits} = require("./evm/usdcUnits");
const config = require("../../config");

const ASSET = "USDC";
const PROVIDER = "turnkey";
const LOG_SCAN_CHUNK = 2000;
/** First scan looks back about six hours. One run can cover that window. */
const MAINNET_LOOKBACK_BLOCKS = 6 * 60 * 30;
const MAX_CHUNKS_PER_ADDRESS = 6;

/**
 * @param {string} network
 * @returns {Promise<{ lastProcessedBlock: number }>}
 */
async function getCursor(network) {
  const doc = await collection("cryptoChainCursors").doc(network).get();
  if (!doc.exists) return {lastProcessedBlock: 0};
  return {lastProcessedBlock: Number(doc.data().lastProcessedBlock) || 0};
}

/**
 * @param {string} network
 * @param {number} lastProcessedBlock
 * @param {string} [docId]
 */
async function setCursor(network, lastProcessedBlock, docId = network) {
  await collection("cryptoChainCursors").doc(docId).set({
    network,
    lastProcessedBlock,
    updatedAt: serverTimestamp(),
  }, {merge: true});
}

/**
 * @param {string} network
 * @param {string} address
 * @returns {string}
 */
function addressCursorId(network, address) {
  return `${network}__${address}`;
}

/**
 * @returns {Promise<Set<string>>}
 */
async function loadWatchedAddresses(networkName = "avalanche-fuji") {
  const expectedNetwork = normalizeNetworkName(networkName);
  const snap = await collection("cryptoWallets")
      .where("provider", "==", PROVIDER)
      .limit(500)
      .get();
  const addresses = new Set();
  const byAddress = new Map();
  for (const doc of snap.docs) {
    const data = doc.data();
    const rowNetwork = normalizeNetworkName(data.network || "avalanche-fuji");
    if (rowNetwork !== expectedNetwork) continue;
    if (expectedNetwork === "avalanche") {
      if (String(data.status || "").toLowerCase() !== "live") continue;
      if (String(data.asset || ASSET).toUpperCase() !== ASSET) continue;
    }
    const addr = normalizeAddress(data.addressLower || data.address);
    if (!addr) continue;
    addresses.add(addr);
    byAddress.set(addr, {id: doc.id, ...data});
  }
  return {addresses, byAddress};
}

/**
 * @param {string} eventId
 * @returns {Promise<boolean>} true if this caller acquired the lock
 */
async function acquireChainEventLock(eventId) {
  const admin = require("../../admin");
  const db = admin.firestore();
  const ref = collection("webhookEvents").doc(eventId);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) return false;
    tx.set(ref, {
      eventId,
      provider: PROVIDER,
      processed: false,
      createdAt: serverTimestamp(),
    });
    return true;
  });
}

/**
 * @param {string} eventId
 * @param {Object} [meta]
 */
async function markChainEventProcessed(eventId, meta = {}) {
  await collection("webhookEvents").doc(eventId).set({
    processed: true,
    processedAt: serverTimestamp(),
    ...meta,
  }, {merge: true});
}

/**
 * Credit a confirmed inbound USDC transfer. Idempotent by txHash+logIndex.
 * @param {Object} transfer
 * @param {Object} wallet
 * @returns {Promise<{ credited: boolean, duplicate?: boolean }>}
 */
async function creditDeposit(transfer, wallet, opts = {}) {
  const networkName = normalizeNetworkName(opts.network || wallet.network || "avalanche-fuji");
  const walletNetwork = normalizeNetworkName(wallet.network || "avalanche-fuji");
  if (walletNetwork !== networkName) {
    return {credited: false, ignored: true, reason: "wrong-network"};
  }
  if (networkName === "avalanche") {
    if (String(wallet.provider || "").toLowerCase() !== PROVIDER) {
      return {credited: false, ignored: true, reason: "wrong-provider"};
    }
    if (String(wallet.status || "").toLowerCase() !== "live") {
      return {credited: false, ignored: true, reason: "inactive"};
    }
    if (String(wallet.asset || ASSET).toUpperCase() !== ASSET) {
      return {credited: false, ignored: true, reason: "wrong-asset"};
    }
  }
  const network = getNetworkConfig(networkName);
  const currentBlock = await evmRpcService.getBlockNumber(networkName);
  const head = evmRpcService.confirmedHeadBlock(currentBlock, network.confirmations);
  if (Number(transfer.blockNumber) > head) {
    return {credited: false, unconfirmed: true};
  }

  const referenceId = `${transfer.txHash}_${transfer.logIndex}`;
  const eventId = `${depositEventPrefix(networkName)}:${referenceId}`;
  const acquired = await acquireChainEventLock(eventId);
  if (!acquired) {
    return {credited: false, duplicate: true};
  }

  try {
    if (await ledgerService.hasLedgerEntry(referenceId)) {
      await markChainEventProcessed(eventId, {duplicate: true, type: "deposit"});
      return {credited: false, duplicate: true};
    }

    const amount = fromUsdcUnits(transfer.value);
    if (!(amount > 0)) {
      await markChainEventProcessed(eventId, {skipped: true, reason: "zero-amount"});
      return {credited: false};
    }

    await ledgerService.appendTransaction({
      userId: wallet.userId,
      type: "deposit",
      asset: ASSET,
      amount,
      direction: "credit",
      source: PROVIDER,
      referenceId,
    });

    const existingTx = await collection("cryptoTransactions")
        .where("providerTransactionId", "==", referenceId)
        .limit(1)
        .get();

    if (existingTx.empty) {
      await collection("cryptoTransactions").add({
        userId: wallet.userId,
        // Flutter compat: circleTransactionId is the on-chain hash (same as send).
        // Ledger / replay identity is txHash+logIndex in providerTransactionId.
        circleTransactionId: transfer.txHash,
        providerTransactionId: referenceId,
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
        type: "deposit",
        amount,
        asset: ASSET,
        status: "complete",
        toAddress: transfer.to,
        fromAddress: transfer.from,
        fromWalletId: wallet.walletId,
        provider: PROVIDER,
        network: network.network,
        chainId: network.chainId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    await markChainEventProcessed(eventId, {type: "deposit", userId: wallet.userId});
    if (isMainnetNetwork(networkName)) {
      try {
        const treasurySweepService = require("./treasurySweepService");
        await treasurySweepService.enqueueSweepAfterCredit({
          type: "deposit",
          userId: wallet.userId,
          fromAddress: transfer.to,
          amount,
          network: networkName,
          depositReferenceId: referenceId,
          depositTxHash: transfer.txHash,
        });
      } catch (sweepErr) {
        console.error("Enqueue treasury sweep failed", {
          referenceId,
          error: sweepErr.message,
        });
      }
    }
    console.log("USDC deposit credited", {network: networkName,
      userId: wallet.userId,
      txHash: transfer.txHash,
      amount,
    });
    return {credited: true};
  } catch (err) {
    console.error("Fuji USDC deposit credit failed", {
      eventId,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Pending customer deposit intents. The mainnet scanner does not call
 * Avalanche until one of these exists.
 * @param {string} networkName
 * @returns {Promise<string[]>}
 */
async function listPendingDepositAddresses(networkName) {
  const snap = await collection("cryptoDepositIntents")
      .where("status", "==", "pending")
      .limit(100)
      .get();
  const addresses = [];
  const seen = new Set();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (normalizeNetworkName(data.network || "avalanche-fuji") !== networkName) continue;
    const addr = normalizeAddress(data.depositAddressLower || data.depositAddress);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    addresses.push(addr);
  }
  return addresses;
}

/**
 * @param {Array<Object>} logs
 * @param {Set<string>} addresses
 * @param {Map<string, Object>} byAddress
 * @param {string} resolved
 * @returns {Promise<{ scanned: number, credited: number, duplicates: number }>}
 */
async function creditMatchingLogs(logs, addresses, byAddress, resolved) {
  let credited = 0;
  let duplicates = 0;
  for (const log of logs) {
    const transfer = evmRpcService.parseUsdcTransferLog(log);
    if (!transfer) continue;
    if (!addresses.has(transfer.to)) continue;
    const wallet = byAddress.get(transfer.to);
    if (!wallet) continue;
    const result = await creditDeposit(transfer, wallet, {network: resolved});
    if (result.credited) credited++;
    if (result.duplicate) duplicates++;
  }
  return {scanned: logs.length, credited, duplicates};
}

/**
 * Scan one deposit address from its cursor through the confirmed head.
 * A new address starts about six hours back so a transfer already on chain
 * is included in the same run as the open deposit.
 * @param {string} resolved
 * @param {string} address
 * @param {number} head
 * @param {Set<string>} addresses
 * @param {Map<string, Object>} byAddress
 */
async function scanPendingDepositAddress(resolved, address, head, addresses, byAddress) {
  const cursorId = addressCursorId(resolved, address);
  const cursor = await getCursor(cursorId);
  let fromBlock = cursor.lastProcessedBlock > 0 ?
    cursor.lastProcessedBlock + 1 :
    Math.max(0, head - MAINNET_LOOKBACK_BLOCKS);
  const maxBlocks = LOG_SCAN_CHUNK * MAX_CHUNKS_PER_ADDRESS;
  if ((head - fromBlock + 1) > maxBlocks) {
    fromBlock = head - maxBlocks + 1;
  }
  if (fromBlock > head) {
    return {scanned: 0, credited: 0, duplicates: 0};
  }

  let scanned = 0;
  let credited = 0;
  let duplicates = 0;
  let last = cursor.lastProcessedBlock;
  for (let start = fromBlock; start <= head; start += LOG_SCAN_CHUNK) {
    const end = Math.min(head, start + LOG_SCAN_CHUNK - 1);
    const logs = await evmRpcService.getUsdcTransferLogs(start, end, address, resolved);
    const batch = await creditMatchingLogs(logs, addresses, byAddress, resolved);
    scanned += batch.scanned;
    credited += batch.credited;
    duplicates += batch.duplicates;
    last = end;
  }
  if (last >= fromBlock) {
    await setCursor(resolved, last, cursorId);
  }
  return {scanned, credited, duplicates};
}

/**
 * Mainnet USDC logs are queried only for addresses with a pending deposit intent.
 * @param {string} resolved
 * @returns {Promise<Object>}
 */
async function processPendingMainnetDeposits(resolved) {
  const pendingAddresses = await listPendingDepositAddresses(resolved);
  const {addresses, byAddress} = await loadWatchedAddresses(resolved);
  const targets = pendingAddresses.filter((address) => addresses.has(address));
  if (!targets.length) {
    return {
      scanned: 0,
      credited: 0,
      duplicates: 0,
      network: resolved,
      skipped: true,
      reason: "no-pending-deposits",
    };
  }

  return scanLiveDepositAddresses(resolved, targets, addresses, byAddress);
}

/**
 * Scan explicit deposit addresses. Used after a topup, including once the
 * short watch has already marked the intent expired.
 * @param {string} networkName
 * @param {string[]} addressList
 * @returns {Promise<Object>}
 */
async function processDepositAddresses(networkName, addressList) {
  const resolved = normalizeNetworkName(networkName);
  const requested = [];
  const seen = new Set();
  for (const raw of addressList || []) {
    const addr = normalizeAddress(raw);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    requested.push(addr);
  }
  const {addresses, byAddress} = await loadWatchedAddresses(resolved);
  const targets = requested.filter((address) => addresses.has(address));
  if (!targets.length) {
    return {
      scanned: 0,
      credited: 0,
      duplicates: 0,
      network: resolved,
      skipped: true,
      reason: "no-live-wallet",
    };
  }
  return scanLiveDepositAddresses(resolved, targets, addresses, byAddress);
}

/**
 * @param {string} resolved
 * @param {string[]} targets
 * @param {Set<string>} addresses
 * @param {Map<string, Object>} byAddress
 * @returns {Promise<Object>}
 */
async function scanLiveDepositAddresses(resolved, targets, addresses, byAddress) {
  const network = getNetworkConfig(resolved);
  const currentBlock = await evmRpcService.getBlockNumber(resolved);
  const head = evmRpcService.confirmedHeadBlock(currentBlock, network.confirmations);
  let scanned = 0;
  let credited = 0;
  let duplicates = 0;

  for (const address of targets) {
    const batch = await scanPendingDepositAddress(
        resolved,
        address,
        head,
        addresses,
        byAddress,
    );
    scanned += batch.scanned;
    credited += batch.credited;
    duplicates += batch.duplicates;
  }

  return {
    scanned,
    credited,
    duplicates,
    network: resolved,
    depositAddresses: targets.length,
  };
}

/**
 * @returns {Promise<{ scanned: number, credited: number, duplicates: number }>}
 */
async function processConfirmedDepositsForNetwork(networkName = "avalanche-fuji") {
  const resolved = normalizeNetworkName(networkName);
  if (resolved === "avalanche") {
    return processPendingMainnetDeposits(resolved);
  }
  const network = getNetworkConfig(resolved);
  const currentBlock = await evmRpcService.getBlockNumber(resolved);
  const head = evmRpcService.confirmedHeadBlock(currentBlock, network.confirmations);
  const cursor = await getCursor(network.network);

  let fromBlock = cursor.lastProcessedBlock > 0 ? cursor.lastProcessedBlock + 1 : 0;
  if (fromBlock === 0) {
    fromBlock = Math.max(0, head - 500);
  }
  if (fromBlock > head) {
    return {scanned: 0, credited: 0, duplicates: 0, network: resolved};
  }

  const {addresses, byAddress} = await loadWatchedAddresses(resolved);
  let credited = 0;
  let duplicates = 0;
  let scanned = 0;
  let last = cursor.lastProcessedBlock;

  for (let start = fromBlock; start <= head; start += LOG_SCAN_CHUNK) {
    const end = Math.min(head, start + LOG_SCAN_CHUNK - 1);
    const logs = await evmRpcService.getUsdcTransferLogs(start, end, undefined, resolved);
    scanned += logs.length;
    for (const log of logs) {
      const transfer = evmRpcService.parseUsdcTransferLog(log);
      if (!transfer) continue;
      if (!addresses.has(transfer.to)) continue;
      const wallet = byAddress.get(transfer.to);
      if (!wallet) continue;
      const result = await creditDeposit(transfer, wallet, {network: resolved});
      if (result.credited) credited++;
      if (result.duplicate) duplicates++;
    }
    last = end;
  }

  await setCursor(network.network, last);
  return {scanned, credited, duplicates, fromBlock, toBlock: last, network: resolved};
}

async function processConfirmedDeposits() {
  return processConfirmedDepositsForNetwork("avalanche-fuji");
}

async function processConfirmedMainnetDeposits() {
  return processConfirmedDepositsForNetwork("avalanche");
}

/**
 * @param {Object} tx
 * @param {FirebaseFirestore.QueryDocumentSnapshot} doc
 */
async function finalizeOutboundSend(doc) {
  const tx = doc.data();
  const txHash = tx.txHash || tx.circleTransactionId;
  if (!txHash) return {action: "skipped"};

  const status = await evmRpcService.getTransactionStatus(txHash, tx.network);
  if (status.status === "pending") {
    const createdMs = tx.createdAt?.toMillis?.() || 0;
    const timeoutMs = Number(config.cryptoRail.txTimeoutMs) || 30 * 60 * 1000;
    if (createdMs && Date.now() - createdMs > timeoutMs) {
      if (tx.reservationId) {
        await reservationService.releaseReservation(tx.reservationId);
      }
      await doc.ref.update({
        status: "failed",
        failureReason: "Confirmation timeout",
        updatedAt: serverTimestamp(),
      });
      return {action: "timeout"};
    }
    return {action: "pending"};
  }

  if (status.status === "failed") {
    if (tx.reservationId) {
      await reservationService.releaseReservation(tx.reservationId);
    }
    await doc.ref.update({
      status: "failed",
      failureReason: "Transaction reverted",
      txHash,
      updatedAt: serverTimestamp(),
    });
    return {action: "reverted"};
  }

  const referenceId = tx.circleTransactionId || txHash;
  if (!(await ledgerService.hasLedgerEntry(referenceId))) {
    await ledgerService.appendTransaction({
      userId: tx.userId,
      type: "send",
      asset: ASSET,
      amount: Number(tx.amount),
      direction: "debit",
      source: PROVIDER,
      referenceId,
    });
  }

  if (tx.reservationId) {
    await reservationService.confirmReservation(tx.reservationId);
  }

  await doc.ref.update({
    status: "complete",
    txHash,
    updatedAt: serverTimestamp(),
  });
  return {action: "complete"};
}

/**
 * @returns {Promise<{ pending: number, completed: number, failed: number }>}
 */
async function processPendingSends() {
  const snap = await collection("cryptoTransactions")
      .where("status", "==", "pending")
      .where("provider", "==", PROVIDER)
      .limit(100)
      .get();

  let completed = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    try {
      const result = await finalizeOutboundSend(doc);
      if (result.action === "complete") completed++;
      if (result.action === "timeout" || result.action === "reverted") failed++;
    } catch (err) {
      console.error("Pending send finalization failed", {
        id: doc.id,
        error: err.message,
      });
    }
  }
  return {pending: snap.size, completed, failed};
}

/**
 * @returns {Promise<Object>}
 */
async function runChainMonitor(opts = {}) {
  const address = opts && opts.address ? String(opts.address) : "";
  const deposits = address ?
    await processDepositAddresses(opts.network || "avalanche", [address]) :
    await processConfirmedMainnetDeposits();
  const sends = await processPendingSends();
  return {deposits, sends};
}

module.exports = {
  getCursor,
  setCursor,
  creditDeposit,
  loadWatchedAddresses,
  processConfirmedDeposits,
  processConfirmedDepositsForNetwork,
  processConfirmedMainnetDeposits,
  processDepositAddresses,
  processPendingSends,
  finalizeOutboundSend,
  runChainMonitor,
  acquireChainEventLock,
};
