/**
 * @fileoverview Turnkey server SDK client. Credentials come from env / Secret Manager.
 * Never log private keys or stamp material.
 */

const {ethers} = require("ethers");
const config = require("../../../config");
const evmRpcService = require("../evm/evmRpcService");
const {getFujiNetwork, isValidEvmAddress} = require("../evm/fujiNetwork");
const {createLogger} = require("../../../utils/paymentOpsLogger");

const logger = createLogger({service: "turnkeyClient"});

/** @type {import("@turnkey/sdk-server").Turnkey|null} */
let sdkInstance = null;

/** @type {Object|null} */
let apiClientOverride = null;

/**
 * @returns {{
 *   organizationId: string|null,
 *   apiPublicKey: string|null,
 *   apiPrivateKey: string|null,
 *   apiBaseUrl: string,
 * }}
 */
function getTurnkeyConfig() {
  return {
    organizationId: process.env.TURNKEY_ORGANIZATION_ID || config.turnkey.organizationId || null,
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY || config.turnkey.apiPublicKey || null,
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY || config.turnkey.apiPrivateKey || null,
    apiBaseUrl: process.env.TURNKEY_API_BASE_URL || config.turnkey.apiBaseUrl ||
      "https://api.turnkey.com",
  };
}

/**
 * @returns {boolean}
 */
function isTurnkeyConfigured() {
  const cfg = getTurnkeyConfig();
  return !!(cfg.organizationId && cfg.apiPublicKey && cfg.apiPrivateKey);
}

/**
 * @throws {Error} if any required Turnkey credential is missing
 */
function assertTurnkeyConfigured() {
  if (!isTurnkeyConfigured()) {
    throw new Error("Turnkey configuration is incomplete");
  }
}

/**
 * Strip credentials and stamp material from an error message.
 * @param {unknown} err
 * @returns {string}
 */
function sanitizeTurnkeyError(err) {
  let message = String((err && err.message) || err || "unknown error");
  const cfg = getTurnkeyConfig();
  const secrets = [cfg.apiPrivateKey, cfg.apiPublicKey, cfg.organizationId].filter(Boolean);
  for (const secret of secrets) {
    if (secret && message.includes(secret)) {
      message = message.split(secret).join("[redacted]");
    }
  }
  message = message.replace(/X-Stamp[^,\s]*/gi, "[redacted-stamp]");
  message = message.replace(/api[-_]?private[-_]?key[^,\s]*/gi, "[redacted]");
  return message.slice(0, 300);
}

/**
 * @returns {void}
 */
function resetTurnkeyClient() {
  sdkInstance = null;
}

/**
 * @param {Object|null} client
 */
function setApiClientForTests(client) {
  apiClientOverride = client;
}

/**
 * @returns {Object}
 */
function getApiClient() {
  if (apiClientOverride) return apiClientOverride;
  assertTurnkeyConfigured();
  if (!sdkInstance) {
    const {Turnkey} = require("@turnkey/sdk-server");
    const cfg = getTurnkeyConfig();
    sdkInstance = new Turnkey({
      apiBaseUrl: cfg.apiBaseUrl,
      defaultOrganizationId: cfg.organizationId,
      apiPublicKey: cfg.apiPublicKey,
      apiPrivateKey: cfg.apiPrivateKey,
    });
  }
  return sdkInstance.apiClient();
}

/**
 * @returns {string}
 */
function getOrganizationId() {
  assertTurnkeyConfigured();
  return getTurnkeyConfig().organizationId;
}

/**
 * Harmless authenticated query: proves API-key auth against the org.
 * Does not create wallets, accounts, or transactions.
 * @returns {Promise<{ success: true, provider: "turnkey" }>}
 */
async function testTurnkeyConnection() {
  logger.info("Turnkey connection test started");
  try {
    const client = getApiClient();
    await client.getWhoami({organizationId: getOrganizationId()});
    logger.info("Turnkey connection test succeeded");
    return {success: true, provider: "turnkey"};
  } catch (err) {
    const safe = sanitizeTurnkeyError(err);
    logger.error("Turnkey connection test failed", {error: safe});
    if (err && err.message === "Turnkey configuration is incomplete") {
      throw err;
    }
    const wrapped = new Error(`Turnkey connection test failed: ${safe}`);
    throw wrapped;
  }
}

const TREASURY_WALLET_NAME = "TruePay Treasury Dev";
const EXPECTED_ADDRESS_SUFFIX = "e080a";

/**
 * @param {Object} account
 * @returns {boolean}
 */
