/**
 * @fileoverview Short-lived customer USDC deposit watch sessions.
 * Accounting remains ledger + existing scanner credit path.
 */

const {collection, serverTimestamp} = require("../../../libs/firestore");
const {
  ASSET,
  SUPPORTED_NETWORK,
  DepositAddressError,
  getOrCreateCustomerDepositAddress,
} = require("./turnkeyDepositAddressService");
const {
  scanRecentUsdcDepositsForAddress,
} = require("./turnkeyDepositScannerService");

const POLL_INTERVAL_MS = 5000;
const MONITOR_DURATION_MS = 60000;
const MAX_POLLS = Math.ceil(MONITOR_DURATION_MS / POLL_INTERVAL_MS);
const LOOKBACK_BLOCKS = 80;

const STATUS = Object.freeze({
  pending: "pending",
  detected: "detected",
  credited: "credited",
  expired: "expired",
});

class DepositWatchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DepositWatchError";
    this.code = code;
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} userId
 * @param {string} [network]
 * @param {string} [asset]
 * @returns {string}
 */
function intentDocId(userId, network = SUPPORTED_NETWORK, asset = ASSET) {
  return `${userId}_${network}_${asset}`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {unknown} asset
 * @param {unknown} network
 */
function assertWatchTarget(asset, network) {
  if (asset && String(asset).toUpperCase() !== ASSET) {
    throw new DepositWatchError("WRONG_ASSET", "Only USDC deposit monitoring is supported");
  }
  if (network && String(network).toLowerCase() !== SUPPORTED_NETWORK) {
    throw new DepositWatchError("WRONG_NETWORK", "Only Avalanche Fuji is supported");
  }
}

/**
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function startDepositWatch(userId, input = {}) {
  const uid = String(userId || "").trim();
  if (!uid) {
    throw new DepositWatchError("UNAUTHENTICATED", "Authentication required");
  }
  assertWatchTarget(input.asset, input.network);

  let addressResult;
  try {
    addressResult = await getOrCreateCustomerDepositAddress({
      userId: uid,
      asset: ASSET,
      network: SUPPORTED_NETWORK,
    });
  } catch (err) {
    if (err instanceof DepositAddressError || err.name === "DepositAddressError") {
      throw new DepositWatchError(err.code, err.message);
    }
    throw err;
  }

  const intentRef = collection("cryptoDepositIntents").doc(intentDocId(uid));
  const existing = await intentRef.get();
  const existingData = existing.exists ? existing.data() : null;
  const stillActive = existingData &&
    existingData.status === STATUS.pending &&
    toMillis(existingData.expiresAt) > Date.now();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + MONITOR_DURATION_MS);
  let started = false;

  if (stillActive) {
    return {
      success: true,
      intentId: intentRef.id,
      userId: uid,
      asset: ASSET,
      network: SUPPORTED_NETWORK,
      address: addressResult.depositAddress,
      status: "monitoring",
      expiresAt: existingData.expiresAt && existingData.expiresAt.toDate ?
        existingData.expiresAt.toDate().toISOString() :
        new Date(toMillis(existingData.expiresAt)).toISOString(),
      reusedIntent: true,
      started,
    };
  }

  await intentRef.set({
    userId: uid,
    asset: ASSET,
    network: SUPPORTED_NETWORK,
    depositAddress: addressResult.depositAddress,
    depositAddressLower: String(addressResult.depositAddress || "").toLowerCase(),
    status: STATUS.pending,
    createdAt: existing.exists ? existingData.createdAt || serverTimestamp() : serverTimestamp(),
    expiresAt,
    detectedTxHash: null,
    detectedLogIndex: null,
    detectedAmount: null,
    creditedAt: null,
    updatedAt: serverTimestamp(),
  }, {merge: true});
  started = true;

  return {
    success: true,
    intentId: intentRef.id,
    userId: uid,
    asset: ASSET,
    network: SUPPORTED_NETWORK,
    address: addressResult.depositAddress,
    status: "monitoring",
    expiresAt: expiresAt.toISOString(),
    reusedIntent: false,
    started,
  };
}

/**
 * @param {FirebaseFirestore.DocumentReference} intentRef
 * @param {Object} credit
 */
async function markIntentCredited(intentRef, credit) {
  await intentRef.set({
    status: credit.credited ? STATUS.credited : STATUS.detected,
    detectedTxHash: credit.txHash,
    detectedLogIndex: credit.logIndex,
    detectedAmount: credit.amount,
    creditedAt: credit.credited ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
  }, {merge: true});
}

/**
 * @param {string} intentId
 * @returns {Promise<Object>}
 */
async function runDepositWatchLoop(intentId) {
  const intentRef = collection("cryptoDepositIntents").doc(intentId);
  let lastScan = null;

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const snap = await intentRef.get();
    if (!snap.exists) {
      return {status: "missing", polls: poll};
    }
    const intent = snap.data();
    if (intent.status === STATUS.credited || intent.status === STATUS.detected) {
      return {status: intent.status, polls: poll, scan: lastScan};
    }
    if (intent.status !== STATUS.pending) {
      return {status: intent.status, polls: poll};
    }
    if (toMillis(intent.expiresAt) <= Date.now()) {
      await intentRef.set({
        status: STATUS.expired,
        updatedAt: serverTimestamp(),
      }, {merge: true});
      return {status: STATUS.expired, polls: poll, scan: lastScan};
    }

    lastScan = await scanRecentUsdcDepositsForAddress(
        intent.depositAddress,
        LOOKBACK_BLOCKS,
    );
    const credit = (lastScan.credits || []).find((row) => row.userId === intent.userId);
    if (credit) {
      await markIntentCredited(intentRef, credit);
      return {status: credit.credited ? STATUS.credited : STATUS.detected, polls: poll + 1, scan: lastScan};
    }

    if (poll < MAX_POLLS - 1) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  await intentRef.set({
    status: STATUS.expired,
    updatedAt: serverTimestamp(),
  }, {merge: true});
  return {status: STATUS.expired, polls: MAX_POLLS, scan: lastScan};
}

module.exports = {
  ASSET,
  SUPPORTED_NETWORK,
  POLL_INTERVAL_MS,
  MONITOR_DURATION_MS,
  MAX_POLLS,
  STATUS,
  DepositWatchError,
  intentDocId,
  startDepositWatch,
  runDepositWatchLoop,
};
