/**
 * @fileoverview Per-user B2B dashboard test ledger (isolated from live rails).
 * All sandbox portal features read/write here. Tagged environment: "test".
 */

const crypto = require("crypto");
const {firestore, serverTimestamp} = require("../libs/firestore");
const config = require("../config");

const LEDGER_COL = "partnerTestLedgers";
const LINK_INDEX_COL = "sandboxPaymentLinkIndex";
const MAX_ROWS = 100;

const ENV_TEST = "test";
const ENV_LIVE = "live";

const SEED_BALANCES = Object.freeze({
  KES: 10000,
  USD: 0,
  USDT: 100,
  USDC: 0,
  BTC: 0,
  ETH: 0,
  SOL: 0,
});

const WALLET_CODES = Object.freeze(Object.keys(SEED_BALANCES));

const SCENARIOS = Object.freeze(["success", "fail", "pending", "expire"]);

const SEND_RATES = Object.freeze({
  "KES-USDT": 1 / 129.5,
  "USDT-KES": 129.5,
  "KES-USD": 1 / 129.5,
  "USD-KES": 129.5,
  "USD-USDT": 1,
  "USDT-USD": 1,
});

/**
 * @param {string} message
 * @param {string} code
 * @param {number} statusCode
 * @returns {Error}
 */
function httpError(message, code, statusCode) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

/**
 * @param {string} uid
 * @returns {FirebaseFirestore.DocumentReference}
 */
function ledgerRef(uid) {
  return firestore.collection(LEDGER_COL).doc(uid);
}

/**
 * @param {unknown} amount
 * @param {string} [scenario]
 * @returns {"success"|"fail"|"pending"|"expire"}
 */
function resolveScenario(amount, scenario) {
  const explicit = String(scenario || "").trim().toLowerCase();
  if (SCENARIOS.includes(explicit)) {
    return explicit;
  }
  const n = Math.trunc(Math.abs(Number(amount) || 0));
  const last2 = n % 100;
  if (last2 === 1) {
    return "fail";
  }
  if (last2 === 2) {
    return "pending";
  }
  if (last2 === 3) {
    return "expire";
  }
  return "success";
}

/**
 * @param {"success"|"fail"|"pending"|"expire"} scenario
 * @returns {string}
 */
function statusFromScenario(scenario) {
  if (scenario === "fail") {
    return "failed";
  }
  if (scenario === "pending") {
    return "pending";
  }
  if (scenario === "expire") {
    return "expired";
  }
  return "completed";
}

/**
 * @param {unknown} currency
 * @returns {string}
 */
function normCurrency(currency) {
  const c = String(currency || "KES").trim().toUpperCase();
  if (!WALLET_CODES.includes(c)) {
    throw httpError(
        `Unsupported test currency. Use one of: ${WALLET_CODES.join(", ")}`,
        "INVALID_CURRENCY",
        400,
    );
  }
  return c;
}

/**
 * @param {unknown} amount
 * @returns {number}
 */
function positiveAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw httpError("Invalid amount", "INVALID_AMOUNT", 400);
  }
  return Math.round(n * 1e8) / 1e8;
}

/**
 * @param {number} amount
 * @returns {number}
 */
function collectionFee(amount) {
  return Math.round(amount * 0.015 * 100) / 100;
}

/**
 * @returns {string}
 */
function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * @param {Object} balances
 * @param {string} currency
 * @param {number} delta
 * @returns {Object}
 */
function applyBalance(balances, currency, delta) {
  const next = {...SEED_BALANCES, ...(balances || {})};
  const cur = Number(next[currency] || 0) + delta;
  if (cur < -1e-9) {
    throw httpError("Insufficient test wallet balance", "INSUFFICIENT_FUNDS", 400);
  }
  next[currency] = Math.round(cur * 1e8) / 1e8;
  return next;
}

/**
 * @param {Object} row
 * @returns {Object}
 */
function tagRow(row) {
  return {
    ...row,
    sandbox: true,
    environment: ENV_TEST,
    metadata: {
      ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
      sandbox: true,
      environment: ENV_TEST,
    },
  };
}

