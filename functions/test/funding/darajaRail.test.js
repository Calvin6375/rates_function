/**
 * @fileoverview Daraja rail stub mode tests.
 */

const darajaRail = require("../../services/funding/darajaRail");

describe("darajaRail", () => {
  beforeEach(() => {
    delete process.env.DARAJA_CONSUMER_KEY;
    delete process.env.DARAJA_CONSUMER_SECRET;
    process.env.DARAJA_STUB_MODE = "true";
  });

  afterEach(() => {
    delete process.env.DARAJA_STUB_MODE;
  });

  it("runs in stub mode without credentials", () => {
    expect(darajaRail.isStubMode()).toBe(true);
  });

  it("simulates B2B payment in stub mode", async () => {
    const result = await darajaRail.initiateB2BPayment({
      amountKes: 12800,
      reference: "mp_test_1",
      destination: { type: "paybill", paybill: "123456", account: "ACC001" },
    });

    expect(result.status).toBe("processing");
    expect(result.providerReference).toMatch(/^stub_daraja_/);
    expect(result.raw.stub).toBe(true);
  });
});
