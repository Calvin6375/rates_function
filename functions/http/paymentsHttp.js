/**
 * @fileoverview HTTP handlers for payments endpoints
 * Thin controllers that delegate to business logic in libs/payments.js
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const paymentsLib = require("../libs/payments");
const swapLib = require("../libs/swap");
const sendMoneyLib = require("../libs/sendMoney");

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
 * Callable: Create direct (manual / bank) top-up order from the customer app.
 * Does not call IntaSend or credit the wallet (pending ops / admin settlement).
 * Admin wallet credit stays on POST /customer-wallets/:id/credit.
 */
exports.createDirectTopup = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError(
            "unauthenticated",
            "User must be authenticated to create a direct top-up",
        );
      }

      const userId = auth.uid;
      const data = request.data || {};
      const amount = Number(data.amount);
      const currency = String(data.currency || "KES").toUpperCase();
      const phoneNumber = data.phoneNumber || null;
      const note = data.note != null ? String(data.note) : null;
      let metadata = {};
      if (data.metadata && typeof data.metadata === "object" &&
          !Array.isArray(data.metadata)) {
        metadata = data.metadata;
      }

      if (!amount || amount <= 0) {
        throw new HttpsError(
            "invalid-argument",
            "Amount must be a positive number",
        );
      }
      if (!currency) {
        throw new HttpsError("invalid-argument", "Currency is required");
      }

      try {
        return await paymentsLib.createDirectTopupOrder(userId, {
          amount,
          currency,
          phoneNumber,
          note,
          metadata,
        });
      } catch (error) {
        console.error("❌ Error creating direct top-up order:", {
          userId,
          error: error.message,
          stack: error.stack,
        });
        throw new HttpsError(
            "internal",
            `Failed to create direct top-up: ${error.message}`,
        );
      }
    },
);

/**
 * Callable: Create direct (manual / bank) payout request from the customer app.
 * Does not debit wallet or send money; ops settle offline.
 */
exports.createDirectPayout = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError(
            "unauthenticated",
            "User must be authenticated to request a direct payout",
        );
      }

      const userId = auth.uid;
      const data = request.data || {};
      const amount = Number(data.amount);
      const currency = String(data.currency || "KES").toUpperCase();
      const phoneNumber = data.phoneNumber || null;
      const note = data.note != null ? String(data.note) : null;
      const payoutMethod =
        data.payoutMethod != null ? String(data.payoutMethod) : null;
      let metadata = {};
      if (data.metadata && typeof data.metadata === "object" &&
          !Array.isArray(data.metadata)) {
        metadata = data.metadata;
      }

      if (!amount || amount <= 0) {
        throw new HttpsError(
            "invalid-argument",
            "Amount must be a positive number",
        );
      }
      if (!currency) {
        throw new HttpsError("invalid-argument", "Currency is required");
      }

      try {
        return await paymentsLib.createDirectPayoutOrder(userId, {
          amount,
          currency,
          phoneNumber,
          note,
          payoutMethod,
          metadata,
        });
      } catch (error) {
        console.error("❌ Error creating direct payout order:", {
          userId,
          error: error.message,
          stack: error.stack,
        });
        if (error.message && error.message.includes("Insufficient")) {
          throw new HttpsError("failed-precondition", error.message);
        }
        throw new HttpsError(
            "internal",
            `Failed to create direct payout: ${error.message}`,
        );
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

