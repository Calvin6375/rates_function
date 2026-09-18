/**
 * @fileoverview Admin auth + error mapping for treasury balance callable.
 */

const {Interface} = require("ethers");
const {ERC20_TRANSFER_ABI} = require("../../services/crypto/evm/fujiNetwork");

const originalEnv = {...process.env};
const iface = new Interface(ERC20_TRANSFER_ABI);
const TREASURY = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";

jest.mock("../../utils/adminClaims", () => ({
  verifyAdminFromToken: jest.fn(),
  isSuperAdmin: jest.fn(),
  isPlatformAdmin: jest.fn(),
}));

const {HttpsError} = require("firebase-functions/v2/https");
const {verifyAdminFromToken, isSuperAdmin, isPlatformAdmin} = require("../../utils/adminClaims");
const {
  assertAdminCaller,
  assertSuperAdminCaller,
  handleGetTurnkeyTreasuryBalances,
} = require("../../http/turnkeyHttp");
const client = require("../../services/crypto/turnkey/turnkeyClient");
const evmRpcService = require("../../services/crypto/evm/evmRpcService");

describe("getTurnkeyTreasuryBalances authorization", () => {
  afterEach(() => {
    process.env = {...originalEnv};
    jest.clearAllMocks();
    evmRpcService.setProviderForTests(null);
    evmRpcService.resetProvider();
    client.setApiClientForTests(null);
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(assertAdminCaller(null)).rejects.toBeInstanceOf(HttpsError);
    await expect(assertAdminCaller({})).rejects.toMatchObject({code: "unauthenticated"});
    await expect(handleGetTurnkeyTreasuryBalances({auth: null, data: {}}))
        .rejects.toMatchObject({code: "unauthenticated"});
  });

  it("rejects a non-admin user", async () => {
    verifyAdminFromToken.mockReturnValue(false);
    isSuperAdmin.mockResolvedValue(false);
    isPlatformAdmin.mockResolvedValue(false);
    await expect(handleGetTurnkeyTreasuryBalances({
      auth: {uid: "customer_1", token: {}},
      data: {network: "avalanche"},
    })).rejects.toMatchObject({
      code: "permission-denied",
      message: "Super admin access required",
    });
  });

  it("rejects a platform admin who is not super admin", async () => {
    verifyAdminFromToken.mockReturnValue(true);
    isSuperAdmin.mockResolvedValue(false);
    isPlatformAdmin.mockResolvedValue(true);
    await expect(assertSuperAdminCaller({
      uid: "finance_1",
      token: {userType: "admin", role: "finance_admin"},
    })).rejects.toMatchObject({
      code: "permission-denied",
      message: "Super admin access required",
    });
    await expect(handleGetTurnkeyTreasuryBalances({
      auth: {uid: "finance_1", token: {userType: "admin", role: "finance_admin"}},
      data: {network: "avalanche"},
    })).rejects.toMatchObject({code: "permission-denied"});
  });

  it("allows a master-admin session without token claims", async () => {
    verifyAdminFromToken.mockReturnValue(false);
    isSuperAdmin.mockResolvedValue(true);
    isPlatformAdmin.mockResolvedValue(false);
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_secret_value";
    await expect(handleGetTurnkeyTreasuryBalances({
      auth: {uid: "master_1", token: {email: "master@truepay.test"}},
      data: {network: "ethereum"},
    })).rejects.toMatchObject({code: "invalid-argument"});
  });

  it("maps an unsupported network to invalid-argument", async () => {
    isSuperAdmin.mockResolvedValue(true);
    await expect(handleGetTurnkeyTreasuryBalances({
      auth: {uid: "admin_1", token: {admin: true}},
      data: {network: "ethereum"},
    })).rejects.toMatchObject({
      code: "invalid-argument",
      message: "Unsupported network",
    });
  });

  it("maps RPC failures to a clean unavailable error", async () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_secret_value";
    process.env.CRYPTO_TREASURY_ADDRESS = TREASURY;
    isSuperAdmin.mockResolvedValue(true);
    client.setApiClientForTests({
      getWallets: jest.fn(async () => ({
        wallets: [{walletId: "wal_treasury", walletName: "TruePay Treasury Dev"}],
      })),
      getWalletAccounts: jest.fn(async () => ({
        accounts: [{address: TREASURY, addressFormat: "ADDRESS_FORMAT_ETHEREUM"}],
      })),
    });
    evmRpcService.setProviderForTests({
      getBalance: jest.fn(async () => {
        throw new Error("rpc timeout");
      }),
      call: jest.fn(async () => iface.encodeFunctionResult("balanceOf", [0n])),
    });

    await expect(handleGetTurnkeyTreasuryBalances({
      auth: {uid: "admin_1", token: {admin: true}},
      data: {network: "avalanche"},
    })).rejects.toMatchObject({
      code: "unavailable",
      message: "Unable to retrieve live treasury balance",
    });
  });
});
