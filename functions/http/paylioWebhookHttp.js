/**
 * @fileoverview PayLio callback. PayLio GETs this URL. The query string is not proof of payment.
 * Credit happens only after fundingWebhookService re-checks GET /payment-status.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const fundingRailService = require("../services/funding/fundingRailService");
const fundingWebhookService = require("../services/funding/fundingWebhookService");
const opsMetrics = require("../services/ops/opsMetricsService");
const webhookReceiptService = require("../services/ops/webhookReceiptService");
const { FUNDING_PROVIDERS, WEBHOOK_RECEIPT_STATUSES } = require("../utils/fundingTypes");
const { createLogger } = require("../utils/paymentOpsLogger");

const logger = createLogger({ service: "paylioWebhook", provider: FUNDING_PROVIDERS.paylio });

const paylioApiKey = defineSecret(config.secrets.paylioApiKey);

const app = express();

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function handlePaylioWebhook(req, res) {
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const provider = FUNDING_PROVIDERS.paylio;
  await opsMetrics.increment("funding.webhook.received", 1);

  const signatureOk = fundingRailService.verifyWebhookSignature(provider, req, "");
  if (!signatureOk) {
    logger.error("paylio.webhook.unauthenticated", { provider });
    res.status(403).send("Forbidden");
    return;
  }

  const query = req.query || {};
  const payload = {
    ipn_token: String(query.ipn_token || query.ipnToken || ""),
    status: query.status ? String(query.status) : null,
    payment_id: query.payment_id ? String(query.payment_id) : null,
    fundingOrderId: query.fundingOrderId ? String(query.fundingOrderId) : null,
    amount: query.amount || null,
    currency: query.currency || null,
  };

  let event = fundingRailService.normalizeWebhook(provider, payload);
  if (!event) {
    res.status(200).send("OK - Ignored event");
    return;
  }

  const webhookEventId = payload.ipn_token;
  const receipt = await webhookReceiptService.persistReceipt({
    provider,
    eventId: webhookEventId,
    payload,
    fundingOrderId: payload.fundingOrderId,
  });

  if (receipt.duplicate && receipt.status === WEBHOOK_RECEIPT_STATUSES.processed) {
    await opsMetrics.increment("funding.webhook.duplicate", 1);
    logger.info("paylio.webhook.duplicate", {
      provider,
      providerReference: event.providerReference,
      webhookEventId,
      receiptId: receipt.receiptId,
    });
    res.status(200).send("OK - Already processed");
    return;
  }

  await webhookReceiptService.updateReceiptStatus(receipt.receiptId, WEBHOOK_RECEIPT_STATUSES.processing);

  if (event.status === "failed") {
    let verified;
    try {
      verified = await fundingRailService.verifyPayment(provider, event.providerReference, {
        fundingOrderId: payload.fundingOrderId,
        providerTransactionId: event.providerTransactionId,
      });
    } catch (err) {
      logger.error("paylio.webhook.verify_failed", {
        provider,
        providerReference: event.providerReference,
        fundingOrderId: payload.fundingOrderId,
        error: err.message,
      });
      res.status(500).json({ error: "Payment verification failed" });
      return;
    }
    if (verified.status !== "failed") {
      res.status(200).send("OK - Not canceled");
      return;
    }
    event = verified;
  }

  const result = await fundingWebhookService.processFundingEvent({
    provider,
    event,
    webhookEventId,
    receiptId: receipt.receiptId,
  });

  if (!result.success && result.error) {
    if (result.error === "Funding order not found") {
      res.status(200).send("OK - No matching order");
      return;
    }
    logger.error("paylio.webhook.failed", {
      provider,
      providerReference: event.providerReference,
      fundingOrderId: result.fundingOrderId || payload.fundingOrderId,
      webhookEventId,
      error: result.error,
    });
    res.status(500).json({ error: result.error });
    return;
  }

  logger.info("paylio.webhook.processed", {
    provider,
    providerReference: event.providerReference,
    fundingOrderId: result.fundingOrderId || payload.fundingOrderId,
    webhookEventId,
    status: event.status,
    success: result.success,
    duplicate: result.duplicate,
  });

  if (result.duplicate) {
    res.status(200).send("OK - Already processed");
    return;
  }

  res.status(200).send("OK");
}

app.get("/", handlePaylioWebhook);

exports.handlePaylioWebhook = onRequest(
    {
      secrets: [paylioApiKey],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);

exports.handlePaylioWebhookRequest = handlePaylioWebhook;
