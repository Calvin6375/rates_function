/**
 * @fileoverview Payments business logic module
 * Pure business logic for payment processing and webhook handling
 */

const admin = require("../admin");
const crypto = require("crypto");
const config = require("../config");
const {updateBalanceWithTransaction} = require("../utils/firestore");
const {executeWithIdempotency} = require("./idempotency");

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

module.exports = {
  verifySignature,
  parseWebhookPayload,
  resolveWalletId,
  processPaymentWebhook,
  createPaymentOrder,
};

