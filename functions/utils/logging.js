/**
 * @fileoverview Logging utilities
 * Structured logging helpers for better observability
 */

const config = require("../config");

/**
 * Log levels
 * @enum {string}
 */
const LogLevel = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
};

/**
 * Create structured log entry
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {Object} metadata - Additional metadata
 * @returns {Object} Structured log entry
 */
function createLogEntry(level, message, metadata = {}) {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...metadata,
  };
}

/**
 * Log debug message
 * @param {string} message - Log message
 * @param {Object} metadata - Additional metadata
 */
function debug(message, metadata = {}) {
  if (config.features.enableDetailedLogging) {
    const logEntry = createLogEntry(LogLevel.DEBUG, message, metadata);
    console.log(JSON.stringify(logEntry));
  }
}

/**
 * Log info message
 * @param {string} message - Log message
 * @param {Object} metadata - Additional metadata
 */
function info(message, metadata = {}) {
  const logEntry = createLogEntry(LogLevel.INFO, message, metadata);
  console.log(JSON.stringify(logEntry));
}

/**
 * Log warning message
 * @param {string} message - Log message
 * @param {Object} metadata - Additional metadata
 */
function warn(message, metadata = {}) {
  const logEntry = createLogEntry(LogLevel.WARN, message, metadata);
  console.warn(JSON.stringify(logEntry));
}

/**
 * Log error message
 * @param {string} message - Log message
 * @param {Error|Object} error - Error object or metadata
 * @param {Object} metadata - Additional metadata
 */
function error(message, error = {}, metadata = {}) {
  const errorMetadata = error instanceof Error ? {
    error: error.message,
    stack: error.stack,
    errorType: error.constructor.name,
  } : error;

  const logEntry = createLogEntry(LogLevel.ERROR, message, {
    ...errorMetadata,
    ...metadata,
  });
  console.error(JSON.stringify(logEntry));
}

/**
 * Log function execution
 * @param {string} functionName - Function name
 * @param {Object} params - Function parameters
 * @param {Object} result - Function result
 * @param {number} duration - Execution duration in milliseconds
 */
function logFunctionExecution(functionName, params = {}, result = null, duration = null) {
  const metadata = {
    function: functionName,
    params,
    duration: duration ? `${duration}ms` : null,
  };

  if (result) {
    metadata.result = result;
  }

  info(`Function executed: ${functionName}`, metadata);
}

module.exports = {
  LogLevel,
  createLogEntry,
  debug,
  info,
  warn,
  error,
  logFunctionExecution,
};

