/**
 * @fileoverview Partner service (B2B): CRUD for business partners (hotels, safari lodges, fintechs).
 * Partners authenticate via X-API-KEY. Schema: partners/{partnerId}.
 */

const crypto = require("crypto");
const { collection, serverTimestamp } = require("../libs/firestore");

/**
 * Generate a secure API key for a partner
 * @returns {string} Hex-encoded API key
 */
function generateApiKey() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a new partner
 *
 * @param {Object} params
 * @param {string} params.name - Partner display name
 * @param {string} [params.settlementCurrency='KES']
 * @param {string} [params.webhookUrl]
 * @param {string} [params.apiKey] - If not provided, one is generated
 * @returns {Promise<{ partnerId: string, apiKey: string, partner: Object }>}
 */
async function createPartner({ name, settlementCurrency = "KES", webhookUrl = null, apiKey = null }) {
  const col = collection("partners");
  const partnerId = `partner_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const key = apiKey || generateApiKey();
  const data = {
    name: String(name),
    apiKey: key,
    settlementAccount: null, // Can be set later (bank details)
    settlementCurrency: String(settlementCurrency),
    webhookUrl: webhookUrl || null,
    status: "active",
    /** @type {string|null} Firebase Auth UID of the partner org admin (set by platform admin) */
    orgAdminUid: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await col.doc(partnerId).set(data);
  return {
    partnerId,
    apiKey: key,
    partner: { id: partnerId, ...data },
  };
}

/**
 * Get partner by ID
 *
 * @param {string} partnerId
 * @returns {Promise<Object|null>} Partner document (without apiKey in response for security; include only in create/regenerate)
 */
async function getPartner(partnerId) {
  const doc = await collection("partners").doc(partnerId).get();
  if (!doc.exists) return null;
  const d = doc.data();
  const { apiKey, ...safe } = d;
  return {
    id: doc.id,
    ...safe,
    orgAdminUid: d.orgAdminUid ?? null,
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 8)}...` : null,
  };
}

/**
 * Get partner by API key (for auth)
 *
 * @param {string} apiKey
 * @returns {Promise<Object|null>} Full partner doc including id
 */
async function getPartnerByApiKey(apiKey) {
  const snapshot = await collection("partners").where("apiKey", "==", apiKey).limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

/**
 * Update partner
 *
 * @param {string} partnerId
 * @param {Object} updates - name, settlementCurrency, webhookUrl, status, settlementAccount
 * @returns {Promise<Object>}
 */
async function updatePartner(partnerId, updates) {
  const ref = collection("partners").doc(partnerId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Partner not found");
  const allowed = ["name", "settlementCurrency", "webhookUrl", "status", "settlementAccount"];
  const data = { updatedAt: serverTimestamp() };
  for (const k of allowed) {
    if (updates[k] !== undefined) data[k] = updates[k];
  }
  await ref.update(data);
  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

/**
 * List partners (admin)
 *
 * @param {number} [limit=50]
 * @param {admin.firestore.DocumentSnapshot} [startAfter]
 * @returns {Promise<{ partners: Array<Object>, lastDoc: any }>}
 */
async function listPartners(limit = 50, startAfter = null) {
  let query = collection("partners").orderBy("createdAt", "desc").limit(limit);
  if (startAfter) query = query.startAfter(startAfter);
  const snapshot = await query.get();
  const partners = snapshot.docs.map((doc) => {
    const d = doc.data();
    const { apiKey, ...safe } = d;
    return { id: doc.id, ...safe, apiKeyMasked: apiKey ? `${apiKey.slice(0, 8)}...` : null };
  });
  const lastDoc = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1] : null;
  return { partners, lastDoc };
}

module.exports = {
  generateApiKey,
  createPartner,
  getPartner,
  getPartnerByApiKey,
  updatePartner,
  listPartners,
};
