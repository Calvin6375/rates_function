/**
 * @fileoverview Payments business logic module
 * Pure business logic for payment processing and webhook handling
 */

const admin = require("../admin");
const crypto = require("crypto");
const config = require("../config");
const {updateBalanceWithTransaction} = require("../utils/firestore");
const {executeWithIdempotency} = require("./idempotency");
const b2bPayments = require("./b2bPayments");
const {
  createNotification,
  NOTIFICATION_TYPES,
  notifyDirectTopupAdmins,
  notifyDirectPayoutAdmins,
} = require("../utils/notifications");

const firestore = admin.firestore();

/**
 * Verify IntaSend webhook signature
 * @param {string} sharedSecret - Shared secret for HMAC
 * @param {Object} req - Express request object
 * @returns {boolean} True if signature is valid
 */
function verifySignature(sharedSecret, req) {
  const headerSignature = req.get("x-intasend-signature") || req.get("X-IntaSend-Signature") || "";
  if (!headerSignature || !sharedSecret) {
    return false;
  }
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const computed = crypto.createHmac("sha256", sharedSecret).update(rawBody).digest("hex");

  let receivedBuffer;
  try {
    receivedBuffer = Buffer.from(headerSignature, "hex");
  } catch (e) {
    console.error("❌ Invalid IntaSend signature format (expected hex):", e.message);
    return false;
  }

  const computedBuffer = Buffer.from(computed, "hex");
  if (receivedBuffer.length !== computedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuffer, computedBuffer);
}

/**
 * Parse webhook payload to extract payment information
 * @param {Object} payload - Webhook payload
 * @returns {Object} Parsed payment data
 */
function parseWebhookPayload(payload) {
  let paymentId;
  let amount;
  let currency;
  let userId;
  let completedAt;
  let account = null;

  if (payload.event === "payment.completed") {
    // Old IntaSend format with nested data
    const data = payload.data || {};
    paymentId = data.payment_id;
    amount = Number(data.amount || 0);
    currency = data.currency || "KES";

    const metadata = data.metadata || {};
    userId = metadata.user_id || null;
    completedAt = data.completed_at || new Date().toISOString();
  } else {
    // New flat invoice-style payload
    paymentId = payload.invoice_id || null;
    amount = Number(payload.net_amount || payload.value || 0);
    currency = payload.currency || "KES";
    account = payload.account ? String(payload.account) : null;

    const metadata = payload.metadata || {};
    userId = metadata.user_id || metadata.userId || null;

    completedAt = payload.updated_at || payload.created_at || new Date().toISOString();
  }

  return {
    paymentId,
    amount,
    currency,
    userId,
    completedAt,
    account,
    paymentState: payload.state || null,
  };
}

/**
 * Resolve wallet ID from payment information using multiple strategies
 * @param {Object} paymentData - Parsed payment data
 * @returns {Promise<string|null>} Wallet ID or null if not found
 */
