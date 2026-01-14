/**
 * @fileoverview User wallets business logic module
 * Pure business logic for customer wallet operations
 */

const admin = require("../admin");
const config = require("../config");
const {updateBalanceWithTransaction, getUserBalance, userExists, syncBalanceToRealtimeDatabase} = require("../utils/firestore");
const {logTransaction} = require("../utils/transactions");

const db = admin.firestore();

/**
 * Format user data for API response
 * @param {Object} doc - Firestore document snapshot
 * @returns {Object} Formatted user data
 */
function formatUserData(doc) {
  const data = doc.data();
  const docId = doc.id;
  
  // Split name into firstName/lastName if needed
  let firstName = data.firstName || "";
  let lastName = data.lastName || "";
  if (!firstName && !lastName && data.name) {
    const nameParts = data.name.trim().split(" ");
    firstName = nameParts[0] || "";
    lastName = nameParts.slice(1).join(" ") || "";
  }

  // Handle balance mapping: use actual balance fields, with balance as master source of truth
  // Priority: fiatBalance/cryptoBalance if they exist, otherwise use balance field
  const masterBalance = Number(data.balance || 0);
  
  // Get fiatBalance - use actual value if exists, otherwise use master balance
  const fiatBalance = data.fiatBalance !== undefined && data.fiatBalance !== null
    ? Number(data.fiatBalance)
    : masterBalance;
  
  // Get cryptoBalance - use actual value if exists, otherwise use master balance  
  const cryptoBalance = data.cryptoBalance !== undefined && data.cryptoBalance !== null
    ? Number(data.cryptoBalance)
    : masterBalance;

  // Extract currency-specific balances - DO NOT fall back to fiatBalance/cryptoBalance
  // Each currency should be independent to prevent cross-contamination
  const usdBalance = Number(data.usdBalance || data.USD || 0);
  const kesBalance = Number(data.kesBalance || data.KES || 0);
  const usdtBalance = Number(data.usdtBalance || data.USDT || 0);

  return {
    id: docId,
    customerId: docId,
    firstName: firstName,
    lastName: lastName,
    email: data.email || "",
    phone: data.phoneNumber || data.phone || "",
    // Legacy fields for compatibility
    cryptoBalance: cryptoBalance,
    fiatBalance: fiatBalance,
    balance: masterBalance, // Include master balance field
    // Currency-specific balances for dashboard
    usdBalance: usdBalance,
    kesBalance: kesBalance,
    usdtBalance: usdtBalance,
    // Also include as wallets object for compatibility
    wallets: {
      USD: usdBalance,
      KES: kesBalance,
      USDT: usdtBalance,
    },
    status: data.status || "Active",
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
  };
}

/**
 * Get customer wallet by ID
 * @param {string} id - Wallet/user ID
 * @returns {Promise<Object|null>} Wallet data or null if not found
 */
async function getCustomerWallet(id) {
  // Try new architecture first: /users/{uid}
  const userDoc = await db.collection(config.collections.users).doc(id).get();

  if (userDoc.exists) {
    return formatUserData(userDoc);
  }

  // Fall back to legacy architecture: /customerWallets/{id}
  const walletDoc = await db.collection(config.collections.customerWallets).doc(id).get();

  if (!walletDoc.exists) {
    return null;
  }

  const walletData = walletDoc.data();
  return {
    id: walletDoc.id,
    customerId: walletDoc.id,
    firstName: walletData.firstName || "",
    lastName: walletData.lastName || "",
    email: walletData.email || "",
    phone: walletData.phone || "",
    cryptoBalance: Number(walletData.cryptoBalance || walletData.balance || 0),
    fiatBalance: Number(walletData.fiatBalance || walletData.balance || 0),
    status: walletData.status || "Active",
    createdAt: walletData.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: walletData.updatedAt?.toDate?.()?.toISOString() || null,
  };
}

/**
 * List customer wallets with pagination
 * @param {number} limit - Number of results per page
 * @param {number} offset - Number of results to skip
 * @returns {Promise<{wallets: Array, total: number}>} Wallets and total count
 */
