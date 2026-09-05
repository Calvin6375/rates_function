/**
 * @fileoverview C2B register reuses Auth when Flutter created it first.
 */

jest.mock("../admin", () => {
  const authUsers = {};
  const firestoreUsers = {};
  const FieldValue = {serverTimestamp: jest.fn(() => "TS")};

  function notFound(code = "auth/user-not-found") {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  const authApi = {
    createUser: jest.fn(async ({email, password, displayName}) => {
      const existing = Object.values(authUsers).find(
          (u) => u.email === email,
      );
      if (existing) {
        const err = new Error("exists");
        err.code = "auth/email-already-exists";
        throw err;
      }
      const uid = `uid_${email.split("@")[0]}`;
      authUsers[uid] = {uid, email, password, displayName};
      return authUsers[uid];
    }),
    getUserByEmail: jest.fn(async (email) => {
      const rec = Object.values(authUsers).find((u) => u.email === email);
      if (!rec) throw notFound();
      return rec;
    }),
    updateUser: jest.fn(async (uid, patch) => {
      authUsers[uid] = {...authUsers[uid], ...patch};
      return authUsers[uid];
    }),
    deleteUser: jest.fn(async (uid) => {
      delete authUsers[uid];
    }),
  };

  return {
    auth: () => authApi,
    firestore: Object.assign(
        () => ({
          collection: () => ({
            doc: (id) => ({
              get: async () => ({
                exists: !!firestoreUsers[id],
                data: () => firestoreUsers[id],
              }),
              set: async (data) => {
                firestoreUsers[id] = {...(firestoreUsers[id] || {}), ...data};
              },
            }),
          }),
        }),
        {FieldValue},
    ),
    __state: {authUsers, firestoreUsers, authApi},
  };
});

jest.mock("../config", () => ({
  collections: {users: "users"},
}));

jest.mock("../utils/customerAppProvisioning", () => ({
  INSTITUTION_CUSTOMER_APP: "Customer App",
  CHANNEL_C2B: "C2B",
  parseCustomerAppProvisioningFields: (body) => {
    if (body.Institution === "Customer App" && body.Channel === "C2B") {
      return {institution: "Customer App", channel: "C2B"};
    }
    return null;
  },
}));

jest.mock("../utils/accessControl", () => ({
  USER_TYPE_CUSTOMER: "customer",
  setCustomerAccessClaims: jest.fn().mockResolvedValue(undefined),
}));

const admin = require("../admin");
const {
  registerC2bCustomer,
} = require("../services/customerSelfRegistrationService");

const baseBody = {
  Institution: "Customer App",
  Channel: "C2B",
  firstName: "Jackline",
  lastName: "Adamba",
  email: "jacklineadamba@gmail.com",
  phoneNumber: "+254745726475",
  password: "Jayden2014.",
};

describe("registerC2bCustomer", () => {
  beforeEach(() => {
    Object.keys(admin.__state.authUsers).forEach(
        (k) => delete admin.__state.authUsers[k],
    );
    Object.keys(admin.__state.firestoreUsers).forEach(
        (k) => delete admin.__state.firestoreUsers[k],
    );
  });

  it("creates Auth + profile when email is new", async () => {
    const result = await registerC2bCustomer(baseBody);
    expect(result.userId).toBe("uid_jacklineadamba");
    expect(admin.__state.firestoreUsers.uid_jacklineadamba.email)
        .toBe("jacklineadamba@gmail.com");
  });

  it("reuses Auth created by Flutter and writes profile", async () => {
    admin.__state.authUsers.uid_jacklineadamba = {
      uid: "uid_jacklineadamba",
      email: "jacklineadamba@gmail.com",
      password: "old",
      displayName: "temp",
    };

    const result = await registerC2bCustomer(baseBody);
    expect(result.userId).toBe("uid_jacklineadamba");
    expect(admin.__state.firestoreUsers.uid_jacklineadamba.channel).toBe("C2B");
    expect(admin.__state.authApi.updateUser).toHaveBeenCalled();
  });

  it("rejects when a completed customer profile already exists", async () => {
    admin.__state.authUsers.uid_jacklineadamba = {
      uid: "uid_jacklineadamba",
      email: "jacklineadamba@gmail.com",
    };
    admin.__state.firestoreUsers.uid_jacklineadamba = {
      email: "jacklineadamba@gmail.com",
      channel: "C2B",
      institution: "Customer App",
      firstName: "Jackline",
    };

    await expect(registerC2bCustomer(baseBody)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/already exists/i),
    });
  });

  it("rejects typo emails like gmail.coma", async () => {
    await expect(registerC2bCustomer({
      ...baseBody,
      email: "abdalaalifanax@gmail.coma",
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_EMAIL",
      message: expect.stringMatching(/did you mean abdalaalifanax@gmail\.com/i),
    });
    expect(Object.keys(admin.__state.authUsers)).toHaveLength(0);
  });

  it("rejects missing email", async () => {
    await expect(registerC2bCustomer({
      ...baseBody,
      email: "",
    })).rejects.toMatchObject({
      statusCode: 400,
      message: "A valid email is required",
    });
  });
});
