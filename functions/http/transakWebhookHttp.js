/**
 * @fileoverview Transak webhook endpoint — verify JWT, idempotent, delegate to fundingWebhookService.
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

const logger = createLogger({ service: "transakWebhook" });

const transakSecretKey = defineSecret(config.secrets.transakSecretKey);
const transakWebhookSecret = defineSecret(config.secrets.transakWebhookSecret);

const app = express();
app.use(express.raw({ type: "application/json" }));

app.post("/", async (req, res) => {
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

  const provider = FUNDING_PROVIDERS.transak;
  await opsMetrics.increment("funding.webhook.received", 1);

  const signatureOk = fundingRailService.verifyWebhookSignature(provider, req, rawBody);
  if (!signatureOk) {
    logger.error("transak.webhook.invalid_signature", {});
    res.status(403).send("Forbidden");
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

  const event = fundingRailService.normalizeWebhook(provider, payload);
  if (!event) {
    res.status(200).send("OK - Ignored event");
    return;
  }

  const webhookEventId = payload.eventID ||
    payload.eventId ||
    payload.id ||
    `${event.providerReference}_${event.status}`;

  const receipt = await webhookReceiptService.persistReceipt({
    provider,
    eventId: String(webhookEventId),
    payload,
  });

  if (receipt.duplicate && receipt.status === WEBHOOK_RECEIPT_STATUSES.processed) {
    await opsMetrics.increment("funding.webhook.duplicate", 1);
    logger.info("transak.webhook.duplicate", { webhookEventId, receiptId: receipt.receiptId });
    res.status(200).send("OK - Already processed");
    return;
  }

  await webhookReceiptService.updateReceiptStatus(receipt.receiptId, WEBHOOK_RECEIPT_STATUSES.processing);

  const result = await fundingWebhookService.processFundingEvent({
    provider,
    event,
    webhookEventId: String(webhookEventId),
    receiptId: receipt.receiptId,
  });

  if (!result.success && result.error) {
    if (result.error === "Funding order not found") {
      res.status(200).send("OK - No matching order");
      return;
    }
    res.status(500).json({ error: result.error });
    return;
  }

  logger.info("transak.webhook.processed", {
    webhookEventId,
    receiptId: receipt.receiptId,
    providerReference: event.providerReference,
    success: result.success,
    duplicate: result.duplicate,
  });

  if (result.duplicate) {
    res.status(200).send("OK - Already processed");
    return;
  }

  res.status(200).send("OK");
});

exports.handleTransakWebhook = onRequest(
    {
      secrets: [transakSecretKey, transakWebhookSecret],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);
