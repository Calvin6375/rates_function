/**
 * @fileoverview Grid webhook endpoint.
 * Verifies X-Grid-Signature, dedupes on the Grid event id, and delegates
 * ledger credit to fundingWebhookService. This handler never credits a wallet.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const fundingRailService = require("../services/funding/fundingRailService");
const fundingWebhookService = require("../services/funding/fundingWebhookService");
const gridAccountService = require("../services/funding/gridAccountService");
const opsMetrics = require("../services/ops/opsMetricsService");
const webhookReceiptService = require("../services/ops/webhookReceiptService");
const { FUNDING_PROVIDERS, WEBHOOK_RECEIPT_STATUSES } = require("../utils/fundingTypes");
const { createLogger } = require("../utils/paymentOpsLogger");

const logger = createLogger({ service: "gridWebhook", provider: FUNDING_PROVIDERS.grid });

const gridClientId = defineSecret(config.secrets.gridClientId);
const gridClientSecret = defineSecret(config.secrets.gridClientSecret);
const gridWebhookPublicKey = defineSecret(config.secrets.gridWebhookPublicKey);

const app = express();
app.use(express.raw({ type: "application/json" }));

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function handleGridWebhook(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ?
    req.body :
    (req.rawBody ? Buffer.from(req.rawBody) : null);

  if (!rawBody || rawBody.length === 0) {
    res.status(400).send("Bad Request");
    return;
  }

  const provider = FUNDING_PROVIDERS.grid;
  await opsMetrics.increment("funding.webhook.received", 1);

  const signatureOk = fundingRailService.verifyWebhookSignature(provider, req, rawBody);
  if (!signatureOk) {
    logger.error("grid.webhook.invalid_signature", { provider });
    res.status(401).send("Unauthorized");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    void err;
    res.status(400).send("Invalid JSON");
    return;
  }

  const eventType = String(payload.type || "");
  if (eventType === "TEST") {
    logger.info("grid.webhook.test", { eventId: payload.id || null, provider });
    res.status(200).send("OK");
    return;
  }

  const event = fundingRailService.normalizeWebhook(provider, payload);
  if (!event) {
    logger.info("grid.webhook.ignored", { eventId: payload.id || null, provider, status: eventType });
    res.status(200).send("OK - Ignored event");
    return;
  }

  const webhookEventId = payload.id ?
    String(payload.id) :
    `${eventType}_${event.providerTransactionId}`;

  const receipt = await webhookReceiptService.persistReceipt({
    provider,
    eventId: webhookEventId,
    payload,
  });

  if (receipt.duplicate && (
    receipt.status === WEBHOOK_RECEIPT_STATUSES.processed ||
    receipt.status === WEBHOOK_RECEIPT_STATUSES.duplicate
  )) {
    await opsMetrics.increment("funding.webhook.duplicate", 1);
    logger.info("grid.webhook.duplicate", {
      eventId: webhookEventId,
      provider,
      gridPaymentId: event.providerTransactionId || null,
    });
    res.status(200).send("OK - Already processed");
    return;
  }

  await webhookReceiptService.updateReceiptStatus(receipt.receiptId, WEBHOOK_RECEIPT_STATUSES.processing);

  const fundingOrder = await gridAccountService.resolveFundingOrder(event);
  if (!fundingOrder) {
    logger.warn("grid.webhook.unmatched", {
      eventId: webhookEventId,
      provider,
      gridCustomerId: event.customerId || null,
      gridPaymentId: event.providerTransactionId || null,
      status: event.status,
    });
    await webhookReceiptService.updateReceiptStatus(receipt.receiptId, WEBHOOK_RECEIPT_STATUSES.failed, {
      error: "Funding order not found",
    });
    res.status(200).send("OK - No matching order");
    return;
  }

  event.providerReference = fundingOrder.providerReference || fundingOrder.id;

  logger.info("grid.webhook.received", {
    eventId: webhookEventId,
    fundingOrderId: fundingOrder.id,
    userId: fundingOrder.userId,
    provider,
    gridCustomerId: event.customerId || null,
    gridInternalAccountId: event.destinationAccountId || fundingOrder.providerAccountId || null,
    gridPaymentId: event.providerTransactionId || null,
    status: event.status,
  });

  const result = await fundingWebhookService.processFundingEvent({
    provider,
    event,
    webhookEventId,
    receiptId: receipt.receiptId,
  });

  if (result.success && event.status === "pending") {
    await webhookReceiptService.updateReceiptStatus(receipt.receiptId, WEBHOOK_RECEIPT_STATUSES.processed, {
      fundingOrderId: fundingOrder.id,
    });
  }

  if (!result.success && result.error) {
    logger.error("grid.webhook.failed", {
      eventId: webhookEventId,
      fundingOrderId: fundingOrder.id,
      userId: fundingOrder.userId,
      provider,
      gridPaymentId: event.providerTransactionId || null,
      status: event.status,
      error: result.error,
    });
    res.status(500).json({ error: result.error });
    return;
  }

  logger.info("grid.webhook.processed", {
    eventId: webhookEventId,
    fundingOrderId: result.fundingOrderId || fundingOrder.id,
    userId: fundingOrder.userId,
    provider,
    gridPaymentId: event.providerTransactionId || null,
    status: event.status,
    duplicate: result.duplicate === true,
  });

  if (result.duplicate) {
    res.status(200).send("OK - Already processed");
    return;
  }

  res.status(200).send("OK");
}

app.post("/", handleGridWebhook);

exports.handleGridWebhook = onRequest(
    {
      secrets: [gridClientId, gridClientSecret, gridWebhookPublicKey],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);

exports.handleGridWebhookRequest = handleGridWebhook;
