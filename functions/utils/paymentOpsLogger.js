/**
 * @fileoverview Structured logging for Tourist Payments / settlement ops.
 * All funding-layer services should use this instead of ad-hoc console.log.
 */

const config = require("../config");

/**
 * @returns {string}
 */
function resolveEnvironment() {
  return process.env.GCLOUD_PROJECT || process.env.FIREBASE_CONFIG ?
    (process.env.GCLOUD_PROJECT || "emulator") :
    "local";
}

/**
 * @returns {string}
 */
function resolveFunctionName() {
  return process.env.K_SERVICE || process.env.FUNCTION_TARGET || "local";
}

/**
 * @param {Object} base
 * @returns {{ info: Function, warn: Function, error: Function, child: Function }}
 */
function createLogger(base = {}) {
  const defaults = {
    environment: resolveEnvironment(),
    functionName: resolveFunctionName(),
    ...base,
  };

  /**
   * @param {string} level
   * @param {string} event
   * @param {Object} [fields]
   */
  function emit(level, event, fields = {}) {
    const payload = {
      level,
      event,
      timestamp: new Date().toISOString(),
      ...defaults,
      ...fields,
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (extra) => createLogger({ ...defaults, ...extra }),
  };
}

/**
 * @param {Function} fn
 * @param {Object} logger
 * @param {string} eventPrefix
 * @param {Object} [fields]
 * @returns {Function}
 */
function withTiming(fn, logger, eventPrefix, fields = {}) {
  return async (...args) => {
    const started = Date.now();
    logger.info(`${eventPrefix}.started`, fields);
    try {
      const result = await fn(...args);
      logger.info(`${eventPrefix}.completed`, {
        ...fields,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      logger.error(`${eventPrefix}.failed`, {
        ...fields,
        durationMs: Date.now() - started,
        error: err.message,
      });
      throw err;
    }
  };
}

/** Default logger instance */
const defaultLogger = createLogger({
  service: "truepay-payments",
  region: config.region,
});

module.exports = {
  createLogger,
  withTiming,
  defaultLogger,
};
