/**
 * @fileoverview Hard-delete must free Auth email for re-signup.
 */

jest.mock("../admin", () => {
  const users = {};
  const authUsers = {};
  const customerWallets = [];

  function notFound(code = "auth/user-not-found") {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  const auth = {
    getUser: jest.fn(async (uid) => {
      if (!authUsers[uid]) throw notFound();
      return authUsers[uid];
    }),
    getUserByEmail: jest.fn(async (email) => {
      const rec = Object.values(authUsers).find(
          (u) => String(u.email).toLowerCase() === String(email).toLowerCase(),
      );
      if (!rec) throw notFound();
      return rec;
    }),
    getUserByPhoneNumber: jest.fn(async (phone) => {
      const rec = Object.values(authUsers).find((u) => u.phoneNumber === phone);
      if (!rec) throw notFound();
      return rec;
    }),
    deleteUser: jest.fn(async (uid) => {
      if (!authUsers[uid]) throw notFound();
      delete authUsers[uid];
    }),
  };

  const db = {
    collection: (name) => ({
      doc: (id) => ({
        id,
        path: `${name}/${id}`,
        get: async () => {
          if (name === "users") {
            const data = users[id];
            return {exists: !!data, data: () => data, id};
          }
          return {exists: false, data: () => ({}), id};
        },
      }),
      where: (field, _op, value) => ({
        limit: () => ({
          get: async () => {
            if (name === "users" && field === "email") {
              const docs = Object.entries(users)
                  .filter(([, d]) => d && d.email === value)
                  .map(([docId, data]) => ({
                    id: docId,
                    data: () => data,
                    ref: {delete: async () => delete users[docId]},
                  }));
              return {docs, empty: docs.length === 0};
            }
            if (name === "customerWallets" && field === "email") {
              const docs = customerWallets
                  .filter((w) => w.email === value)
                  .map((w) => ({
                    id: w.id,
                    data: () => w,
                    ref: {
                      delete: async () => {
                        const i = customerWallets.findIndex((x) => x.id === w.id);
                        if (i >= 0) customerWallets.splice(i, 1);
                      },
                    },
                  }));
              return {docs, empty: docs.length === 0};
            }
            return {docs: [], empty: true};
          },
        }),
      }),
    }),
    recursiveDelete: async (ref) => {
      const path = (ref && ref.path) || "";
      const [col, id] = path.split("/");
      if (col === "users" && id) delete users[id];
      if (col === "customerWallets" && id) {
        const i = customerWallets.findIndex((w) => w.id === id);
        if (i >= 0) customerWallets.splice(i, 1);
      }
    },
  };

  return {
    auth: () => auth,
    firestore: jest.fn(() => db),
    database: () => ({
      ref: () => ({
        once: async () => ({exists: () => false}),
        remove: async () => undefined,
      }),
    }),
    __state: {users, authUsers, customerWallets, auth},
  };
});

jest.mock("../config", () => ({
  collections: {
    users: "users",
    transactions: "transactions",
    onboarding: "onboarding",
    customerWallets: "customerWallets",
  },
}));

const admin = require("../admin");
const {
  purgeUserAccount,
  resolveAuthIdentitiesForDelete,
} = require("../libs/userAuthDataCleanup");

describe("purgeUserAccount", () => {
  beforeEach(() => {
    const {users, authUsers, customerWallets} = admin.__state;
    Object.keys(users).forEach((k) => delete users[k]);
    Object.keys(authUsers).forEach((k) => delete authUsers[k]);
    customerWallets.splice(0, customerWallets.length);
    admin.__state.auth.deleteUser.mockClear();
  });

  it("deletes Auth by email when Firestore doc id is not the Auth uid", async () => {
    admin.__state.users.fs_orphan = {
      email: "ruben@gmail.com",
      phoneNumber: "+254739614369",
    };
    admin.__state.authUsers.auth_real = {
      uid: "auth_real",
      email: "ruben@gmail.com",
      phoneNumber: null,
    };

    const identities = await resolveAuthIdentitiesForDelete("fs_orphan");
    expect(identities.uids).toEqual(expect.arrayContaining(["auth_real", "fs_orphan"]));

    const result = await purgeUserAccount("fs_orphan", {protectedUids: ["admin_1"]});
    expect(result.authDeletedUids).toContain("auth_real");
    expect(admin.__state.authUsers.auth_real).toBeUndefined();
    expect(admin.__state.users.fs_orphan).toBeUndefined();
  });

  it("does not delete the actor Auth user", async () => {
    admin.__state.users.admin_1 = {email: "admin@truepay.africa"};
    admin.__state.authUsers.admin_1 = {
      uid: "admin_1",
      email: "admin@truepay.africa",
    };

    await purgeUserAccount("admin_1", {protectedUids: ["admin_1"]});
    expect(admin.__state.authUsers.admin_1).toBeDefined();
  });
});
