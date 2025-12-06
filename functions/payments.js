/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("./admin");
const crypto = require("crypto");

const firestore = admin.firestore();
const realtimeDb = admin.database();

// Secret parameter for IntaSend webhook signature (firebase-functions v7+)
// Configure with: firebase functions:secrets:set INTASEND_SECRET
const intaSendSecret = defineSecret("INTASEND_SECRET");
// Challenge token for validating IntaSend webhook origin.
// Configure with: firebase functions:secrets:set INTASEND_CHALLENGE
const intaSendChallenge = defineSecret("INTASEND_CHALLENGE");

function getSecret() {
  // Primary: environment secret managed via Firebase secrets
  const fromParams = intaSendSecret.value();
  if (fromParams) {
    return fromParams;
  }

  // Fallback: plain env var (for local dev / emulator)
  if (process.env.INTASEND_SECRET) {
    return process.env.INTASEND_SECRET;
  }

  return null;
}

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

exports.handleTopUpWebhook = onRequest({
  secrets: [intaSendSecret, intaSendChallenge],
  region: "us-central1",
  cpu: 0.25,
  memory: "256MiB",
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

  // Read optional challenge sent by IntaSend.
  const receivedChallenge =
    req.get("x-intasend-challenge") ||
    req.query?.challenge ||
    payload.challenge ||
    null;

  const challengeOk = !!challenge && receivedChallenge === challenge;

  let signatureOk = false;
  if (secret) {
    signatureOk = verifySignature(secret, req);
  }

  if (!signatureOk && !challengeOk) {
    console.error("❌ Invalid IntaSend signature and/or challenge", {
      hasSignature: !!req.get("x-intasend-signature") || !!req.get("X-IntaSend-Signature"),
      hasChallenge: !!receivedChallenge,
    });
    res.status(403).send("Forbidden");
    return;
  }

  /**
   * The legacy integration expected an envelope:
   *   { event: "payment.completed", data: { ... } }
   * Your current IntaSend callback payload is a flat object like:
   *   {
   *     "invoice_id": "Y5JVGZG",
   *     "state": "COMPLETE",
   *     "net_amount": "10.66",
   *     "currency": "KES",
   *     "value": "11.00",
   *     "account": "254742844875",
   *     ...
   *   }
   *
   * This handler supports BOTH formats:
   * - If payload.event === "payment.completed", use payload.data.*
   * - Otherwise, fall back to the flat invoice payload shape.
   */

  let paymentId;
  let amount;
  let currency;
  let userId;
  let completedAt;
  let isFlatInvoicePayload = false;
  let account = null;

  if (payload.event === "payment.completed") {
    // Old IntaSend format with nested data
    const data = payload.data || {};
    paymentId = data.payment_id;
    amount = Number(data.amount || 0);
    currency = data.currency || "KES";

    // Safely read metadata.user_id if present
    const metadata = data.metadata || {};
    userId = metadata.user_id || null;
    completedAt = data.completed_at || new Date().toISOString();
  } else {
    // New flat invoice-style payload
    isFlatInvoicePayload = true;

    // Use invoice_id as the unique payment identifier
    paymentId = payload.invoice_id || null;

    // Prefer net_amount (amount after fees), fall back to value
    amount = Number(payload.net_amount || payload.value || 0);

    currency = payload.currency || "KES";

    // Raw payer account (e.g. MSISDN / phone number)
    account = payload.account ? String(payload.account) : null;

    /**
     * Preferred: explicit user/wallet ID from our own system.
     * When creating the IntaSend invoice, include:
     *   metadata: { user_id: "<firebase uid or wallet id>" }
     *
     * This makes wallet crediting independent of the phone number used.
     */
    const metadata = payload.metadata || {};
    userId = metadata.user_id || metadata.userId || null;

    completedAt = payload.updated_at || payload.created_at || new Date().toISOString();
  }

  // Extract state from payload (IntaSend sends state field)
  const paymentState = payload.state || null;

  // Only process COMPLETE payments (per IntaSend documentation)
  // IntaSend sends webhooks for: PENDING, PROCESSING, COMPLETE, FAILED
  // We only want to credit wallet on COMPLETE state
  if (paymentState && paymentState !== "COMPLETE") {
    console.log(`ℹ️ Payment ${paymentId} is in ${paymentState} state, skipping balance update`, {
      state: paymentState,
      invoiceId: paymentId,
    });
    res.status(200).send("OK - Payment not complete yet");
    return;
  }

  console.log("💰 Processing payment", {
    paymentId,
    amount,
    currency,
    userId,
    account,
    state: paymentState,
  });

  /**
   * 🔍 Resolve wallet/user ID using multiple strategies (in priority order):
   *
   * 1. Phone number lookup (PRIMARY): Query Firestore users by phoneNumber/phone
   *    This is the most reliable since IntaSend always provides account (phone) field
   *
   * 2. Order lookup by invoice_id: Query Firestore orders collection
   *    Orders have userId and metadata.paymentId or metadata.invoiceId
   *
   * 3. RTDB mapping: Look up wallet/pendingTopups/{invoice_id}
   *    Fallback if order lookup doesn't work
   *
   * 4. Metadata user_id: If IntaSend payload includes metadata.user_id
   *
   * Phone number is now PRIMARY because it's the most reliable identifier
   * from IntaSend webhook payloads.
   */

  let walletId = userId;

  // Strategy 1: Phone number lookup (PRIMARY - most reliable from IntaSend)
  // IntaSend always provides account field (phone number) in webhook payload
  if (!walletId && account) {
    try {
      const usersCol = firestore.collection("users");

      // Normalize phone number (remove leading +, ensure consistent format)
      const normalizedPhone = account.replace(/^\+/, "").trim();

      // Try multiple phone number field variations
      let querySnap = await usersCol.where("phoneNumber", "==", normalizedPhone).limit(1).get();

      if (querySnap.empty) {
        // Try with + prefix
        querySnap = await usersCol.where("phoneNumber", "==", `+${normalizedPhone}`).limit(1).get();
      }

      if (querySnap.empty) {
        // Try phone field
        querySnap = await usersCol.where("phone", "==", normalizedPhone).limit(1).get();
      }

      if (querySnap.empty) {
        // Try phone field with + prefix
        querySnap = await usersCol.where("phone", "==", `+${normalizedPhone}`).limit(1).get();
      }

      if (querySnap.empty) {
        // Try original account value (as-is)
        querySnap = await usersCol.where("phoneNumber", "==", account).limit(1).get();
      }

      if (querySnap.empty) {
        querySnap = await usersCol.where("phone", "==", account).limit(1).get();
      }

      if (!querySnap.empty) {
        // Use the document ID as wallet ID (Firebase UID)
        walletId = querySnap.docs[0].id;
        console.log("✅ Found wallet ID from phone number lookup (PRIMARY)", {
          account,
          normalizedPhone,
          walletId,
          docId: querySnap.docs[0].id,
        });
      } else {
        // Fallback: Try direct document ID match (some schemas use phone as doc ID)
        const directDoc = await usersCol.doc(normalizedPhone).get();
        if (!directDoc.exists) {
          const directDocWithPlus = await usersCol.doc(`+${normalizedPhone}`).get();
          if (directDocWithPlus.exists) {
            const docData = directDocWithPlus.data();
            walletId = docData.userId || docData.uid || docData.id || directDocWithPlus.id;
            console.log("✅ Found wallet ID from phone document ID (with +)", {
              account,
              walletId,
            });
          }
        } else {
          const docData = directDoc.data();
          walletId = docData.userId || docData.uid || docData.id || directDoc.id;
          console.log("✅ Found wallet ID from phone document ID", {
            account,
            walletId,
          });
        }
      }
    } catch (err) {
      console.error("❌ Failed to lookup user by phone number", {
        account,
        error: err.message,
      });
    }
  }

  // Strategy 2: Look up order by invoice_id (secondary - uses existing order data)
  if (paymentId && !walletId) {
    try {
      const ordersCol = firestore.collection("orders");

      // Try to find order by metadata.paymentId or metadata.invoiceId
      let orderQuery = ordersCol
          .where("metadata.paymentId", "==", paymentId)
          .where("orderType", "==", "topup")
          .limit(1);

      let orderSnap = await orderQuery.get();

      // If not found, try metadata.invoiceId
      if (orderSnap.empty) {
        orderQuery = ordersCol
            .where("metadata.invoiceId", "==", paymentId)
            .where("orderType", "==", "topup")
            .limit(1);
        orderSnap = await orderQuery.get();
      }

      // If still not found, try direct invoiceId field
      if (orderSnap.empty) {
        orderQuery = ordersCol
            .where("invoiceId", "==", paymentId)
            .where("orderType", "==", "topup")
            .limit(1);
        orderSnap = await orderQuery.get();
      }

      // If still not found, try matching by amount + currency for pending topup orders
      // This is a fallback - less reliable but might work if invoice_id is stored elsewhere
      if (orderSnap.empty && amount > 0 && currency) {
        try {
          orderQuery = ordersCol
              .where("orderType", "==", "topup")
              .where("status", "==", "pending")
              .where("amount", "==", amount)
              .where("currency", "==", currency)
              .limit(1);
          orderSnap = await orderQuery.get();

          if (!orderSnap.empty) {
            console.log("⚠️ Found order by amount+currency match (less reliable)", {
              invoiceId: paymentId,
              amount,
              currency,
              orderId: orderSnap.docs[0].id,
            });
          }
        } catch (queryErr) {
          // Query might fail if composite index doesn't exist - that's okay
          console.log("ℹ️ Amount+currency query not available (index may be missing)", {
            error: queryErr.message,
          });
        }
      }

      if (!orderSnap.empty) {
        const orderDoc = orderSnap.docs[0];
        const orderData = orderDoc.data();
        
        // Get userId from order
        const orderUserId = orderData.userId || null;
        
        // If we have phone number, verify it matches the order's phone number
        if (orderUserId && account && orderData.phoneNumber) {
          const normalizedOrderPhone = String(orderData.phoneNumber).replace(/^\+/, "").trim();
          const normalizedAccount = account.replace(/^\+/, "").trim();
          
          if (normalizedOrderPhone === normalizedAccount) {
            walletId = orderUserId;
            console.log("✅ Found wallet ID from order lookup (phone verified)", {
              invoiceId: paymentId,
              orderId: orderDoc.id,
              walletId,
              phoneMatch: true,
            });
          } else {
            console.warn("⚠️ Order phone number doesn't match webhook account", {
              invoiceId: paymentId,
              orderId: orderDoc.id,
              orderPhone: orderData.phoneNumber,
              webhookAccount: account,
            });
            // Still use the userId if phone doesn't match (might be different payment method)
            walletId = orderUserId;
          }
        } else if (orderUserId) {
          walletId = orderUserId;
          console.log("✅ Found wallet ID from order lookup", {
            invoiceId: paymentId,
            orderId: orderDoc.id,
            walletId,
          });
        } else {
          console.warn("⚠️ Order found but has no userId field", {
            invoiceId: paymentId,
            orderId: orderDoc.id,
          });
        }
      } else {
        console.log("ℹ️ No order found matching invoice_id", {
          invoiceId: paymentId,
          hint: "Ensure order stores invoice_id in metadata.invoiceId or invoiceId field",
        });
      }
    } catch (err) {
      console.error("❌ Failed to lookup order", {
        invoiceId: paymentId,
        error: err.message,
      });
    }
  }

  // Strategy 3: Look up invoice_id → userId mapping in RTDB (fallback)
  if (paymentId && !walletId) {
    try {
      const mappingRef = realtimeDb.ref(`wallet/pendingTopups/${paymentId}`);
      const mappingSnap = await mappingRef.get();

      if (mappingSnap.exists()) {
        const mapping = mappingSnap.val();
        walletId = mapping.userId || null;

        console.log("✅ Found wallet ID from RTDB invoice mapping", {
          invoiceId: paymentId,
          walletId,
        });

        // Clean up the mapping after use (optional, but recommended)
        await mappingRef.remove();
      }
    } catch (err) {
      console.error("❌ Failed to lookup RTDB invoice mapping", {
        invoiceId: paymentId,
        error: err.message,
      });
    }
  }

  // Strategy 4: Metadata user_id (if provided in IntaSend payload)
  // This is already set in userId variable at the start, so no additional lookup needed

  if (!paymentId) {
    console.error("❌ Missing payment identifier (invoice_id or payment_id)");
    res.status(400).send("Bad Request: missing payment identifier");
    return;
  }

  if (!walletId) {
    // We cannot update a specific wallet without knowing which user it belongs to.
    // Still record the payment for reconciliation purposes.
    console.warn("⚠️ Could not resolve wallet ID. Recording payment only.", {
      invoiceId: paymentId,
      account,
      hint: "Ensure wallet/pendingTopups/{invoice_id} mapping exists when creating invoice",
    });

    await realtimeDb.ref(`payments/${paymentId}`).set({
      ...payload,
      processed_at: new Date().toISOString(),
    });

    res.status(200).send("Recorded without wallet update");
    return;
  }

  // Check if payment was already processed (prevent duplicate credits)
  const paymentRecordRef = realtimeDb.ref(`payments/${paymentId}`);
  const existingPayment = await paymentRecordRef.get();
  
  if (existingPayment.exists()) {
    const existingData = existingPayment.val();
    if (existingData.user_id === walletId && existingData.processed_at) {
      console.log("ℹ️ Payment already processed, skipping duplicate", {
        paymentId,
        walletId,
        processedAt: existingData.processed_at,
      });
      res.status(200).send("OK - Already processed");
      return;
    }
  }

  // Save payment record globally (before processing to prevent duplicates)
  await realtimeDb.ref(`payments/${paymentId}`).set({
    ...payload,
    user_id: walletId,
    processed_at: new Date().toISOString(),
  });

  // ✅ Update balance using Firestore transaction (master source)
  // This ensures atomicity and prevents race conditions
  const {updateBalanceWithTransaction} = require("./utils/firestore");
  const {syncBalanceToRealtime} = require("./utils/realtime");

  try {
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
          account: account, // Include phone number in transaction metadata
        },
    );

    // Step 2: Sync to Realtime Database (cached mirror)
    await syncBalanceToRealtime(walletId, balanceResult.newBalance, currency);

    // Step 3: Update order status to "completed" in Firestore
    if (paymentId) {
      try {
        const ordersCol = firestore.collection("orders");
        // Find order by invoiceId
        let orderQuery = ordersCol
            .where("invoiceId", "==", paymentId)
            .where("orderType", "==", "topup")
            .limit(1);
        
        let orderSnap = await orderQuery.get();
        
        if (orderSnap.empty) {
          // Try metadata.invoiceId
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
        // Don't fail the webhook if order update fails
        console.warn("⚠️ Failed to update order status (non-critical):", orderUpdateError.message);
      }
    }

    // Step 4: Update lastTopUp timestamp in Firestore
    const userRef = firestore.collection("users").doc(walletId);
    await userRef.update({
      lastTopUp: admin.firestore.Timestamp.fromDate(new Date(completedAt)),
    });

    console.log(`✅ Webhook processed successfully: ${walletId}`, {
      paymentId,
      amount,
      currency,
      account: account,
      previousBalance: balanceResult.previousBalance,
      newBalance: balanceResult.newBalance,
      transactionId: balanceResult.transactionId,
    });

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error processing webhook balance update:", {
      walletId,
      paymentId,
      amount,
      error: error.message,
      stack: error.stack,
    });

    // Return error but don't expose internal details
    res.status(500).json({
      error: "internal",
      message: "Failed to process payment",
    });
  }
});

