/**
 * @fileoverview Balance reservations — pending send liabilities.
 * Prevents double-spend while Circle transactions are in flight.
 */

const admin = require("../../admin");
const { collection, serverTimestamp } = require("../../libs/firestore");
const ledgerService = require("./ledgerService");

const STATUS_RESERVED = "reserved";
const STATUS_CONFIRMED = "confirmed";
const STATUS_RELEASED = "released";

/**
 * Sum active reservations for a user.
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getReservedTotal(userId) {
  const snap = await collection("pendingReservations")
      .where("userId", "==", userId)
      .where("status", "==", STATUS_RESERVED)
      .get();

  let total = 0;
  for (const doc of snap.docs) {
    total += Number(doc.data().amount) || 0;
  }
  return total;
}

/**
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getAvailableBalance(userId) {
  const ledgerBalance = await ledgerService.getLedgerBalance(userId, "USDC");
  const reserved = await getReservedTotal(userId);
  return Math.max(0, ledgerBalance - reserved);
}

/**
 * Reserve funds before initiating a Circle send.
 * @param {string} userId
 * @param {number} amount
 * @param {string} requestId - Idempotency key / request identifier
 * @returns {Promise<{ reservationId: string, duplicate?: boolean }>}
 */
async function reserveFunds(userId, amount, requestId) {
  const numericAmount = Number(amount);
  if (!userId || !requestId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid reservation parameters");
  }

  const db = admin.firestore();
  const reservationId = `res_${requestId}`;
  const reservationRef = collection("pendingReservations").doc(reservationId);

  const existing = await reservationRef.get();
  if (existing.exists) {
    const data = existing.data();
    if (data.status === STATUS_RESERVED || data.status === STATUS_CONFIRMED) {
      return { reservationId, duplicate: true };
    }
  }

  const aggregateRef = collection("walletAggregates").doc(userId);

  await db.runTransaction(async (tx) => {
    const resDoc = await tx.get(reservationRef);
    if (resDoc.exists) {
      const status = resDoc.data().status;
      if (status === STATUS_RESERVED || status === STATUS_CONFIRMED) {
        return;
      }
    }

    const aggDoc = await tx.get(aggregateRef);
    const ledgerBalance = aggDoc.exists ? Number(aggDoc.data().USDC || 0) : 0;

    const reservedQuery = collection("pendingReservations")
        .where("userId", "==", userId)
        .where("status", "==", STATUS_RESERVED);
    const reservedSnap = await tx.get(reservedQuery);

    let reservedTotal = 0;
    for (const doc of reservedSnap.docs) {
      if (doc.id === reservationId) continue;
      reservedTotal += Number(doc.data().amount) || 0;
    }

    const available = ledgerBalance - reservedTotal;
    if (available < numericAmount) {
      throw new Error(
          `Insufficient USDC balance. Available: ${available}, requested: ${numericAmount}`,
      );
    }

    tx.set(reservationRef, {
      userId,
      amount: numericAmount,
      status: STATUS_RESERVED,
      requestId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  return { reservationId };
}

/**
 * @param {string} reservationId
 * @param {string} [circleTransactionId]
 */
async function attachCircleTransactionId(reservationId, circleTransactionId) {
  await collection("pendingReservations").doc(reservationId).set({
    circleTransactionId,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

/**
 * Mark reservation confirmed after ledger debit (webhook success).
 * @param {string} reservationId
 */
async function confirmReservation(reservationId) {
  const ref = collection("pendingReservations").doc(reservationId);
  const doc = await ref.get();
  if (!doc.exists) return;

  await ref.update({
    status: STATUS_CONFIRMED,
    confirmedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Release a reservation on send failure (no ledger debit).
 * @param {string} reservationId
 */
async function releaseReservation(reservationId) {
  const ref = collection("pendingReservations").doc(reservationId);
  const doc = await ref.get();
  if (!doc.exists) return;

  const status = doc.data().status;
  if (status === STATUS_CONFIRMED) return;

  await ref.update({
    status: STATUS_RELEASED,
    releasedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Find reservation by Circle transaction id or request id.
 * @param {string} userId
 * @param {string} circleTransactionId
 * @param {string} [requestId]
 * @returns {Promise<{ reservationId: string, data: Object }|null>}
 */
async function findReservation(userId, circleTransactionId, requestId) {
  if (circleTransactionId) {
    const snap = await collection("pendingReservations")
        .where("userId", "==", userId)
        .where("circleTransactionId", "==", circleTransactionId)
        .limit(1)
        .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { reservationId: doc.id, data: doc.data() };
    }
  }

  if (requestId) {
    const reservationId = `res_${requestId}`;
    const doc = await collection("pendingReservations").doc(reservationId).get();
    if (doc.exists && doc.data().userId === userId) {
      return { reservationId: doc.id, data: doc.data() };
    }
  }

  return null;
}

module.exports = {
  STATUS_RESERVED,
  STATUS_CONFIRMED,
  STATUS_RELEASED,
  getReservedTotal,
  getAvailableBalance,
  reserveFunds,
  attachCircleTransactionId,
  confirmReservation,
  releaseReservation,
  findReservation,
};