/**
 * Ensure ledger exists and is seeded. Idempotent.
 *
 * @param {string} uid
 * @param {string|null} [partnerId]
 * @returns {Promise<Object>}
 */
async function ensureLedger(uid, partnerId = null) {
  const ref = ledgerRef(uid);
  const snap = await ref.get();
  const now = new Date().toISOString();
  if (!snap.exists) {
    const doc = {
      partnerId: partnerId || null,
      environment: ENV_TEST,
      testWalletReady: true,
      balances: {...SEED_BALANCES},
      seededAt: now,
      transactions: [],
      paymentLinks: [],
      recipients: [],
      sendPayments: [],
      settlements: [],
      webhookEvents: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await ref.set(doc);
    return {...doc, uid};
  }
  const data = snap.data() || {};
  const updates = {};
  if (data.testWalletReady !== true || !data.balances) {
    updates.balances = {...SEED_BALANCES, ...(data.balances || {})};
    updates.testWalletReady = true;
    updates.seededAt = data.seededAt || now;
  }
  if (partnerId && !data.partnerId) {
    updates.partnerId = partnerId;
  }
  if (Object.keys(updates).length > 0) {
    updates.updatedAt = serverTimestamp();
    await ref.set(updates, {merge: true});
  }
  return {
    uid,
    ...data,
    ...updates,
    balances: updates.balances || {...SEED_BALANCES, ...(data.balances || {})},
    testWalletReady: true,
    environment: data.environment === ENV_LIVE ? ENV_LIVE : ENV_TEST,
  };
}

/**
 * @param {string} uid
 * @param {boolean} merchantActive
 * @returns {Promise<{
 *   environment: string,
 *   canUseLive: boolean,
 *   testWalletReady: boolean,
 *   preferredEnvironment: string,
 * }>}
 */
async function getEnvironmentSession(uid, merchantActive) {
  const ledger = await ensureLedger(uid);
  const canUseLive = merchantActive === true;
  const preferred =
    ledger.environment === ENV_LIVE ? ENV_LIVE : ENV_TEST;
  return {
    environment: canUseLive ? preferred : ENV_TEST,
    canUseLive,
    testWalletReady: ledger.testWalletReady === true,
    preferredEnvironment: preferred,
  };
}

/**
 * @param {string} uid
 * @param {string} environment
 * @param {boolean} canUseLive
 * @returns {Promise<{ environment: string, canUseLive: boolean }>}
 */
async function setEnvironment(uid, environment, canUseLive) {
  const next = String(environment || "").trim().toLowerCase();
  if (next !== ENV_TEST && next !== ENV_LIVE) {
    throw httpError("environment must be test or live", "INVALID_ENVIRONMENT", 400);
  }
  if (next === ENV_LIVE && canUseLive !== true) {
    throw httpError(
        "Live mode is locked until the merchant is active",
        "LIVE_NOT_ALLOWED",
        403,
    );
  }
  await ensureLedger(uid);
  await ledgerRef(uid).set(
      {environment: next, updatedAt: serverTimestamp()},
      {merge: true},
  );
  return {environment: next, canUseLive: canUseLive === true};
}

/**
 * @param {FirebaseFirestore.Transaction} t
 * @param {string} uid
 * @param {string} field
 * @param {Object} row
 * @param {Object} [extra]
 */
function prependField(t, ref, data, field, row, extra = {}) {
  const existing = Array.isArray(data[field]) ? data[field] : [];
  const next = [row, ...existing.filter((r) => r && r.id !== row.id)].slice(0, MAX_ROWS);
  t.set(
      ref,
      {
        [field]: next,
        ...extra,
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );
  return next;
}

/**
 * Record a collection (test payment / link pay). Credits wallet on success.
 *
 * @param {string} uid
 * @param {Object} input
 * @returns {Promise<Object>}
 */
async function recordCollection(uid, input = {}) {
  const amount = positiveAmount(input.amount);
  const currency = normCurrency(input.currency || "KES");
  const scenario = resolveScenario(amount, input.scenario);
  const status = statusFromScenario(scenario);
  const fee = collectionFee(amount);
  const net = Math.round((amount - fee) * 100) / 100;
  const partnerId = input.partnerId || config.b2bSandbox.partnerId;
  const now = new Date().toISOString();
  const transactionId = newId("sbx_tx");
  const movesWallet = status === "completed";

  const tx = tagRow({
    id: transactionId,
    transactionId,
    type: "b2b_payment",
    partnerId,
    amount,
    fee,
    net,
    currency,
    status,
    scenario,
    payerName: input.payerName ? String(input.payerName) : null,
    createdAt: now,
    updatedAt: now,
    metadata: {
      reference: input.reference != null ? String(input.reference) : null,
      linkId: input.linkId || null,
      bookingReference: input.bookingReference || null,
      payerName: input.payerName || null,
      source: input.source || "portal",
    },
  });

  const ref = ledgerRef(uid);
  let newBalance = null;
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const data = snap.exists ? snap.data() : {};
    let balances = {...SEED_BALANCES, ...(data.balances || {})};
    if (movesWallet) {
      balances = applyBalance(balances, currency, net);
    }
    newBalance = balances[currency];
    prependField(t, ref, snap.exists ? data : {}, "transactions", tx, {
      balances,
      testWalletReady: true,
      partnerId: data.partnerId || partnerId || null,
    });
  });

  return {
    ...tx,
    previousBalance: null,
    newBalance,
    reference: tx.metadata.reference,
  };
}

