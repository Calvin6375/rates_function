/**
 * @fileoverview Onboarding status advance rules (Google signup must not downgrade).
 */

const {
  resolveOnboardingStatusPatch,
  derivePartnerName,
} = require("../services/b2bOnboardingService");

describe("resolveOnboardingStatusPatch", () => {
  it("never downgrades credentials_ready to email_verified", () => {
    expect(resolveOnboardingStatusPatch("credentials_ready", "email_verified"))
        .toBe("credentials_ready");
  });

  it("advances draft to email_verified", () => {
    expect(resolveOnboardingStatusPatch("draft", "email_verified"))
        .toBe("email_verified");
  });

  it("treats missing status as draft", () => {
    expect(resolveOnboardingStatusPatch(null, "email_verified"))
        .toBe("email_verified");
  });
});

describe("derivePartnerName", () => {
  it("uses owner.fullName when business name is missing (Google signup)", () => {
    expect(derivePartnerName(
        {owner: {fullName: "Azule Mwanzele", phone: "+254742844875"}},
        null,
        "azule@gmail.com",
    )).toBe("Azule Mwanzele");
  });
});
