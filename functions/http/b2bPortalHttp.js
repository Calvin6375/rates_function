/**
 * @fileoverview B2B portal HTTP API — platform super-admin (Firebase `admin` claim or master
 * account per `isSuperAdminUid`) manages partners and org admins; partner org admins use Bearer ID token.
 * Base path: /b2bPortal (function name).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const { isPlatformAdmin, isSuperAdmin } = require("../utils/accessControl");
const { verifyFirebaseAuth } = require("../libs/auth");
const partnerService = require("../services/partnerService");
const b2bMemberService = require("../services/b2bMemberService");
const b2bOnboardingService = require("../services/b2bOnboardingService");
const b2bPortalSandboxService = require("../services/b2bPortalSandboxService");
const platformConsumerService = require("../services/platformConsumerService");
const dashboardUserDeletionService = require("../services/dashboardUserDeletionService");
const partnerDeletionService = require("../services/partnerDeletionService");
const paymentLinkService = require("../services/paymentLinkService");
const b2bPaymentLinkCheckoutService = require("../services/b2bPaymentLinkCheckoutService");
const paymentRailService = require("../services/paymentRailService");
const walletService = require("../services/walletService");
const transactionService = require("../services/transactionService");
const { renderCheckoutHtml, renderErrorHtml, renderSuccessHtml } = require("../utils/paymentLinkCheckoutPage");
const { logAdminAction } = require("../utils/transactions");

const intaSendPublishableKey = defineSecret(config.secrets.intaSendPublishableKey);
const intaSendSecretKey = defineSecret(config.secrets.intaSendSecretKey);
const smtpUser = defineSecret(config.secrets.smtpUser);
const smtpPass = defineSecret(config.secrets.smtpPass);
const paystackSecretKey = defineSecret(config.secrets.paystackSecretKey);
const paystackSplitCode = defineSecret(config.secrets.paystackSplitCode);
const emailService = require("../services/emailService");
const accountPasswordService = require("../services/accountPasswordService");
const b2bFundingBridgeService = require("../services/funding/b2bFundingBridgeService");
const fundingOrderService = require("../services/funding/fundingOrderService");
const fundingWebhookService = require("../services/funding/fundingWebhookService");
const partnerRecipientService = require("../services/partnerRecipientService");
const b2bSendService = require("../services/b2bSendService");
const partnerWalletAdminService = require("../services/partnerWalletAdminService");
const b2bWalletBalanceSync = require("../services/b2bWalletBalanceSync");
const { correlationFromRequest } = require("../utils/paymentContext");

const {
  parseAccessFromToken,
  resolvePartnerAccess,
  isKnownPartnerRole,
  isPartnerOwnerRole,
  legacyPartnerRoleFromNormalized,
  USER_TYPE_ADMIN,
  USER_TYPE_PARTNER,
} = require("../utils/accessControl");

/** Must match `exports.<name>` in `functions/index.js` (URL path segment before routes). */
const B2B_PORTAL_FUNCTION_SEGMENT = "b2bPortal";

const app = express();
app.use(express.json());

/**
 * Gen2 HTTP URLs are `.../b2bPortal/platform/...` but routes are `/platform/...`.
 * Strip the function segment when present so DELETE and all paths match.
 */
app.use((req, res, next) => {
  const raw = req.url || "/";
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const query = qIdx === -1 ? "" : raw.slice(qIdx);
  const prefix = `/${B2B_PORTAL_FUNCTION_SEGMENT}`;
  if (pathPart === prefix || pathPart.startsWith(`${prefix}/`)) {
    const rest =
        pathPart === prefix ? "/" : pathPart.slice(prefix.length) || "/";
    req.url = rest + query;
  }
  next();
});

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
    if (allowedOrigins.includes(origin)) {
      allowedOrigin = origin;
    } else if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      allowedOrigin = origin;
    } else if (
      origin.includes("truepay-72060") ||
      /^https:\/\/([a-z0-9-]+\.)*truepay\.live$/i.test(origin)
    ) {
      allowedOrigin = origin;
    }
  }

  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
  if (allowedOrigin !== "*") {
    res.set("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function loadFirebaseUser(req, res, next) {
  const result = await verifyFirebaseAuth(req);
  if (!result.success) {
    res.status(401).json({ success: false, error: result.error || "Unauthorized" });
    return;
  }
  req.userId = result.userId;
  req.decodedToken = result.decodedToken;
  next();
}

/**
 * Platform admin: userType admin or legacy admin claim or built-in super-admin email.
 */
async function requirePlatformAdmin(req, res, next) {
  try {
    if (await isPlatformAdmin(req.decodedToken, req.userId)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: "Platform admin access required" });
  } catch (err) {
    console.error("requirePlatformAdmin:", err.message);
    res.status(500).json({ success: false, error: "Authorization check failed" });
  }
}

function attachPartnerContext(req, res, next) {
  const resolved = resolvePartnerAccess(req.decodedToken);
  if (!resolved || !isKnownPartnerRole(resolved.role)) {
    res.status(403).json({ success: false, error: "Not a B2B partner user (missing partner claims)" });
    return;
  }
  req.partnerId = resolved.partnerId;
  req.partnerRole = resolved.role;
  req.legacyPartnerRole = legacyPartnerRoleFromNormalized(resolved.role);
  next();
}

/**
 * Partner portal routes that super admins reuse from the dashboard (e.g. GET /portal/transactions).
 * Partner users: require partnerId + partnerRole claims.
 * Platform super admin: allow without partner claims (admin: true or master email).
 */
async function attachPartnerContextOrPlatformAdmin(req, res, next) {
  const resolved = resolvePartnerAccess(req.decodedToken);
  if (resolved && isKnownPartnerRole(resolved.role)) {
    req.partnerId = resolved.partnerId;
    req.partnerRole = resolved.role;
    req.legacyPartnerRole = legacyPartnerRoleFromNormalized(resolved.role);
    req.platformTransactionScope = false;
    next();
    return;
  }
  try {
    if (await isPlatformAdmin(req.decodedToken, req.userId)) {
      req.platformTransactionScope = true;
      next();
      return;
    }
  } catch (err) {
    console.error("attachPartnerContextOrPlatformAdmin:", err.message);
    res.status(500).json({ success: false, error: "Authorization check failed" });
    return;
  }
  res.status(403).json({ success: false, error: "Not a B2B partner user (missing partner claims)" });
}

function requirePartnerOrgAdmin(req, res, next) {
  if (!isPartnerOwnerRole(req.partnerRole)) {
    res.status(403).json({ success: false, error: "Partner owner access required" });
    return;
  }
  next();
}

/**
 * @param {Error} err
 * @returns {number}
 */
function paymentLinkErrorStatus(err) {
  const msg = err.message || "";
  if (msg.includes("not found")) {
    return 404;
  }
  if (
    msg.includes("Invalid") ||
    msg.includes("required") ||
    msg.includes("Must be") ||
    msg.includes("Cannot edit") ||
    msg.includes("No valid fields")
  ) {
    return 400;
  }
  return 500;
}

/**
 * List transactions for portal or platform dashboard APIs.
 *
 * @param {import('express').Request} req
 * @param {{ platformScope: boolean, partnerId?: string|null }} scope
 * @returns {Promise<{ transactions: Object[], nextPageCursor: string|null, channel: string|null }>}
 */
