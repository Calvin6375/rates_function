/**
 * @fileoverview Provider-aware crypto ledger reconciliation.
 * Invoked manually by the super-admin ops endpoint.
 */

const {
  runCryptoLedgerReconciliation,
} = require("../services/crypto/reconcileCryptoLedgerService");

module.exports.runCryptoLedgerReconciliation = runCryptoLedgerReconciliation;
