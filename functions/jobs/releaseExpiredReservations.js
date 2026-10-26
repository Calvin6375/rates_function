/**
 * @fileoverview Release expired fiat reservations.
 * Invoked manually by the super-admin ops endpoint.
 */

const { releaseExpiredReservations } = require("../services/ledger/fiatReservationService");

module.exports.releaseExpiredReservations = releaseExpiredReservations;
