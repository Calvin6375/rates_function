/**
 * @fileoverview Super-admin custom notification targeting.
 */

jest.mock("../utils/notifications", () => ({
  NOTIFICATION_TYPES: {
    ADMIN_CUSTOM: "admin_custom",
    ADMIN_SYSTEM: "system",
    PROMOTION: "promotion",
  },
  createNotification: jest.fn(),
}));

jest.mock("../utils/transactions", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../admin", () => ({
  firestore: () => ({
    collection: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({docs: []}),
        }),
      }),
    }),
  }),
}));

jest.mock("../config", () => ({
  collections: {users: "users"},
}));

const {createNotification} = require("../utils/notifications");
const {sendCustomNotification} = require("../services/platformNotificationService");

describe("sendCustomNotification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createNotification.mockResolvedValue({notificationId: "n1", sent: true});
  });

  it("sends to an explicit userId", async () => {
    const out = await sendCustomNotification("admin_1", {
      userId: "uid_abc",
      title: "Rates update",
      message: "UGX top-ups are live.",
    });
    expect(out.requested).toBe(1);
    expect(out.pushSent).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: "uid_abc",
      title: "Rates update",
      type: "admin_custom",
    }));
  });

  it("rejects empty title", async () => {
    await expect(sendCustomNotification("admin_1", {
      userId: "uid_abc",
      title: "",
      message: "Hi",
    })).rejects.toMatchObject({statusCode: 400});
  });

  it("rejects missing audience", async () => {
    await expect(sendCustomNotification("admin_1", {
      title: "Hello",
      message: "World",
    })).rejects.toMatchObject({statusCode: 400});
  });

  it("writes a Safari Tap promotion the app can show on the Promotions tab", async () => {
    const out = await sendCustomNotification("admin_1", {
      audience: "c2b",
      userIds: ["uid_abc"],
      title: "Weekend rate boost",
      message: "Send KES this weekend and earn a fee waiver on your first transfer.",
      actionUrl: "/wallet",
      type: "promotion",
    });

    expect(out.type).toBe("promotion");
    expect(out.requested).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: "uid_abc",
      type: "promotion",
      actionUrl: "/wallet",
      sendPush: true,
      metadata: expect.objectContaining({
        category: "promotion",
        source: "platform_admin_promotion",
        sentBy: "admin_1",
      }),
    }));
  });

  it("writes an explicit system inbox row when type is system", async () => {
    await sendCustomNotification("admin_1", {
      userId: "uid_abc",
      title: "Topup Error",
      message: "Hi Abdullahi, we have fixed the issue.",
      type: "system",
    });

    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: "system",
      metadata: expect.objectContaining({
        category: "system",
        source: "platform_admin_system",
      }),
    }));
  });
});
