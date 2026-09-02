/**
 * @fileoverview Product pricing for Revenue Calculator (fee % + flat KES).
 *
 * Suggested values match the dashboard mock UI and are never used to charge.
 * Live charges apply only when a product is enabled in config/productPricing
 * and PRODUCT_PRICING_ENABLED is not false.
 */

const config = require("../../config");
const {collection, serverTimestamp} = require("../../libs/firestore");
const {Decimal, roundAmount} = require("../../utils/money");

const CONFIG_DOC = "productPricing";
const FORMULA = "charge = amount * (feePercent / 100) + flatFeeKes";

/**
 * Static catalog: labels, categories, UI-suggested defaults, live-path hints.
 * Writable fee fields live in Firestore; this map is not admin-editable.
 */
const CATALOG = Object.freeze({
  buy_goods: Object.freeze({
    key: "buy_goods",
    label: "Buy Goods (Till)",
    category: "pay",
    currency: "KES",
    suggested: Object.freeze({feePercent: 1.5, flatFeeKes: 0}),
    liveChargePath: "safari_card_mpesa_b2b_till",
    feeModel: "wallet_debit_surcharge",
    adminHint: "Fee is added to the Safari Card Pay debit (customer pays amount + fee from wallet).",
  }),
  pay_bill: Object.freeze({
    key: "pay_bill",
    label: "Pay Bill",
    category: "pay",
    currency: "KES",
    suggested: Object.freeze({feePercent: 1.25, flatFeeKes: 10}),
    liveChargePath: "safari_card_mpesa_b2b_paybill",
    feeModel: "wallet_debit_surcharge",
    adminHint: "Fee is added to the Safari Card Pay debit (customer pays amount + fee from wallet).",
  }),
  pochi: Object.freeze({
    key: "pochi",
    label: "Pochi la Biashara",
    category: "pay",
    currency: "KES",
    suggested: Object.freeze({feePercent: 1, flatFeeKes: 5}),
    liveChargePath: "none",
    feeModel: "none",
    adminHint: "Catalog only — no live charge path yet.",
  }),
  send_ke: Object.freeze({
    key: "send_ke",
    label: "Send — Kenya",
    category: "send",
    currency: "KES",
    suggested: Object.freeze({feePercent: 0.75, flatFeeKes: 15}),
    liveChargePath: "c2b_send_money_and_b2b_send_kes",
    feeModel: "wallet_debit_surcharge",
    adminHint:
      "Fee is added to the sender wallet debit. Applies to C2B Send Money " +
      "(M-Pesa B2C, bank/PesaLink, SafariTap wallet) and B2B Send Kenya corridor.",
  }),
  send_et: Object.freeze({
    key: "send_et",
    label: "Send — Ethiopia",
    category: "send",
    currency: "KES",
    suggested: Object.freeze({feePercent: 1.8, flatFeeKes: 25}),
    liveChargePath: "b2b_send_kes_etb",
    feeModel: "wallet_debit_surcharge",
    adminHint: "Fee is added to partner wallet debit on B2B Send.",
  }),
  send_ug: Object.freeze({
    key: "send_ug",
    label: "Send — Uganda",
    category: "send",
    currency: "KES",
    suggested: Object.freeze({feePercent: 1.6, flatFeeKes: 20}),
    liveChargePath: "b2b_send_kes_ugx",
    feeModel: "wallet_debit_surcharge",
    adminHint: "Fee is added to partner wallet debit on B2B Send.",
  }),
  send_tz: Object.freeze({
    key: "send_tz",
    label: "Send — Tanzania",
    category: "send",
    currency: "KES",
    suggested: Object.freeze({feePercent: 1.7, flatFeeKes: 22}),
    liveChargePath: "b2b_send_kes_tzs",
    feeModel: "wallet_debit_surcharge",
    adminHint: "Fee is added to partner wallet debit on B2B Send.",
  }),
  send_ae: Object.freeze({
    key: "send_ae",
    label: "Send — UAE",
    category: "send",
    currency: "KES",
    suggested: Object.freeze({feePercent: 2, flatFeeKes: 30}),
    liveChargePath: "b2b_send_kes_aed",
    feeModel: "wallet_debit_surcharge",
    adminHint: "Fee is added to partner wallet debit on B2B Send.",
  }),
  local_topup: Object.freeze({
    key: "local_topup",
    label: "Local Topup (Paystack)",
    category: "topup",
    currency: "KES",
    suggested: Object.freeze({feePercent: 2.5, flatFeeKes: 0}),
    liveChargePath: "paystack_local_topup",
    feeModel: "checkout_surcharge",
    adminHint:
      "User enters amount to receive on SafariTap / partner virtual card. " +
      "Paystack is charged amount + fee; wallet is credited the face amount. " +
      "Applies to C2B Local Topup and partner Add Money (not payment links).",
  }),
  payment_links: Object.freeze({
    key: "payment_links",
    label: "Payment Links",
    category: "collection",
    currency: "KES",
    suggested: Object.freeze({feePercent: 2.5, flatFeeKes: 0}),
    liveChargePath: "b2b_payment_link_credit",
    feeModel: "merchant_credit_deduction",
    adminHint:
      "Customer still pays the link face amount. Platform fee is deducted from " +
      "what the partner receives (not added to Paystack / IntaSend checkout).",
  }),
  checkout: Object.freeze({
    key: "checkout",
    label: "Checkout",
    category: "collection",
    currency: "KES",
    suggested: Object.freeze({feePercent: 2.5, flatFeeKes: 0}),
    liveChargePath: "b2b_checkout_credit",
    feeModel: "merchant_credit_deduction",
    adminHint:
      "Customer still pays the checkout face amount. Platform fee is deducted from " +
      "partner credit after settlement.",
  }),
});