/**
 * Instant test fund (no card / M-Pesa / chain).
 *
 * @param {string} uid
 * @param {Object} input
 * @returns {Promise<Object>}
 */
async function fundWallet(uid, input = {}) {
  const amount = positiveAmount(input.amount);
  const currency = normCurrency(input.currency || "KES");
  const now = new Date().toISOString();
  const transactionId = newId("sbx_fund");
  const partnerId = input.partnerId || null;
  const tx = tagRow({
    id: transactionId,
    transactionId,
    type: "b2b_funding",
    partnerId,
    amount,
    fee: 0,
    net: amount,
    currency,
    status: "completed",
    scenario: "success",
    createdAt: now,
    updatedAt: now,
    metadata: {reference: input.reference || "test-fund", source: "test_fund"},
  });

  const ref = ledgerRef(uid);
  let balances;
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const data = snap.exists ? snap.data() : {};
    balances = applyBalance(
        {...SEED_BALANCES, ...(data.balances || {})},
        currency,
        amount,
    );
    prependField(t, ref, snap.exists ? data : {}, "transactions", tx, {balances});
  });
  return {transaction: tx, wallet: serializeWallet(uid, balances)};
}

/**
 * @param {string} uid
 * @param {Object} balances
 * @returns {Object}
 */
function serializeWallet(uid, balances) {
  const b = {...SEED_BALANCES, ...(balances || {})};
  return {
    walletId: `sbx_wallet_${uid}`,
    balances: WALLET_CODES.map((code) => ({
      currency: code,
      available: Number(b[code] || 0),
      pending: 0,
    })),
    sandbox: true,
    environment: ENV_TEST,
  };
}

/**
 * @param {string} uid
 * @param {string|null} [partnerId]
 * @returns {Promise<Object>}
 */
async function getWallet(uid, partnerId = null) {
  const ledger = await ensureLedger(uid, partnerId);
  return serializeWallet(uid, ledger.balances);
}

/**
 * @param {string} uid
 * @param {number} [limit]
 * @returns {Promise<{ transactions: Object[], sandbox: boolean, environment: string }>}
 */
async function listTransactions(uid, limit = 50) {
  await ensureLedger(uid);
  const snap = await ledgerRef(uid).get();
  const txs = Array.isArray(snap.data()?.transactions) ? snap.data().transactions : [];
  return {
    transactions: txs.slice(0, Math.min(limit, MAX_ROWS)),
    sandbox: true,
    environment: ENV_TEST,
  };
}

