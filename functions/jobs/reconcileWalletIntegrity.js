/**
 * @fileoverview Scheduled job — daily read-only wallet integrity check (Job B).
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const config = require("../config");
const { runWalletIntegrityCheck } = require("../services/ops/walletIntegrityService");
const { createLogger } = require("../utils/paymentOpsLogger");

const logger = createLogger({ service: "reconcileWalletIntegrity" });

exports.reconcileWalletIntegrity = onSchedule(
    {
      schedule: "0 3 * * *",
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      const result = await runWalletIntegrityCheck();
      logger.info("integrity.complete", {
        checked: result.checked,
        mismatches: result.mismatches,
      });
    },
);

module.exports.runWalletIntegrityCheck = runWalletIntegrityCheck;
