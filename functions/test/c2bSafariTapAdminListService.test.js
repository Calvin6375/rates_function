/**
 * @fileoverview Safari Tap admin list helpers.
 */

const {
  normalizeMethodType,
  resolveSafariTapPeriod,
  resolveFailureReason,
  isSafariTapC2bTopupDoc,
  METHOD_TYPES,
} = require("../services/c2bSafariTapAdminListService");

describe("normalizeMethodType", () => {
  it("accepts UI labels and aliases", () => {
    expect(normalizeMethodType("Topups")).toBe(METHOD_TYPES.TOPUPS);
    expect(normalizeMethodType("pay")).toBe(METHOD_TYPES.PAY);
    expect(normalizeMethodType("Send")).toBe(METHOD_TYPES.SEND);
    expect(normalizeMethodType("exchange")).toBe(METHOD_TYPES.EXCHANGE);
    expect(normalizeMethodType("swap")).toBe(METHOD_TYPES.EXCHANGE);
  });

  it("rejects unknown types", () => {
    expect(normalizeMethodType("foo")).toBeNull();
    expect(normalizeMethodType("")).toBeNull();
  });
});

describe("resolveSafariTapPeriod", () => {
  it("resolves today / 7d / 30d / month", () => {
    expect(resolveSafariTapPeriod("today").key).toBe("today");
    expect(resolveSafariTapPeriod("7d").key).toBe("7d");
    expect(resolveSafariTapPeriod("30d").key).toBe("30d");
    expect(resolveSafariTapPeriod("month").key).toBe("month");
  });

  it("requires dates for custom", () => {
    expect(() => resolveSafariTapPeriod("custom", {})).toThrow(/startDate/);
    const period = resolveSafariTapPeriod("custom", {
      startDate: "2026-08-01",
      endDate: "2026-08-30",
    });
    expect(period.key).toBe("custom");
    expect(period.from.toISOString()).toContain("2026-08-01");
  });
});

describe("resolveFailureReason", () => {
  it("uses fundingOrders.failureReason", () => {
    expect(resolveFailureReason({
      status: "failed",
      failureReason: "The transaction was not completed",
      metadata: {product: "tourist"},
    })).toBe("The transaction was not completed");
  });

  it("falls back to metadata.reason", () => {
    expect(resolveFailureReason({
      status: "failed",
      metadata: {reason: "Insufficient funds"},
    })).toBe("Insufficient funds");
  });

  it("returns null when no reason is stored", () => {
    expect(resolveFailureReason({status: "failed", metadata: {}})).toBeNull();
  });
});

describe("isSafariTapC2bTopupDoc", () => {
  it("keeps C2B tourist / consumer funding", () => {
    expect(isSafariTapC2bTopupDoc({
      userId: "uid_consumer",
      type: "funding",
      metadata: {product: "tourist", source: "c2b_createPayment"},
    })).toBe(true);
    expect(isSafariTapC2bTopupDoc({
      userId: "uid_consumer",
      type: "topup",
      metadata: {},
    })).toBe(true);
  });

  it("drops partner wallet and payment-link funding", () => {
    expect(isSafariTapC2bTopupDoc({
      userId: "partner:abc",
      provider: "paystack",
      metadata: {product: "b2b_payment_link", partnerId: "abc"},
    })).toBe(false);
    expect(isSafariTapC2bTopupDoc({
      userId: "partner:abc",
      provider: "paystack",
      metadata: {product: "b2b_self_topup", partnerId: "abc"},
    })).toBe(false);
    expect(isSafariTapC2bTopupDoc({
      userId: "uid_1",
      type: "b2b_funding",
      metadata: {product: "b2b_self_topup", partnerId: "p1"},
    })).toBe(false);
  });
});
