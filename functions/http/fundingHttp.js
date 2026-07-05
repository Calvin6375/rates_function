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
const merchantSettlementService = require("../services/settlement/merchantSettlementService");
const { recordEvent } = require("../services/ops/paymentTimelineService");
const { createPaymentContext, correlationFromRequest } = require("../utils/paymentContext");
const { createLogger } = require("../utils/paymentOpsLogger");
const {
  FUNDING_CURRENCY,
  FUNDING_PROVIDERS,
  TIMELINE_EVENT_TYPES,
} = require("../utils/fundingTypes");

const logger = createLogger({ service: "fundingHttp" });

/**
 * @param {import("express").Express} app
 */
function mountFundingRoutes(app) {
  /**
   * POST /funding/orders — create funding order and initialize Paystack checkout
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
    const provider = String(body.provider || config.funding.defaultProvider).toLowerCase();
    const email = body.email || auth.decodedToken?.email || null;
    const callbackUrl = body.callbackUrl || body.redirectUrl || null;
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

    if (provider !== FUNDING_PROVIDERS.paystack) {
      res.status(400).json({ success: false, error: `Provider not yet enabled: ${provider}` });
      return;
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
        amount,
        currency: FUNDING_CURRENCY,
        correlationId: ctx.correlationId,
        fundingRequestId: idempotencyKey,
        metadata: {
          ...metadata,
          product: "tourist_payments",
          correlationId: ctx.correlationId,
        },
      });

      const session = await fundingRailService.initializePayment({
        provider,
        amount,
        currency: FUNDING_CURRENCY,
        email,
        callbackUrl,
        providerReference: order.providerReference,
        metadata: order.metadata,
      });

      const updated = await fundingOrderService.updateFundingOrder(order.id, {
        providerReference: session.providerReference,
        providerTransactionId: session.providerTransactionId || null,
        checkoutUrl: session.checkoutUrl,
      });

      await recordEvent({
        fundingOrderId: order.id,
        correlationId: ctx.correlationId,
        eventType: TIMELINE_EVENT_TYPES.order_created,
        provider,
        status: updated.status,
        metadata: { amount, currency: FUNDING_CURRENCY },
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
