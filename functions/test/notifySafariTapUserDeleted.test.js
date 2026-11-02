/**
 * @fileoverview Super admin is notified when a Safari Tap user
 * requests account deletion.
 */

const mockSaved = [];

const mockCollection = jest.fn((name) => ({
  doc: jest.fn((id) => ({
    id: id || "notif_delete_1",
    set: jest.fn(async (data) => {
      mockSaved.push(data);
    }),
    get: jest.fn(async () => ({exists: false, data: () => ({})})),
  })),
  get: jest.fn(async () => ({docs: []})),
  name,
}));

jest.mock("../admin", () => ({
  firestore: Object.assign(
      jest.fn(() => ({collection: mockCollection})),
      {FieldValue: {serverTimestamp: jest.fn(() => "ts"), delete: jest.fn()}},
  ),
  messaging: jest.fn(() => ({send: jest.fn()})),
  auth: jest.fn(() => ({
    getUserByEmail: jest.fn(async () => {
      const err = new Error("not found");
      err.code = "auth/user-not-found";
      throw err;
    }),
  })),
}));

const {notifySafariTapDeletionRequestAdmins} = require("../utils/notifications");
const {isAdminAlertType} = require("../utils/notificationAccess");

describe("notifySafariTapDeletionRequestAdmins", () => {
  beforeEach(() => {
    mockSaved.length = 0;
    mockCollection.mockClear();
  });

  it("stores a system notification for the super admin", async () => {
    const result = await notifySafariTapDeletionRequestAdmins({
      userId: "user_1",
      userName: "Amina",
      email: "amina@example.com",
      phoneNumber: "+254700000000",
    });

    expect(result.notificationId).toBe("notif_delete_1");
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toEqual(expect.objectContaining({
      userId: "system",
      type: "safari_tap_deletion_request_admin_alert",
      title: "Safari Tap deletion request",
      message: "Amina requested account deletion",
    }));
    expect(mockSaved[0].metadata).toEqual(expect.objectContaining({
      userId: "user_1",
      action: "safari_tap_deletion_request",
    }));
    expect(isAdminAlertType("safari_tap_deletion_request_admin_alert")).toBe(
        true,
    );
  });
});
