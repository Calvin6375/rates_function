/**
 * @fileoverview Reports classify service fees as TruePay revenue.
 */

const {
  classifyReportCategory,
  extractServiceFee,
} = require("../services/platformReportsService");

describe("classifyReportCategory", () => {
  it("maps collection / pay / send / exchange", () => {
    expect(classifyReportCategory({type: "b2b_payment"})).toBe("collection");
    expect(classifyReportCategory({type: "merchant_payment"})).toBe("pay");
    expect(classifyReportCategory({type: "MPESA_B2B"})).toBe("pay");
    expect(classifyReportCategory({type: "b2b_send"})).toBe("send");
    expect(classifyReportCategory({type: "withdrawal", metadata: {type: "MPESA_B2C"}})).toBe("send");
    expect(classifyReportCategory({
      type: "TRUEPAY_MERCHANT",
      metadata: {source: "truepay_merchant_profile"},
    })).toBe("pay");
    expect(classifyReportCategory({
      type: "withdrawal",
      metadata: {source: "truepay_merchant_profile"},
    })).toBe("pay");
    expect(classifyReportCategory({orderType: "swap"})).toBe("exchange");
  });

  it("ignores top-ups", () => {
    expect(classifyReportCategory({type: "funding"})).toBeNull();
    expect(classifyReportCategory({type: "topup"})).toBeNull();
  });
});

describe("extractServiceFee", () => {
  it("prefers platformFee then ourFee", () => {
    expect(extractServiceFee({
      metadata: {platformFee: 12.4, fee: 1},
    })).toBe(12.4);
    expect(extractServiceFee({
      metadata: {fees: {ourFee: 15, paymentFee: 3, totalFees: 18}},
    })).toBe(15);
    expect(extractServiceFee({fee: 8})).toBe(8);
  });
});
