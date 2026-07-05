/**
 * @fileoverview Tourist merchant directory — external M-Pesa Tills, PayBills, bank accounts.
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");

const COL = config.collections.merchantDirectory;

/**
 * @param {string} merchantId
 * @returns {Promise<Object|null>}
 */
async function getMerchant(merchantId) {
  const doc = await collection(COL).doc(String(merchantId)).get();
  if (!doc.exists) return null;
  return serializeMerchant(doc.id, doc.data());
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createMerchant(params) {
  const {
    name,
    destinationType,
    tillNumber = null,
    paybill = null,
    account = null,
    metadata = {},
  } = params;

  if (!name || !destinationType) {
    throw new Error("Merchant name and destinationType are required");
  }

  const id = `mer_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const data = {
    id,
    name: String(name),
    destinationType: String(destinationType),
    tillNumber,
    paybill,
    account,
    status: "active",
    metadata: typeof metadata === "object" ? metadata : {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await collection(COL).doc(id).set(data);
  return serializeMerchant(id, data);
}

/**
 * @param {string} id
 * @param {Object} data
 * @returns {Object}
 */
function serializeMerchant(id, data) {
  return {
    id,
    name: data.name,
    destinationType: data.destinationType,
    tillNumber: data.tillNumber || null,
    paybill: data.paybill || null,
    account: data.account || null,
    status: data.status || "active",
    metadata: data.metadata || {},
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

/**
 * @param {Object} merchant
 * @returns {{ type: string, tillNumber?: string, paybill?: string, account?: string }}
 */
function merchantDestination(merchant) {
  const type = String(merchant.destinationType || "").toLowerCase();
  if (type === "till") {
    return { type: "till", tillNumber: merchant.tillNumber };
  }
  if (type === "paybill") {
    return { type: "paybill", paybill: merchant.paybill, account: merchant.account };
  }
  return { type: "bank", account: merchant.account };
}

module.exports = {
  getMerchant,
  createMerchant,
  merchantDestination,
  serializeMerchant,
};
