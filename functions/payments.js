/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
const {onRequest} = require("firebase-functions/v2/https");
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

exports.handleTopUpWebhook = onRequest({secrets: [intaSendSecret, intaSendChallenge]}, async (req, res) => {
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

  console.log("💰 Processing payment", {
    paymentId,
    amount,
    currency,
    userId,
    account,
  });

  /**
   * 🔄 Resolve IntaSend account (phone/MSISDN) → internal wallet/user ID
   *
   * IntaSend does not know our internal wallet ID – it only sends the payer
   * account (usually a phone number). Our RTDB wallet structure, however,
   * is keyed by the internal user/wallet ID (e.g. Firebase Auth UID):
   *
   *   wallet/balance/{walletId}
   *
   * For the **legacy envelope format** (`event === "payment.completed"`),
   * `metadata.user_id` is already our internal ID, so we do **not** remap it.
   *
   * For the **flat invoice payload**, we:
   *   1. Take `payload.account` (phone/MSISDN)
   *   2. Try to find a matching Firestore user:
   *        - First, a document whose ID matches the phone number
   *        - Then, a document where `phoneNumber` (or `phone`) equals it
   *   3. Use the found document ID as the wallet/user ID
   *   4. Fall back to using the raw account string if nothing matches
   */

  let walletId = userId;

  // For flat payloads, if we did not receive an explicit metadata.user_id,
  // try to resolve the wallet by phone/MSISDN (`account`) as a fallback.
  if (isFlatInvoicePayload && !walletId && account) {
    try {
      const usersCol = firestore.collection("users");

      // 1) Direct document ID match (some schemas use phone as doc ID)
      const directDoc = await usersCol.doc(account).get();
      if (directDoc.exists) {
        walletId = directDoc.id;
      } else {
        // 2) Match on phoneNumber / phone field
        let querySnap = await usersCol.where("phoneNumber", "==", account).limit(1).get();

        if (querySnap.empty) {
          querySnap = await usersCol.where("phone", "==", account).limit(1).get();
        }

        if (!querySnap.empty) {
          walletId = querySnap.docs[0].id;
        }
      }

      console.log("👤 Resolved wallet ID from account", {
        account,
        walletId,
      });
    } catch (err) {
      console.error("❌ Failed to resolve wallet ID from account", {
        account,
        error: err.message,
      });
    }
  }

  if (!paymentId) {
    console.error("❌ Missing payment identifier (invoice_id or payment_id)");
    res.status(400).send("Bad Request: missing payment identifier");
    return;
  }

  if (!walletId) {
    // We cannot update a specific wallet without knowing which user it belongs to.
    // Still record the payment for reconciliation purposes.
    console.warn("⚠️ Missing user identifier (metadata.user_id or account). Recording payment only.");

    await realtimeDb.ref(`payments/${paymentId}`).set({
      ...payload,
      processed_at: new Date().toISOString(),
    });

    res.status(200).send("Recorded without wallet update");
    return;
  }

  // Save payment record globally
  await realtimeDb.ref(`payments/${paymentId}`).set({
    ...payload,
    user_id: walletId,
    processed_at: new Date().toISOString(),
  });

  // ✅ Update wallet balance in Realtime Database
  const walletRef = realtimeDb.ref(`wallet/balance/${walletId}`);
  const snapshot = await walletRef.get();

  let currentBalance = 0;
  if (snapshot.exists() && snapshot.val().available) {
    currentBalance = Number(snapshot.val().available);
  }

  const newBalance = currentBalance + amount;

  await walletRef.update({
    available: newBalance,
    currency: currency,
    lastUpdated: new Date().toISOString(),
  });

  // ✅ Also update Firestore user record for analytics
  const userRef = firestore.collection("users").doc(walletId);
  const updateData = {
    balance: admin.firestore.FieldValue.increment(amount),
    lastTopUp: admin.firestore.Timestamp.fromDate(new Date(completedAt)),
  };
  await userRef.set(updateData, {merge: true});

  console.log(`✅ Updated ${walletId} wallet: ${currentBalance} → ${newBalance} ${currency}`);

  res.status(200).send("OK");
});
