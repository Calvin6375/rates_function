/**
 * @fileoverview IntaSend disbursement provider stub-mode tests.
 */

const intasendDisbursement = require("../../services/intasend/intasendDisbursementProvider");

describe("intasendDisbursementProvider", () => {
  beforeEach(() => {
    process.env.INTASEND_DISBURSEMENT_STUB_MODE = "true";
  });

  afterEach(() => {
    delete process.env.INTASEND_DISBURSEMENT_STUB_MODE;
  });

  it("lists stub Kenyan banks", async () => {
    const banks = await intasendDisbursement.listKenyanBankCodes();
    expect(Array.isArray(banks)).toBe(true);
    expect(banks.length).toBeGreaterThan(0);
    expect(banks[0]).toHaveProperty("bank_code");
  });

  it("validates account in stub mode", async () => {
    const result = await intasendDisbursement.validateAccount({
      account: "254712345678",
      provider: "MPESA-B2C",
    });
    expect(result.name).toBe("Stub Beneficiary");
    expect(result.stub).toBe(true);
  });

  it("initiates and approves MPESA B2C in stub mode", async () => {
    const tx = intasendDisbursement.buildMpesaB2cTransaction({
      name: "Jane",
      account: "254712345678",
      amount: 100,
      narrative: "Test",
      requestReferenceId: "payout_1",
    });

    const result = await intasendDisbursement.initiateAndApproveSendMoney({
      provider: intasendDisbursement.DISBURSEMENT_PROVIDERS.MPESA_B2C,
      currency: "KES",
      transactions: [tx],
      batchReference: "payout_1",
    });

    expect(result.tracking_id).toBeTruthy();
    expect(result.status_code).toBe("BC100");
    expect(result.transactions[0].status_code).toBe("TS100");
  });

  it("builds PayBill B2B transaction with account_reference", () => {
    const tx = intasendDisbursement.buildMpesaB2bTransaction({
      name: "Biz",
      account: "123456",
      accountType: "PayBill",
      accountReference: "INV-1",
      amount: 200,
    });
    expect(tx.account_type).toBe("PayBill");
    expect(tx.account_reference).toBe("INV-1");
  });

  it("builds Till B2B transaction without account_reference", () => {
    const tx = intasendDisbursement.buildMpesaB2bTransaction({
      name: "Biz",
      account: "512345",
      accountType: "TillNumber",
      amount: 200,
    });
    expect(tx.account_type).toBe("TillNumber");
    expect(tx.account_reference).toBeUndefined();
  });
});