/**
 * @param {string} uid
 * @param {Object} body
 * @param {string|null} partnerId
 * @returns {Promise<Object>}
 */
async function createPaymentLink(uid, body, partnerId = null) {
  await ensureLedger(uid, partnerId);
  const amount = positiveAmount(body.amount);
  const currency = String(body.currency || "KES").trim().toUpperCase();
  if (!WALLET_CODES.includes(currency) && currency !== "USD") {
    normCurrency(currency);
  }
  const bookingReference = String(body.bookingReference || body.bookingRef || "").trim();
  if (!bookingReference) {
    throw httpError("bookingReference is required", "INVALID_ARGUMENT", 400);
  }
  const linkId = newId("sbxpl");
  const now = new Date().toISOString();
  const projectId = process.env.GCLOUD_PROJECT || "truepay-72060";
  const base =
    `https://${config.region}-${projectId}.cloudfunctions.net/b2bPortal`;
  const url = `${base}/public/sandbox/l/${linkId}`;
  const link = tagRow({
    id: linkId,
    linkId,
    partnerId: partnerId || null,
    amount,
    currency,
    bookingReference,
    description: body.description ? String(body.description).trim() : null,
    status: "active",
    paymentCount: 0,
    lastPaidAt: null,
    lastPayerName: null,
    lastTransactionId: null,
    url,
    createdAt: now,
    updatedAt: now,
  });

  const ref = ledgerRef(uid);
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    prependField(t, ref, snap.exists ? snap.data() : {}, "paymentLinks", link);
  });
  await firestore.collection(LINK_INDEX_COL).doc(linkId).set({
    uid,
    partnerId: partnerId || null,
    createdAt: serverTimestamp(),
  });
  return link;
}

/**
 * @param {string} uid
 * @param {number} [limit]
 * @returns {Promise<{ paymentLinks: Object[], nextPageCursor: null }>}
 */
async function listPaymentLinks(uid, limit = 50) {
  await ensureLedger(uid);
  const snap = await ledgerRef(uid).get();
  const links = Array.isArray(snap.data()?.paymentLinks) ? snap.data().paymentLinks : [];
  return {
    paymentLinks: links.slice(0, Math.min(limit, MAX_ROWS)),
    nextPageCursor: null,
    sandbox: true,
    environment: ENV_TEST,
  };
}

/**
 * @param {string} uid
 * @param {string} linkId
 * @returns {Promise<Object|null>}
 */
async function getPaymentLink(uid, linkId) {
  const {paymentLinks} = await listPaymentLinks(uid, MAX_ROWS);
  return paymentLinks.find((l) => l.id === linkId || l.linkId === linkId) || null;
}

/**
 * @param {string} linkId
 * @returns {Promise<{ uid: string, partnerId: string|null }|null>}
 */
async function resolveLinkOwner(linkId) {
  const snap = await firestore.collection(LINK_INDEX_COL).doc(String(linkId || "")).get();
  if (!snap.exists) {
    return null;
  }
  const uid = snap.data()?.uid;
  if (!uid) {
    return null;
  }
  return {uid, partnerId: snap.data()?.partnerId || null};
}

/**
 * @param {string} uid
 * @param {string} linkId
 * @param {Object} input
 * @returns {Promise<Object>}
 */
async function payPaymentLink(uid, linkId, input = {}) {
  const link = await getPaymentLink(uid, linkId);
  if (!link) {
    throw httpError("Payment link not found", "LINK_NOT_FOUND", 404);
  }
  if (link.status === "cancelled") {
    throw httpError("Payment link is cancelled", "LINK_CANCELLED", 400);
  }
  const payment = await recordCollection(uid, {
    amount: input.amount != null ? input.amount : link.amount,
    currency: input.currency || link.currency,
    scenario: input.scenario,
    reference: input.reference || link.bookingReference,
    payerName: input.payerName || input.guestName || "Test payer",
    linkId: link.linkId,
    bookingReference: link.bookingReference,
    partnerId: link.partnerId,
    source: "test_checkout",
  });

  if (payment.status === "completed") {
    const now = new Date().toISOString();
    const ref = ledgerRef(uid);
    await firestore.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const data = snap.data() || {};
      const links = Array.isArray(data.paymentLinks) ? data.paymentLinks : [];
      const next = links.map((l) => {
        if (l.id !== link.id) {
          return l;
        }
        return {
          ...l,
          paymentCount: Number(l.paymentCount || 0) + 1,
          lastPaidAt: now,
          lastPayerName: payment.payerName,
          lastTransactionId: payment.transactionId,
          updatedAt: now,
        };
      });
      t.set(ref, {paymentLinks: next, updatedAt: serverTimestamp()}, {merge: true});
    });
  }
  return payment;
}

