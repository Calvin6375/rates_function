/**
 * @fileoverview Unit tests for B2B request-go-live.
 */

jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));
jest.mock("../admin", () => ({
  auth: jest.fn(() => ({
    getUser: jest.fn().mockResolvedValue({email: "owner@hotel.com"}),
    getUserByEmail: jest.fn(),
  })),
  firestore: Object.assign(jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({exists: false}),
        set: jest.fn(),
      })),
      get: jest.fn().mockResolvedValue({docs: []}),
    })),
  })), {
    FieldValue: {serverTimestamp: jest.fn()},
  }),
}));
jest.mock("../utils/customClaimsMerge", () => ({
  getCustomClaims: jest.fn(),
}));
jest.mock("../services/partnerService");
jest.mock("../utils/notifications", () => ({
  notifyGoLiveRequestAdmins: jest.fn().mockResolvedValue({
    notificationId: "notif_1",
    pushCount: 1,
  }),
}));

const {collection} = require("../libs/firestore");
const {getCustomClaims} = require("../utils/customClaimsMerge");
const partnerService = require("../services/partnerService");
const {notifyGoLiveRequestAdmins} = require("../utils/notifications");
const b2bOnboardingService = require("../services/b2bOnboardingService");

describe("requestGoLive", () => {
  let onboardingSet;
  let partnerSet;

  beforeEach(() => {
    jest.clearAllMocks();
    onboardingSet = jest.fn().mockResolvedValue(undefined);
    partnerSet = jest.fn().mockResolvedValue(undefined);

    getCustomClaims.mockResolvedValue({
      partnerId: "partner_1",
      role: "owner",
    });
    partnerService.getPartner.mockResolvedValue({
      id: "partner_1",
      name: "Acme Hotel",
      status: "pending_review",
      orgAdminUid: "uid_1",
    });

    collection.mockImplementation((name) => {
      if (name === "onboarding") {
        return {
          doc: () => ({
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({
                registeredPartnerId: "partner_1",
                onboardingStatus: "credentials_ready",
                owner: {fullName: "Azule Mwanzele"},
                progress: {},
              }),
            }),
            set: onboardingSet,
          }),
        };
      }
      if (name === "partners") {
        return {
          doc: () => ({
            set: partnerSet,
          }),
        };
      }
      return {
        doc: () => ({
          get: jest.fn().mockResolvedValue({exists: false}),
          set: jest.fn(),
        }),
      };
    });
  });

  it("records request and notifies super admins", async () => {
    const out = await b2bOnboardingService.requestGoLive("uid_1", {
      emailVerified: true,
      email: "owner@hotel.com",
    });

    expect(out.goLiveRequested).toBe(true);
    expect(out.alreadyRequested).toBe(false);
    expect(out.notificationId).toBe("notif_1");
    expect(notifyGoLiveRequestAdmins).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId: "partner_1",
          partnerName: "Acme Hotel",
          requestedByUid: "uid_1",
          ownerName: "Azule Mwanzele",
        }),
    );
    expect(onboardingSet).toHaveBeenCalled();
    expect(partnerSet).toHaveBeenCalled();
  });

  it("rejects unverified email", async () => {
    await expect(b2bOnboardingService.requestGoLive("uid_1", {
      emailVerified: false,
    })).rejects.toMatchObject({code: "EMAIL_NOT_VERIFIED", statusCode: 403});
    expect(notifyGoLiveRequestAdmins).not.toHaveBeenCalled();
  });

  it("is idempotent when already requested", async () => {
    collection.mockImplementation((name) => {
      if (name === "onboarding") {
        return {
          doc: () => ({
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({
                registeredPartnerId: "partner_1",
                onboardingStatus: "submitted",
                progress: {goLiveRequested: true},
              }),
            }),
            set: onboardingSet,
          }),
        };
      }
      if (name === "partners") {
        return {doc: () => ({set: partnerSet})};
      }
      return {doc: () => ({get: jest.fn(), set: jest.fn()})};
    });

    const out = await b2bOnboardingService.requestGoLive("uid_1", {
      emailVerified: true,
    });

    expect(out.alreadyRequested).toBe(true);
    expect(notifyGoLiveRequestAdmins).not.toHaveBeenCalled();
  });
});