function isEvmAccount(account) {
  const format = String(account.addressFormat || "").toUpperCase();
  const address = String(account.address || "");
  if (format.includes("ETHEREUM") || format.includes("EVM")) return true;
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Full treasury address if already configured; otherwise empty (suffix-only match).
 * @returns {string}
 */
function getExpectedTreasuryAddressLower() {
  const configured = String(
      process.env.CRYPTO_TREASURY_ADDRESS ||
      (config.cryptoRail && config.cryptoRail.treasuryAddress) ||
      "",
  ).toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(configured) ? configured : "";
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function addressMatchesExpected(address) {
  const value = String(address || "").toLowerCase();
  const expectedFull = getExpectedTreasuryAddressLower();
  if (expectedFull && value === expectedFull) {
    return true;
  }
  return value.endsWith(EXPECTED_ADDRESS_SUFFIX);
}

/**
 * @param {string} address
 * @returns {{ accountType: string, address: string, addressSuffix: string, matchesExpectedAddress: boolean }}
 */
function sanitizeTreasuryAccount(address) {
  const value = String(address || "");
  return {
    accountType: "EVM",
    address: value,
    addressSuffix: value.slice(-5).toUpperCase(),
    matchesExpectedAddress: addressMatchesExpected(value),
  };
}

/**
 * Read-only lookup of the existing Company Wallet. Does not create or sign.
 * @returns {Promise<Object>}
 */
async function getTurnkeyTreasuryWallet() {
  logger.info("Turnkey treasury wallet lookup started");
  try {
    const client = getApiClient();
    if (typeof client.getWallets !== "function" || typeof client.getWalletAccounts !== "function") {
      throw new Error("Turnkey SDK is missing getWallets/getWalletAccounts");
    }

    const walletsResponse = await client.getWallets({});
    const wallets = walletsResponse.wallets || [];
    const wallet = wallets.find((row) => row.walletName === TREASURY_WALLET_NAME);
    if (!wallet || !wallet.walletId) {
      throw new Error("Treasury wallet not found");
    }

    const accountsResponse = await client.getWalletAccounts({walletId: wallet.walletId});
    const evmAccounts = (accountsResponse.accounts || [])
        .filter(isEvmAccount)
        .map((row) => sanitizeTreasuryAccount(row.address));
    if (!evmAccounts.length) {
      throw new Error("Treasury wallet has no EVM accounts");
    }

    const match = evmAccounts.find((row) => row.matchesExpectedAddress) || evmAccounts[0];
    logger.info("Turnkey treasury wallet lookup succeeded", {
      accountCount: evmAccounts.length,
      matchesExpectedAddress: !!(match && match.matchesExpectedAddress),
    });

    const result = {
      success: true,
      walletName: TREASURY_WALLET_NAME,
      accountType: "EVM",
      address: match ? match.address : null,
      addressSuffix: match ? match.addressSuffix : null,
      matchesExpectedAddress: !!(match && match.matchesExpectedAddress),
    };
    if (evmAccounts.length > 1) {
      result.accounts = evmAccounts;
    }
    return result;
  } catch (err) {
    const safe = sanitizeTurnkeyError(err);
    logger.error("Turnkey treasury wallet lookup failed", {error: safe});
    if (err && err.message === "Turnkey configuration is incomplete") {
      throw err;
    }
    throw new Error(`Turnkey treasury wallet lookup failed: ${safe}`);
  }
}

/**
 * Env-only USDT contract. No default is invented.
 * @returns {string|null}
 */
function getConfiguredUsdtContract() {
  const value = String(process.env.AVALANCHE_FUJI_USDT_CONTRACT || "").trim();
  return isValidEvmAddress(value) ? value : null;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function sanitizeTreasuryBalanceError(err) {
  let message = sanitizeTurnkeyError(err);
  const rpcUrl = getFujiNetwork().rpcUrl;
  if (rpcUrl && message.includes(rpcUrl)) {
    message = message.split(rpcUrl).join("[redacted-rpc]");
  }
  return message;
}

/**
 * Read-only on-chain balances for the verified treasury address.
 * USDT is queried only when AVALANCHE_FUJI_USDT_CONTRACT is already set.
 * @returns {Promise<Object>}
 */
async function getTurnkeyTreasuryBalances() {
  logger.info("Turnkey treasury balance lookup started");
  try {
    const wallet = await getTurnkeyTreasuryWallet();
    const address = wallet && wallet.address;
    if (!isValidEvmAddress(address)) {
      throw new Error("Treasury wallet has no EVM address");
    }

    const network = getFujiNetwork();
    const balances = {};

    balances.USDC = await evmRpcService.getErc20Balance(network.usdcContract, address);

    const usdtContract = getConfiguredUsdtContract();
    if (usdtContract) {
      balances.USDT = await evmRpcService.getErc20Balance(usdtContract, address);
    } else {
      balances.USDT = {
        configured: false,
        error: "USDT contract is not configured for avalanche-fuji",
      };
    }

    const avaxWei = await evmRpcService.getAvaxBalanceWei(address);
    balances.AVAX = {
      raw: avaxWei.toString(),
      decimals: 18,
      balance: ethers.formatEther(avaxWei),
    };

    logger.info("Turnkey treasury balance lookup succeeded", {
      network: network.network,
      usdcConfigured: true,
      usdtConfigured: !!usdtContract,
    });

    return {
      success: true,
      address,
      network: network.network,
      balances,
    };
  } catch (err) {
    const safe = sanitizeTreasuryBalanceError(err);
    logger.error("Turnkey treasury balance lookup failed", {error: safe});
    if (err && err.message === "Turnkey configuration is incomplete") {
      throw err;
    }
    throw new Error(`Turnkey treasury balance lookup failed: ${safe}`);
  }
}

module.exports = {
  TREASURY_WALLET_NAME,
  EXPECTED_ADDRESS_SUFFIX,
  getTurnkeyConfig,
  isTurnkeyConfigured,
  assertTurnkeyConfigured,
  sanitizeTurnkeyError,
  resetTurnkeyClient,
  setApiClientForTests,
  getApiClient,
  getOrganizationId,
  testTurnkeyConnection,
  getTurnkeyTreasuryWallet,
  getTurnkeyTreasuryBalances,
};
