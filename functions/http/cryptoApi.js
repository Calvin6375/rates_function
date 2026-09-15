/**
 * @fileoverview Consumer crypto API: wallet, balance, transactions, send.
 * Provider (Circle or Turnkey) is selected via CRYPTO_RAIL_PROVIDER.
 */

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const QRCode = require("qrcode");
const config = require("../config");
const { verifyFirebaseAuth } = require("../libs/auth");
const cryptoRailProvider = require("../services/crypto/cryptoRailProvider");
const {publicErrorMessage} = require("../services/crypto/cryptoErrors");
const {
  startDepositWatch,
  DepositWatchError,
} = require("../services/crypto/turnkey/cryptoDepositMonitoringService");
const {
  getOrCreateProductionCustomerDepositAddress,
  DepositAddressError,
  PRODUCTION_NETWORK,
} = require("../services/crypto/turnkey/turnkeyDepositAddressService");
const turnkeyWalletService = require("../services/crypto/turnkey/turnkeyWalletService");
const {getCryptoFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {
  C2B_ENCRYPTION_SECRETS,
  C2B_ENCRYPTION_ALLOW_HEADERS,
  createC2bPayloadEncryptionMiddleware,
} = require("./middleware/c2bPayloadEncryption");

const app = express();
app.use(express.json());
app.use(createC2bPayloadEncryptionMiddleware());

/** @type {Map<string, { count: number, resetAt: number }>} */
const sendRateLimits = new Map();
const SEND_RATE_LIMIT = 5;
const SEND_RATE_WINDOW_MS = 60 * 1000;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
    "https://theadmin.truepay.live",
    "https://truepay.live",
    "https://www.truepay.live",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
  ];

  let allowedOrigin = "*";
  if (origin) {
    if (
      allowedOrigins.includes(origin) ||
      origin.includes("localhost") ||
      origin.includes("127.0.0.1") ||
      origin.includes("truepay-72060") ||
      /^https:\/\/([a-z0-9-]+\.)*truepay\.live$/i.test(origin)
    ) {
      allowedOrigin = origin;
    }
  }

  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", C2B_ENCRYPTION_ALLOW_HEADERS);
  res.set("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * @param {string} userId
 * @returns {boolean}
 */
function checkSendRateLimit(userId) {
  const now = Date.now();
  const row = sendRateLimits.get(userId);
  if (!row || now > row.resetAt) {
    sendRateLimits.set(userId, { count: 1, resetAt: now + SEND_RATE_WINDOW_MS });
    return true;
  }
  if (row.count >= SEND_RATE_LIMIT) {
    return false;
  }
  row.count += 1;
  return true;
}

/**
 * GET /crypto/wallet
 * Default (no network / avalanche-fuji): existing Fuji rail wallet.
 * network=avalanche: return production mapping only — never create, never fall back to Fuji.
 */
app.get("/crypto/wallet", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const requestedNetwork = String(req.query.network || "").trim().toLowerCase();
  if (requestedNetwork && requestedNetwork !== "avalanche-fuji" && requestedNetwork !== PRODUCTION_NETWORK) {
    res.status(400).json({success: false, error: "Unsupported network"});
    return;
  }

  try {
    if (requestedNetwork === PRODUCTION_NETWORK) {
      const wallet = await turnkeyWalletService.getWallet(auth.userId, {network: PRODUCTION_NETWORK});
      if (!wallet) {
        res.status(404).json({success: false, error: "Production crypto wallet not found"});
        return;
      }
      const qrDataUrl = await QRCode.toDataURL(wallet.address, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 256,
      });
      res.json({
        success: true,
        data: {
          address: wallet.address,
          chain: wallet.chain,
          asset: wallet.asset || "USDC",
          walletId: wallet.walletId,
          network: wallet.network,
          qrDataUrl,
          qrPayload: wallet.address,
        },
      });
      return;
    }

    let wallet = await cryptoRailProvider.getWallet(auth.userId);
    if (!wallet && cryptoRailProvider.isRailConfigured()) {
      wallet = await cryptoRailProvider.createWallet(auth.userId);
    }
    if (!wallet) {
      res.status(404).json({ success: false, error: "Crypto wallet not found" });
      return;
    }

    const qrDataUrl = await QRCode.toDataURL(wallet.address, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 256,
    });

    res.json({
      success: true,
      data: {
        address: wallet.address,
        chain: wallet.chain,
        asset: wallet.asset || "USDC",
        walletId: wallet.walletId,
        qrDataUrl,
        qrPayload: wallet.address,
      },
    });
  } catch (err) {
    console.error("GET /crypto/wallet failed", { userId: auth.userId, error: err.message });
    res.status(500).json({ success: false, error: "Failed to load crypto wallet" });
  }
});

/**
 * GET /crypto/wallet/status
 * Read-only: is this user still on a Fuji testnet address?
 * Never creates Fuji or production wallets. userId comes from the token.
 */
