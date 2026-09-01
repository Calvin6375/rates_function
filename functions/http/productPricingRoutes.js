/**
 * @fileoverview Product pricing REST routes — mounted on `api`.
 * GET/PUT /config/product-pricing, POST reset + preview.
 */

const {verifyFirebaseAuth} = require("../libs/auth");
const productPricingService = require("../services/pricing/productPricingService");

/**
 * @param {import("express").Express} app
 * @param {{ requireAdmin: Function }} deps
 */
function mountProductPricingRoutes(app, deps) {
  const requireAdmin = deps.requireAdmin;

  /**
   * GET /config/product-pricing
   * Catalog + live values + suggested (any authenticated user).
   */
  app.get("/config/product-pricing", async (req, res) => {
    try {
      const auth = await verifyFirebaseAuth(req);
      if (!auth.success) {
        res.status(401).json({
          success: false,
          error: "Unauthorized",
          message: auth.error || "Authentication required.",
        });
        return;
      }

      const data = await productPricingService.getAdminPricingView();
      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      console.error("GET /config/product-pricing:", err.message);
      res.status(500).json({
        success: false,
        error: "Failed to load product pricing",
        message: err.message,
      });
    }
  });

  /**
   * PUT /config/product-pricing
   * Partial merge of product fees (platform admin).
   */
  app.put("/config/product-pricing", requireAdmin, async (req, res) => {
    try {
      const adminId = req.adminId;
      const products = req.body?.products;
      const before = await productPricingService.getAdminPricingView();
      const afterCfg = await productPricingService.updateProductPricing({
        products,
        updatedBy: adminId,
      });
      const after = await productPricingService.getAdminPricingView();

      try {
        const {logAdminAction} = require("../utils/transactions");
        await logAdminAction(
            adminId,
            "system",
            "updateProductPricing",
            before,
            after,
        );
      } catch (logErr) {
        console.error("Failed to log product pricing update:", logErr.message);
      }

      res.status(200).json({
        success: true,
        data: after,
        message: "Product pricing updated",
        meta: {source: afterCfg.source},
      });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) {
        console.error("PUT /config/product-pricing:", err.message);
      }
      res.status(status).json({
        success: false,
        error: status === 400 ? "Invalid request" : "Failed to update product pricing",
        message: err.message,
      });
    }
  });

  /**
   * POST /config/product-pricing/reset
   * Disable and zero all products (revert to legacy fee paths).
   */
  app.post("/config/product-pricing/reset", requireAdmin, async (req, res) => {
    try {
      const adminId = req.adminId;
      const before = await productPricingService.getAdminPricingView();
      await productPricingService.resetToDefaults({updatedBy: adminId});
      const after = await productPricingService.getAdminPricingView();

      try {
        const {logAdminAction} = require("../utils/transactions");
        await logAdminAction(
            adminId,
            "system",
            "resetProductPricing",
            before,
            after,
        );
      } catch (logErr) {
        console.error("Failed to log product pricing reset:", logErr.message);
      }

      res.status(200).json({
        success: true,
        data: after,
        message: "Product pricing reset to disabled defaults",
      });
    } catch (err) {
      const status = err.statusCode || 500;
      console.error("POST /config/product-pricing/reset:", err.message);
      res.status(status).json({
        success: false,
        error: "Failed to reset product pricing",
        message: err.message,
      });
    }
  });

  /**
   * POST /config/product-pricing/preview
   * Pure calculator math for the Revenue Calculator UI.
   */
  app.post("/config/product-pricing/preview", requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      let feePercent = body.feePercent;
      let flatFeeKes = body.flatFeeKes;
      const productKey = body.productKey ? String(body.productKey) : null;

      if ((feePercent == null || flatFeeKes == null) && productKey) {
        const view = await productPricingService.getAdminPricingView();
        const product = view.products.find((p) => p.key === productKey);
        if (!product) {
          res.status(400).json({
            success: false,
            error: "Invalid request",
            message: `Unknown product key: ${productKey}`,
          });
          return;
        }
        if (feePercent == null) {
          feePercent = product.enabled ? product.feePercent : product.suggested.feePercent;
        }
        if (flatFeeKes == null) {
          flatFeeKes = product.enabled ? product.flatFeeKes : product.suggested.flatFeeKes;
        }
      }

      const preview = productPricingService.previewCharge({
        amount: body.amount,
        feePercent,
        flatFeeKes,
        volume: body.volume,
        currency: body.currency || "KES",
      });

      res.status(200).json({
        success: true,
        data: {
          ...preview,
          productKey: productKey || null,
          feePercent: Number(feePercent),
          flatFeeKes: Number(flatFeeKes),
          formula: productPricingService.FORMULA,
        },
      });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        success: false,
        error: status === 400 ? "Invalid request" : "Failed to preview charge",
        message: err.message,
      });
    }
  });
}

module.exports = {
  mountProductPricingRoutes,
};
