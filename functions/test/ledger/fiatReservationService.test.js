/**
 * @fileoverview Expiry release must not overwrite a reservation confirmed concurrently.
 */

const mockReservationRef = { path: "pendingFiatReservations/fres_req_1" };

const mockQuerySnap = {
  docs: [
    {
      id: "fres_req_1",
      ref: mockReservationRef,
    },
  ],
};

const mockWhereResult = {
  where: jest.fn(),
  limit: jest.fn(),
  get: jest.fn(async () => mockQuerySnap),
};
mockWhereResult.where.mockReturnValue(mockWhereResult);
mockWhereResult.limit.mockReturnValue(mockWhereResult);

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(() => mockWhereResult),
  serverTimestamp: jest.fn(() => "server-ts"),
}));

const mockRunTransaction = jest.fn();

jest.mock("../../services/ledger/fiatLedgerService", () => ({
  getLedgerBalance: jest.fn(),
}));

jest.mock("../../admin", () => ({
  firestore: Object.assign(
      jest.fn(() => ({ runTransaction: mockRunTransaction })),
      {
        Timestamp: {
          now: jest.fn(() => "now"),
          fromDate: jest.fn((date) => date),
        },
      },
  ),
}));

const { releaseExpiredReservations } = require("../../services/ledger/fiatReservationService");

describe("releaseExpiredReservations", () => {
  it("does not release a reservation that is no longer reserved", async () => {
    const txUpdate = jest.fn();
    mockRunTransaction.mockImplementationOnce(async (fn) => fn({
      get: jest.fn(async () => ({
        exists: true,
        data: () => ({ status: "confirmed" }),
      })),
      update: txUpdate,
    }));

    const result = await releaseExpiredReservations();

    expect(result).toEqual({ released: 0 });
    expect(txUpdate).not.toHaveBeenCalled();
  });
});
