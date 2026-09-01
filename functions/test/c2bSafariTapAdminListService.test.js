/**
 * @fileoverview Safari Tap admin list helpers.
 */

const {
  normalizeMethodType,
  resolveSafariTapPeriod,
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
