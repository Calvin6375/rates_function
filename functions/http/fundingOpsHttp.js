/**
 * @fileoverview Admin ops endpoints for Tourist Payments — audit, metrics, recon status.
 */

const config = require("../config");
const { verifyFirebaseAuth } = require("../libs/auth");
const { verifyAdminFromToken } = require("../utils/adminClaims");
const paymentAuditService = require("../services/ops/paymentAuditService");
const opsMetricsService = require("../services/ops/opsMetricsService");
const { listEvents } = require("../services/ops/paymentTimelineService");

/**
 * @param {import("express").Express} app
 */
function mountFundingOpsRoutes(app) {
  /**
   * GET /funding/ops/audit/:correlationId — admin audit trail
   */
  app.get("/funding/ops/audit/:correlationId", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success || !verifyAdminFromToken({ token: auth.decodedToken })) {
      res.status(403).json({ success: false, error: "Admin access required" });
      return;
    }

    try {
      const audit = await paymentAuditService.auditByCorrelationId(req.params.correlationId);
      res.status(200).json({ success: true, data: audit });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /funding/ops/metrics/daily — daily ops rollup
   */
  app.get("/funding/ops/metrics/daily", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success || !verifyAdminFromToken({ token: auth.decodedToken })) {
      res.status(403).json({ success: false, error: "Admin access required" });
      return;
    }

    const date = req.query.date || opsMetricsService.todayBucket();
    const rollup = await opsMetricsService.getDailyRollup(String(date));
    res.status(200).json({ success: true, data: { rollup } });
  });

  /**
   * GET /funding/ops/timeline/:fundingOrderId — order timeline
   */
  app.get("/funding/ops/timeline/:fundingOrderId", async (req, res) => {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success || !verifyAdminFromToken({ token: auth.decodedToken })) {
      res.status(403).json({ success: false, error: "Admin access required" });
      return;
    }

    const events = await listEvents(req.params.fundingOrderId);
    res.status(200).json({ success: true, data: { events } });
  });
}

module.exports = {
  mountFundingOpsRoutes,
};
