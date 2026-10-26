/**
 * @fileoverview Super-admin ops endpoint auth and job dispatch.
 */

const http = require("http");

jest.mock("../libs/auth", () => ({
  verifyFirebaseAuth: jest.fn(),
}));

jest.mock("../utils/accessControl", () => ({
  isSuperAdmin: jest.fn(),
}));

jest.mock("../services/crypto/cryptoRailSecrets", () => ({
  getCryptoFunctionSecrets: () => [],
}));

jest.mock("../services/settlement/settlementRetryService", () => ({
  processRetryableJobs: jest.fn(async () => ({retried: 1})),
}));

jest.mock("../services/ledger/fiatReservationService", () => ({
  releaseExpiredReservations: jest.fn(async () => ({released: 0})),
}));

jest.mock("../services/funding/fundingReconciliationService", () => ({
  reconcileStaleFundingOrders: jest.fn(async () => ({scanned: 0})),
}));

jest.mock("../jobs/reconcileCircleLedger", () => ({
  runCircleLedgerReconciliation: jest.fn(async () => ({checked: 1})),
}));

jest.mock("../services/crypto/reconcileCryptoLedgerService", () => ({
  runCryptoLedgerReconciliation: jest.fn(async () => ({checked: 2})),
}));

jest.mock("firebase-functions/params", () => ({
  defineSecret: (name) => ({name}),
}));

jest.mock("firebase-functions/v2/https", () => ({
  onRequest: (_opts, handler) => handler,
}));

const {verifyFirebaseAuth} = require("../libs/auth");
const {isSuperAdmin} = require("../utils/accessControl");
const {processRetryableJobs} = require("../services/settlement/settlementRetryService");
const {app} = require("../http/opsAdminHttp");

/**
 * @param {Object} options
 * @returns {Promise<{ status: number, body: Object }>}
 */
function request(options) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address();
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: options.path,
        method: options.method || "POST",
        headers: options.headers || {},
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          server.close();
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            body: text ? JSON.parse(text) : {},
          });
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

describe("opsAdmin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a caller who is not the super admin", async () => {
    verifyFirebaseAuth.mockResolvedValue({
      success: true,
      userId: "user_1",
      decodedToken: {uid: "user_1"},
    });
    isSuperAdmin.mockResolvedValue(false);

    const response = await request({
      path: "/ops/retry-settlement-jobs",
      headers: {authorization: "Bearer token"},
    });

    expect(response.status).toBe(403);
    expect(processRetryableJobs).not.toHaveBeenCalled();
  });

  it("runs the settlement retry for the super admin", async () => {
    verifyFirebaseAuth.mockResolvedValue({
      success: true,
      userId: "admin_1",
      decodedToken: {uid: "admin_1", role: "super_admin"},
    });
    isSuperAdmin.mockResolvedValue(true);

    const response = await request({
      path: "/opsAdmin/ops/retry-settlement-jobs",
      headers: {authorization: "Bearer token"},
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      job: "retry-settlement-jobs",
      result: {retried: 1},
    });
    expect(processRetryableJobs).toHaveBeenCalledTimes(1);
  });
});
