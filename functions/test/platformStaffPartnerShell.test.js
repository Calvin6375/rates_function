/**
 * @fileoverview Platform staff must not show up as pending_review partners.
 */

jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../utils/accessControl", () => ({
  isPlatformAdmin: jest.fn(),
}));

const {collection} = require("../libs/firestore");
const accessControl = require("../utils/accessControl");
const {listPartnersForConsole} = require("../services/partnerService");

/**
 * @param {Array<{id: string, data: Object}>} rows
 */
function mockPartnerPage(rows) {
  const docs = rows.map((row) => ({
    id: row.id,
    data: () => row.data,
  }));
  const query = {
    orderBy: jest.fn(() => query),
    limit: jest.fn(() => query),
    startAfter: jest.fn(() => query),
    get: jest.fn().mockResolvedValue({docs}),
  };
  collection.mockReturnValue(query);
}

describe("listPartnersForConsole", () => {
  it("hides onboarding shells owned by platform staff and keeps real merchants", async () => {
    accessControl.isPlatformAdmin.mockImplementation(async (_token, uid) => uid === "staff_calvin");
    mockPartnerPage([
      {
        id: "partner_shell",
        data: {
          name: "calvinrumba8",
          status: "pending_review",
          orgAdminUid: "staff_calvin",
          apiKey: "secretkeyvalue",
        },
      },
      {
        id: "partner_live",
        data: {
          name: "keyah tours",
          status: "active",
          orgAdminUid: "staff_calvin",
          apiKey: "secretkeyvalue",
        },
      },
      {
        id: "partner_admin_ops",
        data: {
          name: "Admin Ops",
          status: "pending_review",
          orgAdminUid: "merchant_user",
          apiKey: "secretkeyvalue",
        },
      },
    ]);

    const {partners} = await listPartnersForConsole(50, null);
    expect(partners.map((partner) => partner.name)).toEqual([
      "keyah tours",
      "Admin Ops",
    ]);
    expect(partners[0].apiKey).toBeUndefined();
  });
});
