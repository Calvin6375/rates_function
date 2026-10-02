/**
 * @fileoverview Webhook API: IntaSend payment webhooks.
 * Flow: receive webhook → verify signature → resolve user → create transaction → credit wallet → (optional) ledger entries.
 * Consumer app and existing integrations remain unchanged; these handlers delegate to libs/payments.js.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const config = require("../config");
const paymentsLib = require("../libs/payments");

const intaSendSecret = defineSecret(config.secrets.intaSendSecret);
const intaSendChallenge = defineSecret(config.secrets.intaSendChallenge);

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

