/**
 * @fileoverview Unit tests for account password change / reset.
 */

jest.mock("axios");
jest.mock("../admin", () => ({
  auth: jest.fn(),
}));

const axios = require("axios");
const admin = require("../admin");
const config = require("../config");
const accountPasswordService = require("../services/accountPasswordService");

describe("accountPasswordService.changePassword", () => {
  const updateUser = jest.fn();
  const getUser = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    config.firebaseWebApiKey = "test_web_api_key";
    admin.auth.mockReturnValue({getUser, updateUser});
    getUser.mockResolvedValue({
      uid: "uid_1",
      email: "ops@hotel.com",
      providerData: [{providerId: "password"}],
    });
    updateUser.mockResolvedValue({});
    axios.post.mockResolvedValue({
      data: {localId: "uid_1", email: "ops@hotel.com"},
    });
  });

  afterEach(() => {
    config.firebaseWebApiKey = null;
  });

  it("verifies current password then updates via Admin SDK", async () => {
    const result = await accountPasswordService.changePassword("uid_1", {
      currentPassword: "oldpass12",
      newPassword: "newpass34",
      confirmPassword: "newpass34",
    });

    expect(result).toEqual({success: true});
    expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining("accounts:signInWithPassword"),
        expect.objectContaining({
          email: "ops@hotel.com",
          password: "oldpass12",
        }),
        expect.any(Object),
    );
    expect(updateUser).toHaveBeenCalledWith("uid_1", {password: "newpass34"});
  });

  it("rejects Google-only accounts", async () => {
    getUser.mockResolvedValue({
      uid: "uid_1",
      email: "ops@gmail.com",
      providerData: [{providerId: "google.com"}],
    });

    await expect(accountPasswordService.changePassword("uid_1", {
      currentPassword: "oldpass12",
      newPassword: "newpass34",
    })).rejects.toMatchObject({code: "NO_PASSWORD_PROVIDER", statusCode: 400});
  });

  it("rejects password mismatch", async () => {
    await expect(accountPasswordService.changePassword("uid_1", {
      currentPassword: "oldpass12",
      newPassword: "newpass34",
      confirmPassword: "otherpass",
    })).rejects.toMatchObject({code: "PASSWORD_MISMATCH"});
  });

  it("rejects incorrect current password", async () => {
    axios.post.mockRejectedValue({
      response: {data: {error: {message: "INVALID_PASSWORD"}}},
    });

    await expect(accountPasswordService.changePassword("uid_1", {
      currentPassword: "wrongpass",
      newPassword: "newpass34",
    })).rejects.toMatchObject({code: "INVALID_CURRENT_PASSWORD", statusCode: 401});
  });
});

describe("accountPasswordService.requestPasswordResetEmail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.firebaseWebApiKey = "test_web_api_key";
    axios.post.mockResolvedValue({data: {}});
  });

  afterEach(() => {
    config.firebaseWebApiKey = null;
  });

  it("sends PASSWORD_RESET oob code", async () => {
    const result = await accountPasswordService.requestPasswordResetEmail({
      email: "ops@hotel.com",
    });
    expect(result).toEqual({success: true});
    expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining("accounts:sendOobCode"),
        expect.objectContaining({
          requestType: "PASSWORD_RESET",
          email: "ops@hotel.com",
        }),
        expect.any(Object),
    );
  });

  it("hides EMAIL_NOT_FOUND", async () => {
    axios.post.mockRejectedValue({
      response: {data: {error: {message: "EMAIL_NOT_FOUND"}}},
    });
    await expect(accountPasswordService.requestPasswordResetEmail({
      email: "missing@hotel.com",
    })).resolves.toEqual({success: true});
  });
});