/**
 * Cloud Function: Create Payment Order
 * Callable function to create a payment order record after IntaSend checkout creation
 * Uses v2 callable function (supports Node.js 22)
 * 
 * Creates:
 * 1. Order document in Firestore: /orders/{orderId}
 * 2. Invoice mapping in Realtime DB: /wallet/pendingTopups/{invoiceId}
 * 
 * This order record is used by the webhook handler to credit the correct user's wallet
 */
exports.createPayment = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
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
        hasAmount: !!data.amount,
        hasCurrency: !!data.currency,
        hasInvoiceId: !!data.invoiceId,
        hasCheckoutUrl: !!data.checkoutUrl,
        checkoutUrl: data.checkoutUrl,
      });

      // Extract payment details
      const amount = Number(data.amount);
      const currency = data.currency || "KES";
      const invoiceId = data.invoiceId || null;
      const checkoutUrl = data.checkoutUrl || null;
      const phoneNumber = data.phoneNumber || null; // Phone number for webhook lookup
      const metadata = data.metadata || {};

      // Validate required fields
      if (!amount || amount <= 0) {
        throw new HttpsError("invalid-argument", "Amount must be a positive number");
      }

      if (!currency) {
        throw new HttpsError("invalid-argument", "Currency is required");
      }

      // Extract invoice ID from checkout URL if not provided directly
      let extractedInvoiceId = invoiceId;
      if (!extractedInvoiceId && checkoutUrl) {
        // Extract invoice ID from IntaSend checkout URL
        // Format: https://payment.intasend.com/checkout/{invoice-id}/express/
        const match = checkoutUrl.match(/checkout\/([^\/]+)/);
        if (match && match[1]) {
          extractedInvoiceId = match[1];
        }
      }

      if (!extractedInvoiceId) {
        throw new HttpsError(
            "invalid-argument",
            "Either invoiceId or checkoutUrl with invoice ID must be provided",
        );
      }

      try {
        console.log(`🔄 Creating payment order for user: ${userId}`, {
          amount,
          currency,
          invoiceId: extractedInvoiceId,
        });

        // Get user's phone number from Firestore if not provided
        let userPhoneNumber = phoneNumber;
        if (!userPhoneNumber) {
          try {
            const userDoc = await firestore.collection("users").doc(userId).get();
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
          invoiceId: extractedInvoiceId,
          phoneNumber: userPhoneNumber, // Store phone number for webhook lookup
          metadata: {
            ...metadata,
            invoiceId: extractedInvoiceId,
            paymentId: extractedInvoiceId, // Also store as paymentId for webhook lookup
            checkoutUrl: checkoutUrl,
            phoneNumber: userPhoneNumber, // Include in metadata too
            createdAt: new Date().toISOString(),
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const orderRef = firestore.collection("orders").doc();
        await orderRef.set(orderData);

        const orderId = orderRef.id;
        console.log(`✅ Created order document: ${orderId}`);

        // Create invoice mapping in Realtime Database for webhook lookup
        const mappingRef = realtimeDb.ref(`wallet/pendingTopups/${extractedInvoiceId}`);
        await mappingRef.set({
          userId: userId,
          orderId: orderId,
          amount: amount,
          currency: currency,
          phoneNumber: userPhoneNumber, // Store phone number for webhook lookup
          createdAt: new Date().toISOString(),
        });

        // Also create phone number to invoice mapping for direct lookup
        if (userPhoneNumber) {
          const phoneMappingRef = realtimeDb.ref(`wallet/phoneToInvoice/${userPhoneNumber}/${extractedInvoiceId}`);
          await phoneMappingRef.set({
            userId: userId,
            orderId: orderId,
            invoiceId: extractedInvoiceId,
            amount: amount,
            currency: currency,
            createdAt: new Date().toISOString(),
          });
        }

        console.log(`✅ Created invoice mapping in RTDB: ${extractedInvoiceId}`);

        // Return order data - always include all fields for Flutter compatibility
        const response = {
          success: true,
          orderId: orderId,
          invoiceId: extractedInvoiceId,
          paymentId: extractedInvoiceId, // Flutter expects paymentId (same as invoiceId for IntaSend)
          amount: amount,
          currency: currency,
          status: "pending",
          checkoutUrl: checkoutUrl || "", // Always include, use empty string if not provided
          createdAt: new Date().toISOString(),
        };

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
