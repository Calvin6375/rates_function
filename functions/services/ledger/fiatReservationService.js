/**
 * @fileoverview Fiat balance reservations for merchant settlement holds.
 */

const admin = require("../../admin");
const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const fiatLedgerService = require("./fiatLedgerService");

const COL = config.collections.pendingFiatReservations;
const TTL_MINUTES = config.fiatOps.reservationTtlMinutes || 30;

const STATUS_RESERVED = "reserved";
const STATUS_CONFIRMED = "confirmed";
const STATUS_RELEASED = "released";

/**
 * @param {string} userId
 * @param {string} [asset="USD"]
 * @returns {Promise<number>}
 */
async function getReservedTotal(userId, asset = "USD") {
  const snap = await collection(COL)
      .where("userId", "==", userId)
      .where("asset", "==", asset)
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
 * @param {string} [asset="USD"]
 * @returns {Promise<number>}
 */
async function getAvailableBalance(userId, asset = "USD") {
  const ledgerBalance = await fiatLedgerService.getLedgerBalance(userId, asset);
  const reserved = await getReservedTotal(userId, asset);
  return Math.max(0, ledgerBalance - reserved);
}

/**
 * @param {Object} params
 * @returns {Promise<{ reservationId: string, duplicate?: boolean }>}
 */
async function reserveFunds(params) {
  const {
    userId,
    amount,
    asset = "USD",
    requestId,
    purpose = "merchant_settlement",
    merchantPaymentId = null,
  } = params;

  const numericAmount = Number(amount);
  if (!userId || !requestId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid fiat reservation parameters");
  }

  const db = admin.firestore();
  const reservationId = `fres_${requestId}`;
  const reservationRef = collection(COL).doc(reservationId);
  const aggregateRef = collection(config.collections.walletAggregatesFiat).doc(userId);

  const existing = await reservationRef.get();
  if (existing.exists) {
    const data = existing.data();
    if (data.status === STATUS_RESERVED || data.status === STATUS_CONFIRMED) {
      return { reservationId, duplicate: true };
    }
  }

  await db.runTransaction(async (tx) => {
    const resDoc = await tx.get(reservationRef);
    if (resDoc.exists) {
      const status = resDoc.data().status;
      if (status === STATUS_RESERVED || status === STATUS_CONFIRMED) {
        return;
      }
    }

    const aggDoc = await tx.get(aggregateRef);
    const ledgerBalance = aggDoc.exists ? Number(aggDoc.data()[asset] || 0) : 0;

    const reservedQuery = collection(COL)
        .where("userId", "==", userId)
        .where("asset", "==", asset)
        .where("status", "==", STATUS_RESERVED);
    const reservedSnap = await tx.get(reservedQuery);

    let reservedTotal = 0;
    for (const doc of reservedSnap.docs) {
      if (doc.id === reservationId) continue;
      reservedTotal += Number(doc.data().amount) || 0;
    }

    const available = ledgerBalance - reservedTotal;
    if (available < numericAmount) {
      throw new Error(`Insufficient ${asset} balance for reservation`);
    }

    tx.set(reservationRef, {
      id: reservationId,
      userId,
      asset,
      amount: numericAmount,
      status: STATUS_RESERVED,
      purpose,
      merchantPaymentId,
      requestId,
      expiresAt: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + TTL_MINUTES * 60 * 1000),
      ),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  return { reservationId };
}

/**
 * @param {string} requestId
 * @returns {Promise<void>}
 */
async function confirmReservation(requestId) {
  const reservationId = `fres_${requestId}`;
  await collection(COL).doc(reservationId).update({
    status: STATUS_CONFIRMED,
    updatedAt: serverTimestamp(),
  });
}

/**
 * @param {string} requestId
 * @returns {Promise<void>}
 */
async function releaseReservation(requestId) {
  const reservationId = `fres_${requestId}`;
  await collection(COL).doc(reservationId).update({
    status: STATUS_RELEASED,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Release reservations past their TTL.
 * @returns {Promise<{ released: number }>}
 */
async function releaseExpiredReservations() {
  const now = admin.firestore.Timestamp.now();
  const snap = await collection(COL)
      .where("status", "==", STATUS_RESERVED)
      .where("expiresAt", "<=", now)
      .limit(100)
      .get();

  let released = 0;
  for (const doc of snap.docs) {
    await doc.ref.update({
      status: STATUS_RELEASED,
      releaseReason: "expired",
      updatedAt: serverTimestamp(),
    });
    released++;
  }

  return { released };
}

module.exports = {
  STATUS_RESERVED,
  STATUS_CONFIRMED,
  STATUS_RELEASED,
  getReservedTotal,
  getAvailableBalance,
  reserveFunds,
  confirmReservation,
  releaseReservation,
  releaseExpiredReservations,
};
