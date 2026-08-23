/**
 * @fileoverview Optional C2B request/response payload encryption middleware.
 */

const { defineSecret } = require("firebase-functions/params");
const config = require("../../config");
const {
  decryptPayload,
  encryptPayload,
  isEncryptionConfigured,
} = require("../../utils/c2bPayloadCrypto");

const c2bPayloadEncryptionKey = defineSecret(config.secrets.c2bPayloadEncryptionKey);

const C2B_ENCRYPTION_SECRETS = [c2bPayloadEncryptionKey];

const HEADER_ENCRYPTED = "x-truepay-encrypted";
const HEADER_KEY_ID = "x-truepay-key-id";

const C2B_ENCRYPTION_ALLOW_HEADERS =
  "Content-Type, Authorization, X-TruePay-Encrypted, X-TruePay-Key-Id, X-Idempotency-Key, X-Requested-With";

/**
 * @param {import("express").Request} req
 * @returns {boolean}
 */
function requestWantsEncryption(req) {
  return String(req.headers[HEADER_ENCRYPTED] || "") === "1";
}

/**
 * @param {import("express").Request} req
 * @returns {string}
 */
function resolveRequestKeyId(req) {
  const fromHeader = String(req.headers[HEADER_KEY_ID] || "").trim();
  return fromHeader || config.c2bPayloadEncryption.defaultKeyId || "default";
}

/**
 * @param {unknown} body
 * @returns {boolean}
 */
function isEncryptedEnvelope(body) {
  return !!(
    body &&
    typeof body === "object" &&
    Number(body.v) === 1 &&
    typeof body.data === "string"
  );
}

/**
 * Express middleware: decrypt incoming JSON bodies and encrypt JSON responses
 * when the client sends `X-TruePay-Encrypted: 1`.
 * @returns {import("express").RequestHandler}
 */
function createC2bPayloadEncryptionMiddleware() {
  return (req, res, next) => {
    const wantsEncrypted = requestWantsEncryption(req);
    const required = config.c2bPayloadEncryption.required === true;
    const keyId = resolveRequestKeyId(req);

    if (required && !wantsEncrypted) {
      res.status(400).json({
        success: false,
        error: "Encrypted payload required for this API",
        code: "ENCRYPTION_REQUIRED",
      });
      return;
    }

    if (!wantsEncrypted) {
      next();
      return;
    }

    if (!isEncryptionConfigured()) {
      res.status(503).json({
        success: false,
        error: "C2B payload encryption is not configured on the server",
        code: "ENCRYPTION_NOT_CONFIGURED",
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      if (!isEncryptedEnvelope(req.body)) {
        res.status(400).json({
          success: false,
          error: "Expected encrypted envelope body { v, kid, data }",
          code: "INVALID_ENCRYPTED_PAYLOAD",
        });
        return;
      }

      try {
        req.body = decryptPayload(req.body);
        req.c2bEncryption = { enabled: true, keyId };
      } catch (err) {
        res.status(400).json({
          success: false,
          error: "Failed to decrypt request payload",
          code: "DECRYPTION_FAILED",
        });
        return;
      }
    } else {
      req.c2bEncryption = { enabled: true, keyId };
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const envelope = encryptPayload(body, req.c2bEncryption.keyId);
        res.set("X-TruePay-Encrypted", "1");
        res.set("X-TruePay-Key-Id", req.c2bEncryption.keyId);
        res.set("Content-Type", "application/json; charset=utf-8");
        return originalJson(envelope);
      } catch (err) {
        console.error("c2bPayloadEncryption.responseEncryptFailed", err.message);
        return originalJson({
          success: false,
          error: "Failed to encrypt response payload",
          code: "ENCRYPTION_FAILED",
        });
      }
    };

    next();
  };
}

module.exports = {
  C2B_ENCRYPTION_SECRETS,
  C2B_ENCRYPTION_ALLOW_HEADERS,
  createC2bPayloadEncryptionMiddleware,
  c2bPayloadEncryptionKey,
};
