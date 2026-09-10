/**
 * @fileoverview Partner profile QR classification and dashboard payload.
 */

jest.mock("../../services/partnerService", () => ({
  getPartner: jest.fn(),
}));

jest.mock("qrcode", () => ({
  toDataURL: jest.fn(async (payload) => `data:image/png;base64,${Buffer.from(payload).toString("base64")}`),
}));

const partnerService = require("../../services/partnerService");
const {
  classifyScannedQr,
  resolveScannedQr,
  getProfileQr,
} = require("../../services/partnerProfileQrService");

describe("partnerProfileQrService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("classifies profile URL vs product payment-link URL", () => {
    expect(classifyScannedQr("https://host/b2bPortal/p/partner_1")).toEqual({
      kind: "profile",
      merchantId: "partner_1",
      partnerId: "partner_1",
      linkId: null,
    });
    expect(classifyScannedQr("https://host/b2bPortal/l/pl_abc?partner=partner_1")).toEqual({
      kind: "product",
      merchantId: "partner_1",
      partnerId: "partner_1",
      linkId: "pl_abc",
    });
    expect(classifyScannedQr("truepay://merchant/partner_1").kind).toBe("profile");
    expect(classifyScannedQr("partner_abc_xyz").kind).toBe("profile");
  });

  it("resolves an active partner for dashboard QR", async () => {
    partnerService.getPartner.mockResolvedValue({
      id: "partner_1",
      name: "Tru Pay",
      status: "active",
      settlementCurrency: "KES",
    });
    const data = await getProfileQr("partner_1");
    expect(data.merchantId).toBe("partner_1");
    expect(data.partnerName).toBe("Tru Pay");
    expect(data.acceptingPayments).toBe(true);
    expect(data.kind).toBe("profile");
    expect(data.payUrl).toContain("/p/partner_1");
    expect(data.qrCode.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects suspended partners on scan resolve", async () => {
    partnerService.getPartner.mockResolvedValue({
      id: "partner_1",
      name: "Tru Pay",
      status: "suspended",
    });
    await expect(resolveScannedQr("partner_1")).rejects.toMatchObject({
      code: "RECIPIENT_NOT_FOUND",
    });
  });

  it("returns kind=product without looking up partner", async () => {
    const data = await resolveScannedQr("https://host/l/pl_1?partner=partner_1");
    expect(data.kind).toBe("product");
    expect(data.linkId).toBe("pl_1");
    expect(partnerService.getPartner).not.toHaveBeenCalled();
  });
});
