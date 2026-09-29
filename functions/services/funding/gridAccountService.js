/**
 * @fileoverview TruePay user ↔ Grid customer / USD internal account mapping.
 * One Grid customer and one USD internal account per TruePay user.
 */

const config = require("../../config");
const { collection, getFirestore, serverTimestamp } = require("../../libs/firestore");
const gridApi = require("./providers/gridApi");
const fundingOrderService = require("./fundingOrderService");
const { FUNDING_PROVIDERS, FUNDING_STATUSES } = require("../../utils/fundingTypes");
const { createLogger } = require("../../utils/paymentOpsLogger");

const logger = createLogger({ service: "gridAccount", provider: FUNDING_PROVIDERS.grid });

const OPEN_STATUSES = new Set([FUNDING_STATUSES.pending, FUNDING_STATUSES.processing]);

/**
 * @param {unknown} value
 * @returns {Array}
 */
function listData(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  if (value && Array.isArray(value.agreements)) return value.agreements;
  return [];
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeClientIp(value) {
  if (!value) return null;
  const first = String(value).split(",")[0].trim();
  if (!first || first.length > 45) return null;
  return first;
}

/**
 * Grid provisions INTERNAL_FIAT only after each current agreement is accepted.
 * Versions come from GET /customers/agreements. Already recorded types are skipped.
 *
 * @param {Array<Object>} agreements
 * @param {Array<Object>} existing
 * @param {{ acceptedAt: string, ipAddress: string }} evidence
 * @returns {Array<Object>}
 */
function buildMissingAgreementConsents(agreements, existing, evidence) {
  const recorded = new Set(
      (Array.isArray(existing) ? existing : [])
          .map((item) => item && item.type)
          .filter(Boolean),
  );
  return (Array.isArray(agreements) ? agreements : [])
      .filter((item) => item && item.type && item.version && !recorded.has(item.type))
      .map((item) => ({
        type: String(item.type),
        acceptedAt: evidence.acceptedAt,
        ipAddress: evidence.ipAddress,
        termsVersion: String(item.version),
        acceptanceMethod: "CLICK_TO_ACCEPT",
      }));
}

/**
 * @param {Object|null|undefined} account
 * @returns {string}
 */
function accountCurrency(account) {
  const code = account?.balance?.currency?.code || account?.currency || "";
  return String(code).toUpperCase();
}

/**
 * Prefer the auto-provisioned INTERNAL_FIAT USD account.
 * POST /internal-accounts only creates RULE_BASED accounts, which sweep funds
 * away and do not hold a balance, so the C2B path does not call it.
 *
 * @param {Array<Object>} accounts
 * @param {string|null} [preferredId]
 * @returns {Object|null}
 */
function pickUsdInternalAccount(accounts, preferredId = null) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (preferredId) {
    const saved = list.find((account) => account && account.id === preferredId);
    if (saved) return saved;
  }
  const usd = list.filter((account) => accountCurrency(account) === "USD" || !accountCurrency(account));
  return usd.find((account) => account.type === "INTERNAL_FIAT") ||
    usd.find((account) => account.type !== "RULE_BASED") ||
    null;
}

/**
 * @param {Object|null|undefined} account
 * @returns {Object|null}
 */
function pickUsdFundingInstructions(account) {
  const instructions = Array.isArray(account?.fundingPaymentInstructions) ?
    account.fundingPaymentInstructions :
    [];
  const usd = instructions.find((item) => {
    const info = item && item.accountOrWalletInfo;
    return info && String(info.accountType || "").toUpperCase() === "USD_ACCOUNT";
  });
  return usd || null;
}

/**
 * Match one open Grid funding order to an incoming payment.
 * Oldest matching amount wins. An order already tied to a different Grid
 * transaction is skipped. The same transaction id always returns that order.
 *
 * @param {Array<Object>} orders
 * @param {{ amount: number, currency: string, providerTransactionId?: string|null }} event
 * @returns {Object|null}
 */
function matchOpenFundingOrder(orders, event) {
  const currency = String(event.currency || "").toUpperCase();
  const amount = Number(event.amount);
  const transactionId = event.providerTransactionId ? String(event.providerTransactionId) : "";
  const open = (Array.isArray(orders) ? orders : []).filter((order) => {
    return order &&
      order.provider === FUNDING_PROVIDERS.grid &&
      OPEN_STATUSES.has(String(order.status || "").toLowerCase());
  });

  if (transactionId) {
    const tied = open.find((order) => String(order.providerTransactionId || "") === transactionId);
    if (tied) return tied;
  }

  const candidates = open.filter((order) => {
    if (String(order.currency || "").toUpperCase() !== currency) return false;
    if (Math.abs(Number(order.amount) - amount) > 0.01) return false;
    const existingTx = String(order.providerTransactionId || "");
    if (transactionId && existingTx && existingTx !== transactionId) return false;
    return true;
  });

  candidates.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  return candidates[0] || null;
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function readUserGrid(userId) {
  const snap = await getFirestore().collection(config.collections.users).doc(String(userId)).get();
  if (!snap.exists) return null;
  const grid = snap.data()?.grid;
  return grid && typeof grid === "object" ? grid : null;
}

/**
 * Grid's individual customer field is `fullName`. The sandbox rejects creates
 * that omit it with "full_name is required for this platform".
 *
 * @param {string|Object|null|undefined} value
 * @returns {string|null}
 */
function joinGridFullName(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ");
    return trimmed ? trimmed.slice(0, 250) : null;
  }
  const explicit = value.fullName || value.name || value.displayName || "";
  const fromParts = [value.firstName, value.lastName]
      .filter((part) => part && String(part).trim())
      .map((part) => String(part).trim())
      .join(" ");
  const combined = String(explicit || fromParts).trim().replace(/\s+/g, " ");
  return combined ? combined.slice(0, 250) : null;
}