/** Shared product key for C2B Local Topup + partner Add Money (Paystack KES). */
const LOCAL_TOPUP_PRODUCT_KEY = "local_topup";

const PRODUCT_KEYS = Object.freeze(Object.keys(CATALOG));

/** B2B Send corridor key → product key (KES-source corridors only). */
const SEND_PRODUCT_BY_CORRIDOR = Object.freeze({
  KES_KES: "send_ke",
  KES_ETB: "send_et",
  KES_UGX: "send_ug",
  KES_TZS: "send_tz",
  KES_AED: "send_ae",
});

/**
 * Live defaults: disabled + zero so charge paths keep legacy fees until enabled.
 * @returns {Record<string, {enabled: boolean, feePercent: number, flatFeeKes: number}>}
 */
function buildLiveDefaults() {
  /** @type {Record<string, {enabled: boolean, feePercent: number, flatFeeKes: number}>} */
  const products = {};
  for (const key of PRODUCT_KEYS) {
    products[key] = {enabled: false, feePercent: 0, flatFeeKes: 0};
  }
  return products;
}

/** @type {{ expiresAt: number, value: Object|null }} */
let cache = {expiresAt: 0, value: null};

/**
 * @returns {void}
 */
function clearCache() {
  cache = {expiresAt: 0, value: null};
}

/**
 * @returns {{ products: Array<Object> }}
 */
