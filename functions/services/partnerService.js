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
 * @param {string} [params.status='active'] - e.g. active | pending_review (self-serve before go-live)
 * @param {string} [params.onboardingSource] - optional audit: "self" | "platform"
 * @returns {Promise<{ partnerId: string, apiKey: string, partner: Object }>}
 */
async function createPartner({
  name,
  settlementCurrency = "KES",
  webhookUrl = null,
  apiKey = null,
  status = "active",
  onboardingSource = null,
}) {
  const col = collection("partners");
  const partnerId = `partner_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const key = apiKey || generateApiKey();
  const data = {
    name: String(name),
    apiKey: key,
    settlementAccount: null, // Can be set later (bank details)
    settlementCurrency: String(settlementCurrency),
    webhookUrl: webhookUrl || null,
    status: String(status),
    /** @type {string|null} Firebase Auth UID of the partner org admin (set by platform admin) */
    orgAdminUid: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (onboardingSource) {
    data.onboardingSource = String(onboardingSource);
  }
  await col.doc(partnerId).set(data);
  return {
    partnerId,
    apiKey: key,
    partner: { id: partnerId, ...data },
  };
}

/**
 * @param {FirebaseFirestore.DocumentSnapshot} doc
 * @param {{ includeApiKey?: boolean }} [options]
 * @returns {Object}
 */
function serializePartnerDoc(doc, options = {}) {
  const includeApiKey = options.includeApiKey === true;
  const d = doc.data() || {};
  const { apiKey, ...safe } = d;
  /** @type {Record<string, unknown>} */
  const out = {
    id: doc.id,
    ...safe,
    orgAdminUid: d.orgAdminUid ?? null,
    apiKeyMasked: apiKey ? `${String(apiKey).slice(0, 8)}...` : null,
  };
  if (includeApiKey && apiKey) {
    out.apiKey = String(apiKey);
  }
  return out;
}

/**
 * Get partner by ID
 *
 * @param {string} partnerId
 * @param {{ includeApiKey?: boolean }} [options] - platform admin routes may set includeApiKey: true
 * @returns {Promise<Object|null>}
 */
async function getPartner(partnerId, options = {}) {
  const doc = await collection("partners").doc(partnerId).get();
  if (!doc.exists) return null;
  return serializePartnerDoc(doc, options);
}

/**
 * Full API key for platform admin (partner integration secret).
 *
 * @param {string} partnerId
 * @returns {Promise<{ partnerId: string, apiKey: string, apiKeyMasked: string }|null>}
 */
async function getPartnerApiKey(partnerId) {
  const doc = await collection("partners").doc(partnerId).get();
  if (!doc.exists) return null;
  const apiKey = doc.data()?.apiKey;
  if (!apiKey || typeof apiKey !== "string") {
    return null;
  }
  return {
    partnerId: doc.id,
    apiKey: String(apiKey),
    apiKeyMasked: `${String(apiKey).slice(0, 8)}...`,
  };
}

/**
 * Rotate a partner API key (invalidates the previous key immediately).
 *
 * @param {string} partnerId
 * @param {string} actorUid - Platform admin uid (audit)
 * @returns {Promise<{ partnerId: string, apiKey: string, apiKeyMasked: string, previousApiKeyMasked: string|null }>}
 */
async function rotatePartnerApiKey(partnerId, actorUid) {
  const ref = collection("partners").doc(partnerId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new Error("Partner not found");
  }
  const previousKey = doc.data()?.apiKey || null;
  const newKey = generateApiKey();
  await ref.update({
    apiKey: newKey,
    apiKeyRotatedAt: serverTimestamp(),
    apiKeyRotatedBy: actorUid,
    updatedAt: serverTimestamp(),
  });
  return {
    partnerId,
    apiKey: newKey,
    apiKeyMasked: `${newKey.slice(0, 8)}...`,
    previousApiKeyMasked: previousKey ? `${String(previousKey).slice(0, 8)}...` : null,
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
  const partners = snapshot.docs.map((doc) => serializePartnerDoc(doc));
  const lastDoc = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1] : null;
  return { partners, lastDoc };
}

module.exports = {
  generateApiKey,
  createPartner,
  getPartner,
  getPartnerApiKey,
  rotatePartnerApiKey,
  serializePartnerDoc,
  getPartnerByApiKey,
  updatePartner,
  listPartners,
};
