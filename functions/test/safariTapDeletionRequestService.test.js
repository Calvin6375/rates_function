/**
 * @fileoverview Safari Tap deletion request notifies once and does not delete.
 */

const mockSet = jest.fn(async () => {});
const mockNotify = jest.fn(async () => ({
  notificationId: "notif_1",
  pushCount: 1,
}));

const users = {
  user_1: {
    exists: true,
    data: () => ({
      channel: "C2B",
      institution: "Customer App",
      name: "Amina",
      email: "amina@example.com",
    }),
  },
};

jest.mock("../admin", () => ({
  firestore: Object.assign(
      jest.fn(() => ({
        collection: () => ({
          doc: (id) => ({
            get: async () => users[id] || {exists: false, data: () => ({})},
            set: mockSet,
          }),
        }),
      })),
      {FieldValue: {serverTimestamp: jest.fn(() => "ts")}},
  ),
  auth: jest.fn(() => ({
    getUser: jest.fn(async (uid) => ({
      uid,
      email: "amina@example.com",
      displayName: "Amina",
      customClaims: {},
    })),
  })),
}));

jest.mock("../utils/notifications", () => ({
  notifySafariTapDeletionRequestAdmins: (...args) => mockNotify(...args),
}));

const {
  requestAccountDeletion,
} = require("../services/safariTapDeletionRequestService");

describe("requestAccountDeletion", () => {
  beforeEach(() => {
    mockSet.mockClear();
    mockNotify.mockClear();
    users.user_1.data = () => ({
      channel: "C2B",
      institution: "Customer App",
      name: "Amina",
      email: "amina@example.com",
    });
  });

  it("stores the request and notifies the super admin", async () => {
    const out = await requestAccountDeletion("user_1");
    expect(out.deletionRequested).toBe(true);
    expect(out.alreadyRequested).toBe(false);
    expect(out.notificationId).toBe("notif_1");
    expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({deletionRequested: true}),
        {merge: true},
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      userName: "Amina",
    }));
  });

  it("does not notify again when a request is already open", async () => {
    users.user_1.data = () => ({
      channel: "C2B",
      deletionRequested: true,
      name: "Amina",
    });
    const out = await requestAccountDeletion("user_1");
    expect(out.alreadyRequested).toBe(true);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
