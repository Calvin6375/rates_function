/**
 * @fileoverview Monitoring utilities
 * Helpers for monitoring function performance and health
 */

const admin = require("../admin");
const config = require("../config");

const firestore = admin.firestore();

/**
 * Record function execution metrics
 * @param {string} functionName - Function name
 * @param {number} duration - Execution duration in milliseconds
 * @param {boolean} success - Whether execution was successful
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<void>}
 */
async function recordMetrics(functionName, duration, success, metadata = {}) {
  try {
    if (!config.features.enableDetailedLogging) {
      return; // Skip if detailed logging is disabled
    }

    const metricsData = {
      functionName,
      duration,
      success,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ...metadata,
    };

    // Optionally store metrics in Firestore for analysis
    // Uncomment if you want to persist metrics:
    // await firestore.collection("metrics").add(metricsData);

    // For now, just log
    console.log(JSON.stringify({
      event: "function_metrics",
      ...metricsData,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    // Don't fail the function if metrics recording fails
    console.warn("Failed to record metrics:", error.message);
  }
}

/**
 * Create a performance timer
 * @returns {{start: Function, end: Function}} Timer object
 */
function createTimer() {
  const startTime = Date.now();

  return {
    start: () => startTime,
    end: () => Date.now() - startTime,
  };
}

/**
 * Wrap a function with monitoring
 * @param {string} functionName - Function name for monitoring
 * @param {Function} fn - Function to wrap
 * @returns {Function} Wrapped function
 */
function monitorFunction(functionName, fn) {
  return async (...args) => {
    const timer = createTimer();
    let success = false;
    let error = null;

    try {
      const result = await fn(...args);
      success = true;
      const duration = timer.end();
      await recordMetrics(functionName, duration, true);
      return result;
    } catch (err) {
      error = err;
      const duration = timer.end();
      await recordMetrics(functionName, duration, false, {
        error: err.message,
        errorType: err.constructor.name,
      });
      throw err;
    }
  };
}

/**
 * Check system health
 * @returns {Promise<Object>} Health check results
 */
async function checkHealth() {
  const health = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    checks: {},
  };

  // Check Firestore connectivity
  try {
    await firestore.collection("_health").limit(1).get();
    health.checks.firestore = "ok";
  } catch (error) {
    health.checks.firestore = `error: ${error.message}`;
    health.status = "degraded";
  }

  // Realtime Database removed - all data now in Firestore
  // Clients should use Firestore onSnapshot listeners for real-time updates

  return health;
}

module.exports = {
  recordMetrics,
  createTimer,
  monitorFunction,
  checkHealth,
};

