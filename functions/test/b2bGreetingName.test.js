/**
 * @fileoverview Greeting name: business name wins over creation display name.
 */

jest.mock("../admin", () => ({
  auth: jest.fn(() => ({
    getUser: jest.fn().mockResolvedValue({displayName: "Auth Display"}),
  })),
}));
jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_ts: true})),
}));
jest.mock("../utils/customClaimsMerge", () => ({
  getCustomClaims: jest.fn().mockResolvedValue({partnerId: "partner_1"}),
}));
jest.mock("../services/partnerService", () => ({
  getPartner: jest.fn(),
  updatePartner: jest.fn().mockResolvedValue({}),
}));
jest.mock("../services/b2bMemberService", () => ({}));
jest.mock("../utils/notifications", () => ({
  notifyGoLiveRequestAdmins: jest.fn(),
}));

const {collection} = require("../libs/firestore");
const partnerService = require("../services/partnerService");
const svc = require("../services/b2bOnboardingService");

describe("resolveGreetingName / readBusinessName", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads businessName from onboarding business map", () => {
    expect(svc.readBusinessName({
      business: {businessName: "Acme Hotels", name: "ignored"},
    })).toBe("Acme Hotels");
  });

  it("prefers business name over greetingDisplayName", async () => {
    collection.mockReturnValue({
      doc: () => ({
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({business: {businessName: "KyB Co"}}),
        }),
      }),
    });

    const name = await svc.resolveGreetingName("uid_1", {
      name: "Create Modal Name",
      greetingDisplayName: "Display At Create",
    });
    expect(name).toBe("KyB Co");
  });

  it("falls back to creation display name before partner.name", async () => {
    collection.mockReturnValue({
      doc: () => ({
        get: jest.fn().mockResolvedValue({exists: false, data: () => null}),
      }),
    });

    const name = await svc.resolveGreetingName("uid_1", {
      name: "Partner Org Name",
      greetingDisplayName: "Display At Create",
    });
    expect(name).toBe("Display At Create");
  });
});

describe("syncPartnerNameFromBusiness", () => {
  it("updates partner.name from business.businessName", async () => {
    partnerService.getPartner.mockResolvedValue({
      id: "partner_1",
      name: "Old Name",
    });

    await svc.syncPartnerNameFromBusiness("uid_1", {
      registeredPartnerId: "partner_1",
      business: {businessName: "New Business"},
    });

    expect(partnerService.updatePartner).toHaveBeenCalledWith(
        "partner_1",
        {name: "New Business"},
    );
  });
});