/**
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
async function readUserFullName(userId) {
  const snap = await getFirestore().collection(config.collections.users).doc(String(userId)).get();
  if (!snap.exists) return null;
  return joinGridFullName(snap.data() || {});
}

/**
 * @param {string} userId
 * @param {{ customerId: string, usdInternalAccountId?: string|null }} mapping
 * @returns {Promise<void>}
 */
async function persistMapping(userId, mapping) {
  const customerId = String(mapping.customerId);
  const usdInternalAccountId = mapping.usdInternalAccountId ?
    String(mapping.usdInternalAccountId) :
    null;
  const grid = {
    customerId,
    platformCustomerId: String(userId),
    updatedAt: serverTimestamp(),
  };
  if (usdInternalAccountId) {
    grid.usdInternalAccountId = usdInternalAccountId;
  }

  await getFirestore().collection(config.collections.users).doc(String(userId)).set(
      { grid },
      { merge: true },
  );

  await collection(config.collections.gridCustomerLinks).doc(customerId).set({
    userId: String(userId),
    customerId,
    usdInternalAccountId,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

/**
 * @param {string} customerId
 * @returns {Promise<{ userId: string, customerId: string, usdInternalAccountId: string|null }|null>}
 */
async function findUserByCustomerId(customerId) {
  if (!customerId) return null;
  const snap = await collection(config.collections.gridCustomerLinks).doc(String(customerId)).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!data.userId) return null;
  return {
    userId: String(data.userId),
    customerId: String(data.customerId || customerId),
    usdInternalAccountId: data.usdInternalAccountId ? String(data.usdInternalAccountId) : null,
  };
}

/**
 * @param {string} userId
 * @param {string|null} email
 * @param {Object} [ctx]
 * @returns {Promise<string>}
 */
async function resolveCustomerId(userId, email, ctx = {}) {
  const saved = await readUserGrid(userId);
  if (saved?.customerId) {
    try {
      const customer = await gridApi.getCustomer(saved.customerId, { ...ctx, userId });
      if (customer?.id) {
        await persistMapping(userId, {
          customerId: customer.id,
          usdInternalAccountId: saved.usdInternalAccountId || null,
        });
        return String(customer.id);
      }
    } catch (err) {
      if (!(err.statusCode === 404)) {
        throw err;
      }
      logger.warn("grid.customer.missing", {
        userId,
        gridCustomerId: saved.customerId,
        fundingOrderId: ctx.fundingOrderId || null,
        correlationId: ctx.correlationId || null,
      });
    }
  }

  const listed = await gridApi.listCustomersByPlatformId(userId, { ...ctx, userId });
  const existing = listData(listed).find((customer) => customer && customer.id);
  if (existing) {
    await persistMapping(userId, {
      customerId: existing.id,
      usdInternalAccountId: saved?.usdInternalAccountId || null,
    });
    logger.info("grid.customer.reused", {
      userId,
      gridCustomerId: existing.id,
      fundingOrderId: ctx.fundingOrderId || null,
      correlationId: ctx.correlationId || null,
    });
    return String(existing.id);
  }

  const fullName = joinGridFullName(ctx.fullName) || await readUserFullName(userId);
  if (!fullName) {
    throw new gridApi.GridApiError(
        "Grid customer creation requires a full name (firstName and lastName)",
    );
  }
  if (!email) {
    throw new gridApi.GridApiError("Grid customer creation requires an email");
  }
  const body = {
    customerType: "INDIVIDUAL",
    platformCustomerId: String(userId),
    currencies: ["USD"],
    email,
    fullName,
  };

  const created = await gridApi.createCustomer(body, { ...ctx, userId });
  if (!created?.id) {
    throw new gridApi.GridApiError("Grid customer creation failed");
  }
  await persistMapping(userId, {
    customerId: created.id,
    usdInternalAccountId: saved?.usdInternalAccountId || null,
  });
  logger.info("grid.customer.created", {
    userId,
    gridCustomerId: created.id,
    fundingOrderId: ctx.fundingOrderId || null,
    correlationId: ctx.correlationId || null,
  });
  return String(created.id);
}

/**
 * @param {string} userId
 * @param {string} customerId
 * @param {Object} [ctx]
 * @returns {Promise<Object>}
 */
async function readUsdAccount(userId, customerId, ctx = {}) {
  const saved = await readUserGrid(userId);
  const listed = await gridApi.listCustomerInternalAccounts({
    customerId,
    currency: "USD",
    limit: 20,
  }, { ...ctx, userId });
  const account = pickUsdInternalAccount(listData(listed), saved?.usdInternalAccountId || null);
  if (!account?.id) return null;
  const instructions = pickUsdFundingInstructions(account);
  if (!instructions) {
    throw new gridApi.GridApiError("Grid USD internal account is missing funding instructions");
  }
  await persistMapping(userId, {
    customerId,
    usdInternalAccountId: account.id,
  });
  logger.info("grid.account.reused", {
    userId,
    gridCustomerId: customerId,
    gridInternalAccountId: account.id,
    fundingOrderId: ctx.fundingOrderId || null,
    correlationId: ctx.correlationId || null,
  });
  return {
    customerId,
    internalAccountId: String(account.id),
    fundingInstructions: instructions,
    fundingPaymentInstructions: account.fundingPaymentInstructions,
  };
}

/**
 * Unregulated platforms do not receive INTERNAL_FIAT until agreementConsents is on file.
 * POST /internal-accounts cannot create that holding account.
 *
 * @param {string} customerId
 * @param {Object} ctx
 * @returns {Promise<void>}
 */
async function recordMissingAgreementConsents(customerId, ctx = {}) {
  const ipAddress = normalizeClientIp(ctx.clientIp);
  if (!ipAddress) {
    throw new gridApi.GridApiError(
        "Grid USD account requires the customer IP to record End User Terms acceptance",
    );
  }
  const customer = await gridApi.getCustomer(customerId, { ...ctx, userId: ctx.userId });
  const existing = Array.isArray(customer?.agreementConsents) ? customer.agreementConsents : [];
  const catalog = listData(await gridApi.listCustomerAgreements({ ...ctx, userId: ctx.userId }));
  const consents = buildMissingAgreementConsents(catalog, existing, {
    acceptedAt: new Date().toISOString(),
    ipAddress,
  });
  if (!consents.length) return;
  await gridApi.updateCustomer(customerId, {
    customerType: customer?.customerType || "INDIVIDUAL",
    agreementConsents: consents,
  }, { ...ctx, userId: ctx.userId });
  logger.info("grid.customer.terms_recorded", {
    userId: ctx.userId || null,
    gridCustomerId: customerId,
    agreementTypes: consents.map((item) => item.type),
    fundingOrderId: ctx.fundingOrderId || null,
    correlationId: ctx.correlationId || null,
  });
}

/**
 * @param {string} userId
 * @param {string} customerId
 * @param {Object} [ctx]
 * @returns {Promise<Object>}
 */
async function resolveUsdAccount(userId, customerId, ctx = {}) {
  const existing = await readUsdAccount(userId, customerId, ctx);
  if (existing) return existing;

  await recordMissingAgreementConsents(customerId, { ...ctx, userId });
  const provisioned = await readUsdAccount(userId, customerId, ctx);
  if (provisioned) return provisioned;

  throw new gridApi.GridApiError("Grid USD internal account was not provisioned for this customer");
}

/**
 * Create or reuse the Grid customer and USD internal account for a TruePay user.
 * @param {{ userId: string, email?: string|null, fullName?: string|null, clientIp?: string|null, fundingOrderId?: string|null, correlationId?: string|null }} params
 * @returns {Promise<{ customerId: string, internalAccountId: string, fundingInstructions: Object, fundingPaymentInstructions: Array }>}
 */
async function prepareUsdFunding(params) {
  const userId = String(params.userId || "");
  if (!userId) {
    throw new gridApi.GridApiError("Grid funding requires an authenticated user");
  }
  const ctx = {
    userId,
    fundingOrderId: params.fundingOrderId || null,
    correlationId: params.correlationId || null,
    fullName: params.fullName || null,
    clientIp: params.clientIp || null,
  };
  const customerId = await resolveCustomerId(userId, params.email || null, ctx);
  return resolveUsdAccount(userId, customerId, ctx);
}

/**
 * @param {Object} event Normalized grid event
 * @returns {Promise<Object|null>}
 */
async function resolveFundingOrder(event) {
  let userId = event.platformCustomerId ? String(event.platformCustomerId) : "";
  if (event.customerId) {
    const link = await findUserByCustomerId(event.customerId);
    if (link?.userId) {
      if (userId && userId !== link.userId) {
        logger.warn("grid.webhook.customer_mismatch", {
          userId,
          gridCustomerId: event.customerId,
          gridPaymentId: event.providerTransactionId || null,
        });
        return null;
      }
      userId = link.userId;
    }
  }
  if (!userId) {
    return null;
  }

  const orders = await fundingOrderService.listFundingOrdersForUserProvider(
      userId,
      FUNDING_PROVIDERS.grid,
  );
  return matchOpenFundingOrder(orders, event);
}

module.exports = {
  joinGridFullName,
  buildMissingAgreementConsents,
  pickUsdInternalAccount,
  pickUsdFundingInstructions,
  matchOpenFundingOrder,
  prepareUsdFunding,
  resolveFundingOrder,
  findUserByCustomerId,
  persistMapping,
};
