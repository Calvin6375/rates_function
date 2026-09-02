/**
 * @fileoverview Safari Card REST API — authenticated payout/disbursement endpoints.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const { verifyFirebaseAuth } = require("../libs/auth");
const safariCardPayoutService = require("../services/safariCard/safariCardPayoutService");
const safariCardPayoutReconcile = require("../services/safariCard/safariCardPayoutReconcileService");
const intasendDisbursement = require("../services/intasend/intasendDisbursementProvider");
const { ERROR_CODES } = require("../utils/safariCardPayoutTypes");
const { IntaSendApiError } = require("../services/intasend/intasendClient");
const {
  C2B_ENCRYPTION_SECRETS,
  C2B_ENCRYPTION_ALLOW_HEADERS,
  createC2bPayloadEncryptionMiddleware,
} = require("./middleware/c2bPayloadEncryption");

const intaSendSecretKey = defineSecret(config.secrets.intaSendSecretKey);
const intaSendPublishableKey = defineSecret(config.secrets.intaSendPublishableKey);

const EXPECTED_FIREBASE_PROJECT = "truepay-72060";

/**
 * Ensure Firebase secrets are on process.env for intasendClient (reads env only).
 */
function ensureIntaSendSecretsOnEnv() {
  try {
    const secret = intaSendSecretKey.value();
    if (secret && !process.env.INTASEND_SECRET_KEY) {
      process.env.INTASEND_SECRET_KEY = secret;
    }
  } catch (_err) {
    // Secret unavailable outside request context
  }
  try {
    const pub = intaSendPublishableKey.value();
    if (pub && !process.env.INTASEND_PUBLISHABLE_KEY) {
      process.env.INTASEND_PUBLISHABLE_KEY = pub;
    }
  } catch (_err) {
    // ignore
  }
}

/**
 * Decode JWT payload without verification (debug logging only).
 * @param {string} token
 * @returns {Object|null}
 */
function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) {
      return null;
    }
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (_err) {
    return null;
  }
}

/**
 * @param {string} authError
 * @param {string} rawToken
 * @param {Object|null} claims
 * @returns {Object}
 */
function buildAuthFailureBody(authError, rawToken, claims) {
  /** @type {Record<string, unknown>} */
  const body = {
    success: false,
    error: authError || "Unauthorized",
    code: ERROR_CODES.UNAUTHORIZED,
  };

  if (!rawToken) {
    body.hint = "Send Authorization: Bearer <firebase-id-token> from FirebaseAuth.getIdToken()";
    return body;
  }

  const tokenParts = rawToken.split(".").length;
  if (tokenParts !== 3) {
    body.hint = "Authorization is not a Firebase ID token JWT. Use getIdToken(), not refresh/custom/App Check token.";
    body.tokenParts = tokenParts;
    return body;
  }

  if (!claims) {
    body.hint = "Token could not be decoded. Ensure the full JWT is sent after Bearer.";
    return body;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expired = typeof claims.exp === "number" ? claims.exp < nowSec : null;
  const projectMatch = claims.aud === EXPECTED_FIREBASE_PROJECT;
  const iss = typeof claims.iss === "string" ? claims.iss : null;
  const looksLikeFirebaseIdToken = iss ?
    iss.includes(`securetoken.google.com/${EXPECTED_FIREBASE_PROJECT}`) :
    null;

  body.token = {
    aud: claims.aud || null,
    iss,
    exp: claims.exp || null,
    expired,
    expectedProject: EXPECTED_FIREBASE_PROJECT,
    projectMatch,
    looksLikeFirebaseIdToken,
  };

  if (!projectMatch) {
    body.hint = `Firebase project mismatch. App must use ${EXPECTED_FIREBASE_PROJECT} (check google-services.json project_id).`;
  } else if (expired) {
    body.hint = "ID token expired. Call await user.getIdToken(true) immediately before the request.";
  } else if (looksLikeFirebaseIdToken === false) {
    body.hint = "Token issuer is not a Firebase ID token. Do not send App Check or Google OAuth tokens in Authorization.";
  }

  return body;
}

const app = express();
app.use(express.json());
app.use(createC2bPayloadEncryptionMiddleware());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allowedOrigin = "*";
  if (origin) {
    if (
      origin.includes("localhost") ||
      origin.includes("127.0.0.1") ||
      origin.includes("truepay") ||
      /^https:\/\/([a-z0-9-]+\.)*truepay\.live$/i.test(origin)
    ) {
      allowedOrigin = origin;
    }
  }
  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", C2B_ENCRYPTION_ALLOW_HEADERS);
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
async function requireAuth(req, res, next) {
  const authHeader = req.headers?.authorization;
  const bearerMatch = typeof authHeader === "string" ?
    authHeader.match(/^Bearer\s+(.+)$/i) :
    null;
  const rawToken = bearerMatch ? bearerMatch[1].trim() : "";
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success || !auth.userId) {
    const claims = decodeJwtPayloadUnsafe(rawToken);
    const failureBody = buildAuthFailureBody(auth.error || "Unauthorized", rawToken, claims);
    console.error(JSON.stringify({
      event: "safariCardApi.authFailed",
      path: req.path,
      error: failureBody.error,
      hint: failureBody.hint || null,
      token: failureBody.token || null,
      tokenParts: failureBody.tokenParts || null,
    }));
    res.status(401).json(failureBody);
    return;
  }
  req.userId = auth.userId;
  next();
}