async function resolveWalletId(paymentData) {
  const {paymentId, account, userId} = paymentData;
  let walletId = userId;

  // Strategy 1: Phone number lookup (PRIMARY - most reliable from IntaSend)
  if (!walletId && account) {
    try {
      const usersCol = firestore.collection(config.collections.users);
      const normalizedPhone = account.replace(/^\+/, "").trim();

      let querySnap = await usersCol.where("phoneNumber", "==", normalizedPhone).limit(1).get();

      if (querySnap.empty) {
        querySnap = await usersCol.where("phoneNumber", "==", `+${normalizedPhone}`).limit(1).get();
      }

      if (querySnap.empty) {
        querySnap = await usersCol.where("phone", "==", normalizedPhone).limit(1).get();
      }

      if (querySnap.empty) {
        querySnap = await usersCol.where("phone", "==", `+${normalizedPhone}`).limit(1).get();
      }

      if (querySnap.empty) {
        querySnap = await usersCol.where("phoneNumber", "==", account).limit(1).get();
      }

      if (querySnap.empty) {
        querySnap = await usersCol.where("phone", "==", account).limit(1).get();
      }

      if (!querySnap.empty) {
        walletId = querySnap.docs[0].id;
        console.log("✅ Found wallet ID from phone number lookup (PRIMARY)", {
          account,
          normalizedPhone,
          walletId,
        });
      } else {
        // Try direct document ID match
        const directDoc = await usersCol.doc(normalizedPhone).get();
        if (!directDoc.exists) {
          const directDocWithPlus = await usersCol.doc(`+${normalizedPhone}`).get();
          if (directDocWithPlus.exists) {
            const docData = directDocWithPlus.data();
            walletId = docData.userId || docData.uid || docData.id || directDocWithPlus.id;
          }
        } else {
          const docData = directDoc.data();
          walletId = docData.userId || docData.uid || docData.id || directDoc.id;
        }
      }
    } catch (err) {
      console.error("❌ Failed to lookup user by phone number", {
        account,
        error: err.message,
      });
    }
  }

  // Strategy 2: Look up order by invoice_id
  if (paymentId && !walletId) {
    try {
      const ordersCol = firestore.collection(config.collections.orders);

      let orderQuery = ordersCol
          .where("metadata.paymentId", "==", paymentId)
          .where("orderType", "==", "topup")
          .limit(1);

      let orderSnap = await orderQuery.get();

      if (orderSnap.empty) {
        orderQuery = ordersCol
            .where("metadata.invoiceId", "==", paymentId)
            .where("orderType", "==", "topup")
            .limit(1);
        orderSnap = await orderQuery.get();
      }

      if (orderSnap.empty) {
        orderQuery = ordersCol
            .where("invoiceId", "==", paymentId)
            .where("orderType", "==", "topup")
            .limit(1);
        orderSnap = await orderQuery.get();
      }

      if (!orderSnap.empty) {
        const orderDoc = orderSnap.docs[0];
        const orderData = orderDoc.data();
        const orderUserId = orderData.userId || null;

        if (orderUserId && account && orderData.phoneNumber) {
          const normalizedOrderPhone = String(orderData.phoneNumber).replace(/^\+/, "").trim();
          const normalizedAccount = account.replace(/^\+/, "").trim();

          if (normalizedOrderPhone === normalizedAccount) {
            walletId = orderUserId;
            console.log("✅ Found wallet ID from order lookup (phone verified)", {
              invoiceId: paymentId,
              orderId: orderDoc.id,
              walletId,
            });
          } else {
            walletId = orderUserId;
          }
        } else if (orderUserId) {
          walletId = orderUserId;
        }
      }
    } catch (err) {
      console.error("❌ Failed to lookup order", {
        invoiceId: paymentId,
        error: err.message,
      });
    }
  }

  // Strategy 3: Look up invoice_id → userId mapping in Firestore
  if (paymentId && !walletId) {
    try {
      const mappingRef = firestore.collection(config.collections.invoiceMappings).doc(paymentId);
      const mappingDoc = await mappingRef.get();

      if (mappingDoc.exists) {
        const mapping = mappingDoc.data();
        walletId = mapping.userId || null;

        console.log("✅ Found wallet ID from Firestore invoice mapping", {
          invoiceId: paymentId,
          walletId,
        });

        // Clean up the mapping after use (optional - can keep for audit)
        // await mappingRef.delete();
      }
    } catch (err) {
      console.error("❌ Failed to lookup Firestore invoice mapping", {
        invoiceId: paymentId,
        error: err.message,
      });
    }
  }

  return walletId;
}

/**
 * Process payment webhook and update user balance
 * @param {Object} paymentData - Parsed payment data
 * @param {Object} payload - Full webhook payload
 * @returns {Promise<{success: boolean, walletId?: string, error?: string}>}
 */
