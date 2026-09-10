/**
 * @fileoverview Circle webhook endpoint: POST /webhooks/circle
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const circleWebhookService = require("../services/circle/circleWebhookService");
const paymentRailService = require("../services/paymentRailService");

const circleApiKey = defineSecret(config.secrets.circleApiKey);
const circleEntitySecret = defineSecret(config.secrets.circleEntitySecret);

const app = express();
app.use(express.raw({ type: "application/json" }));

/**
 * Circle Console probes the webhook URL with HEAD then GET before activating it.
 * Only POST carries signed events.
 */
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  res.status(200).set("Cache-Control", "no-store");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.send("OK");
});

app.post("/", async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : (req.rawBody ? Buffer.from(req.rawBody) : null);
  if (!rawBody || rawBody.length === 0) {
    res.status(400).send("Bad Request");
    return;
  }

  const signatureOk = await circleWebhookService.verifyCircleSignature(req, rawBody);
  if (!signatureOk) {
    console.error("Circle webhook: invalid signature");
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

  const result = await paymentRailService.processDeposit({
    rail: "circle",
    payload,
    rawBody: rawBody.toString("utf8"),
  });

  if (!result.success && result.error) {
    res.status(500).json({ error: result.error });
    return;
  }

  if (result.duplicate) {
    res.status(200).send("OK - Already processed");
    return;
  }

  res.status(200).send("OK");
});

exports.handleCircleWebhook = onRequest(
    {
      secrets: [circleApiKey, circleEntitySecret],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);
