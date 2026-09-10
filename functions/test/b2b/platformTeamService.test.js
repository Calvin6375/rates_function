/**
 * @fileoverview Platform operations invite — role rules (not Partner team).
 */

const {
  isAssignablePlatformRole,
  normalizePlatformRole,
  ASSIGNABLE_PLATFORM_ROLES,
} = require("../../services/platformTeamService");

describe("platformTeamService roles", () => {
  it("accepts operations_admin, support_admin, finance_admin", () => {
    expect(ASSIGNABLE_PLATFORM_ROLES).toEqual([
      "operations_admin",
      "support_admin",
      "finance_admin",
    ]);
    expect(isAssignablePlatformRole("Finance_Admin")).toBe(true);
    expect(isAssignablePlatformRole("operations_admin")).toBe(true);
  });

  it("maps partner finance/support/operations to platform admin roles", () => {
    expect(normalizePlatformRole("finance")).toBe("finance_admin");
    expect(normalizePlatformRole("Support")).toBe("support_admin");
    expect(isAssignablePlatformRole("finance")).toBe(true);
    expect(isAssignablePlatformRole("super_admin")).toBe(false);
  });
});
