/**
 * One-off SMTP / verification-link smoke test.
 *
 * Usage (from functions/):
 *   SMTP_USER="$(firebase functions:secrets:access SMTP_USER)" \
 *   SMTP_PASS="$(firebase functions:secrets:access SMTP_PASS)" \
 *   node scripts/test-zoho-smtp.js [toEmail]
 *
 * Default recipient: calvinrumba27@gmail.com
 *
 * Steps:
 *   1) Plain SMTP test email
 *   2) If Auth user exists for that email, generate verification link
 *   3) Send branded HTML email with that link
 */

const nodemailer = require("nodemailer");
const admin = require("../admin");
const config = require("../config");
const emailService = require("../services/emailService");

const toEmail = (process.argv[2] || "calvinrumba27@gmail.com").trim().toLowerCase();
const continueUrl = process.env.CONTINUE_URL || "https://truepay.live";

async function main() {
  const user = process.env.SMTP_USER || config.smtp?.user;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    console.error("Set SMTP_USER and SMTP_PASS (e.g. via firebase functions:secrets:access).");
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: config.smtp?.host || "smtp.zoho.com",
    port: Number(config.smtp?.port || 465),
    secure: true,
    auth: {user, pass},
  });

  console.log("--- Test 1: plain SMTP ---");
  console.log(`From: ${user}`);
  console.log(`To:   ${toEmail}`);
  const info1 = await transporter.sendMail({
    from: `"TruePay" <${user}>`,
    to: toEmail,
    subject: "SMTP Test",
    text: "If you received this, Zoho SMTP is working.",
  });
  console.log("Sent.", {messageId: info1.messageId, response: info1.response});

  console.log("\n--- Test 2: generateEmailVerificationLink ---");
  let authUser = null;
  try {
    authUser = await admin.auth().getUserByEmail(toEmail);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      console.log(`No Firebase Auth user for ${toEmail}. Skipping link generation.`);
      console.log("Create/sign up that user first, then re-run for Tests 2–3.");
      return;
    }
    throw err;
  }

  console.log("Auth user:", {
    uid: authUser.uid,
    email: authUser.email,
    emailVerified: authUser.emailVerified,
  });

  if (authUser.emailVerified) {
    console.log("Email already verified — generating a link would still work, but skip branded send.");
  }

  const link = await admin.auth().generateEmailVerificationLink(toEmail, {
    url: continueUrl,
    handleCodeInApp: false,
  });
  console.log("Verification link generated (do not share publicly):");
  console.log(link);

  console.log("\n--- Test 3: branded email with link ---");
  if (authUser.emailVerified) {
    console.log("Skipping send — user is already verified. Use an unverified account to click-test.");
    return;
  }

  // Use the same transporter credentials already validated in Test 1
  process.env.SMTP_USER = user;
  process.env.SMTP_PASS = pass;
  const result = await emailService.sendEmailVerificationForUid(authUser.uid, {
    continueUrl,
  });
  console.log("Branded verification email sent:", result);
}

main().catch((err) => {
  console.error("FAILED:", err.message || err);
  process.exit(1);
});
