/**
 * @fileoverview Paystack customer email sanitizer.
 */

const {
  FALLBACK_PAYSTACK_EMAIL,
  resolvePaystackCustomerEmail,
  isPaystackInvalidEmailError,
} = require("../../utils/paystackEmail");

describe("resolvePaystackCustomerEmail", () => {
  it("corrects gmail.coma (Abdullahi profile typo)", () => {
    const result = resolvePaystackCustomerEmail("abdalaalifanax@gmail.coma");
    expect(result).toEqual({
      email: "abdalaalifanax@gmail.com",
      usedFallback: false,
      corrected: true,
    });
  });

  it("falls back when empty", () => {
    expect(resolvePaystackCustomerEmail(null).email).toBe(FALLBACK_PAYSTACK_EMAIL);
    expect(resolvePaystackCustomerEmail("").usedFallback).toBe(true);
  });

  it("keeps a valid address", () => {
    expect(resolvePaystackCustomerEmail("jackline@gmail.com")).toEqual({
      email: "jackline@gmail.com",
      usedFallback: false,
      corrected: false,
    });
  });
});

describe("isPaystackInvalidEmailError", () => {
  it("matches Paystack 400 copy", () => {
    expect(isPaystackInvalidEmailError("Paystack 400: Invalid Email Address Passed")).toBe(true);
  });
});
