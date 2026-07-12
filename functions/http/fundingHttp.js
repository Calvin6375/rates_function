/**
 * @fileoverview Tourist Payments funding REST routes — mounted on `api`.
 * POST /funding/orders, GET /funding/orders/:id, POST /funding/confirm,
 * POST /funding/merchant-payments, GET /funding/merchant-payments/:id
 */

const config = require("../config");
const { verifyFirebaseAuth } = require("../libs/auth");
const fundingOrderService = require("../services/funding/fundingOrderService");
const fundingRailService = require("../services/funding/fundingRailService");
const fundingWebhookService = require("../services/funding/fundingWebhookService");
const fundingIdempotencyService = require("../services/funding/fundingIdempotencyService");
const { convertToKesForPaystack } = require("../services/funding/c2bFundingFxService");
const merchantSettlementService = require("../services/settlement/merchantSettlementService");
const { resolvePaystackCallbackUrl, buildAppReturnDeepLink, apiBaseUrl } =
  require("../services/funding/fundingCallbackService");
const { renderFundingPaymentReturnHtml } = require("../utils/fundingPaymentReturnPage");
const { recordEvent } = require("../services/ops/paymentTimelineService");
const opsMetrics = require("../services/ops/opsMetricsService");
const { createPaymentContext, correlationFromRequest } = require("../utils/paymentContext");
const { createLogger } = require("../utils/paymentOpsLogger");
const {
  C2B_PAYSTACK_CURRENCY,
  FUNDING_CURRENCY,
  FUNDING_PROVIDERS,
  TIMELINE_EVENT_TYPES,
} = require("../utils/fundingTypes");

const transakProvider = require("../services/funding/providers/transakProvider");

const logger = createLogger({ service: "fundingHttp" });

/**
 * @param {import("express").Express} app
 */
