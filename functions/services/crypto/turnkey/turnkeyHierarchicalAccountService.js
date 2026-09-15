/**
 * @fileoverview Deterministic customer EVM accounts under one TruePay Turnkey wallet.
 * Uses the installed SDK helpers:
 *   defaultEthereumAccountAtIndex(n) → m/44'/60'/{n}'/0/0
 *   createWalletAccounts({ walletId, accounts })
 */

const admin = require("../../../admin");
const {collection, serverTimestamp} = require("../../../libs/firestore");
const turnkeyClient = require("./turnkeyClient");
const {
  getFujiNetwork,
  isTreasuryAddress,
  isValidEvmAddress,
  normalizeAddress,
} = require("../evm/fujiNetwork");
const {walletProvisioningFailure} = require("../cryptoErrors");

const PROVIDER = "turnkey";
const ASSET = "USDC";
const STATUS_LIVE = "live";
const STATUS_PROVISIONING = "provisioning";
const SUPPORTED_NETWORK = "avalanche-fuji";
const CUSTOMER_DEPOSITS_WALLET_NAME =
  process.env.TURNKEY_CUSTOMER_DEPOSITS_WALLET_NAME || "TruePay Customer Deposits Dev";

class HierarchicalAddressError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "HierarchicalAddressError";
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
function customerWalletDocId(userId, network = SUPPORTED_NETWORK, asset = ASSET) {
  return `turnkey_${userId}_${network}_${asset}`;
}

/**
 * @param {string} [network]
 * @param {string} [asset]
 * @returns {string}
 */
function counterDocId(network = SUPPORTED_NETWORK, asset = ASSET) {
  return `${network}_${asset}`;
}

/**
 * @param {number} index
 * @returns {{ curve: string, pathFormat: string, path: string, addressFormat: string }}
 */
function ethereumAccountAtIndex(index) {
  const {defaultEthereumAccountAtIndex} = require("@turnkey/sdk-server");
  return defaultEthereumAccountAtIndex(Number(index));
}

/**
 * @param {Object} wallet
 * @returns {boolean}
 */
function isLiveFujiUsdcWallet(wallet) {
  if (!wallet || !wallet.userId || !wallet.address) return false;
  if (String(wallet.provider || "").toLowerCase() !== PROVIDER) return false;
  if (String(wallet.status || "").toLowerCase() !== STATUS_LIVE) return false;
  if (String(wallet.network || "").toLowerCase() !== SUPPORTED_NETWORK) return false;
  if (String(wallet.asset || "").toUpperCase() !== ASSET) return false;
  return true;
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function findLiveCustomerWallet(userId) {
  const snap = await collection("cryptoWallets")
      .where("userId", "==", userId)
      .where("provider", "==", PROVIDER)
      .get();
  const live = snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter(isLiveFujiUsdcWallet);
  return live[0] || null;
}

/**
 * @param {string} [knownWalletId]
 * @returns {Promise<{ walletId: string, created: boolean }>}
 */
async function getOrCreateParentWallet(knownWalletId) {
  const client = turnkeyClient.getApiClient();
  if (knownWalletId) {
    return {walletId: knownWalletId, created: false};
  }
  if (typeof client.getWallets !== "function") {
    throw walletProvisioningFailure("Turnkey SDK is missing getWallets");
  }
  const listed = await client.getWallets({});
  const match = (listed.wallets || []).find((row) => row.walletName === CUSTOMER_DEPOSITS_WALLET_NAME);
  if (match && match.walletId) {
    return {walletId: match.walletId, created: false};
  }
  if (typeof client.createWallet !== "function") {
    throw walletProvisioningFailure("Turnkey SDK is missing createWallet");
  }
  const created = await client.createWallet({
    walletName: CUSTOMER_DEPOSITS_WALLET_NAME,
    accounts: [],
  });
  if (!created.walletId) {
    throw walletProvisioningFailure("Turnkey createWallet returned no parent walletId");
  }
  return {walletId: created.walletId, created: true};
}

/**
 * Atomically reserve the next HD account index and remember the parent wallet id.
 * @returns {Promise<{ index: number, parentTurnkeyWalletId: string|null }>}
 */
async function allocateNextIndex() {
  const db = admin.firestore();
  const counterRef = collection("cryptoWalletAddressCounters").doc(counterDocId());
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? snap.data() : {};
    const index = Number(data.nextIndex || 0);
    const parentTurnkeyWalletId = data.parentTurnkeyWalletId || null;
    tx.set(counterRef, {
      network: SUPPORTED_NETWORK,
      asset: ASSET,
      nextIndex: index + 1,
      parentTurnkeyWalletId,
      parentWalletName: CUSTOMER_DEPOSITS_WALLET_NAME,
      updatedAt: serverTimestamp(),
    }, {merge: true});
    return {index, parentTurnkeyWalletId};
  });
}

