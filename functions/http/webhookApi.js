/**
 * @fileoverview Webhook API: IntaSend and TransFi payment webhooks.
 * Flow: receive webhook → verify signature → resolve user → create transaction → credit wallet → (optional) ledger entries.
 * Consumer app and existing integrations remain unchanged; these handlers delegate to libs/payments.js.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const paymentsLib = require("../libs/payments");

const intaSendSecret = defineSecret(config.secrets.intaSendSecret);
const intaSendChallenge = defineSecret(config.secrets.intaSendChallenge);
const transfiWebhookSecret = defineSecret(config.secrets.transfiWebhookSecret);

function getSecret() {
  const fromParams = intaSendSecret.value();
  if (fromParams) return fromParams;
  if (process.env.INTASEND_SECRET) return process.env.INTASEND_SECRET;
  return null;
}

function getChallenge() {
  const fromParams = intaSendChallenge.value();
  if (fromParams) return fromParams;
  if (process.env.INTASEND_CHALLENGE) return process.env.INTASEND_CHALLENGE;
  return null;
}

function getTransFiWebhookSecret() {
  const fromParams = transfiWebhookSecret.value();
  if (fromParams) return fromParams;
  if (process.env.TRANSFI_WEBHOOK_SECRET) return process.env.TRANSFI_WEBHOOK_SECRET;
  return null;
}

/**
 * HTTP endpoint: Handle IntaSend top-up webhook
 */
exports.handleTopUpWebhook = onRequest(
  {
    secrets: [intaSendSecret, intaSendChallenge],
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const secret = getSecret();
    const challenge = getChallenge();

    if (!secret && !challenge) {
      console.error("❌ IntaSend configuration error: neither INTASEND_SECRET nor INTASEND_CHALLENGE is set");
      res.status(500).send("Configuration error");
      return;
    }

    const payload = req.body || {};
    const receivedChallenge =
      req.get("x-intasend-challenge") || req.query?.challenge || payload.challenge || null;
    const challengeOk = !!challenge && receivedChallenge === challenge;

    let signatureOk = false;
    if (secret) {
      signatureOk = paymentsLib.verifySignature(secret, req);
    }

    if (!signatureOk && !challengeOk) {
      console.error("❌ Invalid IntaSend signature and/or challenge", {
        hasSignature: !!req.get("x-intasend-signature") || !!req.get("X-IntaSend-Signature"),
        hasChallenge: !!receivedChallenge,
      });
      res.status(403).send("Forbidden");
      return;
    }

    const paymentData = paymentsLib.parseWebhookPayload(payload);
    const paymentState = paymentData.paymentState;

    if (paymentState && paymentState !== "COMPLETE") {
      console.log(`ℹ️ Payment ${paymentData.paymentId} is in ${paymentState} state, skipping balance update`, {
        state: paymentState,
        invoiceId: paymentData.paymentId,
      });
      res.status(200).send("OK - Payment not complete yet");
      return;
    }

    console.log("💰 Processing payment", {
      paymentId: paymentData.paymentId,
      amount: paymentData.amount,
      currency: paymentData.currency,
      userId: paymentData.userId,
      account: paymentData.account,
      state: paymentState,
    });

    const result = await paymentsLib.processPaymentWebhook(paymentData, payload);

    if (!result.success) {
      if (result.error === "Missing payment identifier (invoice_id or payment_id)") {
        res.status(400).send("Bad Request: missing payment identifier");
        return;
      }
      if (result.error === "Could not resolve wallet ID") {
        res.status(200).send("Recorded without wallet update");
        return;
      }
      res.status(500).json({ error: "internal", message: "Failed to process payment" });
      return;
    }

    if (result.duplicate) {
      res.status(200).send("OK - Already processed");
      return;
    }

    res.status(200).send("OK");
  }
);

/**
 * TransFi top-up webhook HTTP endpoint
 */
const transfiWebhookApp = express();
transfiWebhookApp.use(express.raw({ type: "application/json" }));
transfiWebhookApp.post("/", async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const secret = getTransFiWebhookSecret();
  if (!secret) {
    console.error("❌ TransFi: TRANSFI_WEBHOOK_SECRET not configured");
    res.status(500).send("Configuration error");
    return;
  }

  const receivedSignature = req.get("X-Transfi-Hmac-Hash") || req.get("x-transfi-hmac-hash") || "";
  if (!receivedSignature) {
    console.error("❌ TransFi: Missing X-Transfi-Hmac-Hash header");
    res.status(401).send("Unauthorized");
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : (req.rawBody ? Buffer.from(req.rawBody) : null);
  if (!rawBody || rawBody.length === 0) {
    console.error("❌ TransFi: Empty or missing request body");
    res.status(400).send("Bad Request");
    return;
  }

  if (!paymentsLib.verifyTransFiSignature(secret, rawBody, receivedSignature)) {
    console.error("❌ TransFi: Invalid webhook signature");
    res.status(401).send("Unauthorized");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (e) {
    console.error("❌ TransFi: Invalid JSON body", e.message);
    res.status(400).send("Bad Request");
    return;
  }

  const paymentData = paymentsLib.parseTransFiWebhookPayload(payload);
  if (!paymentData) {
    const status = payload.status || payload.event;
    console.log("ℹ️ TransFi: Non-processable event, skipping", { status, payload: Object.keys(payload) });
    res.status(200).send("OK - Event skipped");
    return;
  }

  console.log("💰 TransFi: Processing top-up webhook", {
    paymentId: paymentData.paymentId,
    userId: paymentData.userId,
    amount: paymentData.amount,
    currency: paymentData.currency,
  });

  const result = await paymentsLib.processTransFiWebhook(paymentData);

  if (!result.success) {
    if (result.error && result.error.includes("extract userId")) {
      console.warn("⚠️ TransFi: Could not resolve user from customerOrderId", {
        customerOrderId: paymentData.customerOrderId,
      });
      res.status(200).send("Recorded without wallet update");
      return;
    }
    console.error("❌ TransFi: Processing failed", result.error);
    res.status(500).json({ error: "internal", message: "Failed to process webhook" });
    return;
  }

  if (result.duplicate) {
    res.status(200).send("OK - Already processed");
    return;
  }

  res.status(200).send("OK");
});

exports.handleTransFiTopUpWebhook = onRequest(
  {
    secrets: [transfiWebhookSecret],
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
  },
  transfiWebhookApp
);