function getCatalog() {
  return {
    products: PRODUCT_KEYS.map((key) => {
      const item = CATALOG[key];
      return {
        key: item.key,
        label: item.label,
        category: item.category,
        currency: item.currency,
        suggested: {...item.suggested},
        liveChargePath: item.liveChargePath,
        feeModel: item.feeModel || "none",
        adminHint: item.adminHint || null,
      };
    }),
  };
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") {
    try {
      return value.toDate().toISOString();
    } catch (_e) {
      return null;
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

/**
 * @param {Object} raw
 * @returns {{ enabled: boolean, feePercent: number, flatFeeKes: number, updatedAt: string|null, updatedBy: string|null }}
 */
function normalizeProductEntry(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: data.enabled === true,
    feePercent: Number.isFinite(Number(data.feePercent)) ? Number(data.feePercent) : 0,
    flatFeeKes: Number.isFinite(Number(data.flatFeeKes)) ? Number(data.flatFeeKes) : 0,
    updatedAt: toIso(data.updatedAt),
    updatedBy: data.updatedBy != null ? String(data.updatedBy) : null,
  };
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh]
 * @returns {Promise<{
 *   products: Record<string, Object>,
 *   source: string,
 *   updatedAt: string|null,
 *   updatedBy: string|null,
 *   schemaVersion: number,
 * }>}
 */
async function getPricingConfig(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const ttl = Number(config.productPricing?.cacheTtlMs) || 60000;
  const now = Date.now();
  if (!forceRefresh && cache.value && cache.expiresAt > now) {
    return cache.value;
  }

  const defaults = buildLiveDefaults();
  try {
    const snap = await collection(config.collections.config).doc(CONFIG_DOC).get();
    if (!snap.exists) {
      const value = {
        products: defaults,
        source: "defaults",
        updatedAt: null,
        updatedBy: null,
        schemaVersion: 1,
      };
      cache = {expiresAt: now + ttl, value};
      return value;
    }

    const data = snap.data() || {};
    const stored = data.products && typeof data.products === "object" ? data.products : {};
    /** @type {Record<string, Object>} */
    const products = {};
    for (const key of PRODUCT_KEYS) {
      products[key] = {
        ...defaults[key],
        ...normalizeProductEntry(stored[key]),
      };
    }

    const value = {
      products,
      source: "config/productPricing",
      updatedAt: toIso(data.updatedAt),
      updatedBy: data.updatedBy != null ? String(data.updatedBy) : null,
      schemaVersion: Number(data.schemaVersion) || 1,
    };
    cache = {expiresAt: now + ttl, value};
    return value;
  } catch (err) {
    console.warn("productPricingService.getPricingConfig:", err.message);
    const value = {
      products: defaults,
      source: "defaults_on_error",
      updatedAt: null,
      updatedBy: null,
      schemaVersion: 1,
    };
    cache = {expiresAt: now + Math.min(ttl, 5000), value};
    return value;
  }
}

/**
 * @param {string} productKey
 * @returns {Promise<{key: string, enabled: boolean, feePercent: number, flatFeeKes: number, source: string}|null>}
 */
async function getProductPricing(productKey) {
  const key = String(productKey || "");
  if (!CATALOG[key]) return null;
  const cfg = await getPricingConfig();
  const product = cfg.products[key];
  return {
    key,
    enabled: product.enabled === true,
    feePercent: Number(product.feePercent) || 0,
    flatFeeKes: Number(product.flatFeeKes) || 0,
    source: cfg.source,
  };
}

/**
 * Calculator preview — pure math; never touches charge paths.
 *
 * @param {Object} params
 * @param {number|string} params.amount
 * @param {number|string} params.feePercent
 * @param {number|string} params.flatFeeKes
 * @param {number|string} [params.volume]
 * @param {string} [params.currency]
 * @returns {{ feeAmount: number, customerCharge: number, netAmount: number, projectedRevenue: number|null, currency: string }}
 */
function previewCharge(params) {
  const currency = String(params.currency || "KES").toUpperCase();
  const amount = Number(params.amount);
  const feePercent = Number(params.feePercent);
  const flatFeeKes = Number(params.flatFeeKes);
  if (!Number.isFinite(amount) || amount < 0) {
    const err = new Error("amount must be a number >= 0");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
    const err = new Error("feePercent must be between 0 and 100");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(flatFeeKes) || flatFeeKes < 0) {
    const err = new Error("flatFeeKes must be a number >= 0");
    err.statusCode = 400;
    throw err;
  }

  const feeDec = new Decimal(amount).mul(feePercent).div(100).plus(flatFeeKes);
  const feeAmount = Number(roundAmount(feeDec, currency));
  const customerCharge = Number(roundAmount(new Decimal(amount).plus(feeAmount), currency));
  const volume = params.volume != null ? Number(params.volume) : null;
  const projectedRevenue = Number.isFinite(volume) && volume >= 0 ?
    Number(roundAmount(new Decimal(feeAmount).mul(volume), currency)) :
    null;

  return {
    feeAmount,
    customerCharge,
    netAmount: Number(roundAmount(amount, currency)),
    projectedRevenue,
    currency,
  };
}

/**
 * The only function charge paths should call.
 * applied === false ⇒ caller MUST use pre-existing fee logic unchanged.
 *
 * @param {Object} params
 * @param {string} params.productKey
 * @param {number|string} params.amount
 * @param {string} [params.currency]
 * @returns {Promise<{
 *   applied: boolean,
 *   reason: string|null,
 *   feeAmount: number,
 *   feePercent: number,
 *   flatFee: number,
 *   currency: string,
 *   productKey: string,
 *   source: string,
 * }>}
 */
async function computeProductFee(params) {
  const productKey = String(params.productKey || "");
  const currency = String(params.currency || "KES").toUpperCase();
  const amount = Number(params.amount);

  const base = {
    applied: false,
    reason: null,
    feeAmount: 0,
    feePercent: 0,
    flatFee: 0,
    currency,
    productKey,
    source: "none",
  };

  if (!config.productPricing || config.productPricing.enabled === false) {
    return {...base, reason: "kill_switch"};
  }
  if (!CATALOG[productKey]) {
    return {...base, reason: "unknown_product"};
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return {...base, reason: "invalid_amount"};
  }

  let priced;
  try {
    priced = await getProductPricing(productKey);
  } catch (err) {
    console.warn("productPricingService.computeProductFee:", err.message);
    return {...base, reason: "config_error", source: "defaults_on_error"};
  }

  if (!priced) {
    return {...base, reason: "unknown_product"};
  }
  if (priced.source === "defaults_on_error") {
    return {...base, reason: "config_error", source: priced.source};
  }
  if (!priced.enabled) {
    return {...base, reason: "not_enabled", source: priced.source};
  }

  const feePercent = Number(priced.feePercent) || 0;
  let flatFee = Number(priced.flatFeeKes) || 0;
  let reason = null;

  if (currency !== "KES" && flatFee > 0) {
    flatFee = 0;
    reason = "flat_fee_skipped_non_kes";
  }

  if (feePercent <= 0 && flatFee <= 0) {
    return {
      ...base,
      reason: "zero_pricing",
      feePercent,
      flatFee: 0,
      source: priced.source,
    };
  }

  const feeDec = new Decimal(amount).mul(feePercent).div(100).plus(flatFee);
  const feeAmount = Number(roundAmount(feeDec, currency));

  return {
    applied: true,
    reason,
    feeAmount,
    feePercent,
    flatFee,
    currency,
    productKey,
    source: `product_pricing:${productKey}`,
  };
}

/**
 * @param {Object} patch
 * @param {string} key
 * @returns {{ enabled: boolean, feePercent: number, flatFeeKes: number }}
 */
function validateProductPatch(patch, key) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    const err = new Error(`products.${key} must be an object`);
    err.statusCode = 400;
    throw err;
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    const err = new Error(`products.${key}.enabled must be a boolean`);
    err.statusCode = 400;
    throw err;
  }
  if (patch.feePercent !== undefined) {
    const p = Number(patch.feePercent);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      const err = new Error(`products.${key}.feePercent must be between 0 and 100`);
      err.statusCode = 400;
      throw err;
    }
  }
  if (patch.flatFeeKes !== undefined) {
    const f = Number(patch.flatFeeKes);
    if (!Number.isFinite(f) || f < 0) {
      const err = new Error(`products.${key}.flatFeeKes must be a number >= 0`);
      err.statusCode = 400;
      throw err;
    }
  }
  /** @type {{ enabled?: boolean, feePercent?: number, flatFeeKes?: number }} */
  const out = {};
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.feePercent !== undefined) out.feePercent = Number(patch.feePercent);
  if (patch.flatFeeKes !== undefined) out.flatFeeKes = Number(patch.flatFeeKes);
  return out;
}