/**
 * @param {string} parentWalletId
 */
async function persistParentWalletId(parentWalletId) {
  await collection("cryptoWalletAddressCounters").doc(counterDocId()).set({
    parentTurnkeyWalletId: parentWalletId,
    parentWalletName: CUSTOMER_DEPOSITS_WALLET_NAME,
    updatedAt: serverTimestamp(),
  }, {merge: true});
}

/**
 * @param {Object} client
 * @param {string} walletId
 * @param {string} path
 * @param {string} [address]
 * @returns {Promise<string|null>}
 */
async function findAccountId(client, walletId, path, address) {
  if (typeof client.getWalletAccounts !== "function") return null;
  const accounts = await client.getWalletAccounts({walletId});
  const rows = accounts.accounts || [];
  const expectedAddr = normalizeAddress(address);
  const byPath = rows.find((row) => String(row.path || "") === path);
  if (byPath) return byPath.walletAccountId || null;
  const byAddr = expectedAddr ?
    rows.find((row) => normalizeAddress(row.address) === expectedAddr) :
    null;
  return (byAddr && byAddr.walletAccountId) || null;
}

/**
 * @param {number} index
 * @param {string} parentWalletId
 * @returns {Promise<{ address: string, path: string, accountId: string|null, walletId: string }>}
 */
async function createAccountAtIndex(index, parentWalletId) {
  const client = turnkeyClient.getApiClient();
  if (typeof client.createWalletAccounts !== "function") {
    throw walletProvisioningFailure("Turnkey SDK is missing createWalletAccounts");
  }
  const account = ethereumAccountAtIndex(index);
  let address = null;
  try {
    const created = await client.createWalletAccounts({
      walletId: parentWalletId,
      accounts: [account],
    });
    address = created.addresses?.[0] || null;
  } catch (err) {
    const recoveredId = await findAccountId(client, parentWalletId, account.path);
    if (!recoveredId) {
      throw walletProvisioningFailure(err.message || "createWalletAccounts failed");
    }
    const accounts = await client.getWalletAccounts({walletId: parentWalletId});
    const match = (accounts.accounts || []).find((row) => String(row.path || "") === account.path);
    address = match && match.address;
  }
  if (!isValidEvmAddress(address)) {
    throw walletProvisioningFailure("Turnkey returned an invalid customer deposit address");
  }
  if (isTreasuryAddress(address)) {
    throw walletProvisioningFailure("Refusing to assign the treasury address to a customer");
  }
  const accountId = await findAccountId(client, parentWalletId, account.path, address);
  return {
    address,
    path: account.path,
    accountId,
    walletId: parentWalletId,
  };
}

/**
 * @param {import("firebase-admin").firestore.DocumentReference} walletRef
 * @returns {Promise<Object>}
 */
