/**
 * @fileoverview Retry settlement jobs that are still processing.
 * Invoked manually by the super-admin ops endpoint.
 */

const { processRetryableJobs } = require("../services/settlement/settlementRetryService");

module.exports.processRetryableJobs = processRetryableJobs;
