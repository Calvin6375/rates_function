/**
 * Temporary SMTP / verification smoke endpoint (remove after QA).
 *
 * POST /
 * Header: X-Smoke-Token: <SMTP_SMOKE_TOKEN secret>
 * Body JSON:
 *   { "to": "calvinrumba27@gmail.com", "mode": "plain"|"verify"|"both", "continueUrl"?: string }
 *
 * Deploy:
 *   firebase deploy --only functions:smtpSmokeTest
 */

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const nodemailer = require("nodemailer");
const admin = require("../admin");
const config = require("../config");
const emailService = require("../services/emailService");

const smtpUser = defineSecret(config.secrets.smtpUser);
const smtpPass = defineSecret(config.secrets.smtpPass);
const smokeToken = defineSecret("SMTP_SMOKE_TOKEN");

const ALLOWED_TO = new Set([
  "calvinrumba27@gmail.com",
  "calvinrumba27+truepay-smtp@gmail.com",
]);

exports.smtpSmokeTest = onRequest(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      secrets: [smtpUser, smtpPass, smokeToken],
    },
    async (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Headers", "Content-Type, X-Smoke-Token");
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({success: false, error: "POST only"});
        return;
      }

      const provided = String(req.get("X-Smoke-Token") || "");
      const expected = String(process.env.SMTP_SMOKE_TOKEN || "");
      if (!expected || provided !== expected) {
        res.status(401).json({success: false, error: "Unauthorized"});
        return;
      }

      const body = req.body || {};
      const to = String(body.to || "").trim().toLowerCase();
      const mode = String(body.mode || "both").toLowerCase();
      const continueUrl = body.continueUrl || "https://truepay.live";

      if (!ALLOWED_TO.has(to)) {
        res.status(400).json({
          success: false,
          error: `to must be one of: ${[...ALLOWED_TO].join(", ")}`,
        });
        return;
      }

      /** @type {Record<string, unknown>} */
      const out = {to, mode};

      try {
        if (mode === "plain" || mode === "both") {
          const transporter = nodemailer.createTransport({
            host: config.smtp?.host || "smtp.zoho.com",
            port: Number(config.smtp?.port || 465),
            secure: true,
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            },
          });
          const info = await transporter.sendMail({
            from: `"TruePay" <${process.env.SMTP_USER}>`,
            to,
            subject: "SMTP Test",
            text: "If you received this, Zoho SMTP is working.",
          });
          out.plain = {
            ok: true,
            messageId: info.messageId,
            response: info.response,
          };
        }

        if (mode === "verify" || mode === "both") {
          let user;
          let created = false;
          try {
            user = await admin.auth().getUserByEmail(to);
          } catch (err) {
            if (err.code !== "auth/user-not-found") {
              throw err;
            }
            // QA only: create a disposable Auth user so we can generate a verify link.
            user = await admin.auth().createUser({
              email: to,
              emailVerified: false,
              password: `Tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}!`,
              displayName: "SMTP Smoke Test",
            });
            created = true;
            out.createdAuthUser = true;
          }

          out.authUser = {
            uid: user.uid,
            email: user.email,
            emailVerified: user.emailVerified,
            created,
          };

          const link = await admin.auth().generateEmailVerificationLink(to, {
            url: continueUrl,
            handleCodeInApp: false,
          });
          // Return a redacted prefix only — full link goes in the email.
          out.verifyLinkPrefix = `${link.slice(0, 64)}...`;

          if (user.emailVerified) {
            out.verify = {
              ok: true,
              skippedSend: true,
              reason: "already_verified",
            };
          } else {
            const result = await emailService.sendEmailVerificationForUid(
                user.uid,
                {continueUrl},
            );
            out.verify = {ok: true, ...result};
          }
        }

        res.status(200).json({success: true, data: out});
      } catch (err) {
        console.error("smtpSmokeTest:", err.message);
        res.status(500).json({success: false, error: err.message});
      }
    },
);
