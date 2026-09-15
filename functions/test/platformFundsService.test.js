/**
 * @fileoverview Platform Funds: IntaSend payout wallet snapshot + admin read model.
 */

const mockStore = {
  payout: null,
  snapshots: {},
};

function mockSnapshotQuery(limit, startAfterId) {
  const rows = Object.entries(mockStore.snapshots)
      .map(([id, data]) => ({id, data}))
      .sort((a, b) => String(b.data.providerUpdatedAtIso || b.data.recordedAtIso)
          .localeCompare(String(a.data.providerUpdatedAtIso || a.data.recordedAtIso)));
  let start = 0;
  if (startAfterId) {
    const idx = rows.findIndex((row) => row.id === startAfterId);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = rows.slice(start, start + limit);
  return {
    docs: page.map((row) => ({
      id: row.id,
      data: () => row.data,
    })),
  };
}

jest.mock("../libs/firestore", () => ({
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
  collection: jest.fn((name) => {
    if (name !== "platformFunds") {
      throw new Error(`Unexpected collection ${name}`);
    }
    return {
      doc: (docId) => {
        if (docId !== "payoutAccount") {
          throw new Error(`Unexpected funds doc ${docId}`);
        }
        return {
          get: async () => ({
            exists: !!mockStore.payout,
            data: () => mockStore.payout,
          }),
          set: async (data) => {
            mockStore.payout = {...(mockStore.payout || {}), ...data};
          },
          collection: (sub) => {
            if (sub !== "snapshots") throw new Error(`Unexpected sub ${sub}`);
            return {
              doc: (id) => ({
                get: async () => ({
                  exists: !!mockStore.snapshots[id],
                  data: () => mockStore.snapshots[id],
                }),
                set: async (data) => {
                  mockStore.snapshots[id] = {...(mockStore.snapshots[id] || {}), ...data};
                },
              }),
              orderBy: () => ({
                limit: (n) => ({
                  get: async () => mockSnapshotQuery(n, null),
                  startAfter: (cursorDoc) => ({
                    limit: (m) => ({
                      get: async () => mockSnapshotQuery(m, cursorDoc.id),
                    }),
                  }),
                }),
                startAfter: (cursorDoc) => ({
                  limit: (m) => ({
                    get: async () => mockSnapshotQuery(m, cursorDoc.id),
                  }),
                }),
              }),
            };
          },
        };
      },
    };
  }),
}));

const {
  extractPayoutWalletSnapshot,
  recordPayoutAccountFromDisbursement,
  getPlatformFunds,
  listFundHistory,
} = require("../services/platformFundsService");

const WEBHOOK = {
  file_id: "Y2PMNGP",
  tracking_id: "3c23562d-9d9a-4f27-aea5-5b6bb24f5044",
  batch_reference: "VRpT06ZtXgxvz183ZL4I",
  status: "Completed",
  status_code: "BC100",
  transactions: [{
    transaction_id: "KOV5OOQ",
    status: "Successful",
    currency: "KES",
    amount: "210.00",
  }],
  wallet: {
    wallet_id: "KNOVXDY",
    label: "default",
    can_disburse: false,
    currency: "KES",
    wallet_type: "SETTLEMENT",
    current_balance: "852.04",
    available_balance: "852.04",
    updated_at: "2026-09-14T18:47:34.090755+03:00",
  },
};

describe("extractPayoutWalletSnapshot", () => {
  it("parses IntaSend settlement wallet amounts", () => {
    const snap = extractPayoutWalletSnapshot(WEBHOOK);
    expect(snap).toEqual(expect.objectContaining({
      accountType: "payout",
      currency: "KES",
      currentBalance: 852.04,
      availableBalance: 852.04,
      walletId: "KNOVXDY",
      walletType: "SETTLEMENT",
      source: "intasend_disbursement_webhook",
      trackingId: WEBHOOK.tracking_id,
    }));
  });

  it("returns null when wallet balances are missing", () => {
    expect(extractPayoutWalletSnapshot({tracking_id: "x"})).toBeNull();
    expect(extractPayoutWalletSnapshot({wallet: {currency: "KES"}})).toBeNull();
  });
});

describe("recordPayoutAccountFromDisbursement", () => {
  beforeEach(() => {
    mockStore.payout = null;
    mockStore.snapshots = {};
  });

  it("writes current payout account and an idempotent snapshot", async () => {
    const first = await recordPayoutAccountFromDisbursement(WEBHOOK);
    const retry = await recordPayoutAccountFromDisbursement(WEBHOOK);

    expect(first.recorded).toBe(true);
    expect(retry.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    expect(mockStore.payout.currentBalance).toBe(852.04);
    expect(Object.keys(mockStore.snapshots)).toHaveLength(1);
  });

  it("skips payloads without a wallet snapshot", async () => {
    const out = await recordPayoutAccountFromDisbursement({tracking_id: "x"});
    expect(out).toEqual({recorded: false});
    expect(mockStore.payout).toBeNull();
  });
});

describe("getPlatformFunds", () => {
  beforeEach(() => {
    mockStore.payout = null;
    mockStore.snapshots = {};
  });

  it("returns null payout KES until a webhook is recorded", async () => {
    const data = await getPlatformFunds();
    expect(data.payoutAccount.currencies).toEqual([
      {code: "KES", currentBalance: null, availableBalance: null, updatedAt: null},
    ]);
    expect(data.collectionsAccount.currencies.map((c) => c.code)).toEqual(["KES", "USD"]);
    expect(data.digitalAssets.crypto.map((c) => c.code)).toEqual(["BTC", "ETH", "SOL"]);
    expect(data.digitalAssets.stablecoin.map((c) => c.code)).toEqual(["USDT", "USDC"]);
  });

  it("maps the recorded IntaSend wallet onto payout KES", async () => {
    await recordPayoutAccountFromDisbursement(WEBHOOK);
    const data = await getPlatformFunds();
    expect(data.payoutAccount.currencies[0]).toEqual(expect.objectContaining({
      code: "KES",
      currentBalance: 852.04,
      availableBalance: 852.04,
      walletId: "KNOVXDY",
      source: "intasend_disbursement_webhook",
    }));
    expect(data.collectionsAccount.currencies[0].currentBalance).toBeNull();
  });
});

describe("listFundHistory", () => {
  beforeEach(() => {
    mockStore.payout = null;
    mockStore.snapshots = {};
  });

  it("returns newest snapshots first", async () => {
    await recordPayoutAccountFromDisbursement(WEBHOOK);
    await recordPayoutAccountFromDisbursement({
      ...WEBHOOK,
      tracking_id: "second",
      wallet: {
        ...WEBHOOK.wallet,
        current_balance: "700.00",
        available_balance: "700.00",
        updated_at: "2026-09-15T10:00:00+03:00",
      },
    });

    const page = await listFundHistory({limit: 10});
    expect(page.items).toHaveLength(2);
    expect(page.items[0].currentBalance).toBe(700);
    expect(page.items[1].currentBalance).toBe(852.04);
  });

  it("rejects unsupported account types", async () => {
    await expect(listFundHistory({account: "collections"})).rejects.toMatchObject({
      statusCode: 400,
      code: "UNSUPPORTED_ACCOUNT",
    });
  });
});
