/**
 * @fileoverview Unit tests for Google → existing Firebase account linking.
 */

jest.mock("axios");
jest.mock("../admin", () => ({
  auth: jest.fn(),
}));

const axios = require("axios");
const admin = require("../admin");
const config = require("../config");
const googleAccountLinkService = require("../services/googleAccountLinkService");

const GOOGLE_JWT = "google.jwt.token";

function googlePayload(overrides = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: "web-client.apps.googleusercontent.com",
    sub: "google-sub-1",
    email: "ops@hotel.com",
    email_verified: "true",
    name: "Ops User",
    picture: "https://example.test/p.png",
    ...overrides,
  };
}

describe("googleAccountLinkService.completeGoogleLogin", () => {
  const getUserByEmail = jest.fn();
  const updateUser = jest.fn();
  const createUser = jest.fn();
  const createCustomToken = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    config.googleOauthClientIds = null;
    admin.auth.mockReturnValue({
      getUserByEmail,
      updateUser,
      createUser,
      createCustomToken,
    });
    axios.get.mockResolvedValue({data: googlePayload()});
    axios.post.mockResolvedValue({data: googlePayload()});
    createCustomToken.mockResolvedValue("custom_token_1");
    updateUser.mockResolvedValue({});
    createUser.mockResolvedValue({uid: "new_uid"});
  });

  afterEach(() => {
    config.googleOauthClientIds = null;
    delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
  });

  it("links Google to an existing verified password account and returns a custom token", async () => {
    getUserByEmail.mockResolvedValue({
      uid: "uid_1",
      email: "ops@hotel.com",
      emailVerified: true,
      disabled: false,
      displayName: "Ops User",
      providerData: [{providerId: "password", uid: "ops@hotel.com"}],
    });

    const result = await googleAccountLinkService.completeGoogleLogin(GOOGLE_JWT);

    expect(result).toEqual({
      uid: "uid_1",
      email: "ops@hotel.com",
      customToken: "custom_token_1",
      linked: true,
      created: false,
    });
    expect(updateUser).toHaveBeenCalledWith("uid_1", {
      providerToLink: {
        providerId: "google.com",
        uid: "google-sub-1",
        email: "ops@hotel.com",
        displayName: "Ops User",
        photoURL: "https://example.test/p.png",
      },
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(createCustomToken).toHaveBeenCalledWith("uid_1");
  });

  it("rejects Google login against an unverified password account", async () => {
    getUserByEmail.mockResolvedValue({
      uid: "uid_1",
      email: "ops@hotel.com",
      emailVerified: false,
      disabled: false,
      providerData: [{providerId: "password"}],
    });

    await expect(googleAccountLinkService.completeGoogleLogin(GOOGLE_JWT))
        .rejects.toMatchObject({code: "EMAIL_NOT_VERIFIED", statusCode: 403});
    expect(updateUser).not.toHaveBeenCalled();
    expect(createCustomToken).not.toHaveBeenCalled();
  });

  it("reuses an already-linked Google user without creating a second uid", async () => {
    getUserByEmail.mockResolvedValue({
      uid: "uid_1",
      email: "ops@hotel.com",
      emailVerified: true,
      disabled: false,
      displayName: "Ops User",
      providerData: [{providerId: "google.com", uid: "google-sub-1"}],
    });

    const result = await googleAccountLinkService.completeGoogleLogin(GOOGLE_JWT);

    expect(result).toMatchObject({
      uid: "uid_1",
      linked: false,
      created: false,
      customToken: "custom_token_1",
    });
    expect(updateUser).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it("creates a new Auth user when no email account exists", async () => {
    getUserByEmail.mockRejectedValue({code: "auth/user-not-found"});

    const result = await googleAccountLinkService.completeGoogleLogin(GOOGLE_JWT);

    expect(createUser).toHaveBeenCalledWith({
      email: "ops@hotel.com",
      emailVerified: true,
      displayName: "Ops User",
      photoURL: "https://example.test/p.png",
    });
    expect(updateUser).toHaveBeenCalledWith("new_uid", {
      providerToLink: expect.objectContaining({
        providerId: "google.com",
        uid: "google-sub-1",
      }),
    });
    expect(result).toEqual({
      uid: "new_uid",
      email: "ops@hotel.com",
      customToken: "custom_token_1",
      linked: true,
      created: true,
    });
  });

  it("rejects a token whose audience is not in GOOGLE_OAUTH_CLIENT_IDS", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_IDS = "other-client.apps.googleusercontent.com";

    await expect(googleAccountLinkService.completeGoogleLogin(GOOGLE_JWT))
        .rejects.toMatchObject({code: "INVALID_GOOGLE_AUDIENCE", statusCode: 401});
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it("rejects a missing token", async () => {
    await expect(googleAccountLinkService.completeGoogleLogin(""))
        .rejects.toMatchObject({code: "INVALID_ARGUMENT", statusCode: 400});
  });

  it("unwraps a GIS package string with id_token", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.e30.sig";
    expect(googleAccountLinkService.extractGoogleIdToken({
      token: JSON.stringify({
        iss: "https://accounts.google.com",
        id_token: jwt,
        prompt: "none",
      }),
    })).toBe(jwt);
  });
});
