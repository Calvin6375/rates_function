/**
 * @fileoverview Circle rail adapter — sole external entry point for Circle operations.
 */

const admin = require("../../admin");
const { collection, serverTimestamp } = require("../../libs/firestore");
const ledgerService = require("../ledger/ledgerService");
const reservationService = require("../ledger/reservationService");
const circleService = require("./circleService");
const circleWalletService = require("./circleWalletService");
const sendIdempotencyService = require("./sendIdempotencyService");

const ASSET = "USDC";
const PROVIDER = "circle";

/**
 * @param {Object} event
 * @returns {Object|null}
 */
function normalizeCircleEvent(event) {
  const notificationType = String(event.notificationType || "").toLowerCase();
  const notification = event.notification || {};
  const tx = notification.transaction || notification;

  const state = String(tx.state || notification.state || "").toUpperCase();
  const isTerminalSuccess = state === "COMPLETE" || state === "CONFIRMED";
  const isTerminalFailure = state === "FAILED" || state === "CANCELLED" || state === "DENIED";

  if (state && !isTerminalSuccess && !isTerminalFailure) {
    return null;
  }

  const isInbound =
    notificationType.includes("inbound") ||
    notificationType.includes("incoming") ||
    notificationType === "transfer.incoming" ||
    notificationType === "transactions.inbound";

  const isOutbound =
    notificationType.includes("outbound") ||
    notificationType.includes("outgoing") ||
    notificationType === "transfer.outgoing" ||
    notificationType === "transactions.outbound";

  if (!isInbound && !isOutbound) {
    return null;
  }

  const amount = Number(
      tx.amount?.amount ||
      tx.amounts?.[0] ||
      notification.amount?.amount ||
      notification.amount ||
      0,
  );

  return {
    type: isInbound ? "deposit" : "send",
    amount,
    asset: ASSET,
    status: isTerminalSuccess ? "complete" : "failed",
    failed: isTerminalFailure,
    walletId: tx.walletId || notification.walletId || tx.source?.id || null,
    destinationAddress: tx.destinationAddress || notification.destinationAddress || null,
    sourceAddress: tx.sourceAddress || tx.source?.address || notification.sourceAddress || null,
    txHash: tx.txHash || tx.transactionHash || notification.txHash || null,
    circleTransactionId: tx.id || notification.id || event.notificationId || null,
    notificationType,
    eventId: event.notificationId || event.id || null,
  };
}

/**
 * @param {import("express").Request} req
 * @param {Buffer|string} rawBody
 * @returns {Promise<boolean>}
 */
async function verifyWebhookSignature(req, rawBody) {
  const crypto = require("crypto");
  const signature = req.get("X-Circle-Signature") || req.get("x-circle-signature") || "";
  const keyId = req.get("X-Circle-Key-Id") || req.get("x-circle-key-id") || "";
  if (!signature || !keyId) return false;

  try {
    const { publicKey } = await circleService.getNotificationPublicKey(keyId);
    const message = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
    const sigBuffer = Buffer.from(signature, "base64");
    const keyObject = crypto.createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify("sha256", message, keyObject, sigBuffer);
  } catch (err) {
    console.error("Circle signature verification failed", { error: err.message });
    return false;
  }
}

/**
 * @param {string} eventId
 * @param {string} payloadHash
 * @returns {Promise<{ acquired: boolean, duplicate: boolean }>}
 */
async function acquireWebhookLock(eventId, payloadHash) {
  const db = admin.firestore();
  const ref = collection("webhookEvents").doc(eventId);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) {
      return { acquired: false, duplicate: true };
    }
    tx.set(ref, {
      eventId,
      provider: PROVIDER,
      processed: false,
      payloadHash,
      createdAt: serverTimestamp(),
    });
    return { acquired: true, duplicate: false };
  });
}

/**
 * @param {string} eventId
 * @param {Object} [meta]
 */
async function markWebhookProcessed(eventId, meta = {}) {
  await collection("webhookEvents").doc(eventId).set({
    processed: true,
    processedAt: serverTimestamp(),
    notificationType: meta.notificationType || null,
    stale: meta.stale || false,
  }, { merge: true });
}

