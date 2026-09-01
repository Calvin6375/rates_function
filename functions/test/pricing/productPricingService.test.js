/**
 * @fileoverview Unit tests for productPricingService.
 */

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));

const {collection} = require("../../libs/firestore");
const productPricingService = require("../../services/pricing/productPricingService");

describe("productPricingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    productPricingService.clearCache();
  });

  afterEach(() => {
    productPricingService.clearCache();
  });

  function mockConfigDoc(exists, data) {
    const set = jest.fn().mockResolvedValue(undefined);
    collection.mockReturnValue({
      doc: () => ({
        get: jest.fn().mockResolvedValue({
          exists,
          data: () => data || {},
        }),
        set,
      }),
    });
    return {set};
  }

  it("returns disabled defaults when config/productPricing is missing", async () => {
    mockConfigDoc(false);
    const cfg = await productPricingService.getPricingConfig({forceRefresh: true});
    expect(cfg.source).toBe("defaults");
    expect(cfg.products.buy_goods.enabled).toBe(false);
    expect(cfg.products.buy_goods.feePercent).toBe(0);

    const fee = await productPricingService.computeProductFee({
      productKey: "buy_goods",
      amount: 1000,
      currency: "KES",
    });
    expect(fee.applied).toBe(false);
    expect(fee.reason).toBe("not_enabled");
  });

  it("soft-fails on Firestore errors", async () => {
    collection.mockReturnValue({
      doc: () => ({
        get: jest.fn().mockRejectedValue(new Error("boom")),
      }),
    });
    const fee = await productPricingService.computeProductFee({
      productKey: "pay_bill",
      amount: 1000,
      currency: "KES",
    });
    expect(fee.applied).toBe(false);
    expect(fee.reason).toBe("config_error");
  });

  it("respects kill switch via config.productPricing.enabled", async () => {
    mockConfigDoc(true, {
      products: {
        buy_goods: {enabled: true, feePercent: 1.5, flatFeeKes: 0},
      },
    });
    const config = require("../../config");
    const previous = config.productPricing.enabled;
    config.productPricing.enabled = false;
    try {
      const fee = await productPricingService.computeProductFee({
        productKey: "buy_goods",
        amount: 2000,
        currency: "KES",
      });
      expect(fee.applied).toBe(false);
      expect(fee.reason).toBe("kill_switch");
    } finally {
      config.productPricing.enabled = previous;
    }
  });

  it("computes pay_bill fee at 1.25% + 10 on 1000 KES", async () => {
    mockConfigDoc(true, {
      products: {
        pay_bill: {enabled: true, feePercent: 1.25, flatFeeKes: 10},
      },
    });
    const fee = await productPricingService.computeProductFee({
      productKey: "pay_bill",
      amount: 1000,
      currency: "KES",
    });
    expect(fee.applied).toBe(true);
    expect(fee.feeAmount).toBe(22.5);
    expect(fee.source).toBe("product_pricing:pay_bill");
  });

  it("returns zero_pricing when enabled with zeros", async () => {
    mockConfigDoc(true, {
      products: {
        checkout: {enabled: true, feePercent: 0, flatFeeKes: 0},
      },
    });
    const fee = await productPricingService.computeProductFee({
      productKey: "checkout",
      amount: 1000,
      currency: "KES",
    });
    expect(fee.applied).toBe(false);
    expect(fee.reason).toBe("zero_pricing");
  });

  it("skips flat fee for non-KES currency", async () => {
    mockConfigDoc(true, {
      products: {
        send_ae: {enabled: true, feePercent: 2, flatFeeKes: 30},
      },
    });
    const fee = await productPricingService.computeProductFee({
      productKey: "send_ae",
      amount: 1000,
      currency: "USD",
    });
    expect(fee.applied).toBe(true);
    expect(fee.feeAmount).toBe(20);
    expect(fee.flatFee).toBe(0);
    expect(fee.reason).toBe("flat_fee_skipped_non_kes");
  });

  it("rejects unknown product on write", async () => {
    mockConfigDoc(false);
    await expect(productPricingService.updateProductPricing({
      products: {not_a_product: {enabled: true, feePercent: 1, flatFeeKes: 0}},
      updatedBy: "admin_1",
    })).rejects.toMatchObject({statusCode: 400});
  });

  it("validates feePercent bounds", async () => {
    mockConfigDoc(false);
    await expect(productPricingService.updateProductPricing({
      products: {buy_goods: {enabled: true, feePercent: 101, flatFeeKes: 0}},
      updatedBy: "admin_1",
    })).rejects.toMatchObject({statusCode: 400});
  });

  it("updateProductPricing merges and clears cache", async () => {
    const {set} = mockConfigDoc(true, {
      products: {
        buy_goods: {enabled: false, feePercent: 0, flatFeeKes: 0},
        pay_bill: {enabled: true, feePercent: 1.25, flatFeeKes: 10},
      },
    });
    await productPricingService.updateProductPricing({
      products: {buy_goods: {enabled: true, feePercent: 1.5, flatFeeKes: 0}},
      updatedBy: "admin_1",
    });
    expect(set).toHaveBeenCalled();
    const written = set.mock.calls[0][0];
    expect(written.products.buy_goods.enabled).toBe(true);
    expect(written.products.buy_goods.feePercent).toBe(1.5);
    expect(written.products.pay_bill.enabled).toBe(true);
    expect(written.products.pay_bill.feePercent).toBe(1.25);
  });

  it("previewCharge matches UI formula and volume projection", () => {
    const preview = productPricingService.previewCharge({
      amount: 1000,
      feePercent: 1.25,
      flatFeeKes: 10,
      volume: 5000,
    });
    expect(preview.feeAmount).toBe(22.5);
    expect(preview.customerCharge).toBe(1022.5);
    expect(preview.netAmount).toBe(1000);
    expect(preview.projectedRevenue).toBe(112500);
  });

  it("getAdminPricingView includes suggested values", async () => {
    mockConfigDoc(false);
    const view = await productPricingService.getAdminPricingView();
    const buyGoods = view.products.find((p) => p.key === "buy_goods");
    expect(buyGoods.suggested).toEqual({feePercent: 1.5, flatFeeKes: 0});
    expect(buyGoods.enabled).toBe(false);
    expect(view.formula).toContain("feePercent");
  });

  it("resolveSafariPayProductKey maps Till and PayBill", () => {
    expect(productPricingService.resolveSafariPayProductKey("MPESA_B2B", {
      accountType: "TillNumber",
    })).toBe("buy_goods");
    expect(productPricingService.resolveSafariPayProductKey("MPESA_B2B", {
      accountType: "PayBill",
    })).toBe("pay_bill");
    expect(productPricingService.resolveSafariPayProductKey("MPESA_B2C", {})).toBeNull();
  });

  it("resolveSendProductKey maps KES corridors", () => {
    expect(productPricingService.resolveSendProductKey("KES_AED")).toBe("send_ae");
    expect(productPricingService.resolveSendProductKey("USD_AED")).toBeNull();
  });
});
