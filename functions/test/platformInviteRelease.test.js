/**
 * @fileoverview Promoting someone to platform staff drops onboarding shells.
 */

jest.mock("../admin", () => ({
  auth: jest.fn(),
}));
jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => "ts"),
}));
jest.mock("../services/accountPasswordService", () => ({
  MIN_PASSWORD_LENGTH: 8,
  normalizeEmail: (email) => String(email || "").trim().toLowerCase(),
}));
jest.mock("../services/partnerAdminProvisioningService", () => ({
  setMustChangePasswordFlag: jest.fn(),
}));
jest.mock("../services/partnerService", () => ({
  getPartner: jest.fn(),
  isOnboardingShellStatus: (status) => {
    const normalized = String(status || "").trim().toLowerCase();
    return normalized === "pending_review" || normalized === "pending_kyc";
  },
}));
jest.mock("../services/partnerDeletionService", () => ({
  deletePartnerAsPlatformAdmin: jest.fn().mockResolvedValue({}),
}));
jest.mock("../services/b2bMemberService", () => ({
  removeMember: jest.fn().mockResolvedValue(undefined),
  ensureUserDashboardProfile: jest.fn(),
}));
jest.mock("../utils/customClaimsMerge", () => ({
  getCustomClaims: jest.fn(),
}));
jest.mock("../utils/accessControl", () => ({
  ADMIN_ROLES: ["super_admin", "operations_admin", "support_admin", "finance_admin"],
  ADMIN_ROLE_SUPER: "super_admin",
  SUPER_ADMIN_EMAIL: "calvinrumba8@gmail.com",
  USER_TYPE_ADMIN: "admin",
  PLATFORM_ADMINS_COL: "platformAdmins",
  setAdminAccessClaims: jest.fn(),
  clearAdminAccessClaims: jest.fn(),
  syncUserDocAccessFields: jest.fn(),
}));

const {collection} = require("../libs/firestore");
const partnerService = require("../services/partnerService");
const partnerDeletionService = require("../services/partnerDeletionService");
const b2bMemberService = require("../services/b2bMemberService");
const {
  releaseMerchantAccessForPlatformInvite,
} = require("../services/platformTeamService");

/**
 * @param {string[]} ids
 */
function mockOwnedPartners(ids) {
  collection.mockReturnValue({
    where: jest.fn().mockReturnValue({
      get: jest.fn().mockResolvedValue({
        docs: ids.map((id) => ({id})),
      }),
    }),
  });
}

describe("releaseMerchantAccessForPlatformInvite", () => {
  beforeEach(() => {
    partnerDeletionService.deletePartnerAsPlatformAdmin.mockClear();
    b2bMemberService.removeMember.mockClear();
    partnerService.getPartner.mockReset();
  });

  it("deletes a pending_review org the user owns", async () => {
    mockOwnedPartners(["partner_shell"]);
    partnerService.getPartner.mockResolvedValue({
      id: "partner_shell",
      name: "calvinrumba8",
      status: "pending_review",
      orgAdminUid: "uid_staff",
    });

    await releaseMerchantAccessForPlatformInvite("uid_staff", {
      partnerId: "partner_shell",
    });

    expect(partnerDeletionService.deletePartnerAsPlatformAdmin)
        .toHaveBeenCalledWith("partner_shell");
    expect(b2bMemberService.removeMember).not.toHaveBeenCalled();
  });

  it("refuses to detach the owner of an active merchant", async () => {
    mockOwnedPartners(["partner_live"]);
    partnerService.getPartner.mockResolvedValue({
      id: "partner_live",
      name: "keyah tours",
      status: "active",
      orgAdminUid: "uid_staff",
    });

    await expect(releaseMerchantAccessForPlatformInvite("uid_staff", {
      partnerId: "partner_live",
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "PARTNER_OWNER",
    });
    expect(partnerDeletionService.deletePartnerAsPlatformAdmin).not.toHaveBeenCalled();
  });

  it("removes a non-owner teammate from their merchant", async () => {
    mockOwnedPartners([]);
    partnerService.getPartner.mockResolvedValue({
      id: "partner_live",
      name: "Tru Pay",
      status: "active",
      orgAdminUid: "someone_else",
    });

    await releaseMerchantAccessForPlatformInvite("uid_teammate", {
      partnerId: "partner_live",
    });

    expect(b2bMemberService.removeMember)
        .toHaveBeenCalledWith("partner_live", "uid_teammate");
    expect(partnerDeletionService.deletePartnerAsPlatformAdmin).not.toHaveBeenCalled();
  });
});
