/**
 * @fileoverview C2B payload encryption unit tests.
 */

const crypto = require("crypto");
const {
  encryptPayload,
  decryptPayload,
  decodeKeyMaterial,
  isEncryptionConfigured,
} = require("../../utils/c2bPayloadCrypto");
const { createC2bPayloadEncryptionMiddleware } = require("../../http/middleware/c2bPayloadEncryption");

const TEST_KEY = crypto.randomBytes(32).toString("base64");

describe("c2bPayloadCrypto", () => {
  beforeEach(() => {
    process.env.C2B_PAYLOAD_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.C2B_PAYLOAD_ENCRYPTION_KEYS;
  });

  afterEach(() => {
    delete process.env.C2B_PAYLOAD_ENCRYPTION_KEY;
    delete process.env.C2B_PAYLOAD_ENCRYPTION_KEYS;
  });

  it("decodes base64 32-byte keys", () => {
    expect(decodeKeyMaterial(TEST_KEY).length).toBe(32);
  });

  it("encrypts and decrypts JSON payloads", () => {
    const payload = { success: true, data: { status: "PROCESSING", amount: 13 } };
    const envelope = encryptPayload(payload, "default");
    expect(envelope.v).toBe(1);
    expect(envelope.data).toBeTruthy();
    expect(decryptPayload(envelope)).toEqual(payload);
  });

  it("detects configured encryption keys", () => {
    expect(isEncryptionConfigured()).toBe(true);
    delete process.env.C2B_PAYLOAD_ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
  });
});

describe("c2bPayloadEncryption middleware", () => {
  beforeEach(() => {
    process.env.C2B_PAYLOAD_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.C2B_PAYLOAD_ENCRYPTION_REQUIRED;
  });

  afterEach(() => {
    delete process.env.C2B_PAYLOAD_ENCRYPTION_KEY;
    delete process.env.C2B_PAYLOAD_ENCRYPTION_REQUIRED;
  });

  it("passes through plaintext when encryption header absent", (done) => {
    const middleware = createC2bPayloadEncryptionMiddleware();
    const req = {
      method: "POST",
      headers: {},
      body: { amount: 10 },
    };
    const res = {
      statusCode: 200,
      headers: {},
      set(name, value) {
        this.headers[name] = value;
      },
      json(body) {
        expect(body).toEqual({ amount: 10 });
        done();
      },
    };
    res.json = res.json.bind(res);

    middleware(req, res, () => {
      expect(req.body).toEqual({ amount: 10 });
      res.json({ amount: 10 });
    });
  });

  it("decrypts request and encrypts response when header set", (done) => {
    const middleware = createC2bPayloadEncryptionMiddleware();
    const plaintext = { type: "MPESA_B2B", amount: 13 };
    const envelope = encryptPayload(plaintext, "default");
    const req = {
      method: "POST",
      headers: {
        "x-truepay-encrypted": "1",
        "x-truepay-key-id": "default",
      },
      body: envelope,
    };
    const res = {
      headers: {},
      set(name, value) {
        this.headers[name] = value;
      },
      json(body) {
        expect(this.headers["X-TruePay-Encrypted"]).toBe("1");
        expect(body.v).toBe(1);
        expect(decryptPayload(body)).toEqual({ success: true, data: { status: "SUCCESS" } });
        done();
      },
    };

    middleware(req, res, () => {
      expect(req.body).toEqual(plaintext);
      res.json({ success: true, data: { status: "SUCCESS" } });
    });
  });
});