/**
 * @param {string} uid
 * @param {string} linkId
 * @returns {Promise<Object>}
 */
async function cancelPaymentLink(uid, linkId) {
  const link = await getPaymentLink(uid, linkId);
  if (!link) {
    throw httpError("Payment link not found", "LINK_NOT_FOUND", 404);
  }
  const now = new Date().toISOString();
  const cancelled = {...link, status: "cancelled", updatedAt: now};
  const ref = ledgerRef(uid);
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const links = Array.isArray(snap.data()?.paymentLinks) ? snap.data().paymentLinks : [];
    t.set(
        ref,
        {
          paymentLinks: links.map((l) => (l.id === link.id ? cancelled : l)),
          updatedAt: serverTimestamp(),
        },
        {merge: true},
    );
  });
  return cancelled;
}

/**
 * @param {string} uid
 * @param {string|null} partnerId
 * @returns {Promise<Object>}
 */
async function getProfileQr(uid, partnerId = null) {
  const link = await createPaymentLink(uid, {
    amount: 1,
    currency: "KES",
    bookingReference: "OPEN-QR",
    description: "Test profile QR (open amount at checkout)",
  }, partnerId);
  return {
    merchantId: partnerId || `sbx_${uid.slice(0, 8)}`,
    payUrl: link.url,
    qrPayload: link.url,
    sandbox: true,
    environment: ENV_TEST,
  };
}

/**
 * @param {string} uid
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function createRecipient(uid, body = {}) {
  await ensureLedger(uid);
  const now = new Date().toISOString();
  const recipient = tagRow({
    id: newId("sbx_rcpt"),
    name: String(body.name || body.accountName || "Test recipient").trim(),
    currency: String(body.currency || "KES").toUpperCase(),
    accountNumber: String(body.accountNumber || "0000000000"),
    bankName: body.bankName ? String(body.bankName) : "Test Bank",
    createdAt: now,
    updatedAt: now,
  });
  const ref = ledgerRef(uid);
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    prependField(t, ref, snap.exists ? snap.data() : {}, "recipients", recipient);
  });
  return recipient;
}

/**
 * @param {string} uid
 * @returns {Promise<{ recipients: Object[] }>}
 */
async function listRecipients(uid) {
  await ensureLedger(uid);
  const snap = await ledgerRef(uid).get();
  const recipients = Array.isArray(snap.data()?.recipients) ? snap.data().recipients : [];
  return {recipients, sandbox: true, environment: ENV_TEST};
}

/**
 * @param {Object} input
 * @returns {Object}
 */
