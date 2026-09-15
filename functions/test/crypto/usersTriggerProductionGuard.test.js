/**
 * @fileoverview onUserCreated must never allocate production addresses.
 */

const fs = require("fs");
const path = require("path");

describe("usersTrigger production guard", () => {
  it("does not reference production wallet allocation", () => {
    const src = fs.readFileSync(
        path.join(__dirname, "../../triggers/usersTrigger.js"),
        "utf8",
    );
    expect(src).not.toMatch(/allocateProductionCustomerDepositAddress/);
    expect(src).not.toMatch(/wallet\/production/);
    expect(src).not.toMatch(/PRODUCTION_NETWORK/);
    expect(src).toMatch(/createWallet\(userId\)/);
  });
});
