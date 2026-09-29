/**
 * @fileoverview Grid provider normalization, webhook signatures, and order matching.
 */

const crypto = require("crypto");
const gridProvider = require("../../services/funding/providers/gridProvider");
const {
  joinGridFullName,
  buildMissingAgreementConsents,
  matchOpenFundingOrder,
  pickUsdInternalAccount,
  pickUsdFundingInstructions,
} = require("../../services/funding/gridAccountService");
const { registerFundingProviders } = require("../../services/funding/fundingProviderInterface");

describe("gridProvider", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });

  beforeEach(() => {
    process.env.GRID_WEBHOOK_PUBLIC_KEY = publicPem;
  });

  afterEach(() => {
    delete process.env.GRID_WEBHOOK_PUBLIC_KEY;
  });

  it("implements the funding provider interface", () => {
    expect(() => registerFundingProviders({ grid: gridProvider })).not.toThrow();
    expect(gridProvider.providerId).toBe("grid");
  });

  it("records only agreements the customer has not accepted", () => {
    const consents = buildMissingAgreementConsents(
        [{ type: "LIGHTSPARK_END_USER_TERMS", version: "2025-10-13" }, { type: "OTHER", version: "v2" }],
        [{ type: "OTHER", termsVersion: "v2" }],
        { acceptedAt: "2026-09-28T16:00:00.000Z", ipAddress: "203.0.113.10" },
    );
    expect(consents).toEqual([{
      type: "LIGHTSPARK_END_USER_TERMS",
      acceptedAt: "2026-09-28T16:00:00.000Z",
      ipAddress: "203.0.113.10",
      termsVersion: "2025-10-13",
      acceptanceMethod: "CLICK_TO_ACCEPT",
    }]);
  });

  it("joins the C2B first and last name into Grid fullName", () => {
    expect(joinGridFullName({ firstName: "Ruben", lastName: "Mwachiramba" })).toBe("Ruben Mwachiramba");
    expect(joinGridFullName("  Ruben   Mwachiramba ")).toBe("Ruben Mwachiramba");
    expect(joinGridFullName({ firstName: " ", lastName: "" })).toBeNull();
  });

  it("converts USD cents to major units", () => {
    expect(gridProvider.minorToMajor(10000, 2)).toBe(100);
    expect(gridProvider.majorToMinor(100, 2)).toBe(10000);
  });

  it("normalizes a completed incoming payment and ignores other event types", () => {
    const event = gridProvider.normalizeWebhook({
      id: "Webhook:abc",
      type: "INCOMING_PAYMENT.COMPLETED",
      data: {
        id: "Transaction:tx1",
        status: "COMPLETED",
        type: "INCOMING",
        customerId: "Customer:c1",
        platformCustomerId: "user_1",
        receivedAmount: {
          amount: 10000,
          currency: { code: "USD", decimals: 2 },
        },
        destination: { destinationType: "ACCOUNT", accountId: "InternalAccount:a1" },
      },
    });

    expect(event).toMatchObject({
      provider: "grid",
      providerTransactionId: "Transaction:tx1",
      amount: 100,
      currency: "USD",
      status: "success",
      customerId: "Customer:c1",
      platformCustomerId: "user_1",
      destinationAccountId: "InternalAccount:a1",
    });

    expect(gridProvider.normalizeWebhook({ id: "Webhook:test", type: "TEST", data: {} })).toBeNull();
    expect(gridProvider.normalizeWebhook({
      id: "Webhook:out",
      type: "OUTGOING_PAYMENT.COMPLETED",
      data: { id: "Transaction:out" },
    })).toBeNull();
  });

  it("verifies an X-Grid-Signature over the raw body", () => {
    const body = Buffer.from("{\"id\":\"Webhook:1\"}");
    const signer = crypto.createSign("SHA256");
    signer.update(body);
    signer.end();
    const signature = signer.sign(privateKey).toString("base64");
    const req = {
      get: (name) => (String(name).toLowerCase() === "x-grid-signature" ?
        JSON.stringify({ v: "1", s: signature }) :
        ""),
    };

    expect(gridProvider.verifyWebhookSignature(req, body)).toBe(true);
    expect(gridProvider.verifyWebhookSignature(req, Buffer.from("tampered"))).toBe(false);
  });

  it("refuses sandbox funding unless GRID_ENVIRONMENT is sandbox", async () => {
    process.env.GRID_ENVIRONMENT = "production";
    await expect(gridProvider.sandboxFundInternalAccount("InternalAccount:a1", 100))
        .rejects.toThrow(/GRID_ENVIRONMENT must be sandbox/);
    delete process.env.GRID_ENVIRONMENT;
  });

  it("rejects webhook signatures when the public key is missing", () => {
    delete process.env.GRID_WEBHOOK_PUBLIC_KEY;
    const req = { get: () => "abc" };
    expect(gridProvider.verifyWebhookSignature(req, Buffer.from("{}"))).toBe(false);
  });

  it("reuses the INTERNAL_FIAT USD account and its USD funding instructions", () => {
    const accounts = [
      { id: "InternalAccount:rule", type: "RULE_BASED", balance: { currency: { code: "USD" } } },
      {
        id: "InternalAccount:fiat",
        type: "INTERNAL_FIAT",
        balance: { currency: { code: "USD", decimals: 2 } },
        fundingPaymentInstructions: [
          {
            instructionsNotes: "Include the reference code",
            accountOrWalletInfo: {
              accountType: "USD_ACCOUNT",
              accountNumber: "9876543210",
              routingNumber: "021000021",
              bankName: "JP Morgan Chase",
              intermediaryBankName: "Example Intermediary",
              reference: "FUND-ABC123",
            },
          },
        ],
      },
    ];

    const account = pickUsdInternalAccount(accounts);
    expect(account.id).toBe("InternalAccount:fiat");
    expect(pickUsdInternalAccount(accounts, "InternalAccount:fiat").id).toBe("InternalAccount:fiat");
    const instructions = pickUsdFundingInstructions(account);
    expect(instructions.accountOrWalletInfo).toMatchObject({
      accountNumber: "9876543210",
      routingNumber: "021000021",
      bankName: "JP Morgan Chase",
      intermediaryBankName: "Example Intermediary",
    });
    expect(gridProvider.getFundingInstructions(account)).toBe(instructions);
  });

  it("matches the oldest open order once and ignores a second payment for that transaction", () => {
    const orders = [
      {
        id: "fund_new",
        provider: "grid",
        status: "pending",
        amount: 100,
        currency: "USD",
        providerTransactionId: "",
        createdAt: "2026-09-28T12:00:00.000Z",
      },
      {
        id: "fund_old",
        provider: "grid",
        status: "pending",
        amount: 100,
        currency: "USD",
        providerTransactionId: "",
        createdAt: "2026-09-28T11:00:00.000Z",
      },
    ];

    const first = matchOpenFundingOrder(orders, {
      amount: 100,
      currency: "USD",
      providerTransactionId: "Transaction:tx1",
    });
    expect(first.id).toBe("fund_old");

    orders[1].providerTransactionId = "Transaction:tx1";
    const replay = matchOpenFundingOrder(orders, {
      amount: 100,
      currency: "USD",
      providerTransactionId: "Transaction:tx1",
    });
    expect(replay.id).toBe("fund_old");

    const secondPayment = matchOpenFundingOrder(orders, {
      amount: 100,
      currency: "USD",
      providerTransactionId: "Transaction:tx2",
    });
    expect(secondPayment.id).toBe("fund_new");
  });
});