function quoteSend(input = {}) {
  const amount = positiveAmount(input.amount);
  const fromCurrency = String(input.fromCurrency || input.from || "KES").toUpperCase();
  const toCurrency = String(input.toCurrency || input.to || "USDT").toUpperCase();
  const key = `${fromCurrency}-${toCurrency}`;
  const rate = SEND_RATES[key] != null ? SEND_RATES[key] : 1;
  const fee = Math.round(amount * 0.01 * 100) / 100;
  const sendAmount = Math.round((amount - fee) * 100) / 100;
  const receiveAmount = Math.round(sendAmount * rate * 1e6) / 1e6;
  return {
    quoteId: newId("sbx_q"),
    fromCurrency,
    toCurrency,
    amount,
    fee,
    sendAmount,
    receiveAmount,
    rate,
    rail: input.rail || "bank_transfer",
    sandbox: true,
    environment: ENV_TEST,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

/**
 * @param {string} uid
 * @param {Object} input
 * @returns {Promise<Object>}
 */
async function createSend(uid, input = {}) {
  const quote = quoteSend(input);
  const scenario = resolveScenario(quote.amount, input.scenario);
  const status = statusFromScenario(scenario);
  const now = new Date().toISOString();
  const paymentId = newId("sbx_send");
  const partnerId = input.partnerId || null;
  const debit = status === "failed" || status === "expired" ? 0 : quote.amount;

  const payment = tagRow({
    id: paymentId,
    paymentId,
    type: "b2b_send",
    partnerId,
    amount: quote.amount,
    fee: quote.fee,
    net: quote.sendAmount,
    receiveAmount: quote.receiveAmount,
    currency: quote.fromCurrency,
    toCurrency: quote.toCurrency,
    rate: quote.rate,
    status,
    scenario,
    recipientId: input.recipientId || null,
    recipient: input.recipient || null,
    createdAt: now,
    updatedAt: now,
    metadata: {reference: input.paymentReference || input.reference || null},
  });

  const tx = tagRow({
    id: paymentId,
    transactionId: paymentId,
    type: "b2b_send",
    partnerId,
    amount: quote.amount,
    fee: quote.fee,
    net: quote.sendAmount,
    currency: quote.fromCurrency,
    status,
    scenario,
    createdAt: now,
    updatedAt: now,
    metadata: {paymentId, reference: payment.metadata.reference},
  });

  const ref = ledgerRef(uid);
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const data = snap.exists ? snap.data() : {};
    let balances = {...SEED_BALANCES, ...(data.balances || {})};
    if (debit > 0) {
      balances = applyBalance(balances, quote.fromCurrency, -debit);
    }
    prependField(t, ref, data, "sendPayments", payment, {balances});
    const txs = Array.isArray(data.transactions) ? data.transactions : [];
    t.set(
        ref,
        {
          transactions: [tx, ...txs.filter((r) => r.id !== tx.id)].slice(0, MAX_ROWS),
          updatedAt: serverTimestamp(),
        },
        {merge: true},
    );
  });
  return {payment, quote};
}

/**
 * @param {string} uid
 * @returns {Promise<{ payments: Object[] }>}
 */
async function listSends(uid) {
  await ensureLedger(uid);
  const snap = await ledgerRef(uid).get();
  const payments = Array.isArray(snap.data()?.sendPayments) ? snap.data().sendPayments : [];
  return {payments, sandbox: true, environment: ENV_TEST};
}

/**
 * Simulated payout — never hits a bank / M-Pesa / chain.
 *
 * @param {string} uid
 * @param {Object} input
 * @returns {Promise<Object>}
 */
async function createSettlement(uid, input = {}) {
  const amount = positiveAmount(input.amount);
  const currency = normCurrency(input.currency || "KES");
  const scenario = resolveScenario(amount, input.scenario);
  const status = statusFromScenario(scenario);
  const now = new Date().toISOString();
  const settlementId = newId("sbx_stl");
  const debit = status === "completed" || status === "pending";
  const row = tagRow({
    id: settlementId,
    settlementId,
    type: "settlement",
    amount,
    currency,
    status: status === "completed" ? "completed" : status,
    scenario,
    destination: input.destination || "test_bank",
    createdAt: now,
    updatedAt: now,
    metadata: {reference: input.reference || null},
  });
  const tx = tagRow({
    id: settlementId,
    transactionId: settlementId,
    type: "settlement",
    amount,
    currency,
    status: row.status,
    scenario,
    createdAt: now,
    updatedAt: now,
    metadata: {settlementId},
  });
  const ref = ledgerRef(uid);
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const data = snap.exists ? snap.data() : {};
    let balances = {...SEED_BALANCES, ...(data.balances || {})};
    if (debit) {
      balances = applyBalance(balances, currency, -amount);
    }
    prependField(t, ref, data, "settlements", row, {balances});
    const txs = Array.isArray(data.transactions) ? data.transactions : [];
    t.set(
        ref,
        {
          transactions: [tx, ...txs.filter((r) => r.id !== tx.id)].slice(0, MAX_ROWS),
          updatedAt: serverTimestamp(),
        },
        {merge: true},
    );
  });
  return row;
}