async function fetchPortalTransactions(req, scope) {
  const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 100);
  const startAfter = req.query.startAfter ? String(req.query.startAfter) : null;
  const channel = req.query.channel ? String(req.query.channel) : null;
  const statusFilter = req.query.status ? String(req.query.status) : null;
  const typeFilter = req.query.type ? String(req.query.type) : null;

  /** @type {Record<string, unknown>} */
  const listOpts = {
    limit,
    startAfterId: startAfter,
    status: statusFilter || undefined,
  };

  if (scope.platformScope) {
    const partnerFilter = req.query.partnerId ? String(req.query.partnerId) : null;
    if (partnerFilter) {
      listOpts.partnerId = partnerFilter;
    }
    if (typeFilter) {
      listOpts.type = typeFilter;
    } else {
      const channelTypes = transactionService.resolveChannelTypes(channel || "b2b");
      if (channelTypes && channelTypes.length === 1) {
        listOpts.type = channelTypes[0];
      } else if (channelTypes && channelTypes.length > 1) {
        listOpts.types = channelTypes;
      }
    }
  } else {
    listOpts.partnerId = scope.partnerId;
    if (typeFilter) {
      listOpts.type = typeFilter;
    } else if (channel) {
      const channelTypes = transactionService.resolveChannelTypes(channel);
      if (channelTypes && channelTypes.length === 1) {
        listOpts.type = channelTypes[0];
      } else if (channelTypes && channelTypes.length > 1) {
        listOpts.types = channelTypes;
      }
    }
  }

  const { transactions, nextPageCursor } = await transactionService.listTransactionRecords(listOpts);
  return {
    transactions: transactions.map(transactionService.serializePortalTransaction),
    nextPageCursor,
    channel: channel || (scope.platformScope ? "b2b" : null),
  };
}

/**
 * Attempt IntaSend reconciliation for links that have a pending checkout session.
 *
 * @param {Object[]} links
 * @returns {Promise<Object[]>}
 */
async function reconcilePendingPaymentLinks(links) {
  if (!Array.isArray(links) || links.length === 0) {
    return links;
  }
  const reconcile = require("../services/b2bCheckoutReconcileService");
  const out = [...links];
  for (let i = 0; i < out.length; i++) {
    const link = out[i];
    const checkoutId = link.lastCheckoutId ? String(link.lastCheckoutId) : "";
    if (!checkoutId || Number(link.paymentCount || 0) > 0) {
      continue;
    }
    try {
      const result = await reconcile.tryReconcileCheckoutSession(checkoutId);
      if (result.reconciled) {
        const updated = await paymentLinkService.getPaymentLink(link.linkId || link.id);
        if (updated) {
          out[i] = updated;
        }
      }
    } catch (err) {
      console.warn("reconcilePendingPaymentLinks:", checkoutId, err.message);
    }
  }
  return out;
}

// --- Platform (super admin = claim admin: true OR master email in adminClaims.js) ---

app.get("/platform/partners", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 100);
    const { partners, lastDoc } = await partnerService.listPartners(limit, null);
    res.status(200).json({
      success: true,
      data: {
        partners,
        nextPageCursor: lastDoc ? lastDoc.id : null,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/partners:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/platform/partners", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const { name, settlementCurrency, webhookUrl } = req.body || {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ success: false, error: "name is required" });
      return;
    }
    const created = await partnerService.createPartner({
      name: name.trim(),
      settlementCurrency: settlementCurrency || "KES",
      webhookUrl: webhookUrl || null,
    });
    res.status(201).json({
      success: true,
      data: {
        partnerId: created.partnerId,
        apiKey: created.apiKey,
        partner: { id: created.partnerId, name: created.partner.name, orgAdminUid: null },
      },
      message: "Store apiKey securely; it is only shown once. Assign org admin with PUT .../org-admin",
    });
  } catch (err) {
    console.error("b2bPortal POST /platform/partners:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/platform/partners/:partnerId/api-key", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const keyPayload = await partnerService.getPartnerApiKey(req.params.partnerId);
    if (!keyPayload) {
      res.status(404).json({ success: false, error: "Partner not found" });
      return;
    }
    res.status(200).json({ success: true, data: keyPayload });
  } catch (err) {
    console.error("b2bPortal GET /platform/partners/:id/api-key:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Rotate partner API key (super admin). Previous key stops working immediately.
 */
app.put("/platform/partners/:partnerId/api-key", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const result = await partnerService.rotatePartnerApiKey(
        req.params.partnerId,
        req.userId,
    );
    await logAdminAction(
        req.userId,
        req.params.partnerId,
        "rotatePartnerApiKey",
        { apiKeyMasked: result.previousApiKeyMasked },
        { apiKeyMasked: result.apiKeyMasked },
    );
    res.status(200).json({
      success: true,
      data: {
        partnerId: result.partnerId,
        apiKey: result.apiKey,
        apiKeyMasked: result.apiKeyMasked,
        previousApiKeyMasked: result.previousApiKeyMasked,
      },
      message: "API key rotated. The previous key is invalid immediately.",
    });
  } catch (err) {
    console.error("b2bPortal PUT /platform/partners/:id/api-key:", err.message);
    const status = err.message.includes("not found") ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.get("/platform/partners/:partnerId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const partner = await partnerService.getPartner(req.params.partnerId, {
      includeApiKey: true,
    });
    if (!partner) {
      res.status(404).json({ success: false, error: "Partner not found" });
      return;
    }
    /** Onboarding contact (fullName / phone / job title) — distinct from member role `owner`. */
    let onboardingOwner = null;
    const orgAdminUid =
      typeof partner.orgAdminUid === "string" ? partner.orgAdminUid.trim() : "";
    if (orgAdminUid) {
      try {
        const onboarding = await b2bOnboardingService.getOnboarding(orgAdminUid);
        const owner = onboarding?.owner;
        if (owner && typeof owner === "object") {
          onboardingOwner = {
            fullName: typeof owner.fullName === "string" ? owner.fullName : "",
            phone: typeof owner.phone === "string" ? owner.phone : "",
            role: typeof owner.role === "string" ? owner.role : "",
          };
        }
      } catch (ownerErr) {
        console.error(
            "b2bPortal GET /platform/partners/:id onboarding owner:",
            ownerErr.message,
        );
      }
    }
    res.status(200).json({
      success: true,
      data: {
        ...partner,
        onboardingOwner,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/partners/:id:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch("/platform/partners/:partnerId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const updated = await partnerService.updatePartner(req.params.partnerId, req.body || {});
    if (String(updated.status || "").toLowerCase() === "active") {
      try {
        await b2bOnboardingService.markGoLiveDoneForPartner(req.params.partnerId);
      } catch (goLiveErr) {
        console.error(
            "b2bPortal PATCH /platform/partners goLiveDone:",
            goLiveErr.message,
        );
      }
    }
    const { apiKey, ...safe } = updated;
    res.status(200).json({
      success: true,
      data: { id: safe.id || req.params.partnerId, ...safe, apiKeyMasked: apiKey ? `${String(apiKey).slice(0, 8)}...` : null },
    });
  } catch (err) {
    console.error("b2bPortal PATCH /platform/partners/:id:", err.message);
    const status = err.message.includes("not found") ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

/**
 * GET /platform/partners/:partnerId/wallet
 * Platform admin: read partner wallet balances (same shape as GET /portal/wallet).
 */
app.get("/platform/partners/:partnerId/wallet", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const data = await partnerWalletAdminService.getPartnerWalletForAdmin(req.params.partnerId);
    // Absorb legacy users/{orgAdminUid} balances credited via C2B customer-wallets UI.
    if (data.partnerId) {
      const partner = await partnerService.getPartner(data.partnerId);
      const orgAdminUid = partner?.orgAdminUid ? String(partner.orgAdminUid) : null;
      if (orgAdminUid) {
        const synced = await b2bWalletBalanceSync.getPartnerWalletAfterLegacySync(
            data.partnerId,
            orgAdminUid,
        );
        data.walletId = synced.walletId;
        data.balances = synced.balances;
        if (synced.migration) {
          data.migration = synced.migration;
        }
      }
    }
    res.status(200).json({success: true, data});
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal GET /platform/partners/:id/wallet:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "WALLET_FETCH_FAILED",
      message: err.message,
    });
  }
});

/**
 * POST /platform/partners/:partnerId/wallet/credit
 * Platform admin manual top-up (mirrors C2B POST /customer-wallets/:id/credit).
 * Body: { amount, currency?, description? }
 */
app.post("/platform/partners/:partnerId/wallet/credit", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await partnerWalletAdminService.creditPartnerWallet({
      partnerId: req.params.partnerId,
      amount: body.amount,
      currency: body.currency || "KES",
      description: body.description || "Admin wallet top-up",
      actorUid: req.userId,
    });
    try {
      await logAdminAction(
          req.userId,
          req.params.partnerId,
          "partnerWalletCredit",
          {balance: result.transaction.previousBalance},
          {
            amount: result.transaction.amount,
            currency: result.transaction.currency,
            newBalance: result.transaction.newBalance,
            transactionId: result.transaction.transactionId,
            description: result.transaction.description,
          },
      );
    } catch (logErr) {
      console.warn("logAdminAction partnerWalletCredit:", logErr.message);
    }
    res.status(200).json({success: true, data: result});
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /platform/partners/:id/wallet/credit:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "WALLET_CREDIT_FAILED",
      message: err.message,
    });
  }
});