/**
 * @param {Object} params
 * @param {Record<string, Object>} params.products
 * @param {string} params.updatedBy
 * @returns {Promise<Object>}
 */
async function updateProductPricing(params) {
  const updatedBy = String(params.updatedBy || "").trim();
  if (!updatedBy) {
    const err = new Error("updatedBy is required");
    err.statusCode = 400;
    throw err;
  }
  const incoming = params.products;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    const err = new Error("products must be an object keyed by product key");
    err.statusCode = 400;
    throw err;
  }

  const keys = Object.keys(incoming);
  if (keys.length === 0) {
    const err = new Error("products must include at least one product");
    err.statusCode = 400;
    throw err;
  }

  for (const key of keys) {
    if (!CATALOG[key]) {
      const err = new Error(`Unknown product key: ${key}`);
      err.statusCode = 400;
      throw err;
    }
    validateProductPatch(incoming[key], key);
  }

  const current = await getPricingConfig({forceRefresh: true});
  /** @type {Record<string, Object>} */
  const merged = {};
  for (const key of PRODUCT_KEYS) {
    const base = {
      enabled: current.products[key].enabled === true,
      feePercent: Number(current.products[key].feePercent) || 0,
      flatFeeKes: Number(current.products[key].flatFeeKes) || 0,
      updatedAt: current.products[key].updatedAt || null,
      updatedBy: current.products[key].updatedBy || null,
    };
    if (incoming[key]) {
      const patch = validateProductPatch(incoming[key], key);
      merged[key] = {
        ...base,
        ...patch,
        updatedAt: new Date().toISOString(),
        updatedBy,
      };
    } else {
      merged[key] = base;
    }
  }

  const ref = collection(config.collections.config).doc(CONFIG_DOC);
  await ref.set({
    schemaVersion: 1,
    products: merged,
    updatedAt: serverTimestamp(),
    updatedBy,
  }, {merge: true});

  clearCache();
  return getPricingConfig({forceRefresh: true});
}