async function listCustomerWallets(limit = 100, offset = 0) {
  // Try to read from /users collection first (new architecture)
  const usersRef = db.collection(config.collections.users);
  let query = usersRef.orderBy("createdAt", "desc").limit(limit);

  if (offset > 0) {
    const offsetSnapshot = await usersRef
        .orderBy("createdAt", "desc")
        .limit(offset)
        .get();
    if (!offsetSnapshot.empty) {
      const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
      query = usersRef
          .orderBy("createdAt", "desc")
          .startAfter(lastDoc)
          .limit(limit);
    }
  }

  const snapshot = await query.get();
  let wallets = snapshot.docs.map(formatUserData);
  let total = snapshot.size;

  // If no users found, try legacy customerWallets collection
  if (wallets.length === 0) {
    const walletsRef = db.collection(config.collections.customerWallets);
    let legacyQuery = walletsRef.orderBy("createdAt", "desc").limit(limit);

    if (offset > 0) {
      const offsetSnapshot = await walletsRef
          .orderBy("createdAt", "desc")
          .limit(offset)
          .get();
      if (!offsetSnapshot.empty) {
        const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
        legacyQuery = walletsRef
            .orderBy("createdAt", "desc")
            .startAfter(lastDoc)
            .limit(limit);
      }
    }

    const legacySnapshot = await legacyQuery.get();
    wallets = legacySnapshot.docs.map((doc) => {
      const data = doc.data();
      const masterBalance = Number(data.balance || 0);
      const fiatBalance = data.fiatBalance !== undefined && data.fiatBalance !== null
        ? Number(data.fiatBalance)
        : masterBalance;
      const cryptoBalance = data.cryptoBalance !== undefined && data.cryptoBalance !== null
        ? Number(data.cryptoBalance)
        : masterBalance;
      
      const usdBalance = Number(data.usdBalance || data.USD || fiatBalance || 0);
      const kesBalance = Number(data.kesBalance || data.KES || 0);
      const usdtBalance = Number(data.usdtBalance || data.USDT || cryptoBalance || 0);
      
      return {
        id: doc.id,
        customerId: doc.id,
        firstName: data.firstName || "",
        lastName: data.lastName || "",
        email: data.email || "",
        phone: data.phone || "",
        balance: masterBalance,
        cryptoBalance: cryptoBalance,
        fiatBalance: fiatBalance,
        usdBalance: usdBalance,
        kesBalance: kesBalance,
        usdtBalance: usdtBalance,
        wallets: {
          USD: usdBalance,
          KES: kesBalance,
          USDT: usdtBalance,
        },
        status: data.status || "Active",
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
      };
    });

    const totalSnapshot = await walletsRef.get();
    total = totalSnapshot.size;
  } else {
    // Get total count from users collection
    const totalSnapshot = await usersRef.get();
    total = totalSnapshot.size;
  }

  return {wallets, total};
}

/**
 * Update customer wallet details
 * @param {string} id - Wallet/user ID
 * @param {Object} updateData - Fields to update
 * @returns {Promise<Object>} Updated wallet data
 */
async function updateCustomerWallet(id, updateData) {
  // Don't allow updating balance directly through this endpoint
  delete updateData.balance;
  delete updateData.id;
  delete updateData.createdAt;

  // Handle firstName/lastName - keep them separate for users collection
  if (updateData.name && !updateData.firstName && !updateData.lastName) {
    const nameParts = updateData.name.trim().split(" ");
    updateData.firstName = nameParts[0] || "";
    updateData.lastName = nameParts.slice(1).join(" ") || "";
    delete updateData.name;
  }
  
  // Map phone -> phoneNumber for users collection
  if (updateData.phone && !updateData.phoneNumber) {
    updateData.phoneNumber = updateData.phone;
    delete updateData.phone;
  }

  // Add updatedAt timestamp
  updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  // Try new architecture first: /users/{uid}
  let userRef = db.collection(config.collections.users).doc(id);
  let userDoc = await userRef.get();

  if (userDoc.exists) {
    await userRef.update(updateData);

    // Fetch updated document
    const updatedDoc = await userRef.get();
    return formatUserData(updatedDoc);
  }

  // Fall back to legacy architecture: /customerWallets/{id}
  const walletRef = db.collection(config.collections.customerWallets).doc(id);
  const walletDoc = await walletRef.get();

  if (!walletDoc.exists) {
    throw new Error("Customer wallet not found in users or customerWallets collection");
  }

  await walletRef.update(updateData);

  // Fetch updated document
  const updatedDoc = await walletRef.get();
  const updatedData = updatedDoc.data();

  return {
    id: updatedDoc.id,
    customerId: updatedDoc.id,
    ...updatedData,
    createdAt: updatedData.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() || null,
  };
}

