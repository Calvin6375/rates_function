/**
 * @fileoverview Super-admin manual runs for jobs that used to be cron tasks.
 * POST https://us-central1-truepay-72060.cloudfunctions.net/opsAdmin/ops/<job>
 * Authorization: Bearer <Firebase ID token> for the super admin.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const express = require("express");
const config = require("../config");
const {verifyFirebaseAuth} = require("../libs/auth");
const {isSuperAdmin} = require("../utils/accessControl");
const {getCryptoFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {processRetryableJobs} = require("../services/settlement/settlementRetryService");
const {releaseExpiredReservations} = require("../services/ledger/fiatReservationService");
const {reconcileStaleFundingOrders} = require("../services/funding/fundingReconciliationService");
const {runCircleLedgerReconciliation} = require("../jobs/reconcileCircleLedger");
const {runCryptoLedgerReconciliation} = require("../services/crypto/reconcileCryptoLedgerService");
const {createLogger} = require("../utils/paymentOpsLogger");

const logger = createLogger({service: "opsAdmin"});

const paystackSecretKey = defineSecret(config.secrets.paystackSecretKey);
const crossmintServerApiKey = defineSecret(config.secrets.crossmintServerApiKey);
const crossmintServerApiKeyProd = defineSecret(config.secrets.crossmintServerApiKeyProd);
const crossmintCollectionWallet = defineSecret(config.secrets.crossmintCollectionWallet);
const crossmintCollectionWalletProd = defineSecret(config.secrets.crossmintCollectionWalletProd);
const paylioApiKey = defineSecret(config.secrets.paylioApiKey);
const darajaConsumerKey = defineSecret(config.secrets.darajaConsumerKey);
const darajaConsumerSecret = defineSecret(config.secrets.darajaConsumerSecret);

const FUNCTION_SEGMENT = "opsAdmin";
const ALLOWED_ORIGINS = [
  "https://truepay-72060.web.app",
  "https://truepay-72060.firebaseapp.com",
  "https://theadmin.truepay.live",
  "https://truepay.live",
  "https://www.truepay.live",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8080",
];

const JOBS = Object.freeze({
  "retry-settlement-jobs": processRetryableJobs,
  "release-expired-reservations": releaseExpiredReservations,
  "reconcile-funding-orders": reconcileStaleFundingOrders,
  "reconcile-circle-ledger": runCircleLedgerReconciliation,
  "reconcile-crypto-ledger": runCryptoLedgerReconciliation,
});

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const raw = req.url || "/";
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const query = qIdx === -1 ? "" : raw.slice(qIdx);
  const prefix = `/${FUNCTION_SEGMENT}`;
  if (pathPart === prefix || pathPart.startsWith(`${prefix}/`)) {
    const rest = pathPart === prefix ? "/" : pathPart.slice(prefix.length) || "/";
    req.url = rest + query;
  }
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allowedOrigin = "";
  if (origin && (ALLOWED_ORIGINS.includes(origin) ||
      origin.includes("localhost") || origin.includes("127.0.0.1"))) {
    allowedOrigin = origin;
  }
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

async function requireSuperAdminRequest(req, res, next) {
  const auth = await verifyFirebaseAuth(req);
  if (!auth.success) {
    res.status(401).json({success: false, error: "Unauthorized"});
    return;
  }
  try {
    const allowed = await isSuperAdmin(auth.decodedToken, auth.userId);
    if (!allowed) {
      res.status(403).json({success: false, error: "Super admin access required"});
      return;
    }
  } catch (err) {
    logger.info("ops.auth.failed", {error: err.message});
    res.status(500).json({success: false, error: "Authorization check failed"});
    return;
  }
  req.userId = auth.userId;
  next();
}

app.post("/ops/:job", requireSuperAdminRequest, async (req, res) => {
  const jobName = String(req.params.job || "");
  const run = JOBS[jobName];
  if (!run) {
    res.status(404).json({success: false, error: "Unknown ops job"});
    return;
  }
  try {
    const result = await run();
    logger.info("ops.job.complete", {job: jobName, adminId: req.userId});
    res.status(200).json({success: true, job: jobName, result});
  } catch (err) {
    logger.info("ops.job.failed", {job: jobName, error: err.message});
    res.status(500).json({
      success: false,
      job: jobName,
      error: err.message || "Ops job failed",
    });
  }
});

app.use((req, res) => {
  res.status(404).json({success: false, error: "Not found"});
});

exports.opsAdmin = onRequest(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      timeoutSeconds: 540,
      secrets: [
        ...getCryptoFunctionSecrets(),
        paystackSecretKey,
        crossmintServerApiKey,
        crossmintServerApiKeyProd,
        crossmintCollectionWallet,
        crossmintCollectionWalletProd,
        paylioApiKey,
        darajaConsumerKey,
        darajaConsumerSecret,
      ],
    },
    app,
);

module.exports.app = app;
module.exports.JOBS = JOBS;
