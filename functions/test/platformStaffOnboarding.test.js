/**
 * @fileoverview Email verification must not mint a merchant for platform staff.
 */

jest.mock("../admin", () => ({
  auth: jest.fn(),
  firestore: jest.fn(),
}));
jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => "ts"),
}));
jest.mock("../utils/customClaimsMerge", () => ({
  getCustomClaims: jest.fn(),
}));
jest.mock("../utils/accessControl", () => ({
  normalizePartnerRole: jest.fn((role) => role),
  isPartnerOwnerRole: jest.fn(() => false),
  isPlatformAdmin: jest.fn(),
}));
jest.mock("../utils/objectDeepMerge", () => ({
  deepMerge: jest.fn(),
}));
jest.mock("../utils/notifications", () => ({
  notifyGoLiveRequestAdmins: jest.fn(),
}));
jest.mock("../services/partnerService", () => ({
  createPartner: jest.fn(),
  getPartner: jest.fn(),
  updatePartner: jest.fn(),
}));
jest.mock("../services/b2bMemberService", () => ({
  setPartnerOrgAdmin: jest.fn(),
}));

const {isPlatformAdmin} = require("../utils/accessControl");
const {getCustomClaims} = require("../utils/customClaimsMerge");
const partnerService = require("../services/partnerService");
const b2bMemberService = require("../services/b2bMemberService");
const {
  ensurePartnerOrgOnEmailVerified,
  registerSelfServePartner,
} = require("../services/b2bOnboardingService");

describe("platform staff partner provisioning", () => {
  it("does not create a partner when a platform member verifies email", async () => {
    isPlatformAdmin.mockResolvedValue(true);

    const out = await ensurePartnerOrgOnEmailVerified("uid_ops", {
      emailVerified: true,
      email: "ops@truepay.live",
    });

    expect(out).toBeNull();
    expect(getCustomClaims).not.toHaveBeenCalled();
    expect(partnerService.createPartner).not.toHaveBeenCalled();
    expect(b2bMemberService.setPartnerOrgAdmin).not.toHaveBeenCalled();
  });

  it("rejects self-serve registration for platform staff", async () => {
    isPlatformAdmin.mockResolvedValue(true);

    await expect(registerSelfServePartner("uid_ops", {name: "Admin Ops"}))
        .rejects.toMatchObject({
          statusCode: 409,
          code: "PLATFORM_ADMIN",
        });
    expect(partnerService.createPartner).not.toHaveBeenCalled();
  });
});