/**
 * @param {unknown} err
 * @returns {{ status: number, body: Object }}
 */
function mapErrorResponse(err) {
  let code = err && typeof err === "object" && err.code ?
    String(err.code) :
    ERROR_CODES.PROVIDER_ERROR;
  let status = err && typeof err === "object" && err.httpStatus ?
    Number(err.httpStatus) :
    500;
  let message = err instanceof Error ? err.message : "Request failed";

  const upstreamAuthFailure = err instanceof IntaSendApiError &&
    (status === 401 || status === 403);
  const upstreamTimeout = err instanceof IntaSendApiError && status === 408;

  if (upstreamAuthFailure) {
    code = ERROR_CODES.PROVIDER_AUTH_ERROR;
    status = 502;
    message = "Payout provider authentication failed. IntaSend API keys or sandbox/production environment may be misconfigured on the server.";
  } else if (upstreamTimeout) {
    code = ERROR_CODES.PROVIDER_TIMEOUT;
    status = 504;
  } else if (err instanceof IntaSendApiError) {
    // Non-auth IntaSend failures (float, validation, approve, etc.)
    code = ERROR_CODES.PROVIDER_ERROR;
    status = 502;
    message = err.message || message;
  } else if (!err?.code && (status === 401 || status === 403)) {
    code = ERROR_CODES.PROVIDER_AUTH_ERROR;
    status = 502;
  }

  /** @type {Record<string, unknown>} */
  const body = { success: false, error: message, code };
  if (err instanceof IntaSendApiError) {
    body.provider = "intasend";
    const upstreamDetail = require("../services/intasend/intasendClient")
        .flattenErrorBody(err.body);
    if (upstreamDetail) {
      body.providerDetail = upstreamDetail.slice(0, 300);
    }
  }
  if (upstreamAuthFailure && err instanceof IntaSendApiError) {
    try {
      const {getIntaSendApiConfig} = require("../services/intasend/intasendClient");
      const cfg = getIntaSendApiConfig();
      body.hint =
        "Use matching IntaSend keys and host: test keys → sandbox.intasend.com " +
        "(INTASEND_ENV=sandbox); live keys → payment.intasend.com (INTASEND_ENV=live). " +
        "Confirm firebase secret INTASEND_SECRET_KEY is bound to safariCardApi.";
      body.diagnostics = {
        apiHost: cfg.apiHost,
        isSandbox: cfg.isSandbox,
        secretKeyConfigured: Boolean(cfg.secretKey),
      };
    } catch (_e) {
      // ignore
    }
  }

  return {
    status: status >= 400 && status < 600 ? status : 500,
    body,
  };
}

app.use((req, _res, next) => {
  ensureIntaSendSecretsOnEnv();
  next();
});

/** POST /safari-card/payouts/validate-beneficiary */
app.post("/safari-card/payouts/validate-beneficiary", requireAuth, async (req, res) => {
  try {
    const data = await safariCardPayoutService.validateBeneficiary(req.body || {});
    res.status(200).json({ success: true, data });
  } catch (err) {
    const mapped = mapErrorResponse(err);
    res.status(mapped.status).json(mapped.body);
  }
});

/**
 * POST /safari-card/payouts/quote — Send Money / Pay fee breakdown for Review screen.
 * Body: { type, amount, currency?, accountType?, recipient? } — does not create a payout.
 *
 * Pay Till:    type=MPESA_B2B, accountType=TillNumber  → buy_goods fees
 * Pay PayBill: type=MPESA_B2B, accountType=PayBill     → pay_bill fees
 * Send Money:  type=MPESA_B2C | SAFARITAP_WALLET | BANK
 */
app.post("/safari-card/payouts/quote", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const {quotePayoutBreakdown} = require("../services/safariCard/safariCardPayoutFeeService");
    const data = await quotePayoutBreakdown({
      userId: req.userId,
      payoutType: body.type || body.payoutType,
      amount: body.amount,
      currency: body.currency || "KES",
      accountType: body.accountType || body.recipient?.accountType,
      recipient: body.recipient || {},
    });
    res.status(200).json({success: true, data});
  } catch (err) {
    const mapped = mapErrorResponse(err);
    res.status(mapped.status).json(mapped.body);
  }
});