function mountFundingRoutes(app) {
  /**
   * GET /internal/transak/health — Transak configuration probe (no secrets).
   */
  app.get("/internal/transak/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json(transakProvider.getHealthStatus());
  });

  /**
   * GET /funding/payment-return — Paystack browser redirect landing (public).
   * Paystack appends ?reference=…&trxref=… — no WebView required.
   */
  app.get("/funding/payment-return", async (req, res) => {
    const reference = String(req.query.reference || req.query.trxref || "").trim() || null;
    const deepLink = buildAppReturnDeepLink(reference);
    const statusUrl = `${apiBaseUrl()}/public/funding/status`;

    res.set("Cache-Control", "no-store");
    res.status(200).send(renderFundingPaymentReturnHtml({
      reference,
      deepLink,
      statusUrl,
    }));
  });

  /**
   * GET /public/funding/status — poll funding order status by provider reference (public).
   */
  app.get("/public/funding/status", async (req, res) => {
    const reference = String(req.query.reference || "").trim();
    if (!reference) {
      res.status(400).json({ success: false, error: "reference is required" });
      return;
    }

    const providerHint = String(req.query.provider || "").trim().toLowerCase();
    const providers = providerHint ?
      [providerHint] :
      fundingRailService.listProviders();

    let order = null;
    for (const provider of providers) {
      order = await fundingOrderService.findByProviderReference(provider, reference);
      if (order) {
        break;
      }
    }

    if (!order) {
      res.status(404).json({ success: false, error: "Funding order not found" });
      return;
    }

    res.status(200).json({
      success: true,
      status: order.status,
      amount: order.amount,
      currency: order.currency,
      reference: order.providerReference,
      provider: order.provider,
    });
  });

  /**
   * POST /funding/orders — create funding order and initialize provider checkout
   */
  app.post("/funding/orders", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const userId = auth.userId;
    const body = req.body || {};
    const amount = Number(body.amount);
    const inputCurrency = String(body.currency || "USD").toUpperCase();
    const provider = String(body.provider || config.funding.defaultProvider).toLowerCase();
    const email = body.email || auth.decodedToken?.email || null;
    const callbackUrl = body.callbackUrl || body.redirectUrl || null;
    const transakAccessToken = body.transakAccessToken || body.accessToken || null;
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
    const idempotencyKey =
      req.get("Idempotency-Key") ||
      req.get("idempotency-key") ||
      body.idempotencyKey ||
      null;

    if (!amount || amount <= 0) {
      res.status(400).json({ success: false, error: "Amount must be a positive number" });
      return;
    }

    if (!fundingRailService.listProviders().includes(provider)) {
      res.status(400).json({ success: false, error: `Provider not yet enabled: ${provider}` });
      return;
    }

    let chargeAmount = amount;
    let chargeCurrency = inputCurrency;
    let chargeMeta = {
      requestedAmount: amount,
      requestedCurrency: inputCurrency,
    };

    if (provider === FUNDING_PROVIDERS.paystack) {
      try {
        const charge = await convertToKesForPaystack(amount, inputCurrency);
        chargeAmount = charge.amountKes;
        chargeCurrency = C2B_PAYSTACK_CURRENCY;
        chargeMeta = {
          requestedAmount: charge.requestedAmount,
          requestedCurrency: charge.requestedCurrency,
          fxRate: charge.fxRate,
          paystackCurrency: charge.paystackCurrency,
        };
      } catch (fxErr) {
        res.status(400).json({ success: false, error: fxErr.message });
        return;
      }
    } else if (provider === FUNDING_PROVIDERS.transak) {
      chargeCurrency = FUNDING_CURRENCY;
      chargeMeta.treasuryWallet = process.env.TRANSAK_TREASURY_WALLET || config.transak?.treasuryWallet || null;
      chargeMeta.cryptoCurrency = process.env.TRANSAK_DEFAULT_CRYPTO || config.transak?.defaultCrypto || "USDT";
    }

    try {
      const ctx = createPaymentContext({
        correlationId: correlationFromRequest(req),
        userId,
        provider,
        source: "fundingHttp",
      });

      if (idempotencyKey) {
        const existing = await fundingIdempotencyService.lookupIdempotencyKey(userId, idempotencyKey);
        if (existing) {
          const prior = await fundingOrderService.getFundingOrderForUser(userId, existing.fundingOrderId);
          if (prior) {
            res.status(200).json({
              success: true,
              duplicate: true,
              data: { fundingOrder: prior, checkoutUrl: prior.checkoutUrl, correlationId: prior.correlationId },
            });
            return;
          }
        }
      }

      const orderId = fundingOrderService.generateFundingOrderId();

      if (idempotencyKey) {
        const claim = await fundingIdempotencyService.claimIdempotencyKey({
          userId,
          idempotencyKey,
          fundingOrderId: orderId,
        });
        if (claim.duplicate && claim.fundingOrderId !== orderId) {
          const prior = await fundingOrderService.getFundingOrderForUser(userId, claim.fundingOrderId);
          if (prior) {
            res.status(200).json({
              success: true,
              duplicate: true,
              data: { fundingOrder: prior, checkoutUrl: prior.checkoutUrl, correlationId: prior.correlationId },
            });
            return;
          }
        }
      }

      const order = await fundingOrderService.createFundingOrder({
        id: orderId,
        userId,
        provider,
        amount: chargeAmount,
        currency: chargeCurrency,
        correlationId: ctx.correlationId,
        fundingRequestId: idempotencyKey,
        metadata: {
          ...metadata,
          product: "tourist",
          correlationId: ctx.correlationId,
          userId,
          provider,
          environment: process.env.GCLOUD_PROJECT || config.transak?.environment || "staging",
          ...chargeMeta,
        },
      });

      let session;
      try {
        session = await fundingRailService.initializePayment({
          provider,
          amount: chargeAmount,
          currency: chargeCurrency,
          email,
          callbackUrl: resolvePaystackCallbackUrl(callbackUrl),
          providerReference: order.providerReference,
          fundingOrderId: order.id,
          userId,
          correlationId: ctx.correlationId,
          transakAccessToken,
          metadata: order.metadata,
        });
        await opsMetrics.increment("funding.checkout.initialized", 1);
      } catch (initErr) {
        await opsMetrics.increment("funding.checkout.failed", 1);
        throw initErr;
      }

      const patch = {
        providerReference: session.providerReference,
        providerTransactionId: session.providerTransactionId || null,
        checkoutUrl: session.checkoutUrl,
      };
      if (provider === FUNDING_PROVIDERS.transak && session.raw) {
        patch.metadata = {
          ...order.metadata,
          quoteId: session.raw.quote?.quoteId || order.metadata.quoteId || null,
          cryptoAmount: session.raw.cryptoAmount || session.raw.quote?.cryptoAmount || null,
          treasuryWallet: session.raw.treasuryWallet || order.metadata.treasuryWallet || null,
        };
      }

      const updated = await fundingOrderService.updateFundingOrder(order.id, patch);

      await recordEvent({
        fundingOrderId: order.id,
        correlationId: ctx.correlationId,
        eventType: TIMELINE_EVENT_TYPES.order_created,
        provider,
        status: updated.status,
        metadata: {
          amount: chargeAmount,
          currency: chargeCurrency,
          ...chargeMeta,
        },
      });

      await recordEvent({
        fundingOrderId: order.id,
        correlationId: ctx.correlationId,
        eventType: TIMELINE_EVENT_TYPES.provider_initialized,
        provider,
        metadata: { checkoutUrl: session.checkoutUrl },
      });

      res.set("X-Correlation-Id", ctx.correlationId);
      res.status(201).json({
        success: true,
        data: {
          fundingOrder: updated,
          checkoutUrl: session.checkoutUrl,
          correlationId: ctx.correlationId,
        },
      });
    } catch (err) {
      logger.error("funding.orders.failed", { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /funding/orders/:id
   */
  app.get("/funding/orders/:id", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const order = await fundingOrderService.getFundingOrderForUser(auth.userId, req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: "Funding order not found" });
      return;
    }

    res.status(200).json({ success: true, data: { fundingOrder: order } });
  });

  /**
   * POST /funding/confirm — server-side verify after Paystack redirect
   */
  app.post("/funding/confirm", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const fundingOrderId = req.body?.fundingOrderId || req.body?.orderId;
    if (!fundingOrderId) {
      res.status(400).json({ success: false, error: "fundingOrderId is required" });
      return;
    }

    try {
      const result = await fundingWebhookService.confirmFundingOrder(auth.userId, fundingOrderId);
      const order = await fundingOrderService.getFundingOrderForUser(auth.userId, fundingOrderId);
      res.status(200).json({
        success: result.success !== false,
        duplicate: result.duplicate || false,
        data: { fundingOrder: order, result },
      });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /funding/merchant-payments — pay external merchant from USD balance
   */
  app.post("/funding/merchant-payments", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const body = req.body || {};
    const amountUsd = Number(body.amountUsd || body.amount);
    const merchantId = body.merchantId;
    const requestId = body.requestId || body.idempotencyKey;
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};

    if (!merchantId) {
      res.status(400).json({ success: false, error: "merchantId is required" });
      return;
    }
    if (!requestId) {
      res.status(400).json({ success: false, error: "requestId (idempotency key) is required" });
      return;
    }
    if (!amountUsd || amountUsd <= 0) {
      res.status(400).json({ success: false, error: "amountUsd must be positive" });
      return;
    }

    try {
      const result = await merchantSettlementService.initiateMerchantPayment({
        userId: auth.userId,
        merchantId,
        amountUsd,
        requestId,
        metadata: {
          ...metadata,
          correlationId: correlationFromRequest(req) || metadata.correlationId,
        },
      });
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      const status = err.statusCode || 500;
      console.error("POST /funding/merchant-payments:", err.message);
      res.status(status).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /funding/merchant-payments/:id
   */
  app.get("/funding/merchant-payments/:id", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const payment = await merchantSettlementService.getMerchantPaymentForUser(
        auth.userId,
        req.params.id,
    );
    if (!payment) {
      res.status(404).json({ success: false, error: "Merchant payment not found" });
      return;
    }

    res.status(200).json({ success: true, data: { merchantPayment: payment } });
  });
}

module.exports = {
  mountFundingRoutes,
};
