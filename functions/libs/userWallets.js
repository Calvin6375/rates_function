/**
 * @fileoverview User wallets business logic module
 * Pure business logic for customer wallet operations
 */

const admin = require("../admin");
const config = require("../config");
const {updateBalanceWithTransaction, getUserBalance, userExists} = require("../utils/firestore");
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

  // Handle balance mapping: prioritize balance field as source of truth
  const balance = Number(data.balance || 0);
  const cryptoBalanceValue = data.cryptoBalance !== undefined && data.cryptoBalance !== null 
    ? Number(data.cryptoBalance) 
    : null;
  const fiatBalanceValue = data.fiatBalance !== undefined && data.fiatBalance !== null 
    ? Number(data.fiatBalance) 
    : null;
  
  // Use balance as fallback if the specific balance fields are 0 or missing
  const cryptoBalance = (cryptoBalanceValue !== null && cryptoBalanceValue !== 0) 
    ? cryptoBalanceValue 
    : balance;
  const fiatBalance = (fiatBalanceValue !== null && fiatBalanceValue !== 0) 
    ? fiatBalanceValue 
    : balance;

  return {
    id: docId,
    customerId: docId,
    firstName: firstName,
    lastName: lastName,
    email: data.email || "",
    phone: data.phoneNumber || data.phone || "",
    cryptoBalance: cryptoBalance,
    fiatBalance: fiatBalance,
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
      const balance = Number(data.balance || 0);
      const cryptoBalanceValue = data.cryptoBalance !== undefined && data.cryptoBalance !== null 
        ? Number(data.cryptoBalance) 
        : null;
      const fiatBalanceValue = data.fiatBalance !== undefined && data.fiatBalance !== null 
        ? Number(data.fiatBalance) 
        : null;
      const cryptoBalance = (cryptoBalanceValue !== null && cryptoBalanceValue !== 0) 
        ? cryptoBalanceValue 
        : balance;
      const fiatBalance = (fiatBalanceValue !== null && fiatBalanceValue !== 0) 
        ? fiatBalanceValue 
        : balance;
      
      return {
        id: doc.id,
        customerId: doc.id,
        firstName: data.firstName || "",
        lastName: data.lastName || "",
        email: data.email || "",
        phone: data.phone || "",
        cryptoBalance: cryptoBalance,
        fiatBalance: fiatBalance,
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
 * @returns {Promise<Object>} Updated wallet data and transaction info
 */
async function creditCustomerWallet(id, amount, description = "Wallet credit") {
  // Try new architecture first: /users/{uid}
  const userDoc = await db.collection(config.collections.users).doc(id).get();

  if (userDoc.exists) {
    const userRef = db.collection(config.collections.users).doc(id);
    const userData = userDoc.data();
    const currentFiatBalance = Number(userData.fiatBalance || 0);
    const currentBalance = Number(userData.balance || currentFiatBalance);
    const newFiatBalance = currentFiatBalance + amount;
    const newBalance = currentBalance + amount;

    // Update both fiatBalance and balance using Firestore transaction
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(userRef);
      if (!doc.exists) {
        throw new Error("User not found");
      }
      
      const currentData = doc.data();
      const currentFiatBalance = Number(currentData.fiatBalance || 0);
      const currentBalance = Number(currentData.balance || currentFiatBalance);
      const newFiatBalance = currentFiatBalance + amount;
      const newBalance = currentBalance + amount;
      
      transaction.update(userRef, {
        fiatBalance: newFiatBalance,
        balance: newBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Log transaction
    try {
      await logTransaction(
          id,
          "credit",
          amount,
          "completed",
          currentFiatBalance,
          newFiatBalance,
          {
            source: "admin_api",
            description: description,
            currency: "fiat",
          },
      );
    } catch (logError) {
      console.error("Failed to log transaction:", logError.message);
    }

    // Balance is stored in Firestore only (no RTDB sync needed)
    // Clients should listen to Firestore document changes for real-time updates

    // Fetch updated user
    const updatedDoc = await db.collection(config.collections.users).doc(id).get();
    const updatedData = updatedDoc.data();

    const balance = Number(updatedData.balance || 0);
    const cryptoBalanceValue = updatedData.cryptoBalance !== undefined && updatedData.cryptoBalance !== null 
      ? Number(updatedData.cryptoBalance) 
      : null;
    const cryptoBalance = (cryptoBalanceValue !== null && cryptoBalanceValue !== 0) 
      ? cryptoBalanceValue 
      : balance;

    return {
      wallet: formatUserData(updatedDoc),
      transaction: {
        type: "credit",
        amount,
        previousBalance: currentFiatBalance,
        newBalance: newFiatBalance,
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
 * @returns {Promise<Object>} Updated wallet data and transaction info
 */
async function debitCustomerWallet(id, amount, description = "Wallet debit") {
  // Try new architecture first: /users/{uid}
  const userDoc = await db.collection(config.collections.users).doc(id).get();

  if (userDoc.exists) {
    const userRef = db.collection(config.collections.users).doc(id);
    const userData = userDoc.data();
    const currentFiatBalance = Number(userData.fiatBalance || 0);
    const currentBalance = Number(userData.balance || currentFiatBalance);

    if (currentFiatBalance < amount) {
      throw new Error("Insufficient balance");
    }

    const newFiatBalance = currentFiatBalance - amount;
    const newBalance = currentBalance - amount;

    // Update both fiatBalance and balance using Firestore transaction
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(userRef);
      if (!doc.exists) {
        throw new Error("User not found");
      }
      
      const currentData = doc.data();
      const currentFiatBalance = Number(currentData.fiatBalance || 0);
      const currentBalance = Number(currentData.balance || currentFiatBalance);
      
      if (currentFiatBalance < amount) {
        throw new Error("Insufficient balance");
      }
      
      const newFiatBalance = currentFiatBalance - amount;
      const newBalance = currentBalance - amount;
      
      transaction.update(userRef, {
        fiatBalance: newFiatBalance,
        balance: newBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Log transaction
    try {
      await logTransaction(
          id,
          "debit",
          amount,
          "completed",
          currentFiatBalance,
          newFiatBalance,
          {
            source: "admin_api",
            description: description,
            currency: "fiat",
          },
      );
    } catch (logError) {
      console.error("Failed to log transaction:", logError.message);
    }

    // Balance is stored in Firestore only (no RTDB sync needed)
    // Clients should listen to Firestore document changes for real-time updates

    // Fetch updated user
    const updatedDoc = await db.collection(config.collections.users).doc(id).get();
    const updatedData = updatedDoc.data();

    const balance = Number(updatedData.balance || 0);
    const cryptoBalanceValue = updatedData.cryptoBalance !== undefined && updatedData.cryptoBalance !== null 
      ? Number(updatedData.cryptoBalance) 
      : null;
    const cryptoBalance = (cryptoBalanceValue !== null && cryptoBalanceValue !== 0) 
      ? cryptoBalanceValue 
      : balance;

    return {
      wallet: formatUserData(updatedDoc),
      transaction: {
        type: "debit",
        amount,
        previousBalance: currentFiatBalance,
        newBalance: newFiatBalance,
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

