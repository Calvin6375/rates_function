/**
 * @fileoverview Zoho SMTP mailer (Nodemailer) for Auth emails and transactional mail.
 * Credentials: Firebase Secret Manager SMTP_USER / SMTP_PASS (bound on the calling function).
 *
 * Verification links are rewritten to `b2bPortal/public/verify-email`, which applies the
 * oobCode server-side and 302-redirects the browser to the B2B dashboard.
 */

const nodemailer = require("nodemailer");
const axios = require("axios");
const admin = require("../admin");
const config = require("../config");

/** @type {import("nodemailer").Transporter|null} */
let cachedTransporter = null;

const ALLOWED_CONTINUE_HOSTS = new Set([
  "truepay.live",
  "www.truepay.live",
  "app.truepay.live",
  "theadmin.truepay.live",
  "partner.truepay.africa",
  "admin.truepay.africa",
  "truepay-72060.web.app",
  "truepay-72060.firebaseapp.com",
  "localhost",
  "127.0.0.1",
]);

/**
 * @return {string}
 */
function defaultContinueUrl() {
  const raw = config.b2bDashboardUrl || "https://theadmin.truepay.live";
  try {
    const u = new URL(raw);
    // Land on dashboard root (no trailing path required).
    if (!u.pathname || u.pathname === "/") {
      u.pathname = "/";
    }
    return u.toString();
  } catch (_e) {
    return "https://theadmin.truepay.live/";
  }
}

/**
 * @param {string} [raw]
 * @return {string}
 */
function resolveContinueUrl(raw) {
  const candidate =
    typeof raw === "string" && raw.trim() ? raw.trim() : defaultContinueUrl();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_e) {
    throw new Error("Invalid continueUrl");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("continueUrl must be http(s)");
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_CONTINUE_HOSTS.has(host)) {
    throw new Error("continueUrl host is not allowed");
  }
  if (host === "localhost" || host === "127.0.0.1") {
    if (parsed.protocol !== "http:") {
      throw new Error("localhost continueUrl must use http");
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error("continueUrl must use https");
  }
  return parsed.toString();
}

/**
 * Public handler that applies oobCode then redirects to the dashboard.
 * @return {string}
 */
function getVerificationHandlerBaseUrl() {
  if (config.emailVerificationHandlerBaseUrl) {
    return String(config.emailVerificationHandlerBaseUrl).replace(/\/$/, "");
  }
  const projectId = process.env.GCLOUD_PROJECT || "truepay-72060";
  const region = config.region || "us-central1";
  return `https://${region}-${projectId}.cloudfunctions.net/b2bPortal`;
}

/**
 * Rewrite Firebase's __/auth/action link to our public verify handler so the
 * click applies the code and immediately redirects to the B2B dashboard.
 *
 * @param {string} firebaseLink
 * @param {string} continueUrl
 * @return {string}
 */
function toDashboardVerificationLink(firebaseLink, continueUrl) {
  const parsed = new URL(firebaseLink);
  const oobCode = parsed.searchParams.get("oobCode");
  const mode = parsed.searchParams.get("mode") || "verifyEmail";
  const apiKey = parsed.searchParams.get("apiKey");
  if (!oobCode) {
    throw new Error("Generated verification link missing oobCode");
  }
  const handler = new URL(
      `${getVerificationHandlerBaseUrl()}${config.emailVerificationHandlerPath || "/public/verify-email"}`,
  );
  handler.searchParams.set("mode", mode);
  handler.searchParams.set("oobCode", oobCode);
  handler.searchParams.set("continueUrl", continueUrl);
  if (apiKey) {
    handler.searchParams.set("apiKey", apiKey);
  }
  return handler.toString();
}

/**
 * Apply an email-verification oobCode via Identity Toolkit, then the caller redirects.
 *
 * @param {string} oobCode
 * @param {string} [apiKey] Web API key from the generated link (preferred) or env
 * @return {Promise<{ email?: string, emailVerified?: boolean }>}
 */
async function applyEmailVerificationOobCode(oobCode, apiKey) {
  if (!oobCode || typeof oobCode !== "string") {
    throw new Error("oobCode is required");
  }
  const webApiKey =
    (typeof apiKey === "string" && apiKey.trim()) ||
    config.firebaseWebApiKey ||
    "";
  if (!webApiKey) {
    throw new Error("FIREBASE_WEB_API_KEY is not configured");
  }
  const url =
    "https://identitytoolkit.googleapis.com/v1/accounts:update" +
    `?key=${encodeURIComponent(webApiKey)}`;
  const {data} = await axios.post(
      url,
      {oobCode: oobCode.trim()},
      {
        timeout: 15000,
        headers: {"Content-Type": "application/json"},
        validateStatus: () => true,
      },
  );
  if (data && data.error) {
    const msg =
      (data.error.message && String(data.error.message)) || "INVALID_OOB_CODE";
    const err = new Error(msg);
    err.code = msg;
    throw err;
  }
  return {
    email: data && data.email ? String(data.email) : undefined,
    emailVerified: data && data.emailVerified === true,
  };
}

