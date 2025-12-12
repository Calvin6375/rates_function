/**
 * @fileoverview Idempotency module for ensuring operations are only executed once
 * @typedef {Object} IdempotencyResult
 * @property {boolean} isDuplicate - Whether this is a duplicate request
 * @property {any} cachedResult - Cached result if duplicate
 * @property {string} idempotencyKey - The idempotency key used
 */

const admin = require("../admin");

const firestore = admin.firestore();
const IDEMPOTENCY_COLLECTION = "idempotency";
const IDEMPOTENCY_TTL_HOURS = 24; // Keep idempotency records for 24 hours

/**
 * Generate an idempotency key from request data
 * @param {string} operation - Operation name (e.g., "createPayment", "updateBalance")
 * @param {Object} requestData - Request data to generate key from
 * @param {string} userId - Optional user ID for user-scoped operations
 * @returns {string} Idempotency key
 */
function generateIdempotencyKey(operation, requestData, userId = null) {
  // Create a deterministic key from operation and request data
  const keyParts = [operation];
  
  if (userId) {
    keyParts.push(userId);
  }
  
  // Include relevant request fields (exclude timestamps, etc.)
  const relevantData = {...requestData};
  delete relevantData.timestamp;
  delete relevantData.createdAt;
  delete relevantData.updatedAt;
  
  // Sort keys for consistency
  const sortedKeys = Object.keys(relevantData).sort();
  const dataString = sortedKeys.map((key) => `${key}:${relevantData[key]}`).join("|");
  
  keyParts.push(dataString);
  
  // Use crypto to create a hash (or simple string for now)
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(keyParts.join("::")).digest("hex");
  
  return `${operation}::${hash}`;
}

/**
 * Check if an operation has already been executed (idempotency check)
 * @param {string} idempotencyKey - Unique idempotency key
 * @returns {Promise<IdempotencyResult>} Idempotency check result
 */
async function checkIdempotency(idempotencyKey) {
  try {
    const idempotencyRef = firestore.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKey);
    const doc = await idempotencyRef.get();
    
    if (doc.exists) {
      const data = doc.data();
      
      // Check if result is still valid (not expired)
      const createdAt = data.createdAt?.toMillis?.() || data.createdAt;
      const expiresAt = createdAt + (IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);
      
      if (Date.now() < expiresAt) {
        return {
          isDuplicate: true,
          cachedResult: data.result,
          idempotencyKey,
        };
      } else {
        // Expired, delete the old record
        await idempotencyRef.delete();
      }
    }
    
    return {
      isDuplicate: false,
      cachedResult: null,
      idempotencyKey,
    };
  } catch (error) {
    console.error("❌ Error checking idempotency:", {
      idempotencyKey,
      error: error.message,
    });
    // On error, allow the operation to proceed (fail open)
    return {
      isDuplicate: false,
      cachedResult: null,
      idempotencyKey,
    };
  }
}

/**
 * Store idempotency result after successful operation
 * @param {string} idempotencyKey - Unique idempotency key
 * @param {any} result - Operation result to cache
 * @returns {Promise<void>}
 */
async function storeIdempotencyResult(idempotencyKey, result) {
  try {
    const idempotencyRef = firestore.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKey);
    
    await idempotencyRef.set({
      result,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + (IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000)),
      ),
    });
  } catch (error) {
    // Log error but don't fail the operation
    console.error("⚠️ Error storing idempotency result (non-critical):", {
      idempotencyKey,
      error: error.message,
    });
  }
}

/**
 * Execute an operation with idempotency protection
 * @param {string} operation - Operation name
 * @param {Function} operationFn - Async function to execute
 * @param {Object} requestData - Request data for key generation
 * @param {string} userId - Optional user ID
 * @returns {Promise<any>} Operation result (from cache or execution)
 */
async function executeWithIdempotency(operation, operationFn, requestData, userId = null) {
  const idempotencyKey = generateIdempotencyKey(operation, requestData, userId);
  
  // Check if already executed
  const check = await checkIdempotency(idempotencyKey);
  
  if (check.isDuplicate) {
    console.log(`ℹ️ Idempotent operation detected: ${operation}`, {
      idempotencyKey,
    });
    return check.cachedResult;
  }
  
  // Execute operation
  const result = await operationFn();
  
  // Store result for future idempotency checks
  await storeIdempotencyResult(idempotencyKey, result);
  
  return result;
}

module.exports = {
  generateIdempotencyKey,
  checkIdempotency,
  storeIdempotencyResult,
  executeWithIdempotency,
};

