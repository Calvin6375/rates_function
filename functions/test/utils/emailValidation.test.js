/**
 * @fileoverview C2B customer email validation.
 */

const {
  isValidCustomerEmail,
  validateCustomerEmail,
} = require("../../utils/emailValidation");

describe("isValidCustomerEmail", () => {
  it("accepts a normal Gmail address", () => {
    expect(isValidCustomerEmail("jacklineadamba@gmail.com")).toBe(true);
  });

  it("rejects gmail.coma", () => {
    expect(isValidCustomerEmail("abdalaalifanax@gmail.coma")).toBe(false);
  });
});

describe("validateCustomerEmail", () => {
  it("suggests the corrected domain", () => {
    expect(validateCustomerEmail("abdalaalifanax@gmail.coma")).toEqual({
      ok: false,
      error: "Invalid email address. Did you mean abdalaalifanax@gmail.com?",
    });
  });

  it("normalizes a valid email", () => {
    expect(validateCustomerEmail("Jackline@Gmail.COM")).toEqual({
      ok: true,
      email: "jackline@gmail.com",
    });
  });
});
