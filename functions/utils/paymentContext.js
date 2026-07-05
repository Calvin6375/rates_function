/**
 * @fileoverview Universal payment correlation context — provider-agnostic trace ID.
 * Generated at funding order creation and propagated through all downstream operations.
 */

const crypto = require("crypto");

/**
 * @typedef {Object} PaymentContext
 * @property {string} correlationId
 * @property {string} [userId]
 * @property {string} [fundingOrderId]
 * @property {string} [provider]
 * @property {string} [settlementProvider]
 * @property {string} [source]
 */

/**
 * @returns {string}
 */
function generateCorrelationId() {
  return `corr_${crypto.randomUUID()}`;
}

/**
 * @param {string} [raw]
 * @returns {string|null}
 */
function normalizeCorrelationHeader(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 128) {
    return null;
  }
  return trimmed;
}

/**
 * @param {Object} params
 * @param {string} [params.correlationId]
 * @param {string} [params.userId]
 * @param {string} [params.fundingOrderId]
 * @param {string} [params.provider]
 * @param {string} [params.settlementProvider]
 * @param {string} [params.source]
 * @returns {PaymentContext}
 */
function createPaymentContext(params = {}) {
  const correlationId =
    normalizeCorrelationHeader(params.correlationId) || generateCorrelationId();
  return {
    correlationId,
    userId: params.userId || null,
    fundingOrderId: params.fundingOrderId || null,
    provider: params.provider || null,
    settlementProvider: params.settlementProvider || null,
    source: params.source || null,
  };
}

/**
 * @param {PaymentContext|null|undefined} ctx
 * @param {Object} patch
 * @returns {PaymentContext}
 */
function propagateContext(ctx, patch = {}) {
  const base = ctx && ctx.correlationId ? { ...ctx } : createPaymentContext({});
  return {
    correlationId: base.correlationId,
    userId: patch.userId !== undefined ? patch.userId : base.userId,
    fundingOrderId: patch.fundingOrderId !== undefined ?
      patch.fundingOrderId :
      base.fundingOrderId,
    provider: patch.provider !== undefined ? patch.provider : base.provider,
    settlementProvider: patch.settlementProvider !== undefined ?
      patch.settlementProvider :
      base.settlementProvider,
    source: patch.source !== undefined ? patch.source : base.source,
  };
}

/**
 * @param {PaymentContext|null|undefined} ctx
 * @returns {PaymentContext}
 */
function assertContext(ctx) {
  if (!ctx || !ctx.correlationId) {
    throw new Error("Payment context with correlationId is required");
  }
  return ctx;
}

/**
 * Extract correlation ID from HTTP request headers.
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function correlationFromRequest(req) {
  const raw =
    req.get("X-Correlation-Id") ||
    req.get("x-correlation-id") ||
    null;
  return normalizeCorrelationHeader(raw);
}

/**
 * @param {PaymentContext|null|undefined} ctx
 * @returns {Object}
 */
function contextToMetadata(ctx) {
  if (!ctx || !ctx.correlationId) {
    return {};
  }
  return {
    correlationId: ctx.correlationId,
    fundingOrderId: ctx.fundingOrderId || null,
    provider: ctx.provider || null,
    settlementProvider: ctx.settlementProvider || null,
  };
}

module.exports = {
  generateCorrelationId,
  normalizeCorrelationHeader,
  createPaymentContext,
  propagateContext,
  assertContext,
  correlationFromRequest,
  contextToMetadata,
};
