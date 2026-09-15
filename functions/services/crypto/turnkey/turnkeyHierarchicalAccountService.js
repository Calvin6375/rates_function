/**
 * @fileoverview Deterministic customer EVM accounts under one TruePay Turnkey wallet.
 * Uses the installed SDK helpers:
 *   defaultEthereumAccountAtIndex(n) → m/44'/60'/{n}'/0/0
 *   createWalletAccounts({ walletId, accounts })
 *
 * Fuji and production share this allocator. Counters, parent wallets, and
 * cryptoWallets documents are isolated by network. Never write the production
 * parent id onto the Fuji counter.
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
const PRODUCTION_NETWORK = "avalanche";
const CUSTOMER_DEPOSITS_WALLET_NAME =
  process.env.TURNKEY_CUSTOMER_DEPOSITS_WALLET_NAME || "TruePay Customer Deposits Dev";
const PRODUCTION_PARENT_WALLET_ID =
  process.env.TURNKEY_PRODUCTION_CUSTOMER_DEPOSITS_WALLET_ID ||
  "ba3dfc05-1024-5ef0-bf1c-7b5c009a582b";
const PRODUCTION_PARENT_WALLET_NAME =
  process.env.TURNKEY_PRODUCTION_CUSTOMER_DEPOSITS_WALLET_NAME ||
  "TruePay Customer Deposits Production";
const PRODUCTION_CHAIN_ID = 43114;

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
 * @param {string} network
 * @returns {{ network: string, chainLabel: string, blockchain: string, chainId: number }}
 */
function getNetworkRecord(network) {
  if (String(network) === PRODUCTION_NETWORK) {
    return {
      network: PRODUCTION_NETWORK,
      chainLabel: "AVALANCHE",
      blockchain: "AVALANCHE",
      chainId: PRODUCTION_CHAIN_ID,
    };
  }
  const fuji = getFujiNetwork();
  return {
    network: fuji.network,
    chainLabel: fuji.chainLabel,
    blockchain: fuji.blockchain,
    chainId: fuji.chainId,
  };
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
 * @param {string} [network]
 * @param {string} [asset]
 * @returns {boolean}
 */
function isLiveNetworkWallet(wallet, network = SUPPORTED_NETWORK, asset = ASSET) {
  if (!wallet || !wallet.userId || !wallet.address) return false;
  if (String(wallet.provider || "").toLowerCase() !== PROVIDER) return false;
  if (String(wallet.status || "").toLowerCase() !== STATUS_LIVE) return false;
  if (String(wallet.network || "").toLowerCase() !== String(network).toLowerCase()) return false;
  if (String(wallet.asset || "").toUpperCase() !== String(asset).toUpperCase()) return false;
  return true;
}

/**
 * @param {Object} wallet
 * @returns {boolean}
 */
function isLiveFujiUsdcWallet(wallet) {
  return isLiveNetworkWallet(wallet, SUPPORTED_NETWORK, ASSET);
}

/**
 * @param {string} userId
 * @param {string} [network]
 * @param {string} [asset]
 * @returns {Promise<Object|null>}
 */
async function findLiveCustomerWallet(userId, network = SUPPORTED_NETWORK, asset = ASSET) {
  const snap = await collection("cryptoWallets")
      .where("userId", "==", userId)
      .where("provider", "==", PROVIDER)
      .get();
  const live = snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((row) => isLiveNetworkWallet(row, network, asset));
  return live[0] || null;
}

/**
 * @param {Object} opts
 * @param {string} [opts.knownWalletId]
 * @param {boolean} [opts.allowCreate]
 * @param {string} [opts.parentWalletName]
 * @returns {Promise<{ walletId: string, created: boolean }>}
 */
async function getOrCreateParentWallet(knownWalletId, opts = {}) {
  if (typeof knownWalletId === "object" && knownWalletId) {
    opts = knownWalletId;
    knownWalletId = opts.knownWalletId;
  }
  const allowCreate = opts.allowCreate !== false;
  const parentWalletName = opts.parentWalletName || CUSTOMER_DEPOSITS_WALLET_NAME;

  if (knownWalletId) {
    return {walletId: knownWalletId, created: false};
  }
  const client = turnkeyClient.getApiClient();
  if (typeof client.getWallets !== "function") {
    throw walletProvisioningFailure("Turnkey SDK is missing getWallets");
  }
  const listed = await client.getWallets({});
  const match = (listed.wallets || []).find((row) => row.walletName === parentWalletName);
  if (match && match.walletId) {
    return {walletId: match.walletId, created: false};
  }
  if (!allowCreate) {
    throw walletProvisioningFailure("Production parent Turnkey wallet is not configured");
  }
  if (typeof client.createWallet !== "function") {
    throw walletProvisioningFailure("Turnkey SDK is missing createWallet");
  }
  const created = await client.createWallet({
    walletName: parentWalletName,
    accounts: [],
  });
  if (!created.walletId) {
    throw walletProvisioningFailure("Turnkey createWallet returned no parent walletId");
  }
  return {walletId: created.walletId, created: true};
}

/**
 * Atomically reserve the next HD account index for one network/asset counter.
 * @param {Object} [opts]
 * @returns {Promise<{ index: number, parentTurnkeyWalletId: string|null }>}
 */
async function allocateNextIndex(opts = {}) {
  const network = opts.network || SUPPORTED_NETWORK;
  const asset = opts.asset || ASSET;
  const parentWalletName = opts.parentWalletName || CUSTOMER_DEPOSITS_WALLET_NAME;
  const forcedParentId = opts.parentTurnkeyWalletId || null;
  const db = admin.firestore();
  const counterRef = collection("cryptoWalletAddressCounters").doc(counterDocId(network, asset));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? snap.data() : {};
    const index = Number(data.nextIndex || 0);
    const parentTurnkeyWalletId = forcedParentId || data.parentTurnkeyWalletId || null;
    tx.set(counterRef, {
      network,
      asset,
      nextIndex: index + 1,
      parentTurnkeyWalletId,
      parentWalletName,
      updatedAt: serverTimestamp(),
    }, {merge: true});
    return {index, parentTurnkeyWalletId};
  });
}

