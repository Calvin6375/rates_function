/**
 * @fileoverview Partner role + live-claim resolution.
 */

const {
  normalizePartnerRole,
  resolvePartnerAccess,
  parseAccessFromToken,
  PARTNER_ROLE_OWNER,
} = require("../utils/accessControl");

describe("normalizePartnerRole", () => {
  it("accepts dashboard title-case roles", () => {
    expect(normalizePartnerRole("Finance")).toBe("finance");
    expect(normalizePartnerRole("Support")).toBe("support");
    expect(normalizePartnerRole("Operations")).toBe("operations");
    expect(normalizePartnerRole("Viewer")).toBe("viewer");
    expect(normalizePartnerRole("Owner")).toBe(PARTNER_ROLE_OWNER);
  });

  it("maps legacy org_admin to owner", () => {
    expect(normalizePartnerRole("org_admin")).toBe(PARTNER_ROLE_OWNER);
    expect(normalizePartnerRole("ORG_ADMIN")).toBe(PARTNER_ROLE_OWNER);
  });
});

describe("resolvePartnerAccess", () => {
  it("reads partner claims without treating the user as platform admin", () => {
    expect(resolvePartnerAccess({
      userType: "partner",
      partnerId: "partner_1",
      role: "finance",
    })).toEqual({partnerId: "partner_1", role: "finance"});
  });
});

describe("parseAccessFromToken leftover admin on partner", () => {
  it("keeps userType partner when leftover admin:true is present", () => {
    const access = parseAccessFromToken({
      userType: "partner",
      partnerId: "partner_1",
      role: "finance",
      admin: true,
    });
    expect(access.userType).toBe("partner");
    expect(access.role).toBe("finance");
    expect(access.isLegacyAdmin).toBe(true);
  });

  it("does not promote partnerRole+partnerId to admin", () => {
    const access = parseAccessFromToken({
      partnerId: "partner_1",
      partnerRole: "finance",
      admin: true,
    });
    expect(access.userType).toBe("partner");
    expect(access.role).toBe("finance");
  });
});