async function waitForLiveWallet(walletRef) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snap = await walletRef.get();
    if (snap.exists && isLiveFujiUsdcWallet({id: snap.id, ...snap.data()})) {
      return {id: snap.id, ...snap.data()};
    }
    await sleep(250);
  }
  throw new HierarchicalAddressError(
      "PROVISIONING",
      "Deposit address provisioning is already in progress",
  );
}

/**
 * Race-safe get-or-create of a persistent Fuji USDC deposit address.
 * Existing live mappings (including legacy per-user wallets) are reused.
 * @param {string} userId
 * @returns {Promise<{ wallet: Object, created: boolean }>}
 */
async function allocateCustomerDepositAddress(userId) {
  if (!userId) {
    throw walletProvisioningFailure("userId is required");
  }
  if (!turnkeyClient.isTurnkeyConfigured()) {
    throw walletProvisioningFailure("Turnkey is not configured");
  }

  const existing = await findLiveCustomerWallet(userId);
  if (existing) {
    return {wallet: existing, created: false};
  }

  const db = admin.firestore();
  const walletRef = collection("cryptoWallets").doc(customerWalletDocId(userId));
  const reservation = await db.runTransaction(async (tx) => {
    const snap = await tx.get(walletRef);
    if (snap.exists && isLiveFujiUsdcWallet({id: snap.id, ...snap.data()})) {
      return {kind: "existing", wallet: {id: snap.id, ...snap.data()}};
    }
    if (snap.exists && String(snap.data().status || "") === STATUS_PROVISIONING) {
      return {kind: "provisioning"};
    }
    tx.set(walletRef, {
      userId,
      provider: PROVIDER,
      asset: ASSET,
      network: SUPPORTED_NETWORK,
      status: STATUS_PROVISIONING,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, {merge: true});
    return {kind: "reserved"};
  });

  if (reservation.kind === "existing") {
    return {wallet: reservation.wallet, created: false};
  }
  if (reservation.kind === "provisioning") {
    return {wallet: await waitForLiveWallet(walletRef), created: false};
  }

  try {
    const allocated = await allocateNextIndex();
    const parent = await getOrCreateParentWallet(allocated.parentTurnkeyWalletId);
    if (!allocated.parentTurnkeyWalletId) {
      await persistParentWalletId(parent.walletId);
    }
    const account = await createAccountAtIndex(allocated.index, parent.walletId);
    const collision = await collection("cryptoWallets")
        .where("addressLower", "==", normalizeAddress(account.address))
        .get();
    const other = collision.docs
        .map((doc) => ({id: doc.id, ...doc.data()}))
        .find((row) => row.userId && row.userId !== userId && row.status === STATUS_LIVE);
    if (other) {
      throw walletProvisioningFailure("Address already assigned to another customer");
    }

    const network = getFujiNetwork();
    const walletDoc = {
      userId,
      provider: PROVIDER,
      walletId: account.walletId,
      turnkeyWalletId: account.walletId,
      turnkeyAccountId: account.accountId || null,
      address: account.address,
      addressLower: normalizeAddress(account.address),
      chain: network.chainLabel,
      blockchain: network.blockchain,
      network: network.network,
      chainId: network.chainId,
      asset: ASSET,
      status: STATUS_LIVE,
      derivationIndex: allocated.index,
      derivationPath: account.path,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await walletRef.set(walletDoc, {merge: true});
    return {
      wallet: {
        id: walletRef.id,
        ...walletDoc,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      created: true,
    };
  } catch (err) {
    await walletRef.delete().catch(() => undefined);
    throw err;
  }
}

module.exports = {
  PROVIDER,
  ASSET,
  SUPPORTED_NETWORK,
  CUSTOMER_DEPOSITS_WALLET_NAME,
  HierarchicalAddressError,
  customerWalletDocId,
  counterDocId,
  ethereumAccountAtIndex,
  isLiveFujiUsdcWallet,
  findLiveCustomerWallet,
  getOrCreateParentWallet,
  allocateNextIndex,
  createAccountAtIndex,
  allocateCustomerDepositAddress,
};