/**
 * Credit money to a customer wallet
 * @param {string} id - Wallet/user ID
 * @param {number} amount - Amount to credit
 * @param {string} description - Transaction description
 * @param {string} currency - Currency code (USD, KES, USDT) - defaults to "USD"
 * @returns {Promise<Object>} Updated wallet data and transaction info
 */
async function creditCustomerWallet(id, amount, description = "Wallet credit", currency = "USD") {
  // Try new architecture first: /users/{uid}
  const userDoc = await db.collection(config.collections.users).doc(id).get();

  if (userDoc.exists) {
    const userRef = db.collection(config.collections.users).doc(id);
    const userData = userDoc.data();

    // Update currency-specific balance using Firestore transaction
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(userRef);
      if (!doc.exists) {
        throw new Error("User not found");
      }
      
      const currentData = doc.data();
      const updateFields = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Get current balances for all currencies
      const currentUsdBalance = Number(currentData.usdBalance || currentData.USD || 0);
      const currentKesBalance = Number(currentData.kesBalance || currentData.KES || 0);
      const currentUsdtBalance = Number(currentData.usdtBalance || currentData.USDT || 0);
      const currentBalance = Number(currentData.balance || 0);
      const currentFiatBalance = Number(currentData.fiatBalance || currentUsdBalance || 0);
      const currentCryptoBalance = Number(currentData.cryptoBalance || currentUsdtBalance || 0);

      // Update currency-specific balance based on currency parameter
      if (currency === "USD") {
        const newUsdBalance = currentUsdBalance + amount;
        const newBalance = currentBalance + amount;
        const newFiatBalance = currentFiatBalance + amount;
        
        updateFields.balance = newBalance;
        updateFields.fiatBalance = newFiatBalance;
        updateFields.usdBalance = newUsdBalance;
        updateFields.USD = newUsdBalance;
      } else if (currency === "KES") {
        const newKesBalance = currentKesBalance + amount;
        const newFiatBalance = currentFiatBalance + amount; // KES is also fiat, so update fiatBalance
        const newBalance = currentBalance + amount;
        
        updateFields.kesBalance = newKesBalance;
        updateFields.KES = newKesBalance;
        updateFields.fiatBalance = newFiatBalance; // Update fiatBalance for KES credits
        updateFields.balance = newBalance;
      } else if (currency === "USDT") {
        const newUsdtBalance = currentUsdtBalance + amount;
        const newCryptoBalance = currentCryptoBalance + amount;
        const newBalance = currentBalance + amount;
        
        updateFields.usdtBalance = newUsdtBalance;
        updateFields.USDT = newUsdtBalance;
        updateFields.cryptoBalance = newCryptoBalance;
        updateFields.balance = newBalance;
      }

      // Always update wallets object for dashboard compatibility (stored in Firestore)
      const finalUsdBalance = currency === "USD" ? currentUsdBalance + amount : currentUsdBalance;
      const finalKesBalance = currency === "KES" ? currentKesBalance + amount : currentKesBalance;
      const finalUsdtBalance = currency === "USDT" ? currentUsdtBalance + amount : currentUsdtBalance;
      
      updateFields.wallets = {
        USD: finalUsdBalance,
        KES: finalKesBalance,
        USDT: finalUsdtBalance,
      };
      
      transaction.update(userRef, updateFields);
    });

    // Get previous balance for logging (before transaction)
    const previousBalance = currency === "USD" 
      ? Number(userData.usdBalance || userData.USD || 0)
      : currency === "KES"
        ? Number(userData.kesBalance || userData.KES || 0)
        : Number(userData.usdtBalance || userData.USDT || 0);

    // Log transaction
    try {
      await logTransaction(
          id,
          "credit",
          amount,
          "completed",
          previousBalance,
          previousBalance + amount,
          {
            source: "admin_api",
            description: description,
            currency: currency,
          },
      );
    } catch (logError) {
      console.error("Failed to log transaction:", logError.message);
    }

    // Sync balance to Realtime Database for Flutter app
    try {
      await syncBalanceToRealtimeDatabase(id, currency);
    } catch (syncError) {
      console.error("Failed to sync balance to Realtime DB:", syncError.message);
      // Don't fail the operation if sync fails
    }

    // Fetch updated user
    const updatedDoc = await db.collection(config.collections.users).doc(id).get();

    return {
      wallet: formatUserData(updatedDoc),
      transaction: {
        type: "credit",
        amount,
        currency: currency,
        previousBalance: previousBalance,
        newBalance: previousBalance + amount,
      },
    };
  }

  // Fall back to legacy architecture: /customerWallets/{id}
  const walletRef = db.collection(config.collections.customerWallets).doc(id);
  const walletDoc = await walletRef.get();

  if (!walletDoc.exists) {
    throw new Error("Customer wallet not found in users or customerWallets collection");
  }

  const currentBalance = walletDoc.data().balance || 0;
  const newBalance = currentBalance + amount;

  // Update balance
  await walletRef.update({
    balance: newBalance,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Create transaction record
  const transactionData = {
    walletId: id,
    type: "credit",
    amount,
    previousBalance: currentBalance,
    newBalance,
    description: description,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("walletTransactions").add(transactionData);

  // Fetch updated wallet
  const updatedDoc = await walletRef.get();
  const updatedData = updatedDoc.data();

  return {
    wallet: {
      id: updatedDoc.id,
      customerId: updatedDoc.id,
      ...updatedData,
      createdAt: updatedData.createdAt?.toDate?.()?.toISOString() || null,
      updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() || null,
    },
    transaction: {
      type: "credit",
      amount,
      previousBalance: currentBalance,
      newBalance,
    },
  };
}

/**
 * Debit money from a customer wallet
 * @param {string} id - Wallet/user ID
 * @param {number} amount - Amount to debit
 * @param {string} description - Transaction description
 * @param {string} currency - Currency code (USD, KES, USDT) - defaults to "USD"
 * @returns {Promise<Object>} Updated wallet data and transaction info
 */
async function debitCustomerWallet(id, amount, description = "Wallet debit", currency = "USD") {
  // Try new architecture first: /users/{uid}
  const userDoc = await db.collection(config.collections.users).doc(id).get();

  if (userDoc.exists) {
    const userRef = db.collection(config.collections.users).doc(id);
    const userData = userDoc.data();

    // Get current balance for the specific currency
    const currentBalance = currency === "USD"
      ? Number(userData.usdBalance || userData.USD || 0)
      : currency === "KES"
        ? Number(userData.kesBalance || userData.KES || 0)
        : Number(userData.usdtBalance || userData.USDT || 0);

    if (currentBalance < amount) {
      throw new Error(`Insufficient ${currency} balance. Current: ${currentBalance}, Required: ${amount}`);
    }

    // Update currency-specific balance using Firestore transaction
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(userRef);
      if (!doc.exists) {
        throw new Error("User not found");
      }
      
      const currentData = doc.data();
      const updateFields = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Get current balances for all currencies
      const currentUsdBalance = Number(currentData.usdBalance || currentData.USD || 0);
      const currentKesBalance = Number(currentData.kesBalance || currentData.KES || 0);
      const currentUsdtBalance = Number(currentData.usdtBalance || currentData.USDT || 0);
      const currentBalance = Number(currentData.balance || 0);
      const currentFiatBalance = Number(currentData.fiatBalance || currentUsdBalance || 0);
      const currentCryptoBalance = Number(currentData.cryptoBalance || currentUsdtBalance || 0);

      // Update currency-specific balance based on currency parameter
      if (currency === "USD") {
        if (currentUsdBalance < amount) {
          throw new Error("Insufficient USD balance");
        }
        
        const newUsdBalance = currentUsdBalance - amount;
        const newBalance = currentBalance - amount;
        const newFiatBalance = currentFiatBalance - amount;
        
        updateFields.balance = newBalance;
        updateFields.fiatBalance = newFiatBalance;
        updateFields.usdBalance = newUsdBalance;
        updateFields.USD = newUsdBalance;
      } else if (currency === "KES") {
        if (currentKesBalance < amount) {
          throw new Error("Insufficient KES balance");
        }
        
        const newKesBalance = currentKesBalance - amount;
        const newFiatBalance = currentFiatBalance - amount; // KES is also fiat, so update fiatBalance
        const newBalance = Math.max(0, currentBalance - amount);
        
        updateFields.kesBalance = newKesBalance;
        updateFields.KES = newKesBalance;
        updateFields.fiatBalance = newFiatBalance; // Update fiatBalance for KES debits
        updateFields.balance = newBalance;
      } else if (currency === "USDT") {
        if (currentUsdtBalance < amount) {
          throw new Error("Insufficient USDT balance");
        }
        
        const newUsdtBalance = currentUsdtBalance - amount;
        const newCryptoBalance = currentCryptoBalance - amount;
        const newBalance = Math.max(0, currentBalance - amount);
        
        updateFields.usdtBalance = newUsdtBalance;
        updateFields.USDT = newUsdtBalance;
        updateFields.cryptoBalance = newCryptoBalance;
        updateFields.balance = newBalance;
      }

      // Always update wallets object for dashboard compatibility (stored in Firestore)
      const finalUsdBalance = currency === "USD" ? currentUsdBalance - amount : currentUsdBalance;
      const finalKesBalance = currency === "KES" ? currentKesBalance - amount : currentKesBalance;
      const finalUsdtBalance = currency === "USDT" ? currentUsdtBalance - amount : currentUsdtBalance;
      
      updateFields.wallets = {
        USD: Math.max(0, finalUsdBalance),
        KES: Math.max(0, finalKesBalance),
        USDT: Math.max(0, finalUsdtBalance),
      };
      
      transaction.update(userRef, updateFields);
    });

    // Log transaction
    try {
      await logTransaction(
          id,
          "debit",
          amount,
          "completed",
          currentBalance,
          currentBalance - amount,
          {
            source: "admin_api",
            description: description,
            currency: currency,
          },
      );
    } catch (logError) {
      console.error("Failed to log transaction:", logError.message);
    }

    // Sync balance to Realtime Database for Flutter app
    try {
      await syncBalanceToRealtimeDatabase(id, currency);
    } catch (syncError) {
      console.error("Failed to sync balance to Realtime DB:", syncError.message);
      // Don't fail the operation if sync fails
    }

    // Fetch updated user
    const updatedDoc = await db.collection(config.collections.users).doc(id).get();

    return {
      wallet: formatUserData(updatedDoc),
      transaction: {
        type: "debit",
        amount,
        currency: currency,
        previousBalance: currentBalance,
        newBalance: currentBalance - amount,
      },
    };
  }

  // Fall back to legacy architecture: /customerWallets/{id}
  const walletRef = db.collection(config.collections.customerWallets).doc(id);
  const walletDoc = await walletRef.get();

  if (!walletDoc.exists) {
    throw new Error("Customer wallet not found in users or customerWallets collection");
  }

  const currentBalance = walletDoc.data().balance || 0;

  if (currentBalance < amount) {
    throw new Error("Insufficient balance");
  }

  const newBalance = currentBalance - amount;

  // Update balance
  await walletRef.update({
    balance: newBalance,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Create transaction record
  const transactionData = {
    walletId: id,
    type: "debit",
    amount,
    previousBalance: currentBalance,
    newBalance,
    description: description,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("walletTransactions").add(transactionData);

  // Fetch updated wallet
  const updatedDoc = await walletRef.get();
  const updatedData = updatedDoc.data();

  return {
    wallet: {
      id: updatedDoc.id,
      customerId: updatedDoc.id,
      ...updatedData,
      createdAt: updatedData.createdAt?.toDate?.()?.toISOString() || null,
      updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() || null,
    },
    transaction: {
      type: "debit",
      amount,
      previousBalance: currentBalance,
      newBalance,
    },
  };
}

module.exports = {
  formatUserData,
  getCustomerWallet,
  listCustomerWallets,
  updateCustomerWallet,
  creditCustomerWallet,
  debitCustomerWallet,
};

