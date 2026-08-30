/**
 * @fileoverview Safari Card payout service tests (mocked persistence).
 */

jest.mock("../../admin", () => {
  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: true,
          data: () => ({ name: "Jane Doe", phoneNumber: "254712345678" }),
        })),
      })),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn(async () => ({ empty: true, docs: [] })),
    })),
  }));
  firestoreFn.FieldValue = {
    serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
    arrayUnion: jest.fn((v) => ({ _arrayUnion: v })),
  };
  return { firestore: firestoreFn };
});

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
}));

jest.mock("../../services/walletService", () => ({
  getFiatAvailableBalance: jest.fn(),
  debitUserFiat: jest.fn(),
  creditUserFiat: jest.fn(),
}));

jest.mock("../../services/transactionService", () => ({
  TRANSACTION_TYPES: { withdrawal: "withdrawal", funding: "funding" },
  STATUSES: { completed: "completed", failed: "failed" },
  createTransactionRecord: jest.fn().mockResolvedValue({ transactionId: "txr_sc_1" }),
}));

jest.mock("../../libs/sendMoney", () => ({
  resolveRecipientUserId: jest.fn(),
}));

jest.mock("../../services/ledger/fiatReservationService", () => ({
  reserveFunds: jest.fn(),
  confirmReservation: jest.fn(),
  releaseReservation: jest.fn(),
}));

jest.mock("../../services/intasend/intasendDisbursementProvider", () => ({
  DISBURSEMENT_PROVIDERS: {
    MPESA_B2C: "MPESA-B2C",
    MPESA_B2B: "MPESA-B2B",
    PESALINK: "PESALINK",
  },
  initiateAndApproveSendMoney: jest.fn(),
  buildMpesaB2cTransaction: jest.requireActual("../../services/intasend/intasendDisbursementProvider")
      .buildMpesaB2cTransaction,
  buildMpesaB2bTransaction: jest.requireActual("../../services/intasend/intasendDisbursementProvider")
      .buildMpesaB2bTransaction,
  buildBankTransaction: jest.requireActual("../../services/intasend/intasendDisbursementProvider")
      .buildBankTransaction,
}));

const { collection } = require("../../libs/firestore");
const walletService = require("../../services/walletService");
const fiatReservationService = require("../../services/ledger/fiatReservationService");
const intasendDisbursement = require("../../services/intasend/intasendDisbursementProvider");
const { resolveRecipientUserId } = require("../../libs/sendMoney");
const safariCardPayoutService = require("../../services/safariCard/safariCardPayoutService");
const { PAYOUT_STATUS, ERROR_CODES } = require("../../utils/safariCardPayoutTypes");

