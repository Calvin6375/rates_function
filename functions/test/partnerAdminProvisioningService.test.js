/**
 * @fileoverview Platform create-partner with org admin + first-login set-pin.
 */

jest.mock("../admin", () => ({
  auth: jest.fn(),
}));
jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));
jest.mock("../utils/customClaimsMerge", () => ({
  mergeCustomUserClaims: jest.fn().mockResolvedValue({}),
  getCustomClaims: jest.fn().mockResolvedValue({}),
}));
jest.mock("../services/partnerService");
jest.mock("../services/b2bMemberService", () => ({
  setPartnerOrgAdmin: jest.fn().mockResolvedValue({}),
  ensureUserDashboardProfile: jest.fn().mockResolvedValue(undefined),
  INSTITUTION_PARTNER_DASHBOARD: "PartnerDashboard",
  CHANNEL_B2B: "B2B",
}));
jest.mock("../services/accountPasswordService", () => ({
  MIN_PASSWORD_LENGTH: 8,
  normalizeEmail: (e) => String(e || "").trim().toLowerCase(),
  changePassword: jest.fn().mockResolvedValue({success: true}),
}));

const admin = require("../admin");
const {collection} = require("../libs/firestore");
const {mergeCustomUserClaims, getCustomClaims} = require("../utils/customClaimsMerge");
const partnerService = require("../services/partnerService");
const b2bMemberService = require("../services/b2bMemberService");
const accountPasswordService = require("../services/accountPasswordService");
const svc = require("../services/partnerAdminProvisioningService");

describe("partnerAdminProvisioningService", () => {
  let createUser;
  let getUserByEmail;
  let updateUser;
  let userSet;

  beforeEach(() => {
    jest.clearAllMocks();
    createUser = jest.fn().mockResolvedValue({
      uid: "uid_new",
      email: "client@acme.test",
      displayName: "Acme",
    });
    getUserByEmail = jest.fn().mockRejectedValue({code: "auth/user-not-found"});
    updateUser = jest.fn().mockResolvedValue({});
    admin.auth.mockReturnValue({createUser, getUserByEmail, updateUser});

    userSet = jest.fn().mockResolvedValue(undefined);
    collection.mockImplementation(() => ({
      doc: () => ({
        set: userSet,
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({mustChangePassword: true}),
        }),
      }),
    }));

    partnerService.createPartner.mockResolvedValue({
      partnerId: "partner_1",
      apiKey: "key_abc",
      partner: {name: "Acme Hotels"},
    });
    getCustomClaims.mockResolvedValue({});
  });

  it("creates partner + org admin with mustChangePassword", async () => {
    const result = await svc.createPartnerWithOrgAdmin({
      name: "Acme Hotels",
      email: "client@acme.test",
      temporaryPassword: "TempPass1",
      actorUid: "admin_1",
    });

    expect(partnerService.createPartner).toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "client@acme.test",
          emailVerified: false,
        }),
    );
    expect(b2bMemberService.setPartnerOrgAdmin).toHaveBeenCalledWith(
        "partner_1",
        "uid_new",
        "admin_1",
    );
    expect(mergeCustomUserClaims).toHaveBeenCalledWith(
        "uid_new",
        {mustChangePassword: true},
    );
    expect(result.orgAdmin).toEqual(
        expect.objectContaining({
          userId: "uid_new",
          email: "client@acme.test",
          mustChangePassword: true,
          redirectTo: "set_pin",
        }),
    );
  });

  it("rejects weak temporary password", async () => {
    await expect(svc.createPartnerWithOrgAdmin({
      name: "Acme",
      email: "a@b.co",
      temporaryPassword: "short",
      actorUid: "admin_1",
    })).rejects.toMatchObject({code: "WEAK_PASSWORD", statusCode: 400});
    expect(partnerService.createPartner).not.toHaveBeenCalled();
  });

  it("completes first-login set-pin and verifies email", async () => {
    const out = await svc.completeFirstLoginSetPassword("uid_new", {
      temporaryPassword: "TempPass1",
      newPassword: "NewPass99",
      confirmPassword: "NewPass99",
    });

    expect(accountPasswordService.changePassword).toHaveBeenCalledWith(
        "uid_new",
        expect.objectContaining({
          currentPassword: "TempPass1",
          newPassword: "NewPass99",
        }),
    );
    expect(updateUser).toHaveBeenCalledWith("uid_new", {emailVerified: true});
    expect(mergeCustomUserClaims).toHaveBeenCalledWith(
        "uid_new",
        {mustChangePassword: null},
    );
    expect(out).toEqual(
        expect.objectContaining({
          emailVerified: true,
          mustChangePassword: false,
          claimsNeedRefresh: true,
        }),
    );
  });
});