/**
 * POST /platform/partners/:partnerId/wallet/debit
 * Platform admin manual debit (mirrors C2B customer wallet debit).
 */
app.post("/platform/partners/:partnerId/wallet/debit", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await partnerWalletAdminService.debitPartnerWallet({
      partnerId: req.params.partnerId,
      amount: body.amount,
      currency: body.currency || "KES",
      description: body.description || "Admin wallet debit",
      actorUid: req.userId,
    });
    try {
      await logAdminAction(
          req.userId,
          req.params.partnerId,
          "partnerWalletDebit",
          {balance: result.transaction.previousBalance},
          {
            amount: result.transaction.amount,
            currency: result.transaction.currency,
            newBalance: result.transaction.newBalance,
            transactionId: result.transaction.transactionId,
            description: result.transaction.description,
          },
      );
    } catch (logErr) {
      console.warn("logAdminAction partnerWalletDebit:", logErr.message);
    }
    res.status(200).json({success: true, data: result});
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /platform/partners/:id/wallet/debit:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "WALLET_DEBIT_FAILED",
      message: err.message,
    });
  }
});

/**
 * DELETE /platform/partners/:partnerId
 * Platform master admin: delete partner org, clear member claims, remove payment links.
 */
app.delete("/platform/partners/:partnerId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const data = await partnerDeletionService.deletePartnerAsPlatformAdmin(
        req.params.partnerId,
    );
    await logAdminAction(
        req.userId,
        req.params.partnerId,
        "deletePartner.platform",
        {partnerId: req.params.partnerId},
        data,
    );
    res.status(200).json({
      success: true,
      data,
      message: "Partner organization deleted",
    });
  } catch (err) {
    const msg = err.message || "Delete failed";
    console.error("b2bPortal DELETE /platform/partners/:partnerId:", msg);
    const status = msg.includes("not found") ? 404 : 400;
    res.status(status).json({success: false, error: msg});
  }
});

// --- Platform payment links (super admin) ---

app.post("/platform/partners/:partnerId/payment-links", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const link = await paymentLinkService.createPaymentLink(
        req.params.partnerId,
        req.userId,
        req.body || {},
    );
    res.status(201).json({ success: true, data: link });
  } catch (err) {
    console.error("b2bPortal POST /platform/partners/:id/payment-links:", err.message);
    res.status(paymentLinkErrorStatus(err)).json({ success: false, error: err.message });
  }
});

