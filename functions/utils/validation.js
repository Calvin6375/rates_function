/**
 * Validate user ID format
 * @param {string} userId - User ID to validate
 * @returns {boolean} True if valid
 */
function isValidUserId(userId) {
  return typeof userId === "string" && userId.length > 0 && userId.trim().length > 0;
}

/**
 * Validate amount (must be positive number)
 * @param {number} amount - Amount to validate
 * @returns {boolean} True if valid
 */
function isValidAmount(amount) {
  return typeof amount === "number" && amount > 0 && isFinite(amount);
}

/**
 * Validate transaction type
 * @param {string} type - Transaction type
 * @returns {boolean} True if valid
 */
function isValidTransactionType(type) {
  const validTypes = ["credit", "debit", "transfer", "topup", "withdrawal", "refund"];
  return typeof type === "string" && validTypes.includes(type.toLowerCase());
}

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid
 */
function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate admin role
 * @param {Object} userData - User document data
 * @returns {boolean} True if user is admin
 */
function isAdmin(userData) {
  if (!userData) return false;
  // Check for role field or isAdmin field
  return userData.role === "admin" || userData.isAdmin === true;
}

/**
 * Validate balance update request
 * @param {Object} data - Request data
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateBalanceUpdate(data) {
  if (!data.userId || !isValidUserId(data.userId)) {
    return {valid: false, error: "Invalid or missing userId"};
  }

  if (data.amount === undefined || data.amount === null) {
    return {valid: false, error: "Missing amount"};
  }

  const amount = Number(data.amount);
  if (!isFinite(amount)) {
    return {valid: false, error: "Amount must be a valid number"};
  }

  // Allow negative amounts for debits, but not zero
  if (amount === 0) {
    return {valid: false, error: "Amount cannot be zero"};
  }

  return {valid: true};
}

module.exports = {
  isValidUserId,
  isValidAmount,
  isValidTransactionType,
  isValidEmail,
  isAdmin,
  validateBalanceUpdate,
};

