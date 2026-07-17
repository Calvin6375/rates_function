/**
 * @fileoverview HTTP handlers for payments endpoints
 * Thin controllers that delegate to business logic in libs/payments.js
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const config = require("../config");
const paymentsLib = require("../libs/payments");
const swapLib = require("../libs/swap");
const sendMoneyLib = require("../libs/sendMoney");
const c2bFundingBridge = require("../services/funding/c2bFundingBridgeService");
const fundingOrderService = require("../services/funding/fundingOrderService");
const fundingRailService = require("../services/funding/fundingRailService");
const fundingWebhookService = require("../services/funding/fundingWebhookService");
const {createLogger} = require("../utils/paymentOpsLogger");
const {FUNDING_CURRENCY} = require("../utils/fundingTypes");

const logger = createLogger({service: "paymentsHttp"});
const paystackSecretKey = defineSecret(config.secrets.paystackSecretKey);
const paystackSplitCode = defineSecret(config.secrets.paystackSplitCode);
const paystackSecrets = [paystackSecretKey, paystackSplitCode];
const transakApiKey = defineSecret(config.secrets.transakApiKey);
const transakSecretKey = defineSecret(config.secrets.transakSecretKey);
const transakTreasuryWallet = defineSecret(config.secrets.transakTreasuryWallet);
const transakCheckoutSecrets = [
  transakApiKey,
  transakSecretKey,
  transakTreasuryWallet,
];
const fundingCheckoutSecrets = [...paystackSecrets, ...transakCheckoutSecrets];

const REDACTED_HEADER_KEYS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "x-firebase-appcheck",
]);

/**
 * @param {Object<string, string|string[]|undefined>} headers
 * @returns {Object<string, string|string[]>}
 */
function sanitizeCallableHeaders(headers = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }
    safe[key] = REDACTED_HEADER_KEYS.has(String(key).toLowerCase()) ?
      "[redacted]" :
      value;
  }
  return safe;
}

/**
 * C2B createPayment uses server-side Paystack checkout only.
 * Reject legacy client-side IntaSend session fields so apps cannot open the wrong URL.
 *
 * @param {Object} data
 * @param {string} userId
 */
function assertNoLegacyIntaSendClientCheckout(data, userId) {
  const intasendCheckoutId = data.intasendCheckoutId || null;
  const clientCheckoutUrl = data.checkoutUrl ? String(data.checkoutUrl).trim() : null;
  const usesLegacyIntaSend =
    !!intasendCheckoutId ||
    (clientCheckoutUrl && /intasend\.com/i.test(clientCheckoutUrl));

  if (!usesLegacyIntaSend) {
    return;
  }

  logger.warn("createPayment.legacy_intasend_client_checkout", {
    userId,
    hasIntasendCheckoutId: !!intasendCheckoutId,
    hasClientCheckoutUrl: !!clientCheckoutUrl,
  });

  throw new HttpsError(
      "failed-precondition",
      "C2B top-up no longer uses client-side IntaSend checkout. Remove IntaSend " +
      "session creation from the app. Call createPayment with amount, currency, and " +
      "email only, then launch checkoutUrl from the response (Paystack hosted checkout).",
  );
}

/**
 * Callable function: Create Payment Order (C2B tourist card top-up via Paystack).
 * Always uses Paystack (not Transak). Returns the legacy response shape
 * expected by the Flutter app (`orderId`, `invoiceId`, `checkoutUrl`, …).
 */
exports.createPayment = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      secrets: fundingCheckoutSecrets,
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to create payment");
      }

      const userId = auth.uid;
      const data = request.data || {};

      const amount = Number(data.amount);
      const currency = String(data.currency || FUNDING_CURRENCY).toUpperCase();
      const email = data.email || auth.token?.email || null;
      const callbackUrl = data.callbackUrl || data.redirectUrl || null;
      const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
      const idempotencyKey = data.idempotencyKey || data.requestId || null;

      if (!amount || amount <= 0) {
        throw new HttpsError("invalid-argument", "Amount must be a positive number");
      }

      if (!currency) {
        throw new HttpsError("invalid-argument", "Currency is required");
      }

      assertNoLegacyIntaSendClientCheckout(data, userId);

      try {
        logger.info("createPayment.request", {
          userId,
          amount,
          currency,
          hasCallbackUrl: !!callbackUrl,
          headers: sanitizeCallableHeaders(request.rawRequest?.headers),
        });

        const response = await c2bFundingBridge.createC2bTopupCheckout({
          userId,
          amount,
          currency,
          email,
          callbackUrl,
          metadata,
          idempotencyKey,
          correlationId: data.correlationId || null,
        });

        logger.info("createPayment.success", {
          userId,
          orderId: response.orderId,
          invoiceId: response.invoiceId,
          checkoutUrl: response.checkoutUrl || null,
          provider: response.provider || null,
        });

        return response;
      } catch (error) {
        logger.error("createPayment.failed", {
          userId,
          error: error.message,
          ...(error.details ? {
            transakRequest: {
              method: error.details.httpMethod || null,
              url: error.details.url || null,
              params: error.details.requestParams || null,
              body: error.details.requestBody || null,
            },
            transakResponse: {
              statusCode: error.details.statusCode || null,
              body: error.details.responseBody || null,
            },
          } : {}),
        });

        if (error instanceof HttpsError) {
          throw error;
        }

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
 * Callable: Mark payment link as opened, or confirm Paystack funding after redirect.
 * Accepts invoiceId / paymentId (Paystack reference or funding order id).
 */
exports.handlePaymentWebhook = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      secrets: [paystackSecretKey, transakApiKey, transakSecretKey],
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
        data.fundingOrderId || data.orderId ||
        (typeof raw === "string" ? raw : null);

      if (invoiceId) {
        let byReference = null;
        for (const provider of fundingRailService.listProviders()) {
          byReference = await fundingOrderService.findByProviderReference(provider, invoiceId);
          if (byReference) {
            break;
          }
        }
        const byId = !byReference ?
          await fundingOrderService.getFundingOrderForUser(auth.uid, invoiceId) :
          null;
        const fundingOrder = byReference || byId;

        if (fundingOrder && fundingOrder.userId === auth.uid) {
          const result = await fundingWebhookService.confirmFundingOrder(auth.uid, fundingOrder.id);
          return {
            success: result.success !== false,
            duplicate: result.duplicate || false,
            fundingOrderId: fundingOrder.id,
            invoiceId: fundingOrder.providerReference,
          };
        }
      }

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

