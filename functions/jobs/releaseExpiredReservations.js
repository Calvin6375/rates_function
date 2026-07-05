/**
 * @fileoverview Scheduled job — release expired fiat reservations.
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const config = require("../config");
const { releaseExpiredReservations } = require("../services/ledger/fiatReservationService");
const { createLogger } = require("../utils/paymentOpsLogger");

const logger = createLogger({ service: "releaseExpiredReservations" });

exports.releaseExpiredReservations = onSchedule(
    {
      schedule: "*/10 * * * *",
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      const result = await releaseExpiredReservations();
      logger.info("reservations.release.complete", result);
    },
);

module.exports.releaseExpiredReservations = releaseExpiredReservations;
