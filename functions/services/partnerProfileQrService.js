/**
 * @fileoverview Partner profile QR — open-amount pay-to-merchant identity.
 * Distinct from product payment links (`/l/:linkId?partner=`).
 */

const QRCode = require("qrcode");
const partnerService = require("./partnerService");
const {paymentLinkBaseUrl} = require("./paymentLinkService");

const PROFILE_PATH_PREFIX = "/p/";
const PRODUCT_PATH_PREFIX = "/l/";
const CUSTOM_SCHEME_PREFIXES = [
  "truepay://merchant/",
  "truepay://pay/merchant/",
];

const PAYABLE_STATUSES = new Set(["active"]);

/**
 * @param {string} partnerId
 * @returns {string}
 */
function buildProfilePayUrl(partnerId) {
  const id = String(partnerId || "").trim();
  const base = paymentLinkBaseUrl();
  return `${base}${PROFILE_PATH_PREFIX}${encodeURIComponent(id)}`;
}

/**
 * Canonical string encoded in the profile QR (same as pay URL).
 *
 * @param {string} partnerId
 * @returns {string}
 */
function buildQrPayload(partnerId) {
  return buildProfilePayUrl(partnerId);
}

/**
 * @param {string} raw
 * @returns {string|null}
 */
function extractPartnerIdFromProfileUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  try {
    const url = new URL(text);
    const match = url.pathname.match(/\/p\/([^/?#]+)/i);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  } catch (_err) {
    const match = text.match(/\/p\/([^/?#]+)/i);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

/**
 * @param {string} raw
 * @returns {{ linkId: string, partnerId: string|null }|null}
 */
function extractProductLink(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  try {
    const url = new URL(text);
    const match = url.pathname.match(/\/l\/([^/?#]+)/i);
    if (!match) {
      return null;
    }
    const partner = url.searchParams.get("partner");
    return {
      linkId: decodeURIComponent(match[1]),
      partnerId: partner ? String(partner).trim() : null,
    };
  } catch (_err) {
    const match = text.match(/\/l\/([^/?#]+)/i);
    if (!match) {
      return null;
    }
    const partnerMatch = text.match(/[?&]partner=([^&#]+)/i);
    return {
      linkId: decodeURIComponent(match[1]),
      partnerId: partnerMatch ? decodeURIComponent(partnerMatch[1]) : null,
    };
  }
}

/**
 * Classify a scanned QR / typed merchant ID.
 *
 * @param {unknown} raw
 * @returns {{
 *   kind: "profile"|"product"|"unknown",
 *   merchantId: string|null,
 *   partnerId: string|null,
 *   linkId: string|null,
 * }}
 */
function classifyScannedQr(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return {kind: "unknown", merchantId: null, partnerId: null, linkId: null};
  }

  const product = extractProductLink(text);
  if (product) {
    return {
      kind: "product",
      merchantId: product.partnerId,
      partnerId: product.partnerId,
      linkId: product.linkId,
    };
  }

  for (const prefix of CUSTOM_SCHEME_PREFIXES) {
    if (text.toLowerCase().startsWith(prefix)) {
      const id = decodeURIComponent(text.slice(prefix.length).split(/[?#]/)[0]).trim();
      if (id) {
        return {kind: "profile", merchantId: id, partnerId: id, linkId: null};
      }
    }
  }

  const fromUrl = extractPartnerIdFromProfileUrl(text);
  if (fromUrl) {
    return {kind: "profile", merchantId: fromUrl, partnerId: fromUrl, linkId: null};
  }

  if (/^partner_[A-Za-z0-9_]+$/.test(text) || /^[A-Za-z0-9_-]{8,80}$/.test(text)) {
    return {kind: "profile", merchantId: text, partnerId: text, linkId: null};
  }

  return {kind: "unknown", merchantId: null, partnerId: null, linkId: null};
}

/**
 * @param {Object|null} partner
 * @returns {boolean}
 */
function isPartnerPayable(partner) {
  if (!partner) {
    return false;
  }
  const status = String(partner.status || "active").toLowerCase();
  return PAYABLE_STATUSES.has(status);
}

/**
 * Public merchant identity (no secrets).
 *
 * @param {string} partnerId
 * @returns {Promise<Object>}
 */
async function resolvePublicMerchant(partnerId) {
  const id = String(partnerId || "").trim();
  if (!id) {
    const err = new Error("merchantId is required");
    err.statusCode = 400;
    err.httpStatus = 400;
    err.code = "INVALID_RECIPIENT";
    throw err;
  }
  const partner = await partnerService.getPartner(id);
  if (!partner || !isPartnerPayable(partner)) {
    const err = new Error("TruePay merchant not found or not accepting payments");
    err.statusCode = 404;
    err.httpStatus = 404;
    err.code = "RECIPIENT_NOT_FOUND";
    throw err;
  }
  const payUrl = buildProfilePayUrl(partner.id);
  return {
    kind: "profile",
    merchantId: partner.id,
    partnerId: partner.id,
    partnerName: partner.name || null,
    settlementCurrency: partner.settlementCurrency || "KES",
    status: partner.status || "active",
    payUrl,
    qrPayload: payUrl,
  };
}

/**
 * Resolve a scanned QR or typed merchant ID for SafariTap.
 *
 * @param {unknown} raw
 * @returns {Promise<Object>}
 */
async function resolveScannedQr(raw) {
  const classified = classifyScannedQr(raw);
  if (classified.kind === "product") {
    return {
      kind: "product",
      linkId: classified.linkId,
      partnerId: classified.partnerId,
      merchantId: classified.partnerId,
      checkoutUrl: String(raw || "").trim(),
      message: "This is a product payment link, not a merchant profile QR.",
    };
  }
  if (classified.kind !== "profile" || !classified.merchantId) {
    const err = new Error("Unrecognized QR. Scan a TruePay merchant profile QR.");
    err.statusCode = 400;
    err.httpStatus = 400;
    err.code = "INVALID_RECIPIENT";
    throw err;
  }
  return resolvePublicMerchant(classified.merchantId);
}

/**
 * Dashboard payload: merchant ID + PNG QR that SafariTap can pay.
 *
 * @param {string} partnerId
 * @returns {Promise<Object>}
 */
async function getProfileQr(partnerId) {
  const id = String(partnerId || "").trim();
  if (!id) {
    const err = new Error("partnerId is required");
    err.statusCode = 400;
    throw err;
  }
  const partner = await partnerService.getPartner(id);
  if (!partner) {
    const err = new Error("Partner not found");
    err.statusCode = 404;
    throw err;
  }
  const payUrl = buildProfilePayUrl(partner.id);
  const qrCode = await QRCode.toDataURL(payUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
  return {
    merchantId: partner.id,
    partnerId: partner.id,
    partnerName: partner.name || null,
    status: partner.status || "active",
    acceptingPayments: isPartnerPayable(partner),
    settlementCurrency: partner.settlementCurrency || "KES",
    payUrl,
    qrPayload: payUrl,
    qrCode,
    kind: "profile",
    instructions:
      "Display this QR for SafariTap Pay. It identifies the merchant only — " +
      "the payer enters the amount. Product payment-link QRs stay on Payment Links.",
  };
}

/**
 * Simple fallback page when a generic camera opens the profile URL.
 *
 * @param {Object} merchant
 * @returns {string}
 */
function renderProfileQrLandingHtml(merchant) {
  const name = merchant.partnerName || "TruePay merchant";
  const merchantId = merchant.merchantId || "";
  const safeName = String(name).replace(/[<>&"]/g, (ch) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
  }[ch]));
  const safeId = String(merchantId).replace(/[<>&"]/g, (ch) => ({
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
  <title>Pay ${safeName}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f1419; color: #e8eef4;
      display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
    .card { background: #1a222c; border-radius: 16px; padding: 28px 24px; max-width: 360px;
      text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #9aa8b5; line-height: 1.45; }
    code { display: block; margin-top: 16px; padding: 10px; background: #0f1419;
      border-radius: 8px; word-break: break-all; font-size: .85rem; color: #5eead4; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Pay ${safeName}</h1>
    <p>Open this QR in the SafariTap app and enter an amount. This is a merchant profile, not a product payment link.</p>
    <code>${safeId}</code>
  </div>
</body>
</html>`;
}

module.exports = {
  PROFILE_PATH_PREFIX,
  PRODUCT_PATH_PREFIX,
  buildProfilePayUrl,
  buildQrPayload,
  classifyScannedQr,
  isPartnerPayable,
  resolvePublicMerchant,
  resolveScannedQr,
  getProfileQr,
  renderProfileQrLandingHtml,
};
