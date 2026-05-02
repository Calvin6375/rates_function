/**
 * @fileoverview Admin actions business logic module
 * Pure business logic for admin operations
 */

const admin = require("../admin");
const config = require("../config");
const { updateBalanceWithTransaction, getUserBalance, userExists } = require("../utils/firestore");
const { logAdminAction } = require("../utils/transactions");
const { validateBalanceUpdate } = require("../utils/validation");
const { verifyAdminFromToken, isSuperAdminUid } = require("../utils/adminClaims");
const supportedCountriesService = require("../services/supportedCountriesService");
const axios = require("axios");
const { defineSecret } = require("firebase-functions/params");

const firestore = admin.firestore();

// IntaSend API configuration
const intaSendSecretKey = defineSecret(config.secrets.intaSendSecretKey);
const intaSendPublishableKey = defineSecret(config.secrets.intaSendPublishableKey);

/**
 * Get IntaSend API keys
 * @returns {{secretKey: string|null, publishableKey: string|null}}
 */
function getIntaSendKeys() {
  const secretKey = intaSendSecretKey.value() || process.env.INTASEND_SECRET_KEY || null;
  const publishableKey = intaSendPublishableKey.value() || process.env.INTASEND_PUBLISHABLE_KEY || null;
  return { secretKey, publishableKey };
}

/**
 * Verify admin role using Custom Claims
 * @param {string} adminId - Admin user ID
 * @returns {Promise<boolean>} True if user is admin
 * @deprecated Use verifyAdminFromToken(auth) instead for better performance
 */
async function verifyAdmin(adminId) {
  try {
    const userRecord = await admin.auth().getUser(adminId);
    return userRecord.customClaims?.admin === true;
  } catch (error) {
    console.error("Error verifying admin:", error.message);
    return false;
  }
}

/**
 * Update user profile
 * @param {string} adminId - Admin user ID
 * @param {string} userId - Target user ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Update result
 */
async function updateUserProfile(adminId, userId, updates) {
  // Check if user exists
  const exists = await userExists(userId);
  if (!exists) {
    throw new Error(`User ${userId} not found`);
  }

  // Get current user data for logging
  const userRef = firestore.collection(config.collections.users).doc(userId);
  const userDoc = await userRef.get();
  const beforeData = userDoc.data();

  // Prepare allowed fields (prevent balance updates through this function)
  const allowedFields = ["name", "email", "country", "phoneNumber", "kycStatus", "kycData"];
  const sanitizedUpdates = {};

  for (const key of Object.keys(updates)) {
    if (allowedFields.includes(key)) {
      sanitizedUpdates[key] = updates[key];
    }
  }

  if (Object.keys(sanitizedUpdates).length === 0) {
    throw new Error("No valid fields to update");
  }

  // Add updatedAt timestamp
  sanitizedUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  // Update user document
  await userRef.update(sanitizedUpdates);

  // Get updated data for logging
  const afterDoc = await userRef.get();
  const afterData = afterDoc.data();

  // Log admin action
  await logAdminAction(
    adminId,
    userId,
    "updateProfile",
    beforeData,
    afterData,
  );

  console.log(`✅ Admin ${adminId} updated profile for user ${userId}`);

  return {
    success: true,
    userId,
    updatedFields: Object.keys(sanitizedUpdates),
  };
}

/**
 * Update user balance
 * @param {string} adminId - Admin user ID
 * @param {string} userId - Target user ID
 * @param {number} amount - Amount to add (positive) or subtract (negative)
 * @param {string} reason - Reason for balance update
 * @returns {Promise<Object>} Update result
 */
async function updateUserBalance(adminId, userId, amount, reason = "Admin balance adjustment") {
  // Validate request
  const validation = validateBalanceUpdate({ userId, amount });
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const amountDelta = Number(amount);

  // Get current balance for logging
  const beforeBalance = await getUserBalance(userId);

  // Update balance using transaction
  const result = await updateBalanceWithTransaction(
    userId,
    amountDelta,
    amountDelta > 0 ? "credit" : "debit",
    {
      source: "admin",
      adminId,
      reason: reason,
      allowNegative: true, // Admins can set negative balances if needed
    },
  );

  // Balance is now stored only in Firestore (no RTDB sync needed)
  // Clients should listen to Firestore document changes for real-time updates

  // Log admin action
  await logAdminAction(
    adminId,
    userId,
    "updateBalance",
    { balance: beforeBalance },
    { balance: result.newBalance, amountDelta },
  );

  console.log(`✅ Admin ${adminId} updated balance for user ${userId}`, {
    amountDelta,
    previousBalance: result.previousBalance,
    newBalance: result.newBalance,
  });

  return {
    success: true,
    userId,
    previousBalance: result.previousBalance,
    newBalance: result.newBalance,
    amountDelta,
    transactionId: result.transactionId,
  };
}

