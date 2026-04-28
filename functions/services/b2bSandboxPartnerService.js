/**
 * @fileoverview In-memory B2B Partner API sandbox — deterministic fixtures + ephemeral state.
 * Used only by the `partnerSandbox` HTTP function (no Firestore).
 */

const config = require("../config");

/** @type {{ KES: number, USD: number, USDT: number }} */
let walletBalances = { KES: 25000, USD: 100, USDT: 50 };

/** @type {Array<Object>} */
let transactions = [];

let txSeq = 0;

const FIAT_MARKET = {
  KES: 129.5,
  NGN: 1580,
  GHS: 15.2,
};

const FEE_DECIMAL = 0.015;

/**
 * Fiat and asset codes supported in the sandbox (fixtures + in-memory wallet).
 * @returns {{ fiats: string[], assets: string[], paymentCurrencies: string[], defaultFiat: string, defaultAsset: string, all: string[] }}
 */
function getSandboxCurrencies() {
  const defaultFiat = String(config.binance.defaultFiat || "KES").toUpperCase();
  const defaultAsset = String(config.binance.defaultAsset || "USDT").toUpperCase();
  const fiats = Object.keys(FIAT_MARKET).map((c) => c.toUpperCase()).sort();
  const assets = [defaultAsset];
  const paymentCurrencies = Object.keys(walletBalances)
    .map((c) => c.toUpperCase())
    .sort();
  const all = [...new Set([...fiats, ...assets, ...paymentCurrencies])].sort();
  return { fiats, assets, paymentCurrencies, defaultFiat, defaultAsset, all };
}

/**
 * @param {string} fiat
 * @param {string} asset
 * @returns {Object}
 */
function getSandboxRates(fiat, asset) {
  const f = String(fiat || config.binance.defaultFiat).toUpperCase();
  const a = String(asset || config.binance.defaultAsset).toUpperCase();
  const marketPrice = FIAT_MARKET[f] ?? FIAT_MARKET.KES;
  const customerPrice = Math.round(marketPrice * (1 + FEE_DECIMAL) * 100) / 100;
  const now = Date.now();
  return {
    customerPrice,
    feePercentage: FEE_DECIMAL * 100,
    currencyPair: `${a}/${f}`,
    asset: a,
    fiat: f,
    validUntil: new Date(now + 5 * 60 * 1000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    source: "sandbox_fixture",
  };
}

/**
 * All fixture fiat pairs against the default asset (one row per listed fiat market).
 * @returns {{ rates: Object[], defaultAsset: string }}
 */
function getAllSandboxRates() {
  const defaultAsset = String(config.binance.defaultAsset || "USDT").toUpperCase();
  const fiats = Object.keys(FIAT_MARKET);
  const rates = fiats.map((fiat) => getSandboxRates(fiat, defaultAsset));
  return { rates, defaultAsset };
}

/**
 * @param {string} transactionId
 * @returns {Object|null}
 */
function getSandboxTransactionById(transactionId) {
  const id = String(transactionId || "").trim();
  if (!id) return null;
  return transactions.find((t) => t.id === id) || null;
}

function nextSandboxTxId() {
  txSeq += 1;
  return `sbx_tx_${Date.now()}_${txSeq}`;
}

/**
 * @param {string} partnerId
 * @param {number} amount
 * @param {string} currency
 * @param {string|null} reference
 * @param {Object} metadata
 */
function recordSandboxPayment(partnerId, amount, currency, reference, metadata) {
  const cur = String(currency || "KES").toUpperCase();
  const prev = { ...walletBalances };
  const prevBal = Number(prev[cur] ?? 0);
  const newBal = prevBal + amount;
  walletBalances = { ...walletBalances, [cur]: newBal };
  const transactionId = nextSandboxTxId();
  const row = {
    id: transactionId,
    type: "b2b_payment",
    partnerId,
    amount,
    currency: cur,
    status: "completed",
    metadata: { reference: reference || null, ...metadata },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  transactions.unshift(row);
  if (transactions.length > 500) transactions.pop();
  return {
    transactionId,
    amount,
    currency: cur,
    previousBalance: prevBal,
    newBalance: newBal,
    reference: reference || null,
  };
}

/**
 * @param {number} limit
 */
function listSandboxTransactions(limit) {
  return { transactions: transactions.slice(0, limit) };
}

/**
 * @param {string} partnerId
 * @param {number} amount
 * @param {string} currency
 */
function getSandboxCheckoutPayload(partnerId, amount, currency) {
  const cur = String(currency || "KES").toUpperCase();
  const rates = getSandboxRates(cur, config.binance.defaultAsset);
  return {
    amount,
    currency: cur,
    rate: rates.customerPrice,
    partnerId,
    message:
      "Sandbox: no real payment. Use POST /payments to simulate crediting the in-memory wallet.",
  };
}

/**
 * @param {string} partnerId
 * @param {number} limit
 */
function listSandboxSettlements(partnerId, limit) {
  const fixtures = [
    {
      id: "sbx_stl_demo_1",
      settlementId: "sbx_stl_demo_1",
      partnerId,
      amount: 5000,
      currency: "KES",
      bankAccount: "****1234",
      status: "completed",
      metadata: { note: "sandbox fixture" },
      createdAt: "2026-01-10T10:00:00.000Z",
      updatedAt: "2026-01-11T08:00:00.000Z",
    },
    {
      id: "sbx_stl_demo_2",
      settlementId: "sbx_stl_demo_2",
      partnerId,
      amount: 12000,
      currency: "KES",
      bankAccount: "****5678",
      status: "pending",
      metadata: {},
      createdAt: "2026-02-01T12:00:00.000Z",
      updatedAt: "2026-02-01T12:00:00.000Z",
    },
  ];
  return { settlements: fixtures.slice(0, limit) };
}

/**
 * @param {string} partnerId
 */
function getSandboxWallet(partnerId) {
  return {
    walletId: `sandbox_wallet_${partnerId}`,
    balances: { ...walletBalances },
  };
}

function getSandboxSafariCoinBalance() {
  return { balance: 42 };
}

/** For tests or admin tooling */
function resetSandboxState() {
  walletBalances = { KES: 25000, USD: 100, USDT: 50 };
  transactions = [];
  txSeq = 0;
}

module.exports = {
  getSandboxCurrencies,
  getSandboxRates,
  getAllSandboxRates,
  getSandboxTransactionById,
  recordSandboxPayment,
  listSandboxTransactions,
  getSandboxCheckoutPayload,
  listSandboxSettlements,
  getSandboxWallet,
  getSandboxSafariCoinBalance,
  resetSandboxState,
};
