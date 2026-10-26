/**
 * @fileoverview Reconcile stale pending funding orders.
 * Invoked manually by the super-admin ops endpoint.
 */

const { reconcileStaleFundingOrders } = require("../services/funding/fundingReconciliationService");

module.exports.reconcileStaleFundingOrders = reconcileStaleFundingOrders;
