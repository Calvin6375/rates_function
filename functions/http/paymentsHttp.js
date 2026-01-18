/**
 * @fileoverview HTTP handlers for payments endpoints
 * Thin controllers that delegate to business logic in libs/payments.js
 */

const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const config = require("../config");
const paymentsLib = require("../libs/payments");

// Secret parameter for IntaSend webhook signature
const intaSendSecret = defineSecret(config.secrets.intaSendSecret);
const intaSendChallenge = defineSecret(config.secrets.intaSendChallenge);

/**
 * Get IntaSend secret from Firebase secrets or environment
 * @returns {string|null} Secret value
 */
function getSecret() {
  const fromParams = intaSendSecret.value();
  if (fromParams) {
    return fromParams;
  }
  if (process.env.INTASEND_SECRET) {
    return process.env.INTASEND_SECRET;
  }
  return null;
}

/**
 * Get IntaSend challenge from Firebase secrets or environment
 * @returns {string|null} Challenge value
 */
function getChallenge() {
  const fromParams = intaSendChallenge.value();
  if (fromParams) {
    return fromParams;
  }
  if (process.env.INTASEND_CHALLENGE) {
    return process.env.INTASEND_CHALLENGE;
  }
  return null;
}

/**
 * HTTP endpoint: Handle IntaSend top-up webhook
 */
exports.handleTopUpWebhook = onRequest({
  secrets: [intaSendSecret, intaSendChallenge],
  region: config.region,
  cpu: config.resources.cpu,
  memory: config.resources.memory,
}, async (req, res) => {
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

  // Read optional challenge sent by IntaSend
  const receivedChallenge =
    req.get("x-intasend-challenge") ||
    req.query?.challenge ||
    payload.challenge ||
    null;

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

  // Parse webhook payload
  const paymentData = paymentsLib.parseWebhookPayload(payload);

  // Extract state from payload
  const paymentState = paymentData.paymentState;

  // Only process COMPLETE payments
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

  // Process payment webhook
  const result = await paymentsLib.processPaymentWebhook(paymentData, payload);

  if (!result.success) {
    if (result.error === "Missing payment identifier (invoice_id or payment_id)") {
      res.status(400).send("Bad Request: missing payment identifier");
      return;
    }

    if (result.error === "Could not resolve wallet ID") {
      // Record payment for reconciliation but don't update wallet
      res.status(200).send("Recorded without wallet update");
      return;
    }

    // Return error but don't expose internal details
    res.status(500).json({
      error: "internal",
      message: "Failed to process payment",
    });
    return;
  }

  if (result.duplicate) {
    res.status(200).send("OK - Already processed");
    return;
  }

  res.status(200).send("OK");
});

/**
 * Callable function: Create Payment Order
 * Creates order document in Firestore and invoice mapping in Firestore
 */
exports.createPayment = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      // Get the authenticated user from the request
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to create payment");
      }

      const userId = auth.uid;
      const data = request.data || {};

      console.log("📥 Received createPayment request:", {
        userId,
        hasAmount: !!data.amount,
        hasCurrency: !!data.currency,
        hasInvoiceId: !!data.invoiceId,
        hasCheckoutUrl: !!data.checkoutUrl,
        checkoutUrl: data.checkoutUrl,
      });

      // Extract payment details
      const amount = Number(data.amount);
      const currency = data.currency || "KES";
      let invoiceId = data.invoiceId || null;
      const checkoutUrl = data.checkoutUrl || null;
      const phoneNumber = data.phoneNumber || null;
      const metadata = data.metadata || {};

      // Validate required fields
      if (!amount || amount <= 0) {
        throw new HttpsError("invalid-argument", "Amount must be a positive number");
      }

      if (!currency) {
        throw new HttpsError("invalid-argument", "Currency is required");
      }

      // Extract invoice ID from checkout URL if not provided directly
      if (!invoiceId && checkoutUrl) {
        // Extract invoice ID from IntaSend checkout URL
        // Format: https://payment.intasend.com/checkout/{invoice-id}/express/
        const match = checkoutUrl.match(/checkout\/([^\/]+)/);
        if (match && match[1]) {
          invoiceId = match[1];
        }
      }

      if (!invoiceId) {
        throw new HttpsError(
            "invalid-argument",
            "Either invoiceId or checkoutUrl with invoice ID must be provided",
        );
      }

      try {
        console.log(`🔄 Creating payment order for user: ${userId}`, {
          amount,
          currency,
          invoiceId: invoiceId,
        });

        const response = await paymentsLib.createPaymentOrder(userId, {
          amount,
          currency,
          invoiceId,
          checkoutUrl,
          phoneNumber,
          metadata,
        });

        console.log("✅ Returning payment creation response:", {
          orderId: response.orderId,
          invoiceId: response.invoiceId,
          hasCheckoutUrl: !!response.checkoutUrl,
        });

        return response;
      } catch (error) {
        console.error("❌ Error creating payment order:", {
          userId: userId,
          error: error.message,
          stack: error.stack,
        });

        throw new HttpsError("internal", `Failed to create payment order: ${error.message}`);
      }
    },
);

