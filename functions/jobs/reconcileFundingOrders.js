/**
 * @fileoverview Scheduled job — reconcile stale pending funding orders (Job A).
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const config = require("../config");
const { reconcileStaleFundingOrders } = require("../services/funding/fundingReconciliationService");
const { createLogger } = require("../utils/paymentOpsLogger");

const paystackSecretKey = defineSecret(config.secrets.paystackSecretKey);
const transakApiKey = defineSecret(config.secrets.transakApiKey);
const transakSecretKey = defineSecret(config.secrets.transakSecretKey);
const logger = createLogger({ service: "reconcileFundingOrders" });

exports.reconcileFundingOrders = onSchedule(
    {
      schedule: "*/15 * * * *",
      secrets: [paystackSecretKey, transakApiKey, transakSecretKey],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      const result = await reconcileStaleFundingOrders();
      logger.info("reconcile.complete", result);
    },
);

module.exports.reconcileStaleFundingOrders = reconcileStaleFundingOrders;
