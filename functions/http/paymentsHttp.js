/**
 * @fileoverview HTTP handlers for payments endpoints
 * Thin controllers that delegate to business logic in libs/payments.js
 */

const express = require("express");
const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const config = require("../config");
const paymentsLib = require("../libs/payments");
const swapLib = require("../libs/swap");
const sendMoneyLib = require("../libs/sendMoney");

// Secret parameter for IntaSend webhook signature
const intaSendSecret = defineSecret(config.secrets.intaSendSecret);
const intaSendChallenge = defineSecret(config.secrets.intaSendChallenge);

// Secret parameter for TransFi webhook signature
const transfiWebhookSecret = defineSecret(config.secrets.transfiWebhookSecret);

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
 * Get TransFi webhook secret from Firebase secrets or environment
 * @returns {string|null} Secret value
 */
function getTransFiWebhookSecret() {
  const fromParams = transfiWebhookSecret.value();
  if (fromParams) {
    return fromParams;
  }
  if (process.env.TRANSFI_WEBHOOK_SECRET) {
    return process.env.TRANSFI_WEBHOOK_SECRET;
  }
  return null;
}

/**
 * TransFi top-up webhook HTTP endpoint
 * URL: https://us-central1-<project>.cloudfunctions.net/handleTransFiTopUpWebhook
 * Uses raw body for HMAC verification (X-Transfi-Hmac-Hash).
 */
const transfiWebhookApp = express();
transfiWebhookApp.use(express.raw({type: "application/json"}));
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
    console.log("ℹ️ TransFi: Non-processable event, skipping", {status, payload: Object.keys(payload)});
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
    res.status(500).json({error: "internal", message: "Failed to process webhook"});
    return;
  }

  if (result.duplicate) {
    res.status(200).send("OK - Already processed");
    return;
  }

  res.status(200).send("OK");
});

exports.handleTransFiTopUpWebhook = onRequest({
  secrets: [transfiWebhookSecret],
  region: config.region,
  cpu: config.resources.cpu,
  memory: config.resources.memory,
}, transfiWebhookApp);

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

/**
 * Callable: Mark payment link as opened (client calls when user opens IntaSend checkout)
 * Accepts invoiceId, intasendCheckoutId, or paymentId. Idempotent; returns { success: true }.
 */
exports.handlePaymentWebhook = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated");
      }
      const raw = request.data;
      const data = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
      const invoiceId =
        data.invoiceId || data.intasendCheckoutId || data.paymentId ||
        (typeof raw === "string" ? raw : null);

      await paymentsLib.markPaymentLinkOpened(auth.uid, invoiceId);
      return {success: true};
    },
);

/**
 * Callable function: Create Swap Order
 * Converts one currency to another (e.g. USDT → USD), creates order in Firestore,
 * and updates user balances atomically. Client must call this instead of writing to orders.
 *
 * Request data: {
 *   fromCurrency: "USDT",
 *   toCurrency: "USD",
 *   fromAmount: 6.0,
 *   fee?: 0.03,           // optional; or use feeRate
 *   feeRate?: 0.005,      // optional (e.g. 0.5%)
 *   exchangeRate: 1.01297,
 *   toAmount?: 6.07782    // optional; computed from fromAmount * exchangeRate if omitted
 * }
 */
exports.createSwapOrder = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to create swap order");
      }

      const userId = auth.uid;
      const data = request.data || {};

      const fromCurrency = data.fromCurrency || null;
      const toCurrency = data.toCurrency || null;
      const fromAmount = data.fromAmount;
      const fee = data.fee;
      const feeRate = data.feeRate;
      const exchangeRate = data.exchangeRate;
      const toAmount = data.toAmount;

      if (!fromCurrency || !toCurrency) {
        throw new HttpsError("invalid-argument", "fromCurrency and toCurrency are required");
      }
      if (fromAmount == null || Number(fromAmount) <= 0) {
        throw new HttpsError("invalid-argument", "fromAmount must be a positive number");
      }
      if (exchangeRate == null || Number(exchangeRate) <= 0) {
        throw new HttpsError("invalid-argument", "exchangeRate must be a positive number");
      }

      try {
        const result = await swapLib.createSwapOrder(userId, {
          fromCurrency,
          toCurrency,
          fromAmount: Number(fromAmount),
          fee: fee != null ? Number(fee) : undefined,
          feeRate: feeRate != null ? Number(feeRate) : undefined,
          exchangeRate: Number(exchangeRate),
          toAmount: toAmount != null ? Number(toAmount) : undefined,
        });
        return result;
      } catch (error) {
        if (error.message && error.message.includes("Insufficient")) {
          throw new HttpsError("failed-precondition", error.message);
        }
        if (error.message && (error.message.includes("required") || error.message.includes("must be"))) {
          throw new HttpsError("invalid-argument", error.message);
        }
        console.error("❌ Error creating swap order:", { userId, error: error.message });
        throw new HttpsError("internal", `Failed to create swap order: ${error.message}`);
      }
    },
);

/**
 * Callable function: Create Send Money Order
 * P2P transfer: debits sender, credits recipient, creates order in Firestore.
 * Client must call this instead of writing to the orders collection.
 *
 * Request data: {
 *   recipientUserId?: string,      // Firebase UID of recipient (optional if recipientPhoneNumber set)
 *   recipientPhoneNumber?: string, // Recipient phone, with or without + (optional if recipientUserId set)
 *   amount: number,
 *   currency: string,              // USD, KES, or USDT
 *   note?: string
 * }
 */
exports.createSendMoneyOrder = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to send money");
      }

      const senderId = auth.uid;
      const data = request.data || {};

      const recipientUserId = data.recipientUserId || null;
      const recipientPhoneNumber = data.recipientPhoneNumber || null;
      const amount = data.amount;
      const currency = data.currency || null;
      const note = data.note || null;

      if (!recipientUserId && !recipientPhoneNumber) {
        throw new HttpsError(
          "invalid-argument",
          "Either recipientUserId or recipientPhoneNumber is required",
        );
      }
      if (amount == null || Number(amount) <= 0) {
        throw new HttpsError("invalid-argument", "amount must be a positive number");
      }
      if (!currency) {
        throw new HttpsError("invalid-argument", "currency is required");
      }

      try {
        const result = await sendMoneyLib.createSendMoneyOrder(senderId, {
          recipientUserId: recipientUserId || undefined,
          recipientPhoneNumber: recipientPhoneNumber || undefined,
          amount: Number(amount),
          currency: String(currency).toUpperCase(),
          note: note || undefined,
        });
        return result;
      } catch (error) {
        if (error.message && error.message.includes("Insufficient")) {
          throw new HttpsError("failed-precondition", error.message);
        }
        if (error.message && (error.message.includes("not found") || error.message.includes("Recipient"))) {
          throw new HttpsError("not-found", error.message);
        }
        if (error.message && (error.message.includes("yourself") || error.message.includes("currency") || error.message.includes("amount"))) {
          throw new HttpsError("invalid-argument", error.message);
        }
        console.error("❌ Error creating send money order:", { senderId, error: error.message });
        throw new HttpsError("internal", `Failed to create send money order: ${error.message}`);
      }
    },
);

