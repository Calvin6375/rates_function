/**
 * @fileoverview Paystack customer email sanitizer.
 */

const {
  FALLBACK_PAYSTACK_EMAIL,
  resolvePaystackCustomerEmail,
  pickPaystackCustomerEmail,
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

describe("pickPaystackCustomerEmail", () => {
  it("prefers a valid Firestore profile over a stale Auth/app email", () => {
    const result = pickPaystackCustomerEmail([
      "abdalaalifanax@gmail.com",
      "abdalaalifanax@gmail.coma",
      "abdalaalifanax@gmail.coma",
    ]);
    expect(result).toEqual({
      email: "abdalaalifanax@gmail.com",
      usedFallback: false,
      corrected: false,
      source: "profile",
    });
  });

  it("does not let an invalid client email beat a valid profile", () => {
    const result = pickPaystackCustomerEmail([
      "good@gmail.com",
      null,
      "bad@gmail.coma",
    ]);
    expect(result.email).toBe("good@gmail.com");
    expect(result.source).toBe("profile");
  });
});

describe("isPaystackInvalidEmailError", () => {
  it("matches Paystack 400 copy", () => {
    expect(isPaystackInvalidEmailError("Paystack 400: Invalid Email Address Passed")).toBe(true);
  });
});
