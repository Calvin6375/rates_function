/**
 * @fileoverview Customer Wallets PUT profile prep (email → Auth).
 */

const {prepareCustomerWalletUpdates} = require("../../utils/customerWalletProfileUpdate");

describe("prepareCustomerWalletUpdates", () => {
  it("validates email and queues Auth sync", () => {
    const result = prepareCustomerWalletUpdates({
      email: "Abdullahi@Gmail.COM",
      firstName: "abdullahi",
      lastName: "ali hassan",
    });
    expect(result.firestoreUpdates.email).toBe("abdullahi@gmail.com");
    expect(result.authUpdates).toEqual({
      displayName: "abdullahi ali hassan",
      email: "abdullahi@gmail.com",
      emailVerified: false,
    });
  });

  it("rejects gmail.coma", () => {
    expect(() => prepareCustomerWalletUpdates({
      email: "abdalaalifanax@gmail.coma",
    })).toThrow(/Did you mean/);
  });
});