/**
 * Reset every product to live defaults (disabled / zero).
 *
 * @param {Object} params
 * @param {string} params.updatedBy
 * @returns {Promise<Object>}
 */
async function resetToDefaults(params) {
  const updatedBy = String(params.updatedBy || "").trim();
  if (!updatedBy) {
    const err = new Error("updatedBy is required");
    err.statusCode = 400;
    throw err;
  }

  const products = buildLiveDefaults();
  for (const key of PRODUCT_KEYS) {
    products[key] = {
      ...products[key],
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
  }

  const ref = collection(config.collections.config).doc(CONFIG_DOC);
  await ref.set({
    schemaVersion: 1,
    products,
    updatedAt: serverTimestamp(),
    updatedBy,
  }, {merge: true});

  clearCache();
  return getPricingConfig({forceRefresh: true});
}

/**
 * Admin GET payload: catalog + live values + suggested.
 *
 * @returns {Promise<Object>}
 */
async function getAdminPricingView() {
  const cfg = await getPricingConfig();
  const products = PRODUCT_KEYS.map((key) => {
    const catalog = CATALOG[key];
    const live = cfg.products[key];
    return {
      key,
      label: catalog.label,
      category: catalog.category,
      currency: catalog.currency,
      enabled: live.enabled === true,
      feePercent: Number(live.feePercent) || 0,
      flatFeeKes: Number(live.flatFeeKes) || 0,
      suggested: {...catalog.suggested},
      liveChargePath: catalog.liveChargePath,
      feeModel: catalog.feeModel || "none",
      adminHint: catalog.adminHint || null,
      updatedAt: live.updatedAt || null,
      updatedBy: live.updatedBy || null,
    };
  });

  return {
    products,
    source: cfg.source,
    formula: FORMULA,
    /**
     * Preview labels by feeModel — dashboard should bind these so admins
     * are not confused between top-up surcharge vs collection take-rate.
     */
    feeModelLabels: {
      checkout_surcharge: {
        amountLabel: "Wallet credit (face amount)",
        feeLabel: "Platform fee",
        customerChargeLabel: "Paystack / checkout charge",
        netLabel: "Credited to wallet",
        summary:
          "Customer pays face + fee at checkout; wallet receives the face amount.",
      },
      merchant_credit_deduction: {
        amountLabel: "Customer pays (face amount)",
        feeLabel: "Platform fee (from merchant)",
        customerChargeLabel: "Customer pays",
        netLabel: "Partner receives",
        summary:
          "Customer pays the face amount; fee is taken from the partner credit.",
      },
      wallet_debit_surcharge: {
        amountLabel: "Transfer amount",
        feeLabel: "Platform fee",
        customerChargeLabel: "Total wallet debit",
        netLabel: "Recipient / merchant gets",
        summary:
          "Fee is added on top of the transfer and debited from the sender wallet.",
      },
      none: {
        amountLabel: "Amount",
        feeLabel: "Fee",
        customerChargeLabel: "Customer charge",
        netLabel: "Net amount",
        summary: "No live charge path.",
      },
    },
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
    schemaVersion: cfg.schemaVersion,
  };
}

/**
 * Resolve Safari Card Pay product key from payout type + recipient.
 *
 * @param {string} payoutType
 * @param {Object} [recipient]
 * @returns {string|null}
 */
function resolveSafariPayProductKey(payoutType, recipient) {
  if (String(payoutType) !== "MPESA_B2B") return null;
  const accountType = String(recipient?.accountType || "");
  if (accountType === "TillNumber") return "buy_goods";
  if (accountType === "PayBill") return "pay_bill";
  return null;
}

/**
 * Resolve Safari Card Send Money product key (C2B M-Pesa / bank / SafariTap).
 *
 * @param {string} payoutType
 * @returns {string|null}
 */
function resolveSafariSendProductKey(payoutType) {
  const type = String(payoutType || "");
  if (
    type === "MPESA_B2C" ||
    type === "BANK" ||
    type === "SAFARITAP_WALLET"
  ) {
    return "send_ke";
  }
  return null;
}

/**
 * Resolve any Safari Card payout product key (Pay Till/PayBill, then Send).
 *
 * @param {string} payoutType
 * @param {Object} [recipient]
 * @returns {string|null}
 */
function resolveSafariPayoutProductKey(payoutType, recipient) {
  return resolveSafariPayProductKey(payoutType, recipient) ||
    resolveSafariSendProductKey(payoutType);
}

/**
 * @param {string} corridorKey
 * @returns {string|null}
 */
function resolveSendProductKey(corridorKey) {
  return SEND_PRODUCT_BY_CORRIDOR[String(corridorKey || "").toUpperCase()] || null;
}

/**
 * Paystack Local Topup surcharge: wallet credits face KES; checkout charges face + fee.
 *
 * @param {number|string} creditAmountKes - Amount the user entered to receive
 * @returns {Promise<{
 *   creditAmountKes: number,
 *   feeAmount: number,
 *   chargeAmountKes: number,
 *   applied: boolean,
 *   feePercent: number,
 *   flatFee: number,
 *   pricingProductKey: string,
 *   reason: string|null,
 *   source: string,
 * }>}
 */
async function computeLocalTopupPaystackCharge(creditAmountKes) {
  const credit = Number(creditAmountKes);
  if (!Number.isFinite(credit) || credit < 0) {
    const err = new Error("creditAmountKes must be a number >= 0");
    err.statusCode = 400;
    throw err;
  }

  const creditRounded = Number(roundAmount(credit, "KES"));
  const priced = await computeProductFee({
    productKey: LOCAL_TOPUP_PRODUCT_KEY,
    amount: creditRounded,
    currency: "KES",
  });
  const feeAmount = priced.applied ? Number(priced.feeAmount) || 0 : 0;
  const chargeAmountKes = Number(
      roundAmount(new Decimal(creditRounded).plus(feeAmount), "KES"),
  );

  return {
    creditAmountKes: creditRounded,
    feeAmount,
    chargeAmountKes,
    applied: priced.applied === true && feeAmount > 0,
    feePercent: Number(priced.feePercent) || 0,
    flatFee: Number(priced.flatFee) || 0,
    pricingProductKey: LOCAL_TOPUP_PRODUCT_KEY,
    reason: priced.reason,
    source: priced.source,
  };
}

module.exports = {
  CONFIG_DOC,
  FORMULA,
  CATALOG,
  PRODUCT_KEYS,
  LOCAL_TOPUP_PRODUCT_KEY,
  SEND_PRODUCT_BY_CORRIDOR,
  getCatalog,
  getPricingConfig,
  getProductPricing,
  computeProductFee,
  computeLocalTopupPaystackCharge,
  previewCharge,
  updateProductPricing,
  resetToDefaults,
  getAdminPricingView,
  resolveSafariPayProductKey,
  resolveSafariSendProductKey,
  resolveSafariPayoutProductKey,
  resolveSendProductKey,
  clearCache,
  buildLiveDefaults,
};
