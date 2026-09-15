/**
 * @fileoverview Disbursement webhook records payout-account funds even on retry.
 */

jest.mock("../../admin", () => ({
  firestore: jest.fn(),
}));

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({
      get: jest.fn(async () => ({exists: false, data: () => null})),
      set: jest.fn(async () => undefined),
    })),
  })),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));

jest.mock("../../libs/payments", () => ({
  verifySignature: jest.fn(() => false),
}));

jest.mock("../../services/safariCard/safariCardPayoutService", () => ({
  applyProviderStatusUpdate: jest.fn(async () => ({handled: true, payout: {payoutId: "p1"}})),
}));

jest.mock("../../services/platformFundsService", () => ({
  recordPayoutAccountFromDisbursement: jest.fn(async () => ({
    recorded: true,
    snapshot: {currentBalance: 852.04},
  })),
}));

const {collection} = require("../../libs/firestore");
const safariCardPayoutService = require("../../services/safariCard/safariCardPayoutService");
const platformFundsService = require("../../services/platformFundsService");
const {
  processDisbursementWebhook,
} = require("../../services/safariCard/safariCardPayoutWebhookService");

describe("processDisbursementWebhook funds snapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    collection.mockReturnValue({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({exists: false, data: () => null})),
        set: jest.fn(async () => undefined),
      })),
    });
  });

  it("records payout account before applying payout status", async () => {
    const payload = {
      tracking_id: "3c23562d-9d9a-4f27-aea5-5b6bb24f5044",
      status_code: "BC100",
      wallet: {current_balance: "852.04", currency: "KES"},
    };

    const result = await processDisbursementWebhook(payload);

    expect(platformFundsService.recordPayoutAccountFromDisbursement).toHaveBeenCalledWith(payload);
    expect(safariCardPayoutService.applyProviderStatusUpdate).toHaveBeenCalledWith(payload);
    expect(result.funds.recorded).toBe(true);
  });

  it("still records funds when the webhook event is a duplicate", async () => {
    collection.mockReturnValue({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: true,
          data: () => ({processed: true}),
        })),
        set: jest.fn(async () => undefined),
      })),
    });

    const payload = {tracking_id: "dup", status_code: "BC100"};
    const result = await processDisbursementWebhook(payload);

    expect(result.duplicate).toBe(true);
    expect(platformFundsService.recordPayoutAccountFromDisbursement).toHaveBeenCalledWith(payload);
    expect(safariCardPayoutService.applyProviderStatusUpdate).not.toHaveBeenCalled();
  });
});
