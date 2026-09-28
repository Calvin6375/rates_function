/**
 * @fileoverview SafariTap user profile QR — scan to send to another SafariTap wallet.
 * The payload encodes the customer id (Firebase uid) already accepted as
 * recipient.userId on POST /safari-card/payouts type SAFARITAP_WALLET.
 */

const QRCode = require("qrcode");
const admin = require("../admin");
const config = require("../config");
const {paymentLinkBaseUrl} = require("./paymentLinkService");

const USER_PATH_PREFIX = "/u/";
const CUSTOM_SCHEME_PREFIXES = [
  "truepay://user/",
  "truepay://pay/user/",
];

/**
 * @param {string} userId
 * @returns {string}
 */
function buildProfilePayUrl(userId) {
  const id = String(userId || "").trim();
  const base = paymentLinkBaseUrl();
  return `${base}${USER_PATH_PREFIX}${encodeURIComponent(id)}`;
}

/**
 * Canonical string encoded in the QR. Scanner extracts the customer id from it.
 *
 * @param {string} userId
 * @returns {string}
 */
function buildQrPayload(userId) {
  return buildProfilePayUrl(userId);
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function extractUserId(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }

  const lower = text.toLowerCase();
  for (const prefix of CUSTOM_SCHEME_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const id = decodeURIComponent(text.slice(prefix.length).split(/[?#]/)[0]).trim();
      return id || null;
    }
  }

  const fromPath = (pathname) => {
    const match = String(pathname || "").match(/\/u\/([^/?#]+)/i);
    if (!match) {
      return null;
    }
    const id = decodeURIComponent(match[1]).trim();
    return id || null;
  };

  try {
    const url = new URL(text);
    return fromPath(url.pathname);
  } catch (_err) {
    return fromPath(text);
  }
}

/**
 * @param {Object|null|undefined} data
 * @returns {string|null}
 */
function displayNameFromUser(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const combined = [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
  const name = data.name || data.displayName || combined || null;
  return name ? String(name) : null;
}

/**
 * @param {string} userId
 * @returns {Promise<{ customerId: string, displayName: string|null }>}
 */
async function loadCustomer(userId) {
  const id = String(userId || "").trim();
  if (!id) {
    const err = new Error("customerId is required");
    err.statusCode = 400;
    err.httpStatus = 400;
    err.code = "INVALID_RECIPIENT";
    throw err;
  }
  const snap = await admin.firestore().collection(config.collections.users).doc(id).get();
  if (!snap.exists) {
    const err = new Error("SafariTap user not found");
    err.statusCode = 404;
    err.httpStatus = 404;
    err.code = "RECIPIENT_NOT_FOUND";
    throw err;
  }
  const data = snap.data() || {};
  return {
    customerId: snap.id,
    displayName: displayNameFromUser(data),
    phoneNumber: data.phoneNumber || data.phone || null,
  };
}

/**
 * Validate a scanned SafariTap QR or customer id and return the profile name.
 * The app should show fullName in the name field and keep that field read-only.
 *
 * @param {unknown} raw customerId, userId, or QR payload
 * @param {string} [actorUserId] signed-in sender, used only to flag a self scan
 * @returns {Promise<Object>}
 */
async function validateCustomer(raw, actorUserId) {
  const text = String(raw || "").trim();
  const fromQr = extractUserId(text);
  const customerId = fromQr || (text && !text.includes("://") && !text.includes("/") ? text : "");
  if (!customerId) {
    const err = new Error("Scan a SafariTap profile QR or pass a customerId");
    err.statusCode = 400;
    err.httpStatus = 400;
    err.code = "INVALID_RECIPIENT";
    throw err;
  }
  const customer = await loadCustomer(customerId);
  const fullName = customer.displayName;
  return {
    valid: true,
    customerId: customer.customerId,
    userId: customer.customerId,
    fullName,
    beneficiaryName: fullName,
    nameEditable: false,
    phoneNumber: customer.phoneNumber,
    self: actorUserId ? customer.customerId === String(actorUserId) : false,
    kind: "safaritap_user",
  };
}

/**
 * QR for the signed-in SafariTap user. Others scan it and send recipient.userId.
 *
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getProfileQr(userId) {
  const customer = await loadCustomer(userId);
  const payUrl = buildProfilePayUrl(customer.customerId);
  const qrCode = await QRCode.toDataURL(payUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
  return {
    customerId: customer.customerId,
    userId: customer.customerId,
    displayName: customer.displayName,
    payUrl,
    qrPayload: payUrl,
    qrCode,
    kind: "safaritap_user",
    instructions:
      "Show this QR so another SafariTap user can scan it. " +
      "The scan decodes to customerId. Send that as recipient.userId on " +
      "POST /safari-card/payouts with type SAFARITAP_WALLET.",
  };
}

/**
 * @param {Object} customer
 * @returns {string}
 */
function renderProfileQrLandingHtml(customer) {
  const name = customer.displayName || "SafariTap user";
  const customerId = customer.customerId || "";
  const esc = (value) => String(value).replace(/[<>&"]/g, (ch) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
  }[ch]));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Pay ${esc(name)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f3fbf8; color: #10231c;
      display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
    .card { background: #fff; border-radius: 16px; padding: 28px 24px; max-width: 360px;
      text-align: center; box-shadow: 0 12px 40px rgba(16,35,28,.08); }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #5c7268; line-height: 1.45; }
    code { display: block; margin-top: 16px; padding: 10px; background: #f3fbf8;
      border-radius: 8px; word-break: break-all; font-size: .85rem; color: #0f766e; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Pay ${esc(name)}</h1>
    <p>Open this QR in the SafariTap app and enter an amount. The app sends the customer id below.</p>
    <code>${esc(customerId)}</code>
  </div>
</body>
</html>`;
}

module.exports = {
  USER_PATH_PREFIX,
  buildProfilePayUrl,
  buildQrPayload,
  extractUserId,
  displayNameFromUser,
  loadCustomer,
  getProfileQr,
  validateCustomer,
  renderProfileQrLandingHtml,
};
