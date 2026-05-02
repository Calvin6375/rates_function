/**
 * @fileoverview B2B Partner API — public sandbox (static X-API-KEY, in-memory mocks only).
 * Base path: function name `partnerSandbox` → .../partnerSandbox/rates, etc.
 */

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const QRCode = require("qrcode");
const config = require("../config");
const b2bSandboxPartnerService = require("../services/b2bSandboxPartnerService");
const supportedCountriesService = require("../services/supportedCountriesService");

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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Absolute URL for the customer-facing checkout page (emulator vs cloudfunctions.net).
 * @param {import("express").Request} req
 * @param {string} checkoutId
 * @returns {string}
 */
function buildPartnerSandboxCheckoutUrl(req, checkoutId) {
  const encoded = encodeURIComponent(checkoutId);
  const explicit = process.env.B2B_SANDBOX_CHECKOUT_PUBLIC_BASE_URL;
  if (explicit && String(explicit).trim()) {
    return `${String(explicit).replace(/\/$/, "")}/checkout/${encoded}`;
  }
  const project = process.env.GCLOUD_PROJECT || "truepay-72060";
  const region = config.region || "us-central1";
  const fn = "partnerSandbox";
  const xfHost = req.get("x-forwarded-host");
  const host = (xfHost && xfHost.split(",")[0].trim()) || req.get("host") || "";
  const xfProto = req.get("x-forwarded-proto");
  const proto =
    (xfProto && xfProto.split(",")[0].trim()) ||
    (host.startsWith("localhost") ? "http" : "https");

  if (host.includes("localhost")) {
    return `${proto}://${host}/${project}/${region}/${fn}/checkout/${encoded}`;
  }
  if (host.includes("cloudfunctions.net")) {
    return `${proto}://${host}/${fn}/checkout/${encoded}`;
  }
  return `${proto}://${host}/checkout/${encoded}`;
}

/** Customer pay page (no API key — link is the secret). */
app.get("/checkout/:checkoutId", (req, res) => {
  try {
    const row = b2bSandboxPartnerService.getSandboxCheckoutSession(req.params.checkoutId);
    if (!row) {
      res.status(404).type("text/plain").send("Checkout not found.");
      return;
    }
    const amt = Number(row.amount);
    const cur = escapeHtml(row.currency);
    const rate = escapeHtml(String(row.customerFacingRate));
    const pair = escapeHtml(row.currencyPair || "");
    const title = "Sandbox checkout";
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.5rem;background:#0f1419;color:#e6edf3;line-height:1.5;max-width:28rem;}
h1{font-size:1.25rem;font-weight:600;margin:0 0 1rem;}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1.25rem;}
.row{display:flex;justify-content:space-between;gap:1rem;margin:.5rem 0;}
.muted{color:#8b949e;font-size:.875rem;margin-top:1rem;}
a{color:#58a6ff;}
</style>
</head>
<body>
<h1>${title}</h1>
<div class="card">
<div class="row"><span>Amount</span><strong>${amt.toLocaleString("en-US")} ${cur}</strong></div>
<div class="row"><span>Customer rate</span><strong>${rate}</strong></div>
<div class="row"><span>Pair</span><span>${pair}</span></div>
</div>
<p class="muted">Demo only: complete payment out of band. The merchant records it with <code>POST /payments</code> on the Partner Sandbox API.</p>
</body>
</html>`;
    res.status(200).type("text/html; charset=utf-8").send(html);
  } catch (err) {
    console.error("partnerSandbox GET /checkout/:checkoutId:", err.message);
    res.status(500).type("text/plain").send("Error");
  }
});

app.get("/currencies", requireSandboxKey, (req, res) => {
  try {
    const data = b2bSandboxPartnerService.getSandboxCurrencies();
    res.status(200).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox GET /currencies:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/rates/all", requireSandboxKey, (req, res) => {
  try {
    const data = b2bSandboxPartnerService.getAllSandboxRates();
    res.status(200).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox GET /rates/all:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/rates/pair", requireSandboxKey, (req, res) => {
  try {
    const fiat = req.query.fiat || config.binance.defaultFiat;
    const asset = req.query.asset || config.binance.defaultAsset;
    const data = b2bSandboxPartnerService.getSandboxRates(fiat, asset);
    res.status(200).json({ success: true, sandbox: true, data });
  } catch (err) {
    console.error("partnerSandbox GET /rates/pair:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Same as GET /rates/pair — kept for parity with live `GET /partner/rates`. */
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

app.get("/countries", requireSandboxKey, async (req, res) => {
  try {
    const payload = await supportedCountriesService.getSupportedCountries();
    res.status(200).json({
      success: true,
      sandbox: true,
      data: {
        countries: payload.countries,
        updatedAt: payload.updatedAt,
        isDefault: payload.isDefault,
      },
    });
  } catch (err) {
    console.error("partnerSandbox GET /countries:", err.message);
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

app.get("/transactions/:transactionId", requireSandboxKey, (req, res) => {
  try {
    const row = b2bSandboxPartnerService.getSandboxTransactionById(req.params.transactionId);
    if (!row) {
      res.status(404).json({ success: false, sandbox: true, error: "Transaction not found" });
      return;
    }
    res.status(200).json({ success: true, sandbox: true, data: row });
  } catch (err) {
    console.error("partnerSandbox GET /transactions/:transactionId:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/checkout", requireSandboxKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { amount, currency = "KES" } = body;
    const rateField =
      body.customerFacingRate != null
        ? body.customerFacingRate
        : body.customerPrice != null
          ? body.customerPrice
          : body.rate;
    if (!amount || Number(amount) <= 0) {
      res.status(400).json({ success: false, error: "Invalid amount" });
      return;
    }
    const session = b2bSandboxPartnerService.createSandboxCheckoutSession(
      req.partnerId,
      Number(amount),
      currency,
      rateField
    );
    const checkoutUrl = buildPartnerSandboxCheckoutUrl(req, session.checkoutId);
    const qrCodePngDataUrl = await QRCode.toDataURL(checkoutUrl, {
      margin: 1,
      width: 280,
      errorCorrectionLevel: "M",
    });
    const data = {
      ...session,
      checkoutUrl,
      qrCode: qrCodePngDataUrl,
      message:
        "Sandbox: no on-chain move. Customer opens checkoutUrl (or scans qrCode). " +
        "After you collect out-of-band, record with POST /payments.",
    };
    res.status(201).json({ success: true, sandbox: true, data });
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