/**
 * Get user data
 * @param {string} adminId - Admin user ID
 * @param {string} userId - Target user ID
 * @returns {Promise<Object>} User data
 */
async function getUserData(adminId, userId) {
  // Get user document
  const userDoc = await firestore.collection(config.collections.users).doc(userId).get();

  if (!userDoc.exists) {
    throw new Error(`User ${userId} not found`);
  }

  const userData = userDoc.data();

  // Return user data (excluding sensitive fields if needed)
  return {
    success: true,
    userId,
    userData: {
      ...userData,
      // Ensure balance is a number
      balance: Number(userData.balance || 0),
    },
  };
}

/**
 * Update KYC status
 * @param {string} adminId - Admin user ID
 * @param {string} userId - Target user ID
 * @param {string} kycStatus - New KYC status
 * @param {Object} kycData - Additional KYC data
 * @returns {Promise<Object>} Update result
 */
async function updateKYCStatus(adminId, userId, kycStatus, kycData = null) {
  const validStatuses = ["pending", "approved", "rejected", "under_review"];
  if (!validStatuses.includes(kycStatus)) {
    throw new Error(`Invalid KYC status. Must be one of: ${validStatuses.join(", ")}`);
  }

  // Check if user exists
  const exists = await userExists(userId);
  if (!exists) {
    throw new Error(`User ${userId} not found`);
  }

  // Get current user data for logging
  const userRef = firestore.collection(config.collections.users).doc(userId);
  const userDoc = await userRef.get();
  const beforeData = userDoc.data();

  // Update KYC status
  const updateData = {
    kycStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (kycData) {
    updateData.kycData = kycData;
  }

  await userRef.update(updateData);

  // Get updated data for logging
  const afterDoc = await userRef.get();
  const afterData = afterDoc.data();

  // Log admin action
  await logAdminAction(
    adminId,
    userId,
    "updateKYC",
    { kycStatus: beforeData.kycStatus, kycData: beforeData.kycData },
    { kycStatus: afterData.kycStatus, kycData: afterData.kycData },
  );

  console.log(`✅ Admin ${adminId} updated KYC status for user ${userId}`, {
    kycStatus,
  });

  return {
    success: true,
    userId,
    kycStatus,
  };
}

/**
 * Sync user balance to Realtime DB (Manual)
 * @deprecated Realtime Database has been removed. This function is kept for backward compatibility
 * but now only returns the current balance from Firestore.
 * @param {string} adminId - Admin user ID
 * @param {string} userId - Target user ID
 * @returns {Promise<Object>} Current balance info
 */
async function syncUserBalanceToRealtime(adminId, userId) {
  // Get user document from Firestore (source of truth)
  const userDoc = await firestore.collection(config.collections.users).doc(userId).get();

  if (!userDoc.exists) {
    throw new Error(`User ${userId} not found`);
  }

  const userData = userDoc.data();
  const balance = Number(userData.balance || 0);
  const currency = userData.currency || userData.fiatCurrency || "USD";

  console.log(`ℹ️ Realtime DB sync deprecated. Returning current Firestore balance for ${userId}`, {
    balance,
    currency,
  });

  return {
    success: true,
    userId,
    balance,
    currency,
    message: "Balance retrieved from Firestore (Realtime DB removed)",
  };
}

/**
 * Get customer rates configuration (buyRate and sellRate)
 * @param {string} adminId - Admin user ID
 * @returns {Promise<Object>} Customer rates configuration
 */
async function getCommissionConfig(adminId) {
  // Get customer rates configuration from Firestore
  const configRef = firestore.collection(config.collections.config).doc("customerRates");
  const configDoc = await configRef.get();

  if (!configDoc.exists) {
    // Return empty structure if config doesn't exist
    return {
      success: true,
      config: {
        rates: {}, // Empty rates object
      },
      message: "No customer rates configured. Please set buyRate and sellRate.",
    };
  }

  const configData = configDoc.data();

  // Get arbitrage fee from config/fees
  let arbitrageFee = 1.5; // Default fallback
  try {
    const feesRef = firestore.collection(config.collections.config).doc("fees");
    const feesDoc = await feesRef.get();
    if (feesDoc.exists && feesDoc.data().arbitrageFee !== undefined) {
      arbitrageFee = Number(feesDoc.data().arbitrageFee);
    }
  } catch (err) {
    console.error("Error fetching arbitrage fee:", err);
  }

  return {
    success: true,
    config: {
      rates: configData.rates || {},
      arbitrageFee: arbitrageFee,
      updatedAt: configData.updatedAt?.toMillis?.() || null,
    },
  };
}

/**
 * Update customer rates configuration (buyRate and sellRate)
 * @param {string} adminId - Admin user ID
 * @param {number} buyRate - Customer rate for buying (rate + commission)
 * @param {number} sellRate - Customer rate for selling (rate + commission)
 * @param {string} currencyPair - Currency pair (e.g., "USDT/KES"), optional
 * @param {number} arbitrageFee - Arbitrage fee percentage (optional)
 * @returns {Promise<Object>} Update result
 */
async function updateCommissionConfig(adminId, buyRate, sellRate, currencyPair = null, arbitrageFee = null) {
  // Validate that both rates are provided (if we are updating rates)
  // If only updating arbitrageFee, skip rate validation
  if (arbitrageFee === null && (buyRate === undefined || sellRate === undefined)) {
    throw new Error("Both buyRate and sellRate are required unless only updating arbitrageFee");
  }

  // Handle arbitrage fee update if provided
  if (arbitrageFee !== null && arbitrageFee !== undefined) {
    const fee = Number(arbitrageFee);
    if (isNaN(fee) || fee < 0) {
      throw new Error("arbitrageFee must be a non-negative number");
    }

    // Update config/fees document
    const feesRef = firestore.collection(config.collections.config).doc("fees");
    await feesRef.set({
      arbitrageFee: fee,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminId,
    }, { merge: true });
  }

  // If rate updates are not provided, we can stop here (or continue if you want to allow partial updates)
  if (buyRate === undefined || sellRate === undefined) {
    return {
      success: true,
      message: "Arbitrage fee updated successfully",
      config: {
        arbitrageFee: Number(arbitrageFee),
      }
    };
  }

  const buy = Number(buyRate);
  const sell = Number(sellRate);

  if (isNaN(buy) || buy <= 0) {
    throw new Error("buyRate must be a positive number");
  }

  if (isNaN(sell) || sell <= 0) {
    throw new Error("sellRate must be a positive number");
  }

  // Get current config for logging
  const configRef = firestore.collection(config.collections.config).doc("customerRates");
  const configDoc = await configRef.get();
  const beforeData = configDoc.exists ? configDoc.data() : { rates: {} };

  // Determine currency pair
  const pair = currencyPair || `${config.binance.defaultAsset}/${config.binance.defaultFiat}`;

  // Prepare update data
  const updateData = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: adminId,
    rates: {
      ...(beforeData.rates || {}),
      [pair]: {
        buyRate: buy,
        sellRate: sell,
      },
    },
  };

  // Update or create config document
  await configRef.set(updateData, { merge: true });

  // Get updated data for logging
  const afterDoc = await configRef.get();
  const afterData = afterDoc.data();

  // Log admin action
  await logAdminAction(
    adminId,
    "system",
    "updateCustomerRates",
    beforeData,
    afterData,
  );

  console.log(`✅ Admin ${adminId} updated customer rates`, {
    currencyPair: pair,
    buyRate: buy,
    sellRate: sell,
  });

  return {
    success: true,
    config: {
      rates: afterData.rates || {},
      updatedAt: afterData.updatedAt?.toMillis?.() || Date.now(),
      updatedBy: adminId,
    },
    message: "Customer rates updated successfully",
  };
}

