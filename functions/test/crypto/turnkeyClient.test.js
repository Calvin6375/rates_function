/**
 * @fileoverview Turnkey client init, missing-credential safety, connection probe.
 */

const originalEnv = {...process.env};

function loadClient() {
  jest.resetModules();
  return require("../../services/crypto/turnkey/turnkeyClient");
}

describe("turnkeyClient configuration", () => {
  afterEach(() => {
    process.env = {...originalEnv};
    jest.resetModules();
  });

  it("initializes the API client when all credentials exist", () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_test";
    const client = loadClient();
    expect(client.isTurnkeyConfigured()).toBe(true);
    const api = client.getApiClient();
    expect(api).toBeTruthy();
    expect(typeof api.getWhoami).toBe("function");
  });

  it("fails safely when credentials are missing", () => {
    delete process.env.TURNKEY_ORGANIZATION_ID;
    delete process.env.TURNKEY_API_PUBLIC_KEY;
    delete process.env.TURNKEY_API_PRIVATE_KEY;
    const client = loadClient();
    expect(client.isTurnkeyConfigured()).toBe(false);
    expect(() => client.assertTurnkeyConfigured()).toThrow("Turnkey configuration is incomplete");
    expect(() => client.getApiClient()).toThrow("Turnkey configuration is incomplete");
  });

  it("does not include credentials in sanitized errors or logs", () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org_secret_value";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_secret_value";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_secret_value";
    const client = loadClient();
    const logs = [];
    const spy = jest.spyOn(console, "error").mockImplementation((line) => logs.push(String(line)));

    const leaked = new Error("failed with priv_secret_value and X-Stamp:abc123");
    const safe = client.sanitizeTurnkeyError(leaked);
    expect(safe).not.toContain("priv_secret_value");
    expect(safe).not.toContain("pub_secret_value");
    expect(safe).not.toContain("org_secret_value");
    expect(safe).not.toContain("X-Stamp:abc123");

    client.setApiClientForTests({
      getWhoami: jest.fn(async () => {
        throw new Error("auth failed priv_secret_value");
      }),
    });
    return client.testTurnkeyConnection().catch(() => {
      const joined = logs.join("\n");
      expect(joined).not.toContain("priv_secret_value");
      expect(joined).not.toContain("pub_secret_value");
      spy.mockRestore();
    });
  });

  it("succeeds on a mocked getWhoami (no wallet or transfer)", async () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_test";
    const client = loadClient();
    const getWhoami = jest.fn(async () => ({organizationId: "org_test"}));
    client.setApiClientForTests({getWhoami});

    const result = await client.testTurnkeyConnection();
    expect(result).toEqual({success: true, provider: "turnkey"});
    expect(getWhoami).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("org_test");
    expect(JSON.stringify(result)).not.toContain("priv_test");
  });
});

const RUN_LIVE = process.env.RUN_TURNKEY_CONNECTION_TEST === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive("Turnkey live connection", () => {
  it("authenticates with Turnkey when credentials are present", async () => {
    const client = require("../../services/crypto/turnkey/turnkeyClient");
    const result = await client.testTurnkeyConnection();
    expect(result).toEqual({success: true, provider: "turnkey"});
  });
});