app.get("/platform/partners/:partnerId/payment-links", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const startAfter = req.query.startAfter ? String(req.query.startAfter) : null;
    const { paymentLinks, nextPageCursor } = await paymentLinkService.listPaymentLinksForPartner(
        req.params.partnerId,
        limit,
        startAfter,
    );
    const reconciled = await reconcilePendingPaymentLinks(paymentLinks);
    res.status(200).json({
      success: true,
      data: { paymentLinks: reconciled, nextPageCursor },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/partners/:id/payment-links:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** List all payment links across partners; filter with ?partnerId= */
app.get("/platform/payment-links", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const partnerId = req.query.partnerId ? String(req.query.partnerId) : null;
    const startAfter = req.query.startAfter ? String(req.query.startAfter) : null;
    const { paymentLinks, nextPageCursor } = await paymentLinkService.listPaymentLinks(
        limit,
        partnerId,
        startAfter,
    );
    const reconciled = await reconcilePendingPaymentLinks(paymentLinks);
    res.status(200).json({
      success: true,
      data: { paymentLinks: reconciled, nextPageCursor },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/payment-links:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Single payment link (any partner) — platform super admin */
app.get("/platform/payment-links/:linkId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const link = await paymentLinkService.getPaymentLink(req.params.linkId);
    if (!link) {
      res.status(404).json({ success: false, error: "Payment link not found" });
      return;
    }
    res.status(200).json({ success: true, data: link });
  } catch (err) {
    console.error("b2bPortal GET /platform/payment-links/:linkId:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Update any payment link — platform super admin */
app.patch("/platform/payment-links/:linkId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const before = await paymentLinkService.getPaymentLink(req.params.linkId);
    if (!before) {
      res.status(404).json({ success: false, error: "Payment link not found" });
      return;
    }
    const link = await paymentLinkService.updatePaymentLink(
        req.params.linkId,
        req.userId,
        req.body || {},
    );
    await logAdminAction(
        req.userId,
        link.partnerId,
        "updatePaymentLink",
        before,
        link,
    );
    res.status(200).json({
      success: true,
      data: link,
      message: "Payment link updated",
    });
  } catch (err) {
    console.error("b2bPortal PATCH /platform/payment-links/:linkId:", err.message);
    res.status(paymentLinkErrorStatus(err)).json({ success: false, error: err.message });
  }
});

/** Delete any payment link — platform super admin */
app.delete("/platform/payment-links/:linkId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const deleted = await paymentLinkService.deletePaymentLink(req.params.linkId);
    await logAdminAction(
        req.userId,
        deleted.partnerId,
        "deletePaymentLink",
        deleted,
        { deleted: true, linkId: deleted.linkId },
    );
    res.status(200).json({
      success: true,
      data: deleted,
      message: "Payment link deleted",
    });
  } catch (err) {
    console.error("b2bPortal DELETE /platform/payment-links/:linkId:", err.message);
    const status = err.message.includes("not found") ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.put("/platform/partners/:partnerId/org-admin", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const { uid } = req.body || {};
    if (!uid || typeof uid !== "string") {
      res.status(400).json({ success: false, error: "uid (Firebase Auth user id) is required" });
      return;
    }
    const out = await b2bMemberService.setPartnerOrgAdmin(req.params.partnerId, uid.trim(), req.userId);
    res.status(200).json({
      success: true,
      data: out,
      message: "User must refresh their ID token (sign out/in) for partner claims to apply.",
    });
  } catch (err) {
    console.error("b2bPortal PUT org-admin:", err.message);
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.get("/platform/partners/:partnerId/members", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const members = await b2bMemberService.listMembers(req.params.partnerId);
    res.status(200).json({ success: true, data: { members } });
  } catch (err) {
    console.error("b2bPortal GET platform members:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Platform admin: add a member to a partner org (same rules as POST /portal/members).
 * Body: { email, password?, role, displayName? } — password required only when creating a new Auth user.
 */
app.post("/platform/partners/:partnerId/members", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const partnerId = req.params.partnerId;
    const partner = await partnerService.getPartner(partnerId);
    if (!partner) {
      res.status(404).json({ success: false, error: "Partner not found" });
      return;
    }
    const { email, password, role, displayName } = req.body || {};
    const out = await b2bMemberService.addMember(
        partnerId,
        { email, password, role, displayName },
        req.userId,
    );
    res.status(201).json({
      success: true,
      data: out,
      message: "User should sign in and refresh token to receive partner claims.",
    });
  } catch (err) {
    console.error("b2bPortal POST /platform/partners/:id/members:", err.message);
    const status =
      err.message && err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

/** Unified dashboard: counts for consumer app users vs B2B partners */
app.get("/platform/overview", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const counts = await platformConsumerService.getPlatformOverviewCounts();
    res.status(200).json({ success: true, data: counts });
  } catch (err) {
    console.error("b2bPortal GET /platform/overview:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Paginated list of customer-app users (Firestore users) — platform admin only */
app.get("/platform/consumer-users", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const startAfter = req.query.startAfter ? String(req.query.startAfter) : null;
    const { users, nextCursor } = await platformConsumerService.listConsumerUsers(limit, startAfter);
    res.status(200).json({
      success: true,
      data: { users, nextCursor },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/consumer-users:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Single customer-app user profile (read-only summary for super-admin dashboard) */
app.get("/platform/consumer-users/:userId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const user = await platformConsumerService.getConsumerUser(req.params.userId);
    if (!user) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    console.error("b2bPortal GET /platform/consumer-users/:userId:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /platform/users/:userId
 * Platform master admin only (Firebase `admin` claim or super-admin email):
 * deletes Firebase Auth user (if present), partner claims, and Firestore/RTDB data.
 */
app.delete("/platform/users/:userId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const actorIsSuperAdmin = await isSuperAdmin(req.decodedToken, req.userId);
    const data = await dashboardUserDeletionService.deleteUserAsPlatformAdmin(
        req.userId,
        req.params.userId,
        { actorIsSuperAdmin },
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    const msg = err.message || "Delete failed";
    console.error("b2bPortal DELETE /platform/users/:userId:", msg);
    let status = 400;
    if (msg.includes("not found") || msg.includes("Member not found")) {
      status = 404;
    } else if (
      msg.includes("Cannot delete") ||
      msg.includes("Only the platform owner") ||
      msg.includes("administrator account")
    ) {
      status = 403;
    }
    res.status(status).json({ success: false, error: msg });
  }
});

/**
 * Session/bootstrap for platform super-admins (claim admin: true or master account).
 * Unlike GET /portal/me, does not require B2B partnerId / partnerRole claims.
 */
app.get("/platform/me", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const access = parseAccessFromToken(req.decodedToken);
    res.status(200).json({
      success: true,
      data: {
        userId: req.userId,
        userType: access.userType || USER_TYPE_ADMIN,
        role: access.role,
        admin: true,
        email: (req.decodedToken && req.decodedToken.email) || null,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/me:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Send TruePay-branded email verification via Zoho SMTP (replaces client sendEmailVerification).
 * Body (optional): `{ continueUrl?, canHandleCodeInApp? }`
 * Default continueUrl = B2B dashboard (`config.b2bDashboardUrl`). Clicking the email link
 * hits GET /public/verify-email which verifies then 302-redirects to the dashboard.
 */
/**
 * POST /portal/account/change-password — Account Settings → Update Password.
 * Body: { currentPassword, newPassword, confirmPassword? }
 * Requires Bearer Firebase ID token. Email/password accounts only (not Google-only).
 */
app.post("/portal/account/change-password", loadFirebaseUser, async (req, res) => {
  try {
    const body = req.body || {};
    await accountPasswordService.changePassword(req.userId, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      confirmPassword: body.confirmPassword,
    });
    res.status(200).json({
      success: true,
      message: "Password updated. Sign in again on other devices if needed.",
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /portal/account/change-password:", err.message);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err.code || "PASSWORD_CHANGE_FAILED",
      message: err.message || "Unable to update password",
    });
  }
});

/**
 * POST /portal/account/request-password-reset — forgot-password email (public).
 * Body: { email, continueUrl? }. Always returns success for unknown emails.
 */
app.post("/portal/account/request-password-reset", async (req, res) => {
  try {
    const body = req.body || {};
    await accountPasswordService.requestPasswordResetEmail({
      email: body.email,
      continueUrl: body.continueUrl,
    });
    res.status(200).json({
      success: true,
      message: "If an account exists for that email, a reset link has been sent.",
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /portal/account/request-password-reset:", err.message);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err.code || "PASSWORD_RESET_FAILED",
      message: err.message || "Unable to send reset email",
    });
  }
});

app.post("/portal/send-verification-email", loadFirebaseUser, async (req, res) => {
  try {
    const body = req.body || {};
    const continueUrl =
      typeof body.continueUrl === "string" && body.continueUrl.trim() ?
        body.continueUrl.trim() :
        emailService.defaultContinueUrl();
    const result = await emailService.sendEmailVerificationForUid(req.userId, {
      continueUrl,
      canHandleCodeInApp: body.canHandleCodeInApp === true,
    });
    res.status(200).json({
      success: true,
      data: {
        alreadyVerified: result.alreadyVerified === true,
        email: result.email,
        continueUrl: result.continueUrl || continueUrl,
      },
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "Unknown error";
    console.error("b2bPortal POST /portal/send-verification-email:", msg);
    if (
      msg.includes("continueUrl") ||
      msg.includes("no email") ||
      msg.includes("Invalid")
    ) {
      res.status(400).json({success: false, error: msg});
      return;
    }
    if (msg.includes("SMTP is not configured")) {
      res.status(503).json({success: false, error: msg});
      return;
    }
    res.status(500).json({success: false, error: "Unable to send verification email"});
  }
});

/**
 * Idempotent: create or patch Firestore `users/{uid}` using Admin SDK (matches userBootstrap shape).
 * Call from the dashboard immediately after Firebase sign-in with the ID token, before loading profile
 * by email — fixes missing docs for legacy B2B users and email case mismatches on queries.
 */
app.post("/portal/ensure-dashboard-profile", loadFirebaseUser, async (req, res) => {
  try {
    let provisioning = {};
    try {
      const parsed = b2bMemberService.parsePortalProvisioningFields(req.body);
      if (parsed) {
        provisioning = parsed;
      }
    } catch (parseErr) {
      res.status(400).json({ success: false, error: parseErr.message });
      return;
    }
    await b2bMemberService.ensureUserDashboardProfileFromAuthUid(
        req.userId,
        provisioning,
    );
    let partnerOrg = null;
    if (req.decodedToken?.email_verified === true) {
      try {
        partnerOrg = await b2bOnboardingService.ensurePartnerOrgOnEmailVerified(
            req.userId,
            {
              emailVerified: true,
              email: req.decodedToken.email || null,
            },
        );
      } catch (ensureErr) {
        console.error(
            "b2bPortal ensure-dashboard-profile partner org:",
            ensureErr.message,
        );
      }
    }
    const claimsNeedRefresh = Boolean(
        partnerOrg &&
        (partnerOrg.claimsNeedRefresh === true || partnerOrg.alreadyRegistered !== true),
    );
    res.status(200).json({
      success: true,
      message: "Dashboard profile ensured",
      data: {
        ...(partnerOrg ? {
          partnerOrg: {
            partnerId: partnerOrg.partnerId,
            orgAdminUid: partnerOrg.orgAdminUid,
            alreadyRegistered: partnerOrg.alreadyRegistered === true,
            ...(partnerOrg.apiKey ? {apiKey: partnerOrg.apiKey} : {}),
          },
        } : {}),
        claimsNeedRefresh,
      },
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/ensure-dashboard-profile:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Self-serve onboarding (Firebase user; no partner claims required) ---

app.get("/portal/onboarding", loadFirebaseUser, async (req, res) => {
  try {
    const dt = req.decodedToken || {};
    let partnerOrg = null;
    if (dt.email_verified === true) {
      try {
        partnerOrg = await b2bOnboardingService.ensurePartnerOrgOnEmailVerified(
            req.userId,
            {
              emailVerified: true,
              email: dt.email || null,
            },
        );
      } catch (ensureErr) {
        console.error("b2bPortal GET /portal/onboarding partner org:", ensureErr.message);
      }
    }
    const onboarding = await b2bOnboardingService.getOnboarding(req.userId);
    const sandboxExtras =
      await b2bPortalSandboxService.getSandboxOnboardingExtras(req.userId);
    const goLiveDone = await b2bOnboardingService.resolveGoLiveDone(
        req.userId,
        dt.partnerId || partnerOrg?.partnerId,
    );
    const projectId = process.env.GCLOUD_PROJECT || "truepay-72060";
    const partnerSandboxBaseUrl =
      `https://${config.region}-${projectId}.cloudfunctions.net/partnerSandbox`;
    const mergedOnboarding = onboarding ?
      {
        ...onboarding,
        progress: {
          ...(onboarding.progress || {}),
          testTransactionDone: sandboxExtras.testTransactionDone,
          goLiveDone,
        },
      } :
      {
        progress: {
          testTransactionDone: sandboxExtras.testTransactionDone,
          goLiveDone,
        },
      };
    const claimsNeedRefresh = Boolean(
        partnerOrg &&
        (partnerOrg.claimsNeedRefresh === true ||
          (partnerOrg.alreadyRegistered !== true && !dt.partnerId)),
    );
    res.status(200).json({
      success: true,
      data: {
        onboarding: mergedOnboarding,
        emailVerified: dt.email_verified === true,
        claimsNeedRefresh,
        partnerOrg: partnerOrg ? {
          partnerId: partnerOrg.partnerId,
          orgAdminUid: partnerOrg.orgAdminUid,
          alreadyRegistered: partnerOrg.alreadyRegistered === true,
          ...(partnerOrg.apiKey ? {apiKey: partnerOrg.apiKey} : {}),
        } : null,
        sandbox: {
          publicApiKey: config.b2bSandbox.apiKey,
          virtualPartnerId: config.b2bSandbox.partnerId,
          linkToken: sandboxExtras.linkToken,
          testTransactionDone: sandboxExtras.testTransactionDone,
          goLiveDone,
          partnerSandboxBaseUrl,
          hint:
            "Use partnerSandbox with X-API-KEY: publicApiKey. Pass linkToken in " +
            "X-Sandbox-Link-Token (or metadata.linkToken) on POST /payments so the " +
            "dashboard checklist and Transactions tab update automatically.",
        },
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/onboarding:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch("/portal/onboarding", loadFirebaseUser, async (req, res) => {
  try {
    const updated = await b2bOnboardingService.patchOnboarding(req.userId, req.body || {});
    res.status(200).json({ success: true, data: { onboarding: updated } });
  } catch (err) {
    console.error("b2bPortal PATCH /portal/onboarding:", err.message);
    const status = err.message.includes("Provide at least one") ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

/**
 * Create partners/{partnerId} (status pending_review), assign caller as org_admin, persist onboarding.
 * Returns apiKey once when newly created; idempotent retries omit apiKey (alreadyRegistered: true).
 */
app.post("/portal/onboarding/register-partner", loadFirebaseUser, async (req, res) => {
  try {
    if (req.decodedToken?.email_verified !== true) {
      res.status(403).json({
        success: false,
        error: "EMAIL_NOT_VERIFIED",
        message: "Verify your email before generating API credentials.",
      });
      return;
    }
    const { name, settlementCurrency, webhookUrl } = req.body || {};
    const out = await b2bOnboardingService.registerSelfServePartner(req.userId, {
      name,
      settlementCurrency,
      webhookUrl,
    });
    const payload = {
      partnerId: out.partnerId,
      orgAdminUid: out.orgAdminUid,
      alreadyRegistered: out.alreadyRegistered === true,
    };
    if (out.apiKey) {
      payload.apiKey = out.apiKey;
    }
    res.status(out.alreadyRegistered ? 200 : 201).json({
      success: true,
      data: payload,
      message: "Refresh your ID token (sign out/in) so partner claims apply to this session.",
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/onboarding/register-partner:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/** Sandbox test transactions for onboarding checklist (Firebase Bearer; no partner claims). */
app.get("/portal/sandbox/transactions", loadFirebaseUser, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 100);
    const data = await b2bPortalSandboxService.listPortalSandboxTransactions(
        req.userId,
        limit,
    );
    res.status(200).json({
      success: true,
      data: {
        ...data,
        sandbox: true,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/sandbox/transactions:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

/**
 * Run a sandbox payment from the dashboard (same fixture logic as partnerSandbox).
 * Sets progress.testTransactionDone and appends to GET /portal/sandbox/transactions.
 */
app.post("/portal/sandbox/payments", loadFirebaseUser, async (req, res) => {
  try {
    const {amount, currency = "KES", reference, metadata = {}} = req.body || {};
    if (!amount || Number(amount) <= 0) {
      res.status(400).json({success: false, error: "Invalid amount"});
      return;
    }
    const data = await b2bPortalSandboxService.runPortalSandboxPayment(req.userId, {
      amount: Number(amount),
      currency,
      reference: reference != null ? String(reference) : "sandbox-test-001",
      metadata,
    });
    res.status(201).json({success: true, sandbox: true, data});
  } catch (err) {
    console.error("b2bPortal POST /portal/sandbox/payments:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

/** Require terms + AML attestation; sets onboardingStatus submitted (live API still requires platform activation). */
app.post("/portal/onboarding/complete", loadFirebaseUser, async (req, res) => {
  try {
    const { termsAccepted, amlAccepted } = req.body || {};
    const out = await b2bOnboardingService.completeOnboarding(req.userId, { termsAccepted, amlAccepted });
    res.status(200).json({
      success: true,
      data: out,
      message: "Onboarding submitted. Live Partner API remains blocked until a platform admin sets status active.",
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/onboarding/complete:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /portal/onboarding/request-go-live — partner asks super admin to activate live API.
 * Creates a system notification + FCM to platform admins. Idempotent if already requested.
 */
app.post("/portal/onboarding/request-go-live", loadFirebaseUser, async (req, res) => {
  try {
    const dt = req.decodedToken || {};
    const out = await b2bOnboardingService.requestGoLive(req.userId, {
      emailVerified: dt.email_verified === true,
      email: dt.email || null,
      note: req.body?.note != null ? String(req.body.note) : null,
    });
    res.status(out.alreadyRequested || out.alreadyLive ? 200 : 201).json({
      success: true,
      data: out,
      message: out.message,
    });
  } catch (err) {
    const status = err.statusCode || 400;
    console.error("b2bPortal POST /portal/onboarding/request-go-live:", err.message);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err.code || "GO_LIVE_REQUEST_FAILED",
      message: err.message,
    });
  }
});

// --- Partner portal (org admin) ---

/**
 * GET /portal/me — partner session, platform admin, or mid-onboarding dashboard user.
 * Google signup users are email_verified immediately; partner claims may exist on Auth
 * but not yet on the current ID token — never blank the dashboard with a hard 403.
 */
app.get("/portal/me", loadFirebaseUser, async (req, res) => {
  try {
    const dt = req.decodedToken || {};
    const platformAdmin = await isPlatformAdmin(dt, req.userId);
    const resolved = resolvePartnerAccess(dt);

    if (platformAdmin && !resolved) {
      const access = parseAccessFromToken(dt);
      res.status(200).json({
        success: true,
        data: {
          userId: req.userId,
          userType: access.userType || USER_TYPE_ADMIN,
          role: access.role,
          admin: true,
          partnerId: null,
          partnerRole: null,
          roleLegacy: null,
          partner: null,
          emailVerified: dt.email_verified === true,
          claimsNeedRefresh: false,
          onboardingIncomplete: false,
        },
      });
      return;
    }

    if (!resolved || !isKnownPartnerRole(resolved.role)) {
      let partnerOrg = null;
      if (dt.email_verified === true) {
        try {
          partnerOrg = await b2bOnboardingService.ensurePartnerOrgOnEmailVerified(
              req.userId,
              {
                emailVerified: true,
                email: dt.email || null,
              },
          );
        } catch (ensureErr) {
          console.error("b2bPortal GET /portal/me partner org:", ensureErr.message);
        }
      }

      const onboarding = await b2bOnboardingService.getOnboarding(req.userId);
      const partnerId =
        partnerOrg?.partnerId ||
        (onboarding?.registeredPartnerId ?
          String(onboarding.registeredPartnerId) :
          null);
      let partner = null;
      if (partnerId) {
        partner = await partnerService.getPartner(partnerId);
      }

      const claimsNeedRefresh = Boolean(partnerId);
      res.status(200).json({
        success: true,
        data: {
          userId: req.userId,
          userType: partnerId ? USER_TYPE_PARTNER : null,
          role: null,
          admin: platformAdmin,
          partnerId,
          partnerRole: null,
          roleLegacy: null,
          partner: partner || (partnerId ? {id: partnerId} : null),
          email: dt.email || null,
          emailVerified: dt.email_verified === true,
          onboardingStatus: onboarding?.onboardingStatus || null,
          owner: onboarding?.owner || null,
          claimsNeedRefresh,
          onboardingIncomplete: !partnerId,
          message: claimsNeedRefresh ?
            "Partner org is ready — refresh your ID token (getIdToken(true)) to load partner claims." :
            "Complete onboarding to obtain partner claims.",
        },
      });
      return;
    }

    const partner = await partnerService.getPartner(resolved.partnerId);
    res.status(200).json({
      success: true,
      data: {
        userId: req.userId,
        userType: USER_TYPE_PARTNER,
        role: resolved.role,
        admin: platformAdmin,
        partnerId: resolved.partnerId,
        partnerRole: legacyPartnerRoleFromNormalized(resolved.role),
        roleLegacy: legacyPartnerRoleFromNormalized(resolved.role),
        partner: partner || { id: resolved.partnerId },
        emailVerified: dt.email_verified === true,
        claimsNeedRefresh: false,
        onboardingIncomplete: false,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/me:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/portal/members", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const members = await b2bMemberService.listMembers(req.partnerId);
    res.status(200).json({ success: true, data: { members } });
  } catch (err) {
    console.error("b2bPortal GET /portal/members:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/portal/members", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const { email, password, role, displayName } = req.body || {};
    const out = await b2bMemberService.addMember(
      req.partnerId,
      { email, password, role, displayName },
      req.userId,
    );
    res.status(201).json({
      success: true,
      data: out,
      message: "User should sign in and refresh token to receive partner claims.",
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/members:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch("/portal/members/:userId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!role) {
      res.status(400).json({ success: false, error: "role is required" });
      return;
    }
    if (req.params.userId === req.userId) {
      res.status(400).json({ success: false, error: "Cannot change your own role here" });
      return;
    }
    await b2bMemberService.updateMemberRole(req.partnerId, req.params.userId, role);
    res.status(200).json({
      success: true,
      message: "Member updated; user must refresh ID token.",
    });
  } catch (err) {
    console.error("b2bPortal PATCH /portal/members:", err.message);
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.delete("/portal/members/:userId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    if (req.params.userId === req.userId) {
      res.status(400).json({ success: false, error: "Cannot remove yourself; ask platform admin to reassign org admin" });
      return;
    }
    await b2bMemberService.removeMember(req.partnerId, req.params.userId);
    res.status(200).json({ success: true, message: "Member removed from partner" });
  } catch (err) {
    console.error("b2bPortal DELETE /portal/members:", err.message);
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /portal/users/:userId
 * Partner org admin: removes member from org, deletes Firebase Auth user (if any),
 * and Firestore/RTDB user data. Cannot remove org_admin (use platform flow).
 */
app.delete("/portal/users/:userId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const data = await dashboardUserDeletionService.deleteUserAsPartnerOrgAdmin(
        req.userId,
        req.partnerId,
        req.params.userId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    const msg = err.message || "Delete failed";
    console.error("b2bPortal DELETE /portal/users/:userId:", msg);
    let status = 400;
    if (msg.includes("not found") || msg.includes("Member not found")) {
      status = 404;
    } else if (
      msg.includes("Cannot delete") ||
      msg.includes("platform owner") ||
      msg.includes("org admin")
    ) {
      status = 403;
    }
    res.status(status).json({ success: false, error: msg });
  }
});

// --- Partner portal payment links (org admin create; all partner members read) ---

app.post("/portal/payment-links", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const link = await paymentLinkService.createPaymentLink(
        req.partnerId,
        req.userId,
        req.body || {},
    );
    res.status(201).json({ success: true, data: link });
  } catch (err) {
    console.error("b2bPortal POST /portal/payment-links:", err.message);
    res.status(paymentLinkErrorStatus(err)).json({ success: false, error: err.message });
  }
});

app.get("/portal/payment-links", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const startAfter = req.query.startAfter ? String(req.query.startAfter) : null;
    const { paymentLinks, nextPageCursor } = await paymentLinkService.listPaymentLinksForPartner(
        req.partnerId,
        limit,
        startAfter,
    );
    const reconciled = await reconcilePendingPaymentLinks(paymentLinks);
    res.status(200).json({
      success: true,
      data: { paymentLinks: reconciled, nextPageCursor },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/payment-links:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/portal/payment-links/:linkId", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const link = await paymentLinkService.getPaymentLink(req.params.linkId);
    if (!link || link.partnerId !== req.partnerId) {
      res.status(404).json({ success: false, error: "Payment link not found" });
      return;
    }
    res.status(200).json({ success: true, data: link });
  } catch (err) {
    console.error("b2bPortal GET /portal/payment-links/:linkId:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch("/portal/payment-links/:linkId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const link = await paymentLinkService.updatePaymentLink(
        req.params.linkId,
        req.userId,
        req.body || {},
        { partnerId: req.partnerId },
    );
    res.status(200).json({
      success: true,
      data: link,
      message: "Payment link updated",
    });
  } catch (err) {
    console.error("b2bPortal PATCH /portal/payment-links/:linkId:", err.message);
    const status = paymentLinkErrorStatus(err);
    res.status(status).json({ success: false, error: err.message });
  }
});

/** Partner org admin hard-delete (optional — UI may use PATCH cancel instead). */
app.delete("/portal/payment-links/:linkId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const deleted = await paymentLinkService.deletePaymentLink(
        req.params.linkId,
        { partnerId: req.partnerId },
    );
    res.status(200).json({
      success: true,
      data: deleted,
      message: "Payment link deleted",
    });
  } catch (err) {
    console.error("b2bPortal DELETE /portal/payment-links/:linkId:", err.message);
    const status = err.message.includes("not found") ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

/** Partner wallet balances (Firebase Bearer; no API key in browser). */
app.get("/portal/wallet", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    // Migrates stranded users/{uid} balances (from C2B-style admin credit) into partner wallet once.
    const wallet = await b2bWalletBalanceSync.getPartnerWalletAfterLegacySync(
        req.partnerId,
        req.userId,
    );
    res.status(200).json({
      success: true,
      data: {
        walletId: wallet.walletId,
        balances: wallet.balances,
        ...(wallet.migration ? {migration: wallet.migration} : {}),
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/wallet:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- B2B Send (recipients, quote, payments) ---

/** List saved recipients for the partner. Query: ?currency=AED&limit=50 */
app.get("/portal/send/recipients", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const data = await partnerRecipientService.listRecipients(req.partnerId, {
      currency: req.query.currency || null,
      limit: parseInt(String(req.query.limit || "50"), 10) || 50,
    });
    res.status(200).json({success: true, data});
  } catch (err) {
    console.error("b2bPortal GET /portal/send/recipients:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

/** Create a saved recipient (merchant bank account). */
app.post("/portal/send/recipients", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const recipient = await partnerRecipientService.createRecipient(
        req.partnerId,
        req.body || {},
        req.userId,
    );
    res.status(201).json({success: true, data: {recipient}});
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /portal/send/recipients:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "RECIPIENT_CREATE_FAILED",
      message: err.message,
    });
  }
});

app.get("/portal/send/recipients/:recipientId", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const recipient = await partnerRecipientService.getRecipient(
        req.partnerId,
        req.params.recipientId,
    );
    if (!recipient) {
      res.status(404).json({success: false, error: "Recipient not found"});
      return;
    }
    res.status(200).json({success: true, data: {recipient}});
  } catch (err) {
    console.error("b2bPortal GET /portal/send/recipients/:id:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

app.patch("/portal/send/recipients/:recipientId", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const recipient = await partnerRecipientService.updateRecipient(
        req.partnerId,
        req.params.recipientId,
        req.body || {},
        req.userId,
    );
    res.status(200).json({success: true, data: {recipient}});
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal PATCH /portal/send/recipients/:id:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "RECIPIENT_UPDATE_FAILED",
      message: err.message,
    });
  }
});

app.delete("/portal/send/recipients/:recipientId", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const data = await partnerRecipientService.deleteRecipient(
        req.partnerId,
        req.params.recipientId,
    );
    res.status(200).json({success: true, data});
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal DELETE /portal/send/recipients/:id:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "RECIPIENT_DELETE_FAILED",
      message: err.message,
    });
  }
});

/**
 * Quote a send corridor (rate + fee breakdown for Payment summary).
 * Body or query: amount, fromCurrency, toCurrency, rail?
 */
app.post("/portal/send/quote", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const body = req.body || {};
    const quote = await b2bSendService.quoteSend({
      partnerId: req.partnerId,
      amount: body.amount != null ? body.amount : req.query.amount,
      fromCurrency: body.fromCurrency || body.from || req.query.fromCurrency || "KES",
      toCurrency: body.toCurrency || body.to || req.query.toCurrency || "AED",
      rail: body.rail || req.query.rail || "bank_transfer",
    });
    res.status(200).json({success: true, data: {quote}});
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /portal/send/quote:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "QUOTE_FAILED",
      message: err.message,
    });
  }
});

/** List corridor catalog (rates/fees) available for Send. */
app.get("/portal/send/corridors", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const cfg = await b2bSendService.loadSendConfig();
    const corridors = Object.entries(cfg.corridors).map(([key, c]) => ({
      key,
      fromCurrency: c.fromCurrency,
      toCurrency: c.toCurrency,
      rail: c.rail || "bank_transfer",
      rate: Number(c.rate),
      ourFeeFlat: Number(c.ourFeeFlat) || 0,
      ourFeePercent: Number(c.ourFeePercent) || 0,
      paymentFeeFlat: Number(c.paymentFeeFlat) || 0,
      paymentFeePercent: Number(c.paymentFeePercent) || 0,
      estimatedDelivery: c.estimatedDelivery || "Within minutes",
    }));
    res.status(200).json({
      success: true,
      data: {corridors, source: cfg.source},
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/send/corridors:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

/**
 * Create Send payment (Review & Confirm).
 * Debits partner wallet, notifies super admin, status=pending until ops fulfills.
 */
app.post("/portal/send/payments", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await b2bSendService.createSendPayment({
      partnerId: req.partnerId,
      actorUid: req.userId,
      amount: body.amount,
      fromCurrency: body.fromCurrency || body.from,
      toCurrency: body.toCurrency || body.to,
      rail: body.rail || "bank_transfer",
      paymentReference: body.paymentReference || body.reference || null,
      recipientId: body.recipientId || null,
      recipient: body.recipient || null,
      saveRecipient: body.saveRecipient === true,
    });
    res.status(201).json({
      success: true,
      data: result,
      message: "Payment submitted. Platform admin has been notified.",
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /portal/send/payments:", err.message);
    res.status(status).json({
      success: false,
      error: err.code || "SEND_PAYMENT_FAILED",
      message: err.message,
    });
  }
});

app.get("/portal/send/payments", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const data = await b2bSendService.listSendPayments(req.partnerId, {
      limit: parseInt(String(req.query.limit || "50"), 10) || 50,
      status: req.query.status || null,
    });
    res.status(200).json({success: true, data});
  } catch (err) {
    console.error("b2bPortal GET /portal/send/payments:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

app.get("/portal/send/payments/:paymentId", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const payment = await b2bSendService.getSendPayment(
        req.partnerId,
        req.params.paymentId,
    );
    if (!payment) {
      res.status(404).json({success: false, error: "Payment not found"});
      return;
    }
    res.status(200).json({success: true, data: {payment}});
  } catch (err) {
    console.error("b2bPortal GET /portal/send/payments/:id:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

/** Super-admin: list pending (or filtered) send payments across partners. */
app.get("/platform/send/payments", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const data = await b2bSendService.listPlatformSendPayments({
      limit: parseInt(String(req.query.limit || "50"), 10) || 50,
      status: req.query.status || "pending",
    });
    res.status(200).json({success: true, data});
  } catch (err) {
    console.error("b2bPortal GET /platform/send/payments:", err.message);
    res.status(500).json({success: false, error: err.message});
  }
});

/**
 * POST /portal/funding/checkout — B2B Add Money (Paystack KES hosted checkout).
 * Credits partner KES wallet after Paystack webhook verify.
 */
app.post("/portal/funding/checkout", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const body = req.body || {};
    const amount = Number(body.amount);
    const currency = String(body.currency || "KES").toUpperCase();
    const email =
      body.email ||
      req.decodedToken?.email ||
      null;
    const callbackUrl = body.callbackUrl || body.redirectUrl || null;
    const idempotencyKey =
      req.get("Idempotency-Key") ||
      body.idempotencyKey ||
      null;
    const correlationId = correlationFromRequest(req) || body.correlationId || null;

    const data = await b2bFundingBridgeService.createB2bSelfTopupCheckout({
      partnerId: req.partnerId,
      actorUid: req.userId,
      amount,
      currency,
      email,
      callbackUrl,
      idempotencyKey,
      correlationId,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    });

    res.status(data.duplicate ? 200 : 201).json({ success: true, data });
  } catch (err) {
    const status = err.statusCode || (String(err.message || "").includes("supports KES") ? 400 : 500);
    console.error("b2bPortal POST /portal/funding/checkout:", err.message);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err.message || "Checkout failed",
    });
  }
});

/**
 * GET /portal/funding/orders/:orderId — poll Add Money order status.
 */
app.get("/portal/funding/orders/:orderId", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const order = await fundingOrderService.getFundingOrderForPartner(
        req.partnerId,
        req.params.orderId,
    );
    if (!order) {
      res.status(404).json({ success: false, error: "Funding order not found" });
      return;
    }
    res.status(200).json({
      success: true,
      data: {
        orderId: order.id,
        invoiceId: order.providerReference || order.id,
        status: order.status,
        amount: order.metadata?.requestedAmount ?? order.amount,
        currency: order.metadata?.requestedCurrency ?? order.currency,
        checkoutUrl: order.checkoutUrl,
        provider: order.provider,
        failureReason: order.failureReason,
        createdAt: order.createdAt,
        completedAt: order.completedAt,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/funding/orders/:orderId:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /portal/funding/confirm — verify + complete if webhook is slow (return-from-Paystack).
 * Body: { orderId } or { invoiceId } (Paystack reference).
 */
app.post("/portal/funding/confirm", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const body = req.body || {};
    let orderId = body.orderId || body.fundingOrderId || null;
    const invoiceId = body.invoiceId || body.reference || body.trxref || null;

    if (!orderId && invoiceId) {
      const byRef = await fundingOrderService.findByProviderReference("paystack", String(invoiceId));
      if (byRef && String(byRef.metadata?.partnerId || "") === String(req.partnerId)) {
        orderId = byRef.id;
      }
    }

    if (!orderId) {
      res.status(400).json({ success: false, error: "orderId or invoiceId is required" });
      return;
    }

    const result = await fundingWebhookService.confirmB2bFundingOrder(req.partnerId, String(orderId));
    const order = await fundingOrderService.getFundingOrderForPartner(req.partnerId, String(orderId));
    res.status(200).json({
      success: Boolean(result.success),
      data: {
        orderId: order?.id || orderId,
        status: order?.status || null,
        duplicate: Boolean(result.duplicate),
        amount: order?.metadata?.requestedAmount ?? order?.amount ?? null,
        currency: order?.metadata?.requestedCurrency ?? order?.currency ?? null,
        error: result.error || null,
      },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("b2bPortal POST /portal/funding/confirm:", err.message);
    res.status(status).json({ success: false, error: err.message });
  }
});

/** Partner transaction history (Firebase Bearer). Platform super admin: all B2B payments. */
app.get("/portal/transactions", loadFirebaseUser, attachPartnerContextOrPlatformAdmin, async (req, res) => {
  try {
    const data = await fetchPortalTransactions(req, {
      platformScope: Boolean(req.platformTransactionScope),
      partnerId: req.partnerId || null,
    });
    res.status(200).json({
      success: true,
      data: {
        ...data,
        scope: req.platformTransactionScope ? "platform" : "partner",
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/transactions:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Platform-wide transactions for super-admin dashboard (preferred for Overview / Partners tabs). */
app.get("/platform/transactions", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const data = await fetchPortalTransactions(req, { platformScope: true });
    res.status(200).json({
      success: true,
      data: {
        ...data,
        scope: "platform",
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/transactions:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** IntaSend post-payment landing (path-only redirect_url — no query string). */
app.get("/l/:linkId/success", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(renderSuccessHtml(
      req.params.linkId,
      `/${B2B_PORTAL_FUNCTION_SEGMENT}`,
  ));
});

/** Hosted payer checkout page — works without pay.truepay.africa DNS */
app.get("/l/:linkId", (req, res) => {
  const partnerId = req.query.partner ? String(req.query.partner) : "";
  if (!partnerId) {
    res.status(400).send(renderErrorHtml(
        "Invalid link",
        "This payment link is missing the partner parameter.",
    ));
    return;
  }
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(renderCheckoutHtml(
      req.params.linkId,
      partnerId,
      `/${B2B_PORTAL_FUNCTION_SEGMENT}`,
  ));
});

/**
 * Public email-verification click target (no auth).
 * Applies Firebase oobCode via Identity Toolkit, then 302-redirects to the B2B dashboard.
 * Query: mode, oobCode, continueUrl
 */
app.get("/public/verify-email", async (req, res) => {
  const oobCode =
    typeof req.query.oobCode === "string" ? req.query.oobCode.trim() : "";
  const apiKey =
    typeof req.query.apiKey === "string" ? req.query.apiKey.trim() : "";
  let continueUrl;
  try {
    continueUrl = emailService.resolveContinueUrl(
        typeof req.query.continueUrl === "string" ? req.query.continueUrl : "",
    );
  } catch (_e) {
    continueUrl = emailService.defaultContinueUrl();
  }

  if (!oobCode) {
    res.redirect(
        302,
        emailService.withQueryParams(continueUrl, {verifyError: "missing_code"}),
    );
    return;
  }

  try {
    await emailService.applyEmailVerificationOobCode(oobCode, apiKey);
    res.redirect(
        302,
        emailService.withQueryParams(continueUrl, {emailVerified: "1"}),
    );
  } catch (err) {
    const code = (err && (err.code || err.message)) ?
      String(err.code || err.message) :
      "verify_failed";
    console.error("b2bPortal GET /public/verify-email:", code);
    res.redirect(
        302,
        emailService.withQueryParams(continueUrl, {
          verifyError: code.slice(0, 64),
        }),
    );
  }
});

/** Public payer read for hosted checkout — no auth */
app.get("/public/payment-links/:linkId", async (req, res) => {
  try {
    const partnerId = req.query.partner ? String(req.query.partner) : "";
    if (!partnerId) {
      res.status(400).json({
        success: false,
        error: "Query parameter partner is required",
      });
      return;
    }
    const link = await paymentLinkService.getPublicPaymentLink(
        req.params.linkId,
        partnerId,
    );
    if (!link) {
      res.status(404).json({ success: false, error: "Payment link not found" });
      return;
    }
    if (link.status === "expired") {
      res.status(410).json({
        success: false,
        error: "Payment link has expired",
        data: link,
      });
      return;
    }
    if (link.status === "cancelled") {
      res.status(409).json({
        success: false,
        error: `Payment link is ${link.status}`,
        data: link,
      });
      return;
    }
    res.status(200).json({ success: true, data: link });
  } catch (err) {
    console.error("b2bPortal GET /public/payment-links/:linkId:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Start IntaSend (or configured rail) checkout for a hosted payment link — no auth */
app.post("/public/payment-links/:linkId/checkout", async (req, res) => {
  try {
    const partnerId = req.query.partner ? String(req.query.partner) : "";
    if (!partnerId) {
      res.status(400).json({
        success: false,
        error: "Query parameter partner is required",
      });
      return;
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const data = await b2bPaymentLinkCheckoutService.startCheckout(
        req.params.linkId,
        partnerId,
        {
          payerName: body.payerName || body.payer_name || body.name || null,
          email: body.email || null,
          phoneNumber: body.phoneNumber || body.phone || null,
          firstName: body.firstName || null,
          lastName: body.lastName || null,
          country: body.country || null,
        },
        body.rail || null,
    );
    if (!data.checkoutUrl) {
      res.status(200).json({
        success: true,
        data,
        message: data.message || "Manual settlement required.",
      });
      return;
    }
    res.status(201).json({ success: true, data });
  } catch (err) {
    const intaSend = paymentRailService.getIntaSendErrorDetails(err);
    const msg = intaSend?.message || err.message || "Checkout failed";
    console.error("b2bPortal POST /public/payment-links/:linkId/checkout:", msg, {
      intaSend: intaSend?.body,
      httpStatus: intaSend?.httpStatus,
    });
    let status = 500;
    if (msg.includes("not found")) {
      status = 404;
    } else if (msg.includes("expired") || msg.includes("is cancelled")) {
      status = 409;
    } else if (
      msg.includes("Payer name is required") ||
      msg.includes("already paid") ||
      intaSend?.httpStatus === 400 ||
      intaSend?.httpStatus === 422 ||
      msg.includes("Invalid") ||
      msg.includes("not supported") ||
      msg.includes("not configured") ||
      msg.includes("IntaSend checkout failed")
    ) {
      status = 400;
    }
    /** @type {Record<string, unknown>} */
    const body = { success: false, error: msg };
    if (intaSend?.body != null) {
      body.intaSend = intaSend.body;
    }
    res.status(status).json(body);
  }
});

/** Public payment link settlement status — no auth */
app.get("/public/payment-links/:linkId/status", async (req, res) => {
  try {
    const partnerId = req.query.partner ? String(req.query.partner) : null;
    const checkoutId = req.query.checkoutId ? String(req.query.checkoutId) : null;
    const status = await b2bPaymentLinkCheckoutService.getPublicLinkStatus(
        req.params.linkId,
        partnerId,
        checkoutId,
    );
    if (!status) {
      res.status(404).json({ success: false, error: "Payment link not found" });
      return;
    }
    res.status(200).json({ success: true, data: status });
  } catch (err) {
    console.error("b2bPortal GET /public/payment-links/:linkId/status:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

exports.b2bPortal = onRequest(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    secrets: [
      intaSendPublishableKey,
      intaSendSecretKey,
      smtpUser,
      smtpPass,
      paystackSecretKey,
      paystackSplitCode,
    ],
  },
  app,
);
