/**
 * @fileoverview Base Circle API client for Developer-Controlled Wallets.
 * Handles authentication, entity-secret-protected requests, and shared config.
 */

const crypto = require("crypto");
const axios = require("axios");
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");
const config = require("../../config");

/** @type {import("@circle-fin/developer-controlled-wallets").CircleDeveloperControlledWalletsClient|null} */
let sdkClient = null;

/** @type {Map<string, { publicKey: string, algorithm: string, fetchedAt: number }>} */
const publicKeyCache = new Map();

const PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * @returns {string|null}
 */
function getApiKey() {
  return process.env.CIRCLE_API_KEY || null;
}

/**
 * @returns {string|null}
 */
function getEntitySecret() {
  return process.env.CIRCLE_ENTITY_SECRET || null;
}

/**
 * @returns {"sandbox"|"prod"}
 */
function getCircleEnv() {
  const env = String(process.env.CIRCLE_ENV || config.circle?.env || "sandbox").toLowerCase();
  return env === "prod" || env === "production" ? "prod" : "sandbox";
}

/**
 * @returns {string}
 */
function getBaseUrl() {
  if (process.env.CIRCLE_API_BASE_URL) {
    return String(process.env.CIRCLE_API_BASE_URL).replace(/\/$/, "");
  }
  return getCircleEnv() === "prod" ? "https://api.circle.com" : "https://api.circle.com";
}

/**
 * Blockchain identifier for Circle wallet creation.
 * @returns {string}
 */
function getDefaultBlockchain() {
  if (process.env.CIRCLE_BLOCKCHAIN) {
    return process.env.CIRCLE_BLOCKCHAIN;
  }
  return getCircleEnv() === "prod" ? "BASE" : "BASE-SEPOLIA";
}

/**
 * Human-readable chain label stored in Firestore.
 * @returns {"BASE"|"POLYGON"}
 */
function getDefaultChainLabel() {
  const blockchain = getDefaultBlockchain().toUpperCase();
  if (blockchain.includes("MATIC") || blockchain.includes("POLYGON")) {
    return "POLYGON";
  }
  return "BASE";
}

/**
 * @returns {import("@circle-fin/developer-controlled-wallets").CircleDeveloperControlledWalletsClient}
 */
function getSdkClient() {
  const apiKey = getApiKey();
  const entitySecret = getEntitySecret();
  if (!apiKey || !entitySecret) {
    throw new Error("Circle API is not configured (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET)");
  }
  if (!sdkClient) {
    sdkClient = initiateDeveloperControlledWalletsClient({
      apiKey,
      entitySecret,
    });
  }
  return sdkClient;
}

/**
 * Reset SDK client (for tests or credential rotation).
 */
function resetSdkClient() {
  sdkClient = null;
}

/**
 * @returns {string}
 */
function generateIdempotencyKey() {
  return crypto.randomUUID();
}

/**
 * Central Circle REST request handler (non-SDK endpoints).
 * @param {string} method
 * @param {string} path
 * @param {Object|null} [body]
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function circleRequest(method, path, body = null, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("CIRCLE_API_KEY is not configured");
  }

  const url = `${getBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    ...options.headers,
  };

  const response = await axios({
    method,
    url,
    headers,
    data: body || undefined,
    timeout: options.timeout || 30000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const detail = response.data?.message || response.data?.error || JSON.stringify(response.data);
    const err = new Error(`Circle API ${method} ${path} failed (${response.status}): ${detail}`);
    err.httpStatus = response.status;
    err.circleBody = response.data;
    throw err;
  }

  return response.data;
}

/**
 * Fetch and cache Circle webhook notification public key.
 * @param {string} keyId
 * @returns {Promise<{ publicKey: string, algorithm: string }>}
 */
async function getNotificationPublicKey(keyId) {
  const cached = publicKeyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
    return { publicKey: cached.publicKey, algorithm: cached.algorithm };
  }

  const data = await circleRequest("GET", `/v2/notifications/publicKey/${keyId}`);
  const row = data?.data || data;
  const publicKey = row?.publicKey;
  const algorithm = row?.algorithm || "ECDSA";
  if (!publicKey) {
    throw new Error(`Circle public key not found for keyId ${keyId}`);
  }

  publicKeyCache.set(keyId, { publicKey, algorithm, fetchedAt: Date.now() });
  return { publicKey, algorithm };
}

/**
 * @returns {boolean}
 */
function isCircleConfigured() {
  return !!(getApiKey() && getEntitySecret());
}

module.exports = {
  getApiKey,
  getEntitySecret,
  getCircleEnv,
  getBaseUrl,
  getDefaultBlockchain,
  getDefaultChainLabel,
  getSdkClient,
  resetSdkClient,
  generateIdempotencyKey,
  circleRequest,
  getNotificationPublicKey,
  isCircleConfigured,
};
