/**
 * @fileoverview Platform admin PATCH user profile.
 */

jest.mock("../admin", () => {
  const users = {};
  const FieldValue = {serverTimestamp: jest.fn(() => "TS")};
  const authUsers = {};

  return {
    firestore: Object.assign(
        () => ({
          collection: () => ({
            doc: (id) => ({
              get: async () => ({
                exists: !!users[id],
                data: () => users[id],
                id,
              }),
              update: async (patch) => {
                users[id] = {...users[id], ...patch};
              },
            }),
          }),
        }),
        {FieldValue},
    ),
    auth: () => ({
      getUser: async (uid) => {
        if (!authUsers[uid]) {
          const err = new Error("missing");
          err.code = "auth/user-not-found";
          throw err;
        }
        return authUsers[uid];
      },
      updateUser: jest.fn(async (uid, patch) => {
        authUsers[uid] = {...authUsers[uid], ...patch};
        return authUsers[uid];
      }),
    }),
    __state: {users, authUsers},
  };
});

jest.mock("../config", () => ({
  collections: {users: "users"},
}));

jest.mock("../utils/adminClaims", () => ({
  isSuperAdminUid: jest.fn().mockResolvedValue(false),
}));

jest.mock("../utils/transactions", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/platformConsumerService", () => ({
  getConsumerUser: jest.fn(async (userId) => {
    const admin = require("../admin");
    const d = admin.__state.users[userId];
    return d ? {userId, ...d} : null;
  }),
}));

const admin = require("../admin");
const {updatePlatformUser} = require("../services/platformUserAdminService");

describe("updatePlatformUser", () => {
  beforeEach(() => {
    Object.keys(admin.__state.users).forEach((k) => delete admin.__state.users[k]);
    Object.keys(admin.__state.authUsers).forEach((k) => delete admin.__state.authUsers[k]);
    admin.__state.users.uid_1 = {
      firstName: "abdullahi",
      lastName: "ali hassan",
      name: "abdullahi ali hassan",
      email: "abdalaalifanax@gmail.coma",
      phoneNumber: "+254712137171",
      status: "active",
      channel: "C2B",
    };
    admin.__state.authUsers.uid_1 = {
      uid: "uid_1",
      email: "abdalaalifanax@gmail.coma",
      customClaims: {},
    };
    jest.clearAllMocks();
  });

  it("corrects email via validation and syncs Auth", async () => {
    const result = await updatePlatformUser("admin_1", "uid_1", {
      email: "abdalaalifanax@gmail.com",
    }, {actorIsSuperAdmin: true});

    expect(result.updatedFields).toContain("email");
    expect(admin.__state.users.uid_1.email).toBe("abdalaalifanax@gmail.com");
    expect(admin.auth().updateUser).toHaveBeenCalledWith("uid_1", expect.objectContaining({
      email: "abdalaalifanax@gmail.com",
      emailVerified: false,
    }));
  });

  it("rejects gmail.coma", async () => {
    await expect(updatePlatformUser("admin_1", "uid_1", {
      email: "someone@gmail.coma",
    }, {actorIsSuperAdmin: true})).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_EMAIL",
    });
  });

  it("deactivates Auth when status is inactive", async () => {
    await updatePlatformUser("admin_1", "uid_1", {status: "Inactive"}, {actorIsSuperAdmin: true});
    expect(admin.__state.users.uid_1.status).toBe("inactive");
    expect(admin.auth().updateUser).toHaveBeenCalledWith("uid_1", {disabled: true});
  });

  it("rebuilds name from first/last", async () => {
    await updatePlatformUser("admin_1", "uid_1", {
      firstName: "Abdullahi",
      lastName: "Hassan",
    }, {actorIsSuperAdmin: true});
    expect(admin.__state.users.uid_1.name).toBe("Abdullahi Hassan");
  });

  it("rejects non-super-admins", async () => {
    await expect(updatePlatformUser("ops_admin", "uid_1", {name: "X"}, {actorIsSuperAdmin: false}))
        .rejects.toMatchObject({statusCode: 403});
  });

  it("404 when user is missing", async () => {
    await expect(updatePlatformUser("admin_1", "missing", {name: "X"}, {actorIsSuperAdmin: true}))
        .rejects.toMatchObject({statusCode: 404});
  });
});
