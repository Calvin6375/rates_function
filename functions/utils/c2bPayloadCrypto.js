/**
 * @fileoverview AES-256-GCM envelope encryption for C2B mobile API payloads.
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ENVELOPE_VERSION = 1;

/**
 * @param {string} raw
 * @returns {Buffer}
 */
function decodeKeyMaterial(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    throw new Error("Encryption key is empty");
  }

  const base64 = Buffer.from(value, "base64");
  if (base64.length === KEY_LENGTH) {
    return base64;
  }

  const hex = Buffer.from(value, "hex");
  if (hex.length === KEY_LENGTH) {
    return hex;
  }

  throw new Error("Encryption key must decode to 32 bytes (base64 or hex)");
}

/**
 * @param {string} raw
 * @returns {Record<string, Buffer>}
 */
function parseKeyRingJson(raw) {
  /** @type {Record<string, string>} */
  const parsed = JSON.parse(raw);
  /** @type {Record<string, Buffer>} */
  const ring = {};
  for (const [kid, material] of Object.entries(parsed)) {
    ring[String(kid)] = decodeKeyMaterial(material);
  }
  if (Object.keys(ring).length === 0) {
    throw new Error("Encryption key ring JSON is empty");
  }
  return ring;
}

/**
 * @returns {Record<string, Buffer>}
 */
function loadKeyRingFromEnv() {
  const multi = process.env.C2B_PAYLOAD_ENCRYPTION_KEYS;
  if (multi) {
    return parseKeyRingJson(multi);
  }

  const single = process.env.C2B_PAYLOAD_ENCRYPTION_KEY;
  if (single) {
    const trimmed = String(single).trim();
    if (trimmed.startsWith("{")) {
      return parseKeyRingJson(trimmed);
    }
    return { default: decodeKeyMaterial(trimmed) };
  }

  return {};
}

/**
 * @param {string} keyId
 * @returns {Buffer}
 */
function resolveKey(keyId) {
  const ring = loadKeyRingFromEnv();
  const kid = String(keyId || "default");
  const key = ring[kid] || ring.default;
  if (!key) {
    throw new Error(`Unknown encryption key id: ${kid}`);
  }
  return key;
}

/**
 * @param {unknown} payload
 * @param {string} [keyId]
 * @returns {{ v: number, kid: string, data: string }}
 */
function encryptPayload(payload, keyId = "default") {
  const key = resolveKey(keyId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, ciphertext, tag]);
  return {
    v: ENVELOPE_VERSION,
    kid: keyId,
    data: packed.toString("base64"),
  };
}

/**
 * @param {{ v?: number, kid?: string, data?: string }} envelope
 * @returns {unknown}
 */
function decryptPayload(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Invalid encryption envelope");
  }
  if (Number(envelope.v) !== ENVELOPE_VERSION) {
    throw new Error("Unsupported encryption envelope version");
  }
  if (!envelope.data) {
    throw new Error("Missing encrypted data");
  }

  const key = resolveKey(envelope.kid || "default");
  const packed = Buffer.from(String(envelope.data), "base64");
  if (packed.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted data is too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(packed.length - TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

/**
 * @returns {boolean}
 */
function isEncryptionConfigured() {
  return Object.keys(loadKeyRingFromEnv()).length > 0;
}

module.exports = {
  ENVELOPE_VERSION,
  encryptPayload,
  decryptPayload,
  decodeKeyMaterial,
  isEncryptionConfigured,
};
