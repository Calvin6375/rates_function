/**
 * @fileoverview Daraja B2B callback endpoint — settlement completion webhook.
 */

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const settlementWebhookService = require("../services/settlement/settlementWebhookService");
const { createLogger } = require("../utils/paymentOpsLogger");

const logger = createLogger({ service: "darajaCallback" });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", async (req, res) => {
  const payload = req.body || {};
  logger.info("daraja.callback.received", {
    conversationId: payload?.Result?.ConversationID || payload?.ConversationID,
  });

  try {
    const result = await settlementWebhookService.processDarajaCallback(payload);
    if (!result.success && result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(200).json({ success: true, duplicate: result.duplicate || false });
  } catch (err) {
    logger.error("daraja.callback.failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

exports.handleDarajaCallback = onRequest(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);
