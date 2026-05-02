/**
 * @fileoverview B2B Partner API — REST endpoints for hotels, safari operators, fintechs.
 * Authentication: X-API-KEY header. Base path: /partner (Firebase function name).
 */

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const { verifyPartnerRequest } = require("../libs/auth");
const rateService = require("../services/rateService");
const transactionService = require("../services/transactionService");
const settlementService = require("../services/settlementService");
const walletService = require("../services/walletService");
const safariCoinService = require("../services/safariCoinService");
const supportedCountriesService = require("../services/supportedCountriesService");

const app = express();
app.use(express.json());

// CORS
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

/** Middleware: require valid X-API-KEY and attach partnerId */
async function requirePartner(req, res, next) {
  const result = await verifyPartnerRequest(req);
  if (!result.success) {
    res.status(401).json({ success: false, error: result.error || "Unauthorized" });
    return;
  }
  req.partnerId = result.partnerId;
  req.partner = result.partner;
  next();
}

/**
 * GET /partner/rates
 * Get current exchange rates (Binance P2P + fee)
 */
app.get("/rates", requirePartner, async (req, res) => {
  try {
    const fiat = req.query.fiat || config.binance.defaultFiat;
    const asset = req.query.asset || config.binance.defaultAsset;
    const rates = await rateService.getRates(fiat, asset);
    res.status(200).json({ success: true, data: rates });
  } catch (err) {
    console.error("Partner API GET /rates:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /partner/countries
 * Supported country codes for B2B integrations (same list as consumer app).
 */
app.get("/countries", requirePartner, async (req, res) => {
  try {
    const payload = await supportedCountriesService.getSupportedCountries();
    res.status(200).json({
      success: true,
      data: {
        countries: payload.countries,
        updatedAt: payload.updatedAt,
        isDefault: payload.isDefault,
      },
    });
  } catch (err) {
    console.error("Partner API GET /countries:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /partner/payments
 * Record a B2B payment (e.g. tourist pays hotel). Credits partner wallet.
 * Body: { amount, currency, reference?, metadata? }
 */
app.post("/payments", requirePartner, async (req, res) => {
  try {
    const { amount, currency = "KES", reference, metadata = {} } = req.body || {};
    const partnerId = req.partnerId;
    if (!amount || Number(amount) <= 0) {
      res.status(400).json({ success: false, error: "Invalid amount" });
      return;
    }
    const amt = Number(amount);
    const { getOrCreatePartnerWallet, updatePartnerWalletBalance } = walletService;
    await getOrCreatePartnerWallet(partnerId);
    const { previousBalance, newBalance } = await updatePartnerWalletBalance(partnerId, currency, amt);
    const { transactionId } = await transactionService.createTransactionRecord({
      type: transactionService.TRANSACTION_TYPES.b2b_payment,
      partnerId,
      amount: amt,
      currency,
      status: transactionService.STATUSES.completed,
      metadata: { reference, ...metadata },
      logLegacy: false,
    });
    res.status(201).json({
      success: true,
      data: {
        transactionId,
        amount: amt,
        currency,
        previousBalance,
        newBalance,
        reference: reference || null,
      },
    });
  } catch (err) {
    console.error("Partner API POST /payments:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /partner/transactions
 * List transactions for this partner
 */
app.get("/transactions", requirePartner, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { transactions, lastDoc } = await transactionService.listTransactionRecords({
      partnerId: req.partnerId,
      limit,
      startAfter: null, // TODO: cursor from query
    });
    res.status(200).json({ success: true, data: { transactions } });
  } catch (err) {
    console.error("Partner API GET /transactions:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /partner/checkout
 * Create a checkout session (mock: returns rates + partner info for client to complete payment)
 * Body: { amount, currency }
 */
app.post("/checkout", requirePartner, async (req, res) => {
  try {
    const { amount, currency = "KES" } = req.body || {};
    if (!amount || Number(amount) <= 0) {
      res.status(400).json({ success: false, error: "Invalid amount" });
      return;
    }
    const rates = await rateService.getRates(currency, config.binance.defaultAsset);
    res.status(200).json({
      success: true,
      data: {
        amount: Number(amount),
        currency,
        rate: rates.customerPrice,
        partnerId: req.partnerId,
        message: "Complete payment via your preferred channel; use POST /partner/payments to record after payment.",
      },
    });
  } catch (err) {
    console.error("Partner API POST /checkout:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /partner/settlements
 * List settlements for this partner
 */
app.get("/settlements", requirePartner, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { settlements } = await settlementService.listSettlements({
      partnerId: req.partnerId,
      limit,
    });
    res.status(200).json({ success: true, data: { settlements } });
  } catch (err) {
    console.error("Partner API GET /settlements:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /partner/wallet (optional)
 * Get partner wallet balances
 */
app.get("/wallet", requirePartner, async (req, res) => {
  try {
    const wallet = await walletService.getPartnerWallet(req.partnerId);
    if (!wallet) {
      const created = await walletService.getOrCreatePartnerWallet(req.partnerId);
      return res.status(200).json({ success: true, data: created });
    }
    res.status(200).json({ success: true, data: wallet });
  } catch (err) {
    console.error("Partner API GET /wallet:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /partner/safaricoin/balance (mock)
 * Get SafariCoin balance for partner wallet
 */
app.get("/safaricoin/balance", requirePartner, async (req, res) => {
  try {
    const balance = await safariCoinService.getSafariCoinBalance(req.partnerId);
    res.status(200).json({ success: true, data: { balance } });
  } catch (err) {
    console.error("Partner API GET /safaricoin/balance:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 404 */
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

exports.partner = onRequest(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
  },
  app
);