/**
 * @param {Object} mapped
 * @returns {Promise<{ userId: string, wallet: Object }|null>}
 */
async function resolveUserFromEvent(mapped) {
  if (mapped.walletId) {
    const wallet = await circleWalletService.getWalletByCircleId(mapped.walletId);
    if (wallet) return { userId: wallet.userId, wallet };
  }

  const address = mapped.type === "deposit" ? mapped.destinationAddress : mapped.sourceAddress;
  if (address) {
    const wallet = await circleWalletService.getWalletByAddress(address);
    if (wallet) return { userId: wallet.userId, wallet };
  }
  return null;
}

/**
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getBalance(userId) {
  return ledgerService.getAvailableBalance(userId, ASSET);
}

/**
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function createWallet(userId) {
  return circleWalletService.createWallet(userId);
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getWallet(userId) {
  return circleWalletService.getWallet(userId);
}

/**
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<Array<Object>>}
 */
async function listTransactions(userId, limit = 50) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const snap = await collection("cryptoTransactions")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(cap)
      .get();

  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || null,
    };
  });
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function send(params) {
  const { fromWalletId, toAddress, amount, userId, idempotencyKey } = params;
  const numericAmount = Number(amount);
  if (!fromWalletId || !toAddress || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid send parameters");
  }
  if (!idempotencyKey) {
    throw new Error("X-Idempotency-Key is required");
  }

  const wallet = await circleWalletService.getWalletByCircleId(fromWalletId);
  if (!wallet) throw new Error("Source wallet not found");

  const ownerId = userId || wallet.userId;
  const requestData = {
    fromWalletId,
    toAddress: String(toAddress).toLowerCase(),
    amount: numericAmount,
    userId: ownerId,
  };

  const keyResult = await sendIdempotencyService.acquireSendKey(
      idempotencyKey,
      ownerId,
      requestData,
  );
  if (!keyResult.acquired) {
    return keyResult.cachedResult;
  }

  let reservationId = null;

  try {
    const reservation = await reservationService.reserveFunds(
        ownerId,
        numericAmount,
        idempotencyKey,
    );
    reservationId = reservation.reservationId;

    const client = circleService.getSdkClient();
    const txInput = {
      walletId: fromWalletId,
      destinationAddress: toAddress,
      amount: [String(numericAmount)],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey,
    };
    if (process.env.CIRCLE_USDC_TOKEN_ID) {
      txInput.tokenId = process.env.CIRCLE_USDC_TOKEN_ID;
    }

    const transferResponse = await client.createTransaction(txInput);
    const circleTx = transferResponse.data?.transaction || transferResponse.data;
    const circleTransactionId = circleTx?.id || transferResponse.data?.id;
    if (!circleTransactionId) {
      throw new Error("Circle transfer failed: no transaction id returned");
    }

    await reservationService.attachCircleTransactionId(reservationId, circleTransactionId);

    const txRef = await collection("cryptoTransactions").add({
      userId: ownerId,
      circleTransactionId,
      txHash: null,
      type: "send",
      amount: numericAmount,
      asset: ASSET,
      status: "pending",
      toAddress,
      fromWalletId,
      provider: PROVIDER,
      idempotencyKey,
      reservationId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const result = {
      success: true,
      circleTransactionId,
      txHash: null,
      status: "pending",
      firestoreTxId: txRef.id,
      amount: numericAmount,
      reservationId,
    };

    await sendIdempotencyService.storeSendResult(idempotencyKey, result, circleTransactionId);

    console.log("Circle USDC send initiated (async)", {
      userId: ownerId,
      circleTransactionId,
      amount: numericAmount,
      reservationId,
    });

    return result;
  } catch (err) {
    if (reservationId) {
      await reservationService.releaseReservation(reservationId).catch(() => {});
    }
    await collection("sendIdempotencyKeys").doc(idempotencyKey).delete().catch(() => {});
    throw err;
  }
}

/**
 * @param {Object} event
 * @param {string} rawBody
 * @returns {Promise<{ success: boolean, duplicate?: boolean, stale?: boolean, error?: string }>}
 */
async function handleWebhookEvent(event, rawBody) {
  const crypto = require("crypto");
  const eventId = event.notificationId || event.id;
  if (!eventId) {
    return { success: false, error: "Missing notification id" };
  }

  if (ledgerService.isWebhookEventStale(event.timestamp)) {
    console.warn("Circle webhook: stale event rejected", { eventId, timestamp: event.timestamp });
    await markWebhookProcessed(eventId, {
      notificationType: event.notificationType,
      stale: true,
    });
    return { success: true, duplicate: true, stale: true };
  }

  const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const lock = await acquireWebhookLock(eventId, payloadHash);
  if (!lock.acquired) {
    return { success: true, duplicate: true };
  }

  try {
    const mapped = normalizeCircleEvent(event);
    if (!mapped || !mapped.circleTransactionId) {
      await markWebhookProcessed(eventId, { notificationType: event.notificationType });
      return { success: true, duplicate: false };
    }

    const resolved = await resolveUserFromEvent(mapped);
    if (!resolved) {
      console.warn("Circle webhook: could not resolve user", { eventId, walletId: mapped.walletId });
      await markWebhookProcessed(eventId, { notificationType: event.notificationType });
      return { success: true, duplicate: false };
    }

    const { userId, wallet } = resolved;

    const existingTx = await collection("cryptoTransactions")
        .where("circleTransactionId", "==", mapped.circleTransactionId)
        .limit(1)
        .get();

    let reservationId = null;
    if (!existingTx.empty) {
      reservationId = existingTx.docs[0].data().reservationId || null;
    }

    if (!reservationId && mapped.type === "send") {
      const found = await reservationService.findReservation(
          userId,
          mapped.circleTransactionId,
          null,
      );
      reservationId = found?.reservationId || null;
    }

    if (mapped.failed) {
      if (reservationId) {
        await reservationService.releaseReservation(reservationId);
      }
      if (!existingTx.empty) {
        await existingTx.docs[0].ref.update({
          status: "failed",
          txHash: mapped.txHash || null,
          updatedAt: serverTimestamp(),
        });
      }
      await markWebhookProcessed(eventId, { notificationType: event.notificationType });
      return { success: true, duplicate: false };
    }

    if (await ledgerService.hasLedgerEntry(mapped.circleTransactionId)) {
      if (reservationId) {
        await reservationService.confirmReservation(reservationId);
      }
      if (!existingTx.empty) {
        await existingTx.docs[0].ref.update({
          status: "complete",
          txHash: mapped.txHash || null,
          updatedAt: serverTimestamp(),
        });
      }
      await markWebhookProcessed(eventId, { notificationType: event.notificationType });
      return { success: true, duplicate: true };
    }

    const direction = mapped.type === "deposit" ? "credit" : "debit";

    await ledgerService.appendTransaction({
      userId,
      type: mapped.type,
      asset: ASSET,
      amount: mapped.amount,
      direction,
      source: PROVIDER,
      referenceId: mapped.circleTransactionId,
    });

    if (reservationId) {
      await reservationService.confirmReservation(reservationId);
    }

    if (!existingTx.empty) {
      await existingTx.docs[0].ref.update({
        status: "complete",
        txHash: mapped.txHash || null,
        updatedAt: serverTimestamp(),
      });
    } else {
      await collection("cryptoTransactions").add({
        userId,
        circleTransactionId: mapped.circleTransactionId,
        txHash: mapped.txHash || null,
        type: mapped.type,
        amount: mapped.amount,
        asset: ASSET,
        status: "complete",
        toAddress: mapped.destinationAddress || null,
        fromWalletId: wallet.walletId,
        provider: PROVIDER,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    console.log("Circle webhook processed", {
      eventId,
      userId,
      txHash: mapped.txHash,
      type: mapped.type,
      amount: mapped.amount,
    });

    await markWebhookProcessed(eventId, { notificationType: event.notificationType });
    return { success: true, duplicate: false };
  } catch (err) {
    console.error("Circle webhook processing failed", { eventId, error: err.message });
    throw err;
  }
}

module.exports = {
  ASSET,
  PROVIDER,
  normalizeCircleEvent,
  verifyWebhookSignature,
  handleWebhookEvent,
  getBalance,
  createWallet,
  getWallet,
  listTransactions,
  send,
};
