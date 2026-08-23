/**
 * @fileoverview IntaSend send-money (disbursement) webhook HTTP handler.
 * Separate from collection top-up webhook (handleTopUpWebhook).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const config = require("../config");
const safariCardPayoutWebhook = require("../services/safariCard/safariCardPayoutWebhookService");

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

exports.handleIntaSendDisbursementWebhook = onRequest(
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
        console.error("IntaSend disbursement webhook: neither INTASEND_SECRET nor INTASEND_CHALLENGE configured");
        res.status(500).send("Configuration error");
        return;
      }

      if (!safariCardPayoutWebhook.verifyDisbursementWebhook(req, secret, challenge)) {
        console.error("IntaSend disbursement webhook: invalid signature/challenge");
        res.status(403).send("Forbidden");
        return;
      }

      const payload = req.body || {};
      if (!payload.tracking_id) {
        res.status(400).json({ error: "missing tracking_id" });
        return;
      }

      try {
        const result = await safariCardPayoutWebhook.processDisbursementWebhook(payload);
        if (result.duplicate) {
          res.status(200).send("OK - Already processed");
          return;
        }
        res.status(200).send("OK");
      } catch (err) {
        console.error("IntaSend disbursement webhook processing failed:", err.message);
        res.status(500).json({ error: "internal" });
      }
    },
);
