/**
 * @fileoverview Consumer crypto API: Circle USDC wallet, balance, transactions, send.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const QRCode = require("qrcode");
const config = require("../config");
const { verifyFirebaseAuth } = require("../libs/auth");
const circleService = require("../services/circle/circleService");
const circleRailAdapter = require("../services/circle/circleRailAdapter");

const app = express();
app.use(express.json());

/** @type {Map<string, { count: number, resetAt: number }>} */
const sendRateLimits = new Map();
const SEND_RATE_LIMIT = 5;
const SEND_RATE_WINDOW_MS = 60 * 1000;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
  ];

  let allowedOrigin = "*";
  if (origin) {
    if (allowedOrigins.includes(origin) || origin.includes("localhost") ||
        origin.includes("127.0.0.1") || origin.includes("truepay-72060")) {
      allowedOrigin = origin;
    }
  }

  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Idempotency-Key");
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
 */
app.get("/crypto/wallet", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  try {
    let wallet = await circleRailAdapter.getWallet(auth.userId);
    if (!wallet && circleService.isCircleConfigured()) {
      wallet = await circleRailAdapter.createWallet(auth.userId);
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
 * GET /crypto/balance
 */
app.get("/crypto/balance", async (req, res) => {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  try {
    const balance = await circleRailAdapter.getBalance(auth.userId);
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
    const transactions = await circleRailAdapter.listTransactions(auth.userId, limit);
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
    const wallet = await circleRailAdapter.getWallet(auth.userId);
    if (!wallet) {
      res.status(404).json({ success: false, error: "Crypto wallet not found" });
      return;
    }

    const result = await circleRailAdapter.send({
      fromWalletId: wallet.walletId,
      toAddress,
      amount,
      userId: auth.userId,
      idempotencyKey,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    const message = err.message || "Send failed";
    const status = message.includes("Insufficient") || message.includes("Idempotency") ? 400 :
      message.includes("in progress") ? 409 : 500;
    console.error("POST /crypto/send failed", { userId: auth.userId, error: message });
    res.status(status).json({ success: false, error: message });
  }
});

const circleApiKey = defineSecret(config.secrets.circleApiKey);
const circleEntitySecret = defineSecret(config.secrets.circleEntitySecret);

exports.cryptoApi = onRequest(
    {
      secrets: [circleApiKey, circleEntitySecret],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);