/**
 * @param {string} parentWalletId
 * @param {Object} [opts]
 */
async function persistParentWalletId(parentWalletId, opts = {}) {
  const network = opts.network || SUPPORTED_NETWORK;
  const asset = opts.asset || ASSET;
  const parentWalletName = opts.parentWalletName || CUSTOMER_DEPOSITS_WALLET_NAME;
  await collection("cryptoWalletAddressCounters").doc(counterDocId(network, asset)).set({
    parentTurnkeyWalletId: parentWalletId,
    parentWalletName,
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
 * @returns {Promise<{ address: string, path: string, accountId: string|null, walletId: string }|null>}
 */
async function recoverAccountAtIndex(index, parentWalletId) {
  const client = turnkeyClient.getApiClient();
  const account = ethereumAccountAtIndex(index);
  const accountId = await findAccountId(client, parentWalletId, account.path);
  if (!accountId) return null;
  const accounts = await client.getWalletAccounts({walletId: parentWalletId});
  const match = (accounts.accounts || []).find((row) => String(row.path || "") === account.path);
  const address = match && match.address;
  if (!isValidEvmAddress(address)) return null;
  if (isTreasuryAddress(address)) {
    throw walletProvisioningFailure("Refusing to assign the treasury address to a customer");
  }
  return {
    address,
    path: account.path,
    accountId,
    walletId: parentWalletId,
  };
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
    const recovered = await recoverAccountAtIndex(index, parentWalletId);
    if (recovered) return recovered;
    throw walletProvisioningFailure(err.message || "createWalletAccounts failed");
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
 * @param {string} [network]
 * @param {string} [asset]
 * @returns {Promise<Object>}
 */
async function waitForLiveWallet(walletRef, network = SUPPORTED_NETWORK, asset = ASSET) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snap = await walletRef.get();
    if (snap.exists && isLiveNetworkWallet({id: snap.id, ...snap.data()}, network, asset)) {
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
 * @param {Object} account
 * @param {Object} params
 * @returns {Object}
 */
function buildLiveWalletDoc(account, params) {
  const record = getNetworkRecord(params.network);
  return {
    userId: params.userId,
    provider: PROVIDER,
    walletId: account.walletId,
    turnkeyWalletId: account.walletId,
    turnkeyAccountId: account.accountId || null,
    address: account.address,
    addressLower: normalizeAddress(account.address),
    chain: record.chainLabel,
    blockchain: record.blockchain,
    network: record.network,
    chainId: record.chainId,
    asset: params.asset,
    status: STATUS_LIVE,
    derivationIndex: params.index,
    derivationPath: account.path,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

/**
 * @param {string} userId
 * @param {string} address
 */
async function assertAddressNotAssigned(userId, address) {
  const collision = await collection("cryptoWallets")
      .where("addressLower", "==", normalizeAddress(address))
      .get();
  const other = collision.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .find((row) => row.userId && row.userId !== userId && row.status === STATUS_LIVE);
  if (other) {
    throw walletProvisioningFailure("Address already assigned to another customer");
  }
}

/**
 * @param {string} userId
 * @param {Object} opts
 * @returns {Promise<{ wallet: Object, created: boolean }>}
 */
async function allocateCustomerDepositAddressForNetwork(userId, opts = {}) {
  const network = opts.network || SUPPORTED_NETWORK;
  const asset = opts.asset || ASSET;
  const parentWalletName = opts.parentWalletName || CUSTOMER_DEPOSITS_WALLET_NAME;
  const forcedParentId = opts.parentTurnkeyWalletId || null;
  const allowCreateParent = opts.allowCreateParent !== false;

  if (!userId) {
    throw walletProvisioningFailure("userId is required");
  }
  if (!turnkeyClient.isTurnkeyConfigured()) {
    throw walletProvisioningFailure("Turnkey is not configured");
  }

  const existing = await findLiveCustomerWallet(userId, network, asset);
  if (existing) {
    return {wallet: existing, created: false};
  }

  const db = admin.firestore();
  const walletRef = collection("cryptoWallets").doc(customerWalletDocId(userId, network, asset));
  const reservation = await db.runTransaction(async (tx) => {
    const snap = await tx.get(walletRef);
    if (snap.exists && isLiveNetworkWallet({id: snap.id, ...snap.data()}, network, asset)) {
      return {kind: "existing", wallet: {id: snap.id, ...snap.data()}};
    }
    if (snap.exists && String(snap.data().status || "") === STATUS_PROVISIONING) {
      return {kind: "provisioning", wallet: {id: snap.id, ...snap.data()}};
    }
    tx.set(walletRef, {
      userId,
      provider: PROVIDER,
      asset,
      network,
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
    if (reservation.wallet && reservation.wallet.derivationIndex != null) {
      return completeReservedAllocation(walletRef, userId, {
        network,
        asset,
        parentWalletName,
        forcedParentId,
        allowCreateParent,
        reserved: reservation.wallet,
      });
    }
    return {wallet: await waitForLiveWallet(walletRef, network, asset), created: false};
  }

  try {
    return await completeReservedAllocation(walletRef, userId, {
      network,
      asset,
      parentWalletName,
      forcedParentId,
      allowCreateParent,
    });
  } catch (err) {
    const snap = await walletRef.get().catch(() => ({exists: false}));
    const data = snap.exists ? snap.data() : {};
    if (data.derivationIndex == null) {
      await walletRef.delete().catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Finish a reserved/provisioning row. Recovers a Turnkey account at a persisted
 * derivation index before allocating a new one.
 * @param {import("firebase-admin").firestore.DocumentReference} walletRef
 * @param {string} userId
 * @param {Object} opts
 * @returns {Promise<{ wallet: Object, created: boolean }|null>}
 */
async function completeReservedAllocation(walletRef, userId, opts) {
  const {
    network,
    asset,
    parentWalletName,
    forcedParentId,
    allowCreateParent,
    reserved,
  } = opts;

  const snap = reserved ? {exists: true, data: () => reserved} : await walletRef.get();
  const reservedData = snap.exists ? snap.data() : {};
  let index = reservedData.derivationIndex;
  let parentId = reservedData.parentTurnkeyWalletId || forcedParentId || null;
  let created = true;

  if (index == null) {
    const allocated = await allocateNextIndex({
      network,
      asset,
      parentWalletName,
      parentTurnkeyWalletId: forcedParentId,
    });
    index = allocated.index;
    const parent = await getOrCreateParentWallet(forcedParentId || allocated.parentTurnkeyWalletId, {
      allowCreate: allowCreateParent,
      parentWalletName,
    });
    parentId = parent.walletId;
    if (!allocated.parentTurnkeyWalletId || forcedParentId) {
      await persistParentWalletId(parentId, {network, asset, parentWalletName});
    }
    await walletRef.set({
      derivationIndex: index,
      parentTurnkeyWalletId: parentId,
      status: STATUS_PROVISIONING,
      updatedAt: serverTimestamp(),
    }, {merge: true});
  } else {
    parentId = parentId || forcedParentId;
    if (!parentId) {
      throw walletProvisioningFailure("Reserved production index is missing parent wallet id");
    }
  }

  let account = await recoverAccountAtIndex(index, parentId);
  if (account) {
    created = false;
  } else {
    account = await createAccountAtIndex(index, parentId);
    created = true;
  }

  await assertAddressNotAssigned(userId, account.address);
  const walletDoc = buildLiveWalletDoc(account, {userId, network, asset, index});
  await walletRef.set(walletDoc, {merge: true});
  return {
    wallet: {
      id: walletRef.id,
      ...walletDoc,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    created,
  };
}

/**
 * Race-safe get-or-create of a persistent Fuji USDC deposit address.
 * Existing live mappings (including legacy per-user wallets) are reused.
 * @param {string} userId
 * @returns {Promise<{ wallet: Object, created: boolean }>}
 */
async function allocateCustomerDepositAddress(userId) {
  const production = await findLiveCustomerWallet(userId, PRODUCTION_NETWORK, ASSET);
  if (production) {
    throw new HierarchicalAddressError(
        "PRODUCTION_WALLET_EXISTS",
        "Fuji deposit addresses are not created after a production address exists",
    );
  }
  return allocateCustomerDepositAddressForNetwork(userId, {
    network: SUPPORTED_NETWORK,
    asset: ASSET,
    parentTurnkeyWalletId: null,
    parentWalletName: CUSTOMER_DEPOSITS_WALLET_NAME,
    allowCreateParent: true,
  });
}

/**
 * Race-safe get-or-create of a persistent Avalanche mainnet USDC deposit address.
 * Never reads or writes the Fuji counter or Fuji cryptoWallets document.
 * @param {string} userId
 * @returns {Promise<{ wallet: Object, created: boolean }>}
 */
async function allocateProductionCustomerDepositAddress(userId) {
  return allocateCustomerDepositAddressForNetwork(userId, {
    network: PRODUCTION_NETWORK,
    asset: ASSET,
    parentTurnkeyWalletId: PRODUCTION_PARENT_WALLET_ID,
    parentWalletName: PRODUCTION_PARENT_WALLET_NAME,
    allowCreateParent: false,
  });
}

module.exports = {
  PROVIDER,
  ASSET,
  SUPPORTED_NETWORK,
  PRODUCTION_NETWORK,
  CUSTOMER_DEPOSITS_WALLET_NAME,
  PRODUCTION_PARENT_WALLET_ID,
  PRODUCTION_PARENT_WALLET_NAME,
  PRODUCTION_CHAIN_ID,
  HierarchicalAddressError,
  customerWalletDocId,
  counterDocId,
  ethereumAccountAtIndex,
  getNetworkRecord,
  isLiveFujiUsdcWallet,
  isLiveNetworkWallet,
  findLiveCustomerWallet,
  getOrCreateParentWallet,
  allocateNextIndex,
  persistParentWalletId,
  recoverAccountAtIndex,
  createAccountAtIndex,
  allocateCustomerDepositAddressForNetwork,
  allocateCustomerDepositAddress,
  allocateProductionCustomerDepositAddress,
};
