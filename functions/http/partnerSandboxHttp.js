/**
 * @fileoverview B2B Partner API — public sandbox (static X-API-KEY, in-memory mocks only).
 * Base path: function name `partnerSandbox` → .../partnerSandbox/rates, etc.
 */

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const b2bSandboxPartnerService = require("../services/b2bSandboxPartnerService");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-API-KEY");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

function requireSandboxKey(req, res, next) {
  const expected = config.b2bSandbox.apiKey;
  if (!expected || !String(expected).trim()) {
    res.status(503).json({
      success: false,
      error: "Sandbox is not configured (set B2B_SANDBOX_PUBLIC_API_KEY on the function)",
    });
    return;
  }
  const apiKey = req.headers?.["x-api-key"] || req.headers?.["X-API-KEY"];
  if (!apiKey || String(apiKey).trim() !== String(expected).trim()) {
    res.status(401).json({ success: false, error: "Invalid or missing X-API-KEY" });
    return;
  }
  req.partnerId = config.b2bSandbox.partnerId;
  next();
}

app.get("/rates", requireSandboxKey, (req, res) => {
  try {
    const fiat = req.query.fiat || config.binance.defaultFiat;
    const asset = req.query.asset || config.binance.defaultAsset;
    const data = b2bSandboxPartnerService.getSandboxRates(fiat, asset);
    res.status(200).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox GET /rates:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/payments", requireSandboxKey, (req, res) => {
  try {
    const { amount, currency = "KES", reference, metadata = {} } = req.body || {};
    if (!amount || Number(amount) <= 0) {
      res.status(400).json({ success: false, error: "Invalid amount" });
      return;
    }
    const data = b2bSandboxPartnerService.recordSandboxPayment(
      req.partnerId,
      Number(amount),
      currency,
      reference,
      metadata
    );
    res.status(201).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox POST /payments:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/transactions", requireSandboxKey, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { transactions } = b2bSandboxPartnerService.listSandboxTransactions(limit);
    res.status(200).json({ success: true, sandbox: true, data: { transactions } });
  } catch (err) {
    console.error("partnerSandbox GET /transactions:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/checkout", requireSandboxKey, (req, res) => {
  try {
    const { amount, currency = "KES" } = req.body || {};
    if (!amount || Number(amount) <= 0) {
      res.status(400).json({ success: false, error: "Invalid amount" });
      return;
    }
    const data = b2bSandboxPartnerService.getSandboxCheckoutPayload(
      req.partnerId,
      Number(amount),
      currency
    );
    res.status(200).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox POST /checkout:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/settlements", requireSandboxKey, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { settlements } = b2bSandboxPartnerService.listSandboxSettlements(req.partnerId, limit);
    res.status(200).json({ success: true, sandbox: true, data: { settlements } });
  } catch (err) {
    console.error("partnerSandbox GET /settlements:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/wallet", requireSandboxKey, (req, res) => {
  try {
    const data = b2bSandboxPartnerService.getSandboxWallet(req.partnerId);
    res.status(200).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox GET /wallet:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/safaricoin/balance", requireSandboxKey, (req, res) => {
  try {
    const data = b2bSandboxPartnerService.getSandboxSafariCoinBalance();
    res.status(200).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox GET /safaricoin/balance:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

exports.partnerSandbox = onRequest(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
  },
  app
);
