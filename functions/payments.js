/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
const {onRequest} = require("firebase-functions/v2/https");
const functions = require("firebase-functions");
const admin = require("./admin");
const crypto = require("crypto");

const firestore = admin.firestore();
const realtimeDb = admin.database();

function getSecret() {
  const config = functions.config();
  if (config && config.intasend && config.intasend.secret) {
    return config.intasend.secret;
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
  const receivedBuffer = Buffer.from(headerSignature, "hex");
  const computedBuffer = Buffer.from(computed, "hex");
  if (receivedBuffer.length !== computedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuffer, computedBuffer);
}

exports.handleTopUpWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const secret = getSecret();
  if (!secret) {
    console.error("❌ IntaSend secret not configured");
    res.status(500).send("Configuration error");
    return;
  }

  if (!verifySignature(secret, req)) {
    console.error("❌ Invalid IntaSend signature");
    res.status(403).send("Forbidden");
    return;
  }

  const payload = req.body || {};
  if (payload.event !== "payment.completed") {
    console.log("ℹ️ Ignoring event:", payload.event);
    res.status(200).send("Ignored");
    return;
  }

  const data = payload.data || {};
  const paymentId = data.payment_id;
  const amount = Number(data.amount || 0);
  const currency = data.currency || "KES";
  const userId = data.metadata.user_id || null;
  const completedAt = data.completed_at || new Date().toISOString();

  console.log("💰 Processing payment", {paymentId, amount, userId});

  if (!paymentId || !userId) {
    console.error("❌ Missing payment_id or user_id");
    res.status(400).send("Bad Request");
    return;
  }

  // Save payment record globally
  await realtimeDb.ref(`payments/${paymentId}`).set({
    ...data,
    user_id: userId,
    processed_at: new Date().toISOString(),
  });

  // ✅ Update wallet balance in Realtime Database
  const walletRef = realtimeDb.ref(`wallet/balance/${userId}`);
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
  const userRef = firestore.collection("users").doc(userId);
  const updateData = {
    balance: admin.firestore.FieldValue.increment(amount),
    lastTopUp: admin.firestore.Timestamp.fromDate(new Date(completedAt)),
  };
  await userRef.set(updateData, {merge: true});

  console.log(`✅ Updated ${userId} wallet: ${currentBalance} → ${newBalance} ${currency}`);

  res.status(200).send("OK");
});