/**
 * Get IntaSend payment status by invoice_id
 * @param {string} adminId - Admin user ID
 * @param {string} invoiceId - IntaSend invoice ID
 * @returns {Promise<Object>} Payment status
 */
async function getIntaSendPaymentStatus(adminId, invoiceId) {
  if (!invoiceId || typeof invoiceId !== "string" || invoiceId.trim().length === 0) {
    throw new Error("invoiceId is required and must be a non-empty string");
  }

  // Get IntaSend API keys
  const { secretKey, publishableKey } = getIntaSendKeys();

  if (!secretKey) {
    throw new Error("IntaSend API secret key is not configured. Please set INTASEND_SECRET_KEY secret.");
  }

  // Determine if we're in sandbox or production
  const isSandbox = secretKey.includes("sandbox") || secretKey.toLowerCase().includes("test") ||
    process.env.INTASEND_ENV === "sandbox";

  const baseUrl = isSandbox
    ? "https://sandbox.intasend.com"
    : "https://payment.intasend.com";

  // IntaSend API endpoint for checking collection status
  const statusUrl = `${baseUrl}/api/v1/payment/collections/${invoiceId.trim()}/status/`;

  console.log(`🔍 Checking IntaSend payment status for invoice: ${invoiceId}`, {
    baseUrl,
    isSandbox,
  });

  try {
    // Make API call to IntaSend
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${secretKey}`,
    };

    if (publishableKey) {
      headers["X-Publishable-Key"] = publishableKey;
    }

    const response = await axios.get(statusUrl, {
      headers,
      timeout: 10000, // 10 second timeout
    });

    const statusData = response.data;

    console.log(`✅ Successfully retrieved payment status for invoice: ${invoiceId}`);

    // Log admin action
    await logAdminAction(
      adminId,
      "system",
      "checkPaymentStatus",
      {},
      { invoiceId, status: statusData.invoice?.state || "unknown" },
    );

    // Return the status data in a structured format
    return {
      success: true,
      invoiceId,
      status: statusData,
      invoice: statusData.invoice || null,
      meta: statusData.meta || null,
    };
  } catch (apiError) {
    // Handle API errors
    if (apiError.response) {
      const statusCode = apiError.response.status;
      const errorData = apiError.response.data;

      console.error(`❌ IntaSend API error for invoice ${invoiceId}:`, {
        statusCode,
        error: errorData,
      });

      if (statusCode === 404) {
        throw new Error(`Invoice ${invoiceId} not found in IntaSend`);
      } else if (statusCode === 401 || statusCode === 403) {
        throw new Error("Invalid IntaSend API credentials");
      } else {
        throw new Error(`IntaSend API error: ${errorData?.message || errorData?.error || "Unknown error"}`);
      }
    } else if (apiError.request) {
      console.error(`❌ No response from IntaSend API for invoice ${invoiceId}:`, apiError.message);
      throw new Error("IntaSend API request timed out or failed to connect");
    } else {
      console.error(`❌ Error setting up IntaSend API request for invoice ${invoiceId}:`, apiError.message);
      throw new Error(`Failed to check payment status: ${apiError.message}`);
    }
  }
}

/**
 * Replace platform supported countries (super admin only — enforced here).
 * @param {string} adminId - Caller Firebase uid
 * @param {unknown} countries - ISO 3166-1 alpha-3 codes
 * @returns {Promise<Object>}
 */
async function setSupportedCountries(adminId, countries) {
  const ok = await isSuperAdminUid(adminId);
  if (!ok) {
    throw new Error("Super admin access required");
  }

  const result = await supportedCountriesService.setSupportedCountries(adminId, countries);

  await logAdminAction(
    adminId,
    "system",
    "setSupportedCountries",
    { countries: result.before },
    { countries: result.countries, updatedBy: result.updatedBy },
  );

  return {
    success: true,
    countries: result.countries,
    updatedAt: result.updatedAt,
  };
}

module.exports = {
  verifyAdmin,
  updateUserProfile,
  updateUserBalance,
  getUserData,
  updateKYCStatus,
  syncUserBalanceToRealtime, // Deprecated but kept for backward compatibility
  getCommissionConfig,
  updateCommissionConfig,
  getIntaSendPaymentStatus,
  getIntaSendKeys,
  setSupportedCountries,
};