app.get("/crypto/wallet/status", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({success: false, error: "Unauthorized"});
    return;
  }

  try {
    const result = await turnkeyWalletService.getCustomerWalletNetworkStatus(auth.userId);
    res.json(result);
  } catch (err) {
    console.error("GET /crypto/wallet/status failed", {userId: auth.userId, error: err.message});
    res.status(500).json({success: false, error: "Failed to load wallet status"});
  }
});

/**
 * GET /crypto/balance
 */
app.get("/crypto/balance", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  try {
    const balance = await cryptoRailProvider.getBalance(auth.userId);
    res.json({
      success: true,
      data: {
        USDC: balance,
        asset: "USDC",
      },
    });
  } catch (err) {
    console.error("GET /crypto/balance failed", { userId: auth.userId, error: err.message });
    res.status(500).json({ success: false, error: "Failed to load balance" });
  }
});

/**
 * GET /crypto/transactions
 */
app.get("/crypto/transactions", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  try {
    const limit = Number(req.query.limit) || 50;
    const transactions = await cryptoRailProvider.listTransactions(auth.userId, limit);
    res.json({ success: true, data: { transactions } });
  } catch (err) {
    console.error("GET /crypto/transactions failed", { userId: auth.userId, error: err.message });
    res.status(500).json({ success: false, error: "Failed to load transactions" });
  }
});

/**
 * POST /crypto/send
 */
app.post("/crypto/send", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  if (!checkSendRateLimit(auth.userId)) {
    res.status(429).json({ success: false, error: "Rate limit exceeded. Try again later." });
    return;
  }

  const { toAddress, amount } = req.body || {};
  if (!toAddress || amount == null) {
    res.status(400).json({ success: false, error: "toAddress and amount are required" });
    return;
  }

  const idempotencyKey = req.get("X-Idempotency-Key");
  if (!idempotencyKey) {
    res.status(400).json({ success: false, error: "X-Idempotency-Key header is required" });
    return;
  }

  try {
    const wallet = await cryptoRailProvider.getWallet(auth.userId);
    if (!wallet) {
      res.status(404).json({ success: false, error: "Crypto wallet not found" });
      return;
    }

    const result = await cryptoRailProvider.send({
      fromWalletId: wallet.walletId,
      toAddress,
      amount,
      userId: auth.userId,
      idempotencyKey,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    const message = publicErrorMessage(err) || "Send failed";
    const status = err.httpStatus ||
      (message.includes("Insufficient") || message.includes("Idempotency") ||
        message.includes("Invalid") || message.includes("Unsupported") ? 400 :
        message.includes("in progress") ? 409 : 500);
    console.error("POST /crypto/send failed", { userId: auth.userId, error: message });
    res.status(status).json({ success: false, error: message });
  }
});

/**
 * POST /crypto/wallet/production
 * Lazy Avalanche mainnet USDC address. userId comes from the Firebase token.
 */
app.post("/crypto/wallet/production", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({success: false, error: "Unauthorized"});
    return;
  }

  const asset = String((req.body && req.body.asset) || "USDC").toUpperCase();
  if (asset !== "USDC") {
    res.status(400).json({success: false, error: "Only USDC is supported"});
    return;
  }

  try {
    const result = await getOrCreateProductionCustomerDepositAddress(auth.userId);
    res.json(result);
  } catch (err) {
    const message = err.message || "Failed to load production crypto wallet";
    const status = (err instanceof DepositAddressError || err.name === "DepositAddressError") ?
      (err.code === "INVALID_USER" ? 404 : 400) :
      500;
    console.error("POST /crypto/wallet/production failed", {userId: auth.userId, error: message});
    res.status(status).json({success: false, error: message});
  }
});

/**
 * POST /crypto/deposit/watch
 * Authenticated SafariTap / B2B caller starts a 60s inbound USDC monitor.
 * userId is taken from the Firebase ID token, never from the body.
 */
app.post("/crypto/deposit/watch", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({success: false, error: "Unauthorized"});
    return;
  }

  try {
    const result = await startDepositWatch(auth.userId, req.body || {});
    res.json({
      success: true,
      intentId: result.intentId,
      userId: result.userId,
      asset: result.asset,
      network: result.network,
      address: result.address,
      status: result.status,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    const message = err.message || "Failed to start deposit monitoring";
    const status = (err instanceof DepositWatchError || err.name === "DepositWatchError") ?
      (err.code === "UNAUTHENTICATED" ? 401 : 400) :
      500;
    console.error("POST /crypto/deposit/watch failed", {userId: auth.userId, error: message});
    res.status(status).json({success: false, error: message});
  }
});

exports.cryptoApi = onRequest(
    {
      secrets: [...getCryptoFunctionSecrets(), ...C2B_ENCRYPTION_SECRETS],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);
