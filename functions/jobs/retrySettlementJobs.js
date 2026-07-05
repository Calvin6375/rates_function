/**
 * @fileoverview Scheduled job — retry processing settlement jobs.
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const config = require("../config");
const { processRetryableJobs } = require("../services/settlement/settlementRetryService");
const { createLogger } = require("../utils/paymentOpsLogger");

const darajaConsumerKey = defineSecret(config.secrets.darajaConsumerKey);
const darajaConsumerSecret = defineSecret(config.secrets.darajaConsumerSecret);
const logger = createLogger({ service: "retrySettlementJobs" });

exports.retrySettlementJobs = onSchedule(
    {
      schedule: "*/5 * * * *",
      secrets: [darajaConsumerKey, darajaConsumerSecret],
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      const result = await processRetryableJobs();
      logger.info("settlement.retry.complete", result);
    },
);

module.exports.processRetryableJobs = processRetryableJobs;