/** POST /safari-card/payouts */
app.post("/safari-card/payouts", requireAuth, async (req, res) => {
  try {
    const data = await safariCardPayoutService.createPayout(req.userId, req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    const mapped = mapErrorResponse(err);
    console.error(JSON.stringify({
      event: "safariCard.payouts.createFailed",
      userId: req.userId || null,
      type: req.body?.type || null,
      amount: req.body?.amount ?? null,
      status: mapped.status,
      code: mapped.body?.code || null,
      error: mapped.body?.error || (err instanceof Error ? err.message : String(err)),
      providerDetail: mapped.body?.providerDetail || null,
    }));
    res.status(mapped.status).json(mapped.body);
  }
});

/** GET /safari-card/payouts/by-client-request/:clientRequestId */
app.get("/safari-card/payouts/by-client-request/:clientRequestId", requireAuth, async (req, res) => {
  try {
    const clientRequestId = String(req.params.clientRequestId || "").trim();
    if (!clientRequestId) {
      res.status(400).json({
        success: false,
        error: "clientRequestId is required",
        code: ERROR_CODES.VALIDATION_FAILED,
      });
      return;
    }

    const existing = await safariCardPayoutService.findPayoutByIdempotency(
        req.userId,
        clientRequestId,
    );
    if (existing && !["SUCCESS", "FAILED", "CANCELLED"].includes(existing.status)) {
      const payoutId = existing.payoutId || existing.id;
      if (payoutId) {
        try {
          await safariCardPayoutReconcile.reconcilePayout(payoutId);
        } catch (reconcileErr) {
          console.warn("GET payout reconcile:", payoutId, reconcileErr.message);
        }
      }
    }

    const data = await safariCardPayoutService.getPayoutForUserByClientRequestId(
        req.userId,
        clientRequestId,
    );
    if (!data) {
      res.status(404).json({
        success: false,
        error: "Payout not found",
        code: ERROR_CODES.NOT_FOUND,
      });
      return;
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    const mapped = mapErrorResponse(err);
    res.status(mapped.status).json(mapped.body);
  }
});

/** GET /safari-card/payouts/:payoutId */
app.get("/safari-card/payouts/:payoutId", requireAuth, async (req, res) => {
  try {
    const payoutId = String(req.params.payoutId);
    const existing = await safariCardPayoutService.getPayoutById(payoutId);
    if (existing && !["SUCCESS", "FAILED", "CANCELLED"].includes(existing.status)) {
      try {
        await safariCardPayoutReconcile.reconcilePayout(payoutId);
      } catch (reconcileErr) {
        console.warn("GET payout reconcile:", payoutId, reconcileErr.message);
      }
    }

    const data = await safariCardPayoutService.getPayoutForUser(req.userId, payoutId);
    if (!data) {
      res.status(404).json({
        success: false,
        error: "Payout not found",
        code: ERROR_CODES.NOT_FOUND,
      });
      return;
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    const mapped = mapErrorResponse(err);
    res.status(mapped.status).json(mapped.body);
  }
});

/** GET /safari-card/payouts */
app.get("/safari-card/payouts", requireAuth, async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const data = await safariCardPayoutService.listPayoutsForUser(req.userId, limit);
    res.status(200).json({ success: true, data });
  } catch (err) {
    const mapped = mapErrorResponse(err);
    res.status(mapped.status).json(mapped.body);
  }
});

/**
 * GET /safari-card/banks — Kenya PesaLink bank codes for Send Money → Bank.
 * @see https://developers.intasend.com/reference/api_v1_send_money_bank_codes_retrieve
 */
app.get("/safari-card/banks", requireAuth, async (req, res) => {
  try {
    const result = await intasendDisbursement.listKenyanBankCodes();
    const banks = Array.isArray(result) ? result : (result.banks || []);
    const source = Array.isArray(result) ? "intasend" : (result.source || "intasend");
    res.status(200).json({
      success: true,
      data: banks,
      meta: {country: "KE", source, count: banks.length},
    });
  } catch (err) {
    // Last resort: never block the bank picker on provider auth for the list endpoint.
    const fallback = intasendDisbursement.FALLBACK_KENYA_BANK_CODES || [];
    if (fallback.length) {
      console.warn("GET /safari-card/banks fallback:", err.message);
      res.status(200).json({
        success: true,
        data: [...fallback],
        meta: {country: "KE", source: "fallback", count: fallback.length},
      });
      return;
    }
    const mapped = mapErrorResponse(err);
    res.status(mapped.status).json(mapped.body);
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

exports.safariCardApi = onRequest(
    {
      secrets: [intaSendSecretKey, intaSendPublishableKey, ...C2B_ENCRYPTION_SECRETS],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);
