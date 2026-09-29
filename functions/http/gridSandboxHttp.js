/**
 * @fileoverview Sandbox-only helper to simulate a Grid incoming deposit.
 * Gated by GRID_ENVIRONMENT=sandbox. Does not credit the TruePay ledger.
 * The ledger moves only after the signed Grid webhook is verified.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const { verifyFirebaseAuth } = require("../libs/auth");
const fundingOrderService = require("../services/funding/fundingOrderService");
const gridProvider = require("../services/funding/providers/gridProvider");
const gridApi = require("../services/funding/providers/gridApi");
const { FUNDING_PROVIDERS, FUNDING_STATUSES } = require("../utils/fundingTypes");
const { createLogger } = require("../utils/paymentOpsLogger");

const logger = createLogger({ service: "gridSandbox", provider: FUNDING_PROVIDERS.grid });

const gridClientId = defineSecret(config.secrets.gridClientId);
const gridClientSecret = defineSecret(config.secrets.gridClientSecret);

const app = express();
app.use(express.json());

app.post("/", async (req, res) => {
  if (!gridApi.isSandbox()) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }

  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const fundingOrderId = String(req.body?.fundingOrderId || "").trim();
  if (!fundingOrderId) {
    res.status(400).json({ success: false, error: "fundingOrderId is required" });
    return;
  }

  const order = await fundingOrderService.getFundingOrderForUser(auth.userId, fundingOrderId);
  if (!order || order.provider !== FUNDING_PROVIDERS.grid) {
    res.status(404).json({ success: false, error: "Funding order not found" });
    return;
  }
  if (order.status !== FUNDING_STATUSES.pending && order.status !== FUNDING_STATUSES.processing) {
    res.status(409).json({ success: false, error: `Funding order is ${order.status}` });
    return;
  }

  const accountId = order.providerAccountId || order.metadata?.providerAccountId || null;
  if (!accountId) {
    res.status(409).json({ success: false, error: "Funding order has no Grid internal account" });
    return;
  }

  try {
    await gridProvider.sandboxFundInternalAccount(accountId, order.amount, {
      userId: auth.userId,
      fundingOrderId: order.id,
      correlationId: order.correlationId || null,
    });
  } catch (err) {
    logger.error("grid.sandbox.fund_failed", {
      userId: auth.userId,
      fundingOrderId: order.id,
      gridInternalAccountId: accountId,
      provider: FUNDING_PROVIDERS.grid,
      error: err.message,
    });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
    res.status(status).json({ success: false, error: err.message });
    return;
  }

  logger.info("grid.sandbox.fund_requested", {
    userId: auth.userId,
    fundingOrderId: order.id,
    gridCustomerId: order.providerCustomerId || order.metadata?.providerCustomerId || null,
    gridInternalAccountId: accountId,
    provider: FUNDING_PROVIDERS.grid,
    status: order.status,
  });

  res.status(202).json({
    success: true,
    simulated: true,
    fundingOrderId: order.id,
    provider: FUNDING_PROVIDERS.grid,
    currency: order.currency,
    amount: order.amount,
    status: order.status,
    message: "Sandbox fund requested. The TruePay USD ledger credits only after the Grid webhook is verified.",
  });
});

exports.gridSandboxFund = onRequest(
    {
      secrets: [gridClientId, gridClientSecret],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    app,
);
