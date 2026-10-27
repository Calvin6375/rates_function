/**
 * @fileoverview Partner org admin is notified when platform admin changes status.
 */

const mockSaved = [];

const mockCollection = jest.fn(() => ({
  doc: jest.fn((id) => ({
    id: id || "notif_status_1",
    set: jest.fn(async (data) => {
      mockSaved.push(data);
    }),
    get: jest.fn(async () => ({exists: false})),
    update: jest.fn(),
  })),
}));

jest.mock("../admin", () => ({
  firestore: Object.assign(
      jest.fn(() => ({collection: mockCollection})),
      {FieldValue: {serverTimestamp: jest.fn(() => "ts"), delete: jest.fn()}},
  ),
  messaging: jest.fn(() => ({send: jest.fn()})),
}));

const {notifyPartnerStatusChanged} = require("../utils/notifications");

describe("notifyPartnerStatusChanged", () => {
  beforeEach(() => {
    mockSaved.length = 0;
    mockCollection.mockClear();
  });

  it("stores a notification for the partner org admin", async () => {
    const result = await notifyPartnerStatusChanged({
      partnerId: "partner_1",
      partnerName: "Parry",
      previousStatus: "pending_review",
      status: "active",
      orgAdminUid: "owner_1",
    });

    expect(result.notificationId).toBe("notif_status_1");
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toEqual(expect.objectContaining({
      userId: "owner_1",
      type: "partner_status_changed",
      title: "Partner status updated",
      message: "Parry status changed from pending_review to active",
    }));
    expect(mockSaved[0].metadata).toEqual(expect.objectContaining({
      partnerId: "partner_1",
      previousStatus: "pending_review",
      status: "active",
    }));
  });

  it("does not notify when the partner has no org admin", async () => {
    const result = await notifyPartnerStatusChanged({
      partnerId: "partner_1",
      partnerName: "Parry",
      previousStatus: "pending_review",
      status: "active",
      orgAdminUid: null,
    });

    expect(result).toEqual({notificationId: null, pushCount: 0});
    expect(mockSaved).toHaveLength(0);
  });
});
