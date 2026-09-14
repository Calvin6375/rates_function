/**
 * @fileoverview Read-only Turnkey treasury wallet lookup.
 */

const originalEnv = {...process.env};

function loadClient() {
  jest.resetModules();
  return require("../../services/crypto/turnkey/turnkeyClient");
}

describe("getTurnkeyTreasuryWallet", () => {
  afterEach(() => {
    process.env = {...originalEnv};
    jest.resetModules();
  });

  function configuredClient() {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_secret_value";
    return loadClient();
  }

  const configuredTreasury = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";
  const suffixOnlyAddress = "0x11111111111111111111111111111111111E080A";

  it("looks up TruePay Treasury Dev and identifies the configured EVM account", async () => {
    const client = configuredClient();
    const getWallets = jest.fn(async () => ({
      wallets: [
        {walletId: "wal_other", walletName: "Other"},
        {walletId: "wal_treasury", walletName: "TruePay Treasury Dev"},
      ],
    }));
    const getWalletAccounts = jest.fn(async () => ({
      accounts: [{
        address: configuredTreasury,
        addressFormat: "ADDRESS_FORMAT_ETHEREUM",
      }],
    }));
    client.setApiClientForTests({getWallets, getWalletAccounts});

    const result = await client.getTurnkeyTreasuryWallet();
    expect(getWallets).toHaveBeenCalledTimes(1);
    expect(getWalletAccounts).toHaveBeenCalledWith({walletId: "wal_treasury"});
    expect(result.success).toBe(true);
    expect(result.walletName).toBe("TruePay Treasury Dev");
    expect(result.accountType).toBe("EVM");
    expect(result.address).toBe(configuredTreasury);
    expect(result.addressSuffix).toBe("F080A");
    expect(result.matchesExpectedAddress).toBe(true);
  });

  it("identifies the E080A account among multiple EVM accounts", async () => {
    const client = configuredClient();
    client.setApiClientForTests({
      getWallets: jest.fn(async () => ({
        wallets: [{walletId: "wal_treasury", walletName: "TruePay Treasury Dev"}],
      })),
      getWalletAccounts: jest.fn(async () => ({
        accounts: [
          {address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", addressFormat: "ADDRESS_FORMAT_ETHEREUM"},
          {address: suffixOnlyAddress, addressFormat: "ADDRESS_FORMAT_ETHEREUM"},
        ],
      })),
    });

    const result = await client.getTurnkeyTreasuryWallet();
    expect(result.address.toLowerCase().endsWith("e080a")).toBe(true);
    expect(result.addressSuffix).toBe("E080A");
    expect(result.matchesExpectedAddress).toBe(true);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.filter((row) => row.matchesExpectedAddress)).toHaveLength(1);
  });

  it("does not return secrets", async () => {
    const client = configuredClient();
    client.setApiClientForTests({
      getWallets: jest.fn(async () => ({
        wallets: [{walletId: "wal_treasury", walletName: "TruePay Treasury Dev"}],
      })),
      getWalletAccounts: jest.fn(async () => ({
        accounts: [{address: configuredTreasury, addressFormat: "ADDRESS_FORMAT_ETHEREUM"}],
      })),
    });
    const result = await client.getTurnkeyTreasuryWallet();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("priv_secret_value");
    expect(serialized).not.toContain("pub_test");
    expect(serialized).not.toContain("org_test");
    expect(result).not.toHaveProperty("apiPrivateKey");
    expect(result).not.toHaveProperty("privateKey");
  });

  it("sanitizes Turnkey API errors", async () => {
    const client = configuredClient();
    const logs = [];
    const spy = jest.spyOn(console, "error").mockImplementation((line) => logs.push(String(line)));
    client.setApiClientForTests({
      getWallets: jest.fn(async () => {
        throw new Error("denied priv_secret_value X-Stamp:abc");
      }),
      getWalletAccounts: jest.fn(),
    });

    await expect(client.getTurnkeyTreasuryWallet()).rejects.toThrow(/Turnkey treasury wallet lookup failed/);
    const joined = logs.join("\n");
    expect(joined).not.toContain("priv_secret_value");
    expect(joined).not.toContain("X-Stamp:abc");
    spy.mockRestore();
  });
});