async function processPaymentWebhook(paymentData, payload) {
  const {paymentId, amount, currency, completedAt, account} = paymentData;

  if (!paymentId) {
    return {
      success: false,
      error: "Missing payment identifier (invoice_id or payment_id)",
    };
  }

  // B2B hosted payment links — partner wallet settlement (consumer path unchanged below).
  const b2bMapping = await b2bPayments.lookupB2bInvoiceMapping(paymentId, {
    apiRef: payload.api_ref || payload.apiRef || null,
  });
  if (b2bMapping) {
    return b2bPayments.processB2bPaymentWebhook(paymentData, payload, b2bMapping);
  }

  // Resolve wallet ID
  const walletId = await resolveWalletId(paymentData);

  if (!walletId) {
    // Record payment for reconciliation in Firestore
    await firestore.collection("payments").doc(paymentId).set({
      ...payload,
      processed_at: admin.firestore.FieldValue.serverTimestamp(),
      status: "unresolved",
    });

    return {
      success: false,
      error: "Could not resolve wallet ID",
    };
  }

  // Check if payment was already processed (prevent duplicate credits)
  const paymentRecordRef = firestore.collection("payments").doc(paymentId);
  const existingPayment = await paymentRecordRef.get();

  if (existingPayment.exists) {
    const existingData = existingPayment.data();
    if (existingData.user_id === walletId && existingData.processed_at) {
      console.log("ℹ️ Payment already processed, skipping duplicate", {
        paymentId,
        walletId,
        processedAt: existingData.processed_at,
      });
      return {
        success: true,
        walletId,
        duplicate: true,
      };
    }
  }

  // Save payment record globally (before processing to prevent duplicates)
  await paymentRecordRef.set({
    ...payload,
    user_id: walletId,
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
    status: "processing",
  }, {merge: true});

  // Process payment with idempotency
  try {
    const result = await executeWithIdempotency(
        "processPayment",
        async () => {
          // Step 1: Update Firestore balance using transaction
          const balanceResult = await updateBalanceWithTransaction(
              walletId,
              amount, // Positive amount for credit
              "topup",
              {
                paymentId,
                currency,
                completedAt,
                source: "intasend",
                account: account,
              },
          );

          // Step 2: Update payment record status
          await paymentRecordRef.update({
            status: "completed",
            balance_updated: true,
            new_balance: balanceResult.newBalance,
          });

          // Step 3: Update order status to "completed" in Firestore
          if (paymentId) {
            try {
              const ordersCol = firestore.collection(config.collections.orders);
              let orderQuery = ordersCol
                  .where("invoiceId", "==", paymentId)
                  .where("orderType", "==", "topup")
                  .limit(1);

              let orderSnap = await orderQuery.get();

              if (orderSnap.empty) {
                orderQuery = ordersCol
                    .where("metadata.invoiceId", "==", paymentId)
                    .where("orderType", "==", "topup")
                    .limit(1);
                orderSnap = await orderQuery.get();
              }

              if (!orderSnap.empty) {
                const orderRef = ordersCol.doc(orderSnap.docs[0].id);
                await orderRef.update({
                  status: "completed",
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                console.log(`✅ Updated order status to completed: ${orderSnap.docs[0].id}`);
              }
            } catch (orderUpdateError) {
              console.warn("⚠️ Failed to update order status (non-critical):", orderUpdateError.message);
            }
          }

          // Step 4: Update lastTopUp timestamp in Firestore
          const userRef = firestore.collection(config.collections.users).doc(walletId);
          await userRef.update({
            lastTopUp: admin.firestore.Timestamp.fromDate(new Date(completedAt)),
          });

          // Step 5: Send notification to user (both dashboard and mobile app)
          try {
            await createNotification({
              userId: walletId,
              type: NOTIFICATION_TYPES.PAYMENT_COMPLETED,
              title: "Payment Received",
              message: `Your deposit of ${currency} ${amount} was successful. New balance: ${currency} ${balanceResult.newBalance.toFixed(2)}`,
              metadata: {
                paymentId,
                amount,
                currency,
                newBalance: balanceResult.newBalance,
              },
            });
          } catch (notifError) {
            console.warn("⚠️ Failed to send notification (non-critical):", notifError.message);
          }

          return balanceResult;
        },
        {paymentId, walletId, amount},
        walletId,
    );

    console.log(`✅ Webhook processed successfully: ${walletId}`, {
      paymentId,
      amount,
      currency,
      account: account,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      transactionId: result.transactionId,
    });

    return {
      success: true,
      walletId,
      balanceResult: result,
    };
  } catch (error) {
    console.error("❌ Error processing webhook balance update:", {
      walletId,
      paymentId,
      amount,
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      error: error.message,
      walletId,
    };
  }
}

/**
 * Create payment order in Firestore
 * @param {string} userId - User ID
 * @param {Object} paymentData - Payment data
 * @returns {Promise<Object>} Created order data
 */
async function createPaymentOrder(userId, paymentData) {
  const {amount, currency, invoiceId, checkoutUrl, phoneNumber, metadata} = paymentData;

  // Get user's phone number from Firestore if not provided
  let userPhoneNumber = phoneNumber;
  if (!userPhoneNumber) {
    try {
      const userDoc = await firestore.collection(config.collections.users).doc(userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        userPhoneNumber = userData.phoneNumber || userData.phone || null;
      }
    } catch (err) {
      console.warn("⚠️ Could not fetch user phone number:", err.message);
    }
  }

  // Create order document in Firestore
  const orderData = {
    userId: userId,
    orderType: "topup",
    status: "pending",
    amount: amount,
    currency: currency,
    invoiceId: invoiceId,
    phoneNumber: userPhoneNumber,
    metadata: {
      ...metadata,
      invoiceId: invoiceId,
      paymentId: invoiceId,
      checkoutUrl: checkoutUrl,
      phoneNumber: userPhoneNumber,
      createdAt: new Date().toISOString(),
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const orderRef = firestore.collection(config.collections.orders).doc();
  await orderRef.set(orderData);

  const orderId = orderRef.id;
  console.log(`✅ Created order document: ${orderId}`);

  // Create invoice mapping in Firestore for webhook lookup
  const mappingRef = firestore.collection(config.collections.invoiceMappings).doc(invoiceId);
  await mappingRef.set({
    userId: userId,
    orderId: orderId,
    amount: amount,
    currency: currency,
    phoneNumber: userPhoneNumber,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "pending",
  });

  console.log(`✅ Created invoice mapping in Firestore: ${invoiceId}`);

  return {
    success: true,
    orderId: orderId,
    invoiceId: invoiceId,
    paymentId: invoiceId,
    amount: amount,
    currency: currency,
    status: "pending",
    checkoutUrl: checkoutUrl || "",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a direct (manual / bank) top-up request from the customer app.
 * Unlike createPaymentOrder: no IntaSend checkout, no invoiceMappings (webhooks do not apply).
 * Unlike admin POST /customer-wallets/:id/credit: does not credit the wallet; creates a pending order only.
 *
 * @param {string} userId - Authenticated user
 * @param {Object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} [params.phoneNumber]
 * @param {string} [params.note] - Optional message for operations / reference
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>}
 */
async function createDirectTopupOrder(userId, params) {
  const {amount, currency, phoneNumber, note, metadata = {}} = params;

  let userPhoneNumber = phoneNumber;
  if (!userPhoneNumber) {
    try {
      const userDoc = await firestore.collection(config.collections.users).doc(userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        userPhoneNumber = userData.phoneNumber || userData.phone || null;
      }
    } catch (err) {
      console.warn("⚠️ Could not fetch user phone number:", err.message);
    }
  }

  const orderRef = firestore.collection(config.collections.orders).doc();
  const orderId = orderRef.id;
  const referenceId = `DIR-${orderId}`;

  const orderData = {
    userId,
    orderType: "direct_topup",
    status: "pending",
    amount,
    currency,
    // Align with IntaSend topup orders so admin UIs do not assume missing fields
    invoiceId: null,
    checkoutUrl: null,
    referenceId,
    phoneNumber: userPhoneNumber,
    metadata: {
      ...metadata,
      source: "customer_direct_topup",
      referenceId,
      phoneNumber: userPhoneNumber,
      note: note || null,
      createdAt: new Date().toISOString(),
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await orderRef.set(orderData);
  console.log(`✅ Created direct_topup order: ${orderId} (${referenceId})`);

  try {
    await createNotification({
      userId,
      type: NOTIFICATION_TYPES.DIRECT_TOPUP_REQUESTED,
      title: "Direct top-up requested",
      message:
        `We received your request to add ${currency} ${amount}. ` +
        `Reference: ${referenceId}. ` +
        "Complete your transfer using the instructions in the app.",
      metadata: {
        orderId,
        referenceId,
        amount,
        currency,
        orderType: "direct_topup",
      },
    });
  } catch (notifError) {
    console.warn(
        "⚠️ Failed to send direct top-up notification (non-critical):",
        notifError.message,
    );
  }

  try {
    await notifyDirectTopupAdmins({
      customerUserId: userId,
      customerPhone: userPhoneNumber,
      orderId,
      referenceId,
      amount,
      currency,
    });
  } catch (adminNotifErr) {
    console.warn(
        "⚠️ notifyDirectTopupAdmins (non-critical):",
        adminNotifErr.message,
    );
  }

  return {
    success: true,
    orderId,
    referenceId,
    amount,
    currency,
    status: "pending",
    orderType: "direct_topup",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a direct (manual / bank) payout request from the customer app.
 * Debits the wallet for `amount` in `currency` immediately; order stays pending until ops settle.
 *
 * @param {string} userId - Authenticated user
 * @param {Object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} [params.phoneNumber]
 * @param {string} [params.note]
 * @param {string} [params.payoutMethod] - e.g. bank, mobile_money
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>}
 */
async function createDirectPayoutOrder(userId, params) {
  const {
    amount,
    currency,
    phoneNumber,
    note,
    payoutMethod,
    metadata = {},
  } = params;

  const amt = Number(amount);
  if (!amt || amt <= 0) {
    throw new Error("Amount must be a positive number");
  }
  const cur = String(currency || "USD").toUpperCase();

  let userPhoneNumber = phoneNumber;
  if (!userPhoneNumber) {
    try {
      const userDoc = await firestore.collection(config.collections.users).doc(userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        userPhoneNumber = userData.phoneNumber || userData.phone || null;
      }
    } catch (err) {
      console.warn("⚠️ Could not fetch user phone number:", err.message);
    }
  }

  const orderRef = firestore.collection(config.collections.orders).doc();
  const orderId = orderRef.id;
  const referenceId = `DPY-${orderId}`;

  let balanceResult;
  try {
    balanceResult = await updateBalanceWithTransaction(
        userId,
        -Math.abs(amt),
        "direct_payout",
        {
          currency: cur,
          transactionStatus: "pending",
          referenceId,
          orderId,
          note: note || null,
          payoutMethod: payoutMethod || null,
        },
    );
  } catch (balErr) {
    console.error("❌ Direct payout balance update failed:", balErr.message);
    throw balErr;
  }

  const orderData = {
    userId,
    orderType: "direct_payout",
    status: "pending",
    amount: amt,
    currency: cur,
    invoiceId: null,
    checkoutUrl: null,
    referenceId,
    phoneNumber: userPhoneNumber,
    balanceTransactionId: balanceResult.transactionId || null,
    previousBalance: balanceResult.previousBalance,
    newBalance: balanceResult.newBalance,
    metadata: {
      ...metadata,
      source: "customer_direct_payout",
      referenceId,
      phoneNumber: userPhoneNumber,
      note: note || null,
      payoutMethod: payoutMethod || null,
      balanceTransactionId: balanceResult.transactionId || null,
      createdAt: new Date().toISOString(),
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await orderRef.set(orderData);
  console.log(`✅ Created direct_payout order: ${orderId} (${referenceId})`);

  try {
    await createNotification({
      userId,
      type: NOTIFICATION_TYPES.DIRECT_PAYOUT_REQUESTED,
      title: "Payout requested",
      message:
        `${cur} ${amt} reserved for payout. Reference: ${referenceId}. ` +
        "We will send funds using your payout details.",
      metadata: {
        orderId,
        referenceId,
        amount: amt,
        currency: cur,
        orderType: "direct_payout",
        transactionId: balanceResult.transactionId || null,
        newBalance: balanceResult.newBalance,
      },
    });
  } catch (notifError) {
    console.warn(
        "⚠️ Failed to send direct payout notification (non-critical):",
        notifError.message,
    );
  }

  try {
    await notifyDirectPayoutAdmins({
      customerUserId: userId,
      customerPhone: userPhoneNumber,
      orderId,
      referenceId,
      amount: amt,
      currency: cur,
    });
  } catch (adminNotifErr) {
    console.warn(
        "⚠️ notifyDirectPayoutAdmins (non-critical):",
        adminNotifErr.message,
    );
  }

  return {
    success: true,
    orderId,
    referenceId,
    amount: amt,
    currency: cur,
    status: "pending",
    orderType: "direct_payout",
    transactionId: balanceResult.transactionId || null,
    previousBalance: balanceResult.previousBalance,
    newBalance: balanceResult.newBalance,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Mark payment link as opened (for client callable when user opens IntaSend checkout)
 * @param {string} userId - User ID
 * @param {string} invoiceId - Invoice/checkout ID
 * @returns {Promise<{success: boolean}>}
 */
async function markPaymentLinkOpened(userId, invoiceId) {
  if (!invoiceId) {
    return {success: true};
  }
  try {
    const ordersCol = firestore.collection(config.collections.orders);
    const snap = await ordersCol
        .where("invoiceId", "==", invoiceId)
        .where("userId", "==", userId)
        .limit(1)
        .get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({
        linkOpenedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✅ Marked payment link opened: order ${snap.docs[0].id}, invoice ${invoiceId}`);
    }
  } catch (err) {
    console.warn("⚠️ markPaymentLinkOpened (non-critical):", err.message);
  }
  return {success: true};
}

/**
 * Verify TransFi webhook signature (HMAC-SHA256 of raw body, hex-encoded)
 * Uses raw body to avoid key-order mismatches from re-stringified JSON
 * @param {string} webhookSecret - Webhook secret from TransFi dashboard
 * @param {Buffer|Uint8Array|string} rawBody - Raw request body as received
 * @param {string} receivedSignature - Value from X-Transfi-Hmac-Hash header
 * @returns {boolean} True if signature is valid
 */
function verifyTransFiSignature(webhookSecret, rawBody, receivedSignature) {
  if (!webhookSecret || !rawBody || !receivedSignature) {
    return false;
  }
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const computed = crypto.createHmac("sha256", webhookSecret).update(buf).digest("hex");
  if (computed.length !== receivedSignature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(receivedSignature, "hex"));
}

/**
 * Parse TransFi webhook payload and extract payment info
 * Expects fund_settled or payment completed events; customerOrderId format: topup_<userId>_<timestamp>
 * @param {Object} payload - Parsed JSON payload
 * @returns {Object|null} { paymentId, userId, amount, currency } or null if not a processable event
 */
function parseTransFiWebhookPayload(payload) {
  const status = payload.status || payload.event;
  if (!status) {
    return null;
  }
  const processableStatuses = ["fund_settled", "payment_completed", "PAYMENT_COMPLETED", "FUND_SETTLED"];
  if (!processableStatuses.includes(status)) {
    return null;
  }

  const order = payload.order || payload.data?.order || payload.data || {};
  const customerOrderId = order.customerOrderId || payload.customerOrderId || order.customer_order_id || "";
  const amount = Number(order.fiatAmount ?? order.fiat_amount ?? order.amount ?? 0);
  const currency = (order.fiatTicker || order.fiat_ticker || order.currency || "USD").toUpperCase();
  const paymentId = payload.entityId || payload.entity_id || order.orderId || order.order_id || order.id || customerOrderId;

  if (!customerOrderId || amount <= 0) {
    return null;
  }

  const match = customerOrderId.match(/^topup_([^_]+)_(\d+)$/);
  const userId = match ? match[1] : null;

  return {
    paymentId: String(paymentId),
    userId,
    amount,
    currency,
    customerOrderId,
  };
}

/**
 * Process TransFi top-up webhook and credit user's fiat wallet
 * @param {Object} paymentData - Parsed payment data from parseTransFiWebhookPayload
 * @returns {Promise<{success: boolean, walletId?: string, duplicate?: boolean, error?: string}>}
 */
async function processTransFiWebhook(paymentData) {
  const {paymentId, userId, amount, currency, customerOrderId} = paymentData;

  if (!userId) {
    return {
      success: false,
      error: "Could not extract userId from customerOrderId (expected format: topup_<userId>_<timestamp>)",
    };
  }

  // Check idempotency - already processed?
  const paymentRecordRef = firestore.collection("payments").doc(`transfi_${paymentId}`);
  const existingPayment = await paymentRecordRef.get();

  if (existingPayment.exists) {
    const existingData = existingPayment.data();
    if (existingData.user_id === userId && existingData.processed_at) {
      return {
        success: true,
        walletId: userId,
        duplicate: true,
      };
    }
  }

  // Reserve record before processing
  await paymentRecordRef.set({
    user_id: userId,
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
    status: "processing",
    amount,
    currency,
    customer_order_id: customerOrderId,
    source: "transfi",
  }, {merge: true});

  try {
    const result = await executeWithIdempotency(
        "processTransFiPayment",
        async () => {
          const balanceResult = await updateBalanceWithTransaction(
              userId,
              amount,
              "topup",
              {
                paymentId,
                currency,
                completedAt: new Date().toISOString(),
                source: "transfi",
              },
          );

          await paymentRecordRef.update({
            status: "completed",
            balance_updated: true,
            new_balance: balanceResult.newBalance,
          });

          const userRef = firestore.collection(config.collections.users).doc(userId);
          await userRef.update({
            lastTopUp: admin.firestore.Timestamp.fromDate(new Date()),
          });

          try {
            await createNotification({
              userId,
              type: NOTIFICATION_TYPES.PAYMENT_COMPLETED,
              title: "Payment Received",
              message: `Your deposit of ${currency} ${amount} was successful. New balance: ${currency} ${balanceResult.newBalance.toFixed(2)}`,
              metadata: {
                paymentId,
                amount,
                currency,
                newBalance: balanceResult.newBalance,
                source: "transfi",
              },
            });
          } catch (notifError) {
            console.warn("⚠️ Failed to send notification (non-critical):", notifError.message);
          }

          return balanceResult;
        },
        {paymentId, walletId: userId, amount},
        userId,
    );

    return {
      success: true,
      walletId: userId,
      balanceResult: result,
    };
  } catch (error) {
    console.error("❌ Error processing TransFi webhook:", {
      userId,
      paymentId,
      amount,
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: error.message,
      walletId: userId,
    };
  }
}

module.exports = {
  verifySignature,
  verifyTransFiSignature,
  parseWebhookPayload,
  parseTransFiWebhookPayload,
  resolveWalletId,
  processPaymentWebhook,
  processTransFiWebhook,
  createPaymentOrder,
  createDirectTopupOrder,
  createDirectPayoutOrder,
  markPaymentLinkOpened,
};

