/**
 * @fileoverview SafariTap user profile QR payload and payout id decode.
 */

jest.mock("../../admin", () => ({
  firestore: jest.fn(),
}));
jest.mock("qrcode", () => ({
  toDataURL: jest.fn(async (payload) => `data:image/png;base64,${Buffer.from(payload).toString("base64")}`),
}));

const admin = require("../../admin");
const {
  extractUserId,
  getProfileQr,
  buildQrPayload,
  validateCustomer,
} = require("../../services/safariTapUserQrService");
const {classifyScannedQr} = require("../../services/partnerProfileQrService");
const {
  validateCreatePayoutRequest,
  validateBeneficiaryRequest,
} = require("../../services/safariCard/safariCardPayoutValidation");

const USER_ID = "firebaseUidRuben123456";

describe("safariTapUserQrService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("extracts the customer id from the profile URL and custom scheme", () => {
    const payload = buildQrPayload(USER_ID);
    expect(payload).toContain(`/u/${USER_ID}`);
    expect(extractUserId(payload)).toBe(USER_ID);
    expect(extractUserId(`truepay://user/${USER_ID}`)).toBe(USER_ID);
    expect(extractUserId(`truepay://pay/user/${USER_ID}`)).toBe(USER_ID);
    expect(extractUserId("https://host/b2bPortal/p/partner_1")).toBeNull();
  });

  it("does not classify a user QR as a merchant profile", () => {
    const payload = buildQrPayload(USER_ID);
    expect(classifyScannedQr(payload)).toEqual({
      kind: "safaritap_user",
      merchantId: null,
      partnerId: null,
      linkId: null,
      userId: USER_ID,
    });
  });

  it("returns a QR whose payload is the customer id URL", async () => {
    admin.firestore.mockReturnValue({
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            id: USER_ID,
            data: () => ({firstName: "Ruben", lastName: "Mwachiramba"}),
          }),
        }),
      }),
    });
    const data = await getProfileQr(USER_ID);
    expect(data.customerId).toBe(USER_ID);
    expect(data.displayName).toBe("Ruben Mwachiramba");
    expect(data.kind).toBe("safaritap_user");
    expect(extractUserId(data.qrPayload)).toBe(USER_ID);
    expect(data.qrCode.startsWith("data:image/png;base64,")).toBe(true);
    expect(data.displayName).not.toMatch(/@/);
  });

  it("decodes a scanned QR into recipient.userId for the existing payout API", () => {
    const payload = buildQrPayload(USER_ID);
    const created = validateCreatePayoutRequest({
      type: "SAFARITAP_WALLET",
      amount: 500,
      currency: "KES",
      clientRequestId: "client-req-qr-001",
      recipient: {qrPayload: payload},
    });
    expect(created.recipient.userId).toBe(USER_ID);

    const validated = validateBeneficiaryRequest({
      type: "SAFARITAP_WALLET",
      recipient: {userId: payload},
    });
    expect(validated.userId).toBe(USER_ID);
  });

  it("validates a scanned id and returns the profile full name as read-only", async () => {
    admin.firestore.mockReturnValue({
      collection: () => ({
        doc: (id) => ({
          get: async () => ({
            exists: id === USER_ID,
            id,
            data: () => ({name: "Ruben Mwachiramba", phoneNumber: "+254712345678"}),
          }),
        }),
      }),
    });
    const data = await validateCustomer(buildQrPayload(USER_ID), "senderUid");
    expect(data.valid).toBe(true);
    expect(data.customerId).toBe(USER_ID);
    expect(data.fullName).toBe("Ruben Mwachiramba");
    expect(data.nameEditable).toBe(false);
    expect(data.self).toBe(false);
    await expect(validateCustomer("not-a-user", "senderUid")).rejects.toMatchObject({
      code: "RECIPIENT_NOT_FOUND",
      httpStatus: 404,
    });
  });
});