describe("safariCardPayoutService.createPayout", () => {
  /** @type {Map<string, Object>} */
  let store;
  let payoutIdCounter;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new Map();
    payoutIdCounter = 0;

    walletService.getFiatAvailableBalance.mockResolvedValue(10000);
    walletService.debitUserFiat.mockResolvedValue({
      previousBalance: 10000,
      newBalance: 5000,
      ledgerEntryId: "fl_test",
    });
    walletService.creditUserFiat.mockResolvedValue({
      previousBalance: 0,
      newBalance: 500,
      ledgerEntryId: "fl_credit",
    });
    resolveRecipientUserId.mockResolvedValue("user_recipient");
    fiatReservationService.reserveFunds.mockResolvedValue({ reservationId: "fres_test" });
    fiatReservationService.confirmReservation.mockResolvedValue(undefined);
    fiatReservationService.releaseReservation.mockResolvedValue(undefined);

    intasendDisbursement.initiateAndApproveSendMoney.mockResolvedValue({
      tracking_id: "track-123",
      status_code: "BP109",
      status: "Sending payment",
      transactions: [{
        status_code: "TP101",
        status: "Pending",
        transaction_id: "txprov_1",
      }],
    });

    collection.mockImplementation((name) => {
      const col = {
        doc: (id) => {
          const docId = id || `payout_${++payoutIdCounter}`;
          const ref = {
            id: docId,
            set: jest.fn(async (data) => {
              store.set(`${name}/${docId}`, { ...(store.get(`${name}/${docId}`) || {}), ...data });
            }),
            update: jest.fn(async (data) => {
              const existing = store.get(`${name}/${docId}`) || {};
              store.set(`${name}/${docId}`, { ...existing, ...data });
            }),
            get: jest.fn(async () => ({
              exists: store.has(`${name}/${docId}`),
              id: docId,
              data: () => store.get(`${name}/${docId}`) || null,
            })),
          };
          return ref;
        },
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn(async () => ({
          empty: true,
          docs: [],
        })),
      };
      return col;
    });
  });

  it("rejects insufficient balance", async () => {
    walletService.getFiatAvailableBalance.mockResolvedValue(100);
    await expect(safariCardPayoutService.createPayout("user_1", {
      type: "MPESA_B2C",
      amount: 5000,
      currency: "KES",
      clientRequestId: "req-insufficient-001",
      recipient: { phoneNumber: "254712345678" },
    })).rejects.toMatchObject({ code: ERROR_CODES.INSUFFICIENT_BALANCE });
  });

  it("creates payout, reserves funds, and calls IntaSend", async () => {
    const result = await safariCardPayoutService.createPayout("user_1", {
      type: "MPESA_B2C",
      amount: 5000,
      currency: "KES",
      clientRequestId: "req-create-001",
      recipient: { phoneNumber: "254712345678" },
    });

    expect(fiatReservationService.reserveFunds).toHaveBeenCalled();
    expect(intasendDisbursement.initiateAndApproveSendMoney).toHaveBeenCalled();
    expect(result.status).toBe(PAYOUT_STATUS.PROCESSING);
    expect(result.clientRequestId).toBeUndefined();
    expect(result.providerTrackingId).toBeUndefined();
  });

  it("returns existing payout for duplicate clientRequestId", async () => {
    store.set("safariCardPayoutIdempotency/scpi_user_1_req-dup-001", {
      payoutId: "payout_existing",
      userId: "user_1",
    });
    store.set("safariCardPayouts/payout_existing", {
      payoutId: "payout_existing",
      userId: "user_1",
      clientRequestId: "req-dup-001",
      status: PAYOUT_STATUS.PROCESSING,
      amount: 5000,
      currency: "KES",
      fee: 0,
      totalDebit: 5000,
      type: "MPESA_B2C",
      provider: "intasend",
      recipient: { phoneNumber: "254712345678", name: "Jane" },
    });

    const result = await safariCardPayoutService.createPayout("user_1", {
      type: "MPESA_B2C",
      amount: 5000,
      currency: "KES",
      clientRequestId: "req-dup-001",
      recipient: { phoneNumber: "254712345678" },
    });

    expect(result.clientRequestId).toBeUndefined();
    expect(result.payoutId).toBeUndefined();
    expect(intasendDisbursement.initiateAndApproveSendMoney).not.toHaveBeenCalled();
  });

  it("finalizes success on immediate provider success", async () => {
    intasendDisbursement.initiateAndApproveSendMoney.mockResolvedValue({
      tracking_id: "track-success",
      status_code: "BC100",
      transactions: [{
        status_code: "TS100",
        transaction_id: "txprov_ok",
        provider_reference: "MPX123",
      }],
    });

    const result = await safariCardPayoutService.createPayout("user_1", {
      type: "MPESA_B2C",
      amount: 1000,
      currency: "KES",
      clientRequestId: "req-success-001",
      recipient: { phoneNumber: "254712345678" },
    });

    expect(result.status).toBe(PAYOUT_STATUS.SUCCESS);
    expect(walletService.debitUserFiat).toHaveBeenCalled();
    expect(fiatReservationService.confirmReservation).toHaveBeenCalled();
  });

  it("releases reservation on provider failure", async () => {
    intasendDisbursement.initiateAndApproveSendMoney.mockResolvedValue({
      tracking_id: "track-fail",
      status_code: "BF102",
      transactions: [{ status_code: "TF106", status_description: "Failed" }],
    });

    await expect(safariCardPayoutService.createPayout("user_1", {
      type: "MPESA_B2C",
      amount: 1000,
      currency: "KES",
      clientRequestId: "req-fail-001",
      recipient: { phoneNumber: "254712345678" },
    })).rejects.toMatchObject({ code: ERROR_CODES.PAYOUT_FAILED });

    expect(fiatReservationService.releaseReservation).toHaveBeenCalled();
  });

  it("completes SAFARITAP_WALLET as internal ledger transfer", async () => {
    const result = await safariCardPayoutService.createPayout("user_1", {
      type: "SAFARITAP_WALLET",
      amount: 500,
      currency: "KES",
      clientRequestId: "req-wallet-001",
      recipient: { phoneNumber: "254712345678", name: "Jane Doe" },
      narrative: "SafariTap wallet transfer",
    });

    expect(intasendDisbursement.initiateAndApproveSendMoney).not.toHaveBeenCalled();
    expect(walletService.debitUserFiat).toHaveBeenCalledWith(
        "user_1",
        500,
        "KES",
        expect.objectContaining({ source: "safaritap_wallet_transfer" }),
    );
    expect(walletService.creditUserFiat).toHaveBeenCalledWith(
        "user_recipient",
        500,
        "KES",
        expect.objectContaining({ source: "safaritap_wallet_transfer" }),
    );
    expect(fiatReservationService.confirmReservation).toHaveBeenCalled();
    expect(result.status).toBe(PAYOUT_STATUS.SUCCESS);
    expect(result.provider).toBe("truepay");
    expect(result.recipientUserId).toBe("user_recipient");
  });

  it("rejects SAFARITAP_WALLET self-transfer", async () => {
    resolveRecipientUserId.mockResolvedValue("user_1");
    await expect(safariCardPayoutService.createPayout("user_1", {
      type: "SAFARITAP_WALLET",
      amount: 500,
      currency: "KES",
      clientRequestId: "req-wallet-self-001",
      recipient: { phoneNumber: "254712345678" },
    })).rejects.toMatchObject({ code: ERROR_CODES.SELF_TRANSFER });
    expect(intasendDisbursement.initiateAndApproveSendMoney).not.toHaveBeenCalled();
  });
});
