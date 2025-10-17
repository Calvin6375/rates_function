/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
const {onRequest} = require("firebase-functions/v2/https");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
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
    console.error("IntaSend secret is not configured");
    res.status(500).send("Configuration error");
    return;
  }

  if (!verifySignature(secret, req)) {
    console.error("Invalid InstaSend signature");
    res.status(403).send("Forbidden");
    return;
  }

  const payload = req.body || {};
  if (payload.event !== "payment.completed") {
    console.log("Ignoring event", payload.event);
    res.status(200).send("Ignored");
    return;
  }

  const data = payload.data || {};
  const paymentId = data.payment_id;
  const amount = Number(data.amount || 0);
  const userId = data.metadata && data.metadata.user_id ? data.metadata.user_id : null;
  const completedAt = data.completed_at || null;

  console.log("Processing payment", {paymentId, amount, userId});

  if (!paymentId || !userId) {
    console.error("Missing payment_id or user_id");
    res.status(400).send("Bad Request");
    return;
  }

  const paymentRecord = {...data};
  if (userId && !paymentRecord.user_id) {
    paymentRecord.user_id = userId;
  }

  await realtimeDb.ref(`payments/${paymentId}`).set(paymentRecord);

  const userRef = firestore.collection("users").doc(userId);
  const updateData = {
    balance: admin.firestore.FieldValue.increment(amount),
  };
  if (completedAt) {
    const parsedDate = new Date(completedAt);
    if (!Number.isNaN(parsedDate.getTime())) {
      updateData.lastTopUp = admin.firestore.Timestamp.fromDate(parsedDate);
    }
  }
  if (!updateData.lastTopUp) {
    updateData.lastTopUp = admin.firestore.FieldValue.serverTimestamp();
  }

  await userRef.set(updateData, {merge: true});

  res.status(200).send("OK");
});