/**
 * @param {string} uid
 * @returns {Promise<{ settlements: Object[] }>}
 */
async function listSettlements(uid) {
  await ensureLedger(uid);
  const snap = await ledgerRef(uid).get();
  const settlements = Array.isArray(snap.data()?.settlements) ? snap.data().settlements : [];
  return {settlements, sandbox: true, environment: ENV_TEST};
}

/**
 * @param {string} uid
 * @returns {Promise<Object>}
 */
async function getDashboard(uid) {
  const {transactions} = await listTransactions(uid, MAX_ROWS);
  const completed = transactions.filter((t) => t.status === "completed");
  const collections = completed.filter((t) => t.type === "b2b_payment");
  const collected = collections.reduce((s, t) => s + Number(t.amount || 0), 0);
  const kesSettled = completed
      .filter((t) => t.type === "settlement" && t.currency === "KES")
      .reduce((s, t) => s + Number(t.amount || 0), 0);
  const {payments} = await listSends(uid);
  return {
    scope: "partner",
    partnerId: null,
    channel: "b2b",
    sandbox: true,
    environment: ENV_TEST,
    summary: {
      totalPaymentsCollected: Math.round(collected * 100) / 100,
      kesSettled: {amount: Math.round(kesSettled * 100) / 100, currency: "KES"},
      transactionCount: transactions.length,
      completedPaymentCount: collections.length,
      pendingSettlements: {count: 0, amount: 0, currency: "KES"},
      conversionRate: transactions.length ?
        Math.round((collections.length / transactions.length) * 10000) / 100 :
        0,
    },
    recentCollections: collections.slice(0, 10),
    recentSends: payments.slice(0, 10),
    activityFeed: transactions.slice(0, 15).map((t) => ({
      id: t.id,
      type: t.type,
      title: t.type,
      message: `${t.currency} ${t.amount}`,
      createdAt: t.createdAt,
      source: "transaction",
    })),
  };
}

/**
 * @param {string} uid
 * @returns {Promise<Object>}
 */
async function getReports(uid) {
  const dash = await getDashboard(uid);
  return {
    sandbox: true,
    environment: ENV_TEST,
    summary: dash.summary,
    collections: dash.recentCollections,
    sends: dash.recentSends,
  };
}

/**
 * Store a test webhook payload (does not call live rails).
 *
 * @param {string} uid
 * @param {Object} [body]
 * @returns {Promise<Object>}
 */
async function enqueueTestWebhook(uid, body = {}) {
  await ensureLedger(uid);
  const now = new Date().toISOString();
  const event = tagRow({
    id: newId("sbx_wh"),
    event: body.event || "payment.completed",
    delivered: false,
    createdAt: now,
    payload: {
      sandbox: true,
      environment: ENV_TEST,
      ...(body.payload && typeof body.payload === "object" ? body.payload : body),
    },
  });
  const ref = ledgerRef(uid);
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    prependField(t, ref, snap.exists ? snap.data() : {}, "webhookEvents", event);
  });
  return event;
}

module.exports = {
  ENV_TEST,
  ENV_LIVE,
  SEED_BALANCES,
  WALLET_CODES,
  resolveScenario,
  statusFromScenario,
  ensureLedger,
  getEnvironmentSession,
  setEnvironment,
  recordCollection,
  fundWallet,
  getWallet,
  listTransactions,
  createPaymentLink,
  listPaymentLinks,
  getPaymentLink,
  resolveLinkOwner,
  payPaymentLink,
  cancelPaymentLink,
  getProfileQr,
  createRecipient,
  listRecipients,
  quoteSend,
  createSend,
  listSends,
  createSettlement,
  listSettlements,
  getDashboard,
  getReports,
  enqueueTestWebhook,
};
