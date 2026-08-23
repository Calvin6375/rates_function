/**
 * @fileoverview Safari Card payout validation tests.
 */

const {
  normalizeKenyanPhoneNumber,
  validateCreatePayoutRequest,
  validateBeneficiaryRequest,
} = require("../../services/safariCard/safariCardPayoutValidation");
const { ERROR_CODES } = require("../../utils/safariCardPayoutTypes");

describe("safariCardPayoutValidation", () => {
  describe("normalizeKenyanPhoneNumber", () => {
    it("normalizes 07XXXXXXXX to 2547XXXXXXXX", () => {
      expect(normalizeKenyanPhoneNumber("0712345678")).toBe("254712345678");
    });

    it("normalizes 7XXXXXXXX to 2547XXXXXXXX", () => {
      expect(normalizeKenyanPhoneNumber("712345678")).toBe("254712345678");
    });

    it("keeps already normalized numbers", () => {
      expect(normalizeKenyanPhoneNumber("254712345678")).toBe("254712345678");
    });

    it("rejects invalid numbers", () => {
      expect(normalizeKenyanPhoneNumber("12345")).toBeNull();
      expect(normalizeKenyanPhoneNumber("+441234567890")).toBeNull();
    });
  });

  describe("validateCreatePayoutRequest", () => {
    it("accepts valid MPESA_B2C request", () => {
      const parsed = validateCreatePayoutRequest({
        type: "MPESA_B2C",
        amount: 5000,
        currency: "KES",
        clientRequestId: "client-req-001",
        recipient: { phoneNumber: "254712345678" },
      });
      expect(parsed.type).toBe("MPESA_B2C");
      expect(parsed.recipient.phoneNumber).toBe("254712345678");
    });

    it("rejects zero amount", () => {
      try {
        validateCreatePayoutRequest({
          type: "MPESA_B2C",
          amount: 0,
          currency: "KES",
          clientRequestId: "client-req-002",
          recipient: { phoneNumber: "254712345678" },
        });
        throw new Error("expected validation error");
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });

    it("requires PayBill accountReference", () => {
      try {
        validateCreatePayoutRequest({
          type: "MPESA_B2B",
          accountType: "PayBill",
          amount: 1500,
          currency: "KES",
          clientRequestId: "client-req-003",
          recipient: { account: "123456" },
        });
        throw new Error("expected validation error");
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.INVALID_PAYBILL_REFERENCE);
      }
    });

    it("accepts valid Till payment without accountReference", () => {
      const parsed = validateCreatePayoutRequest({
        type: "MPESA_B2B",
        accountType: "TillNumber",
        amount: 1500,
        currency: "KES",
        clientRequestId: "client-req-004",
        recipient: { account: "512345" },
      });
      expect(parsed.recipient.accountType).toBe("TillNumber");
      expect(parsed.recipient.accountReference).toBeUndefined();
    });

    it("validates bank payout bounds", () => {
      try {
        validateCreatePayoutRequest({
          type: "BANK",
          amount: 50,
          currency: "KES",
          clientRequestId: "client-req-005",
          recipient: { bankCode: "11", accountNumber: "0123456789" },
        });
        throw new Error("expected validation error");
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.INVALID_AMOUNT);
      }
    });
  });

  describe("validateBeneficiaryRequest", () => {
    it("maps MPESA_B2C to provider MPESA-B2C", () => {
      const parsed = validateBeneficiaryRequest({
        type: "MPESA_B2C",
        phoneNumber: "254712345678",
      });
      expect(parsed.provider).toBe("MPESA-B2C");
    });

    it("maps BANK to PESALINK", () => {
      const parsed = validateBeneficiaryRequest({
        type: "BANK",
        bankCode: "68",
        accountNumber: "0123456789",
      });
      expect(parsed.provider).toBe("PESALINK");
    });
  });
});