/**
 * Append query params to a URL (for post-verify dashboard landing hints).
 *
 * @param {string} baseUrl
 * @param {Record<string, string>} params
 * @return {string}
 */
function withQueryParams(baseUrl, params) {
  const u = new URL(baseUrl);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== "") {
      u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

/**
 * @return {import("nodemailer").Transporter}
 */
function getTransporter() {
  if (cachedTransporter) {
    return cachedTransporter;
  }
  const user = process.env.SMTP_USER || config.smtp?.user || "";
  const pass = process.env.SMTP_PASS || "";
  if (!user || !pass) {
    throw new Error(
        "SMTP is not configured (set secrets SMTP_USER and SMTP_PASS)",
    );
  }
  const host = config.smtp?.host || "smtp.zoho.com";
  const port = Number(config.smtp?.port || 465);
  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {user, pass},
  });
  return cachedTransporter;
}

/**
 * @param {{ verifyUrl: string, recipientEmail: string, displayName?: string|null }} opts
 * @return {{ subject: string, text: string, html: string }}
 */
function buildVerificationEmail(opts) {
  const name =
    opts.displayName && String(opts.displayName).trim() ?
      String(opts.displayName).trim() :
      "there";
  const verifyUrl = opts.verifyUrl;
  const subject = "Verify your TruePay email";
  const text =
    `Hi ${name},\n\n` +
    "Welcome to TruePay. Please verify your email by opening this link:\n\n" +
    `${verifyUrl}\n\n` +
    "After you verify, you will be taken to your TruePay dashboard.\n\n" +
    "If you did not create a TruePay account, you can ignore this message.\n\n" +
    "— TruePay\n";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 8px;font-size:22px;font-weight:700;letter-spacing:0.02em;color:#22A3B2;">
              TruePay
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 0;font-size:20px;font-weight:600;color:#0f172a;">
              Verify your email
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;font-size:15px;line-height:1.55;color:#475569;">
              Hi ${escapeHtml(name)},
              <br /><br />
              Confirm <strong style="color:#0f172a;">${escapeHtml(opts.recipientEmail)}</strong>
              to finish setting up your TruePay account. After you verify, you will be
              taken to your dashboard automatically.
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 28px;" align="center">
              <a href="${escapeHtml(verifyUrl)}"
                 style="display:inline-block;background:#22A3B2;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px;">
                Verify email
              </a>
              <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#64748b;word-break:break-all;">
                Or paste this link into your browser:<br />
                <a href="${escapeHtml(verifyUrl)}" style="color:#22A3B2;">${escapeHtml(verifyUrl)}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-size:12px;line-height:1.5;color:#94a3b8;border-top:1px solid #e2e8f0;">
              <br />
              If you did not sign up for TruePay, you can ignore this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return {subject, text, html};
}

/**
 * @param {string} value
 * @return {string}
 */
function escapeHtml(value) {
  return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * Generate a Firebase email-verification link and send it via Zoho SMTP.
 * The link points at our public handler which verifies then redirects to the dashboard.
 *
 * @param {string} uid Firebase Auth uid
 * @param {{ continueUrl?: string, canHandleCodeInApp?: boolean }} [opts]
 * @return {Promise<{ alreadyVerified: boolean, email: string, continueUrl?: string }>}
 */
async function sendEmailVerificationForUid(uid, opts = {}) {
  if (!uid || typeof uid !== "string") {
    throw new Error("uid is required");
  }
  const user = await admin.auth().getUser(uid);
  const email = user.email;
  if (!email) {
    throw new Error("User has no email address");
  }
  if (user.emailVerified) {
    return {alreadyVerified: true, email};
  }

  const continueUrl = resolveContinueUrl(opts.continueUrl);
  const actionCodeSettings = {
    url: continueUrl,
    handleCodeInApp: opts.canHandleCodeInApp === true,
  };
  const firebaseLink = await admin.auth().generateEmailVerificationLink(
      email,
      actionCodeSettings,
  );
  const verifyUrl = toDashboardVerificationLink(firebaseLink, continueUrl);

  const fromAddress =
    process.env.SMTP_USER || config.smtp?.user || "noreply@truepay.live";
  const fromName = config.smtp?.fromName || "TruePay";
  const content = buildVerificationEmail({
    verifyUrl,
    recipientEmail: email,
    displayName: user.displayName || null,
  });

  const transporter = getTransporter();
  await transporter.sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to: email,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });

  return {alreadyVerified: false, email, continueUrl};
}

module.exports = {
  sendEmailVerificationForUid,
  resolveContinueUrl,
  defaultContinueUrl,
  buildVerificationEmail,
  applyEmailVerificationOobCode,
  toDashboardVerificationLink,
  withQueryParams,
  ALLOWED_CONTINUE_HOSTS,
};
