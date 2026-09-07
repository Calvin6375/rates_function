/**
 * @fileoverview Normalize Customer Wallets PUT body and Auth fields (email sync).
 */

const {validateCustomerEmail} = require("./emailValidation");

/**
 * @param {Object} raw
 * @returns {{ firestoreUpdates: Object, authUpdates: Object }}
 */
function prepareCustomerWalletUpdates(raw) {
  const updateData = raw && typeof raw === "object" ? {...raw} : {};
  delete updateData.balance;
  delete updateData.id;
  delete updateData.createdAt;

  if (updateData.name && !updateData.firstName && !updateData.lastName) {
    const nameParts = String(updateData.name).trim().split(" ");
    updateData.firstName = nameParts[0] || "";
    updateData.lastName = nameParts.slice(1).join(" ") || "";
    delete updateData.name;
  }

  if (updateData.phone && !updateData.phoneNumber) {
    updateData.phoneNumber = updateData.phone;
    delete updateData.phone;
  }

  const authUpdates = {};

  if (updateData.firstName !== undefined || updateData.lastName !== undefined) {
    const name = `${updateData.firstName || ""} ${updateData.lastName || ""}`.trim();
    if (name) {
      updateData.name = updateData.name || name;
      authUpdates.displayName = name;
    }
  }

  if (updateData.email !== undefined) {
    const emailCheck = validateCustomerEmail(updateData.email);
    if (!emailCheck.ok) {
      const err = new Error(emailCheck.error);
      err.statusCode = 400;
      err.code = "INVALID_EMAIL";
      throw err;
    }
    updateData.email = emailCheck.email;
    authUpdates.email = emailCheck.email;
    authUpdates.emailVerified = false;
  }

  if (updateData.phoneNumber) {
    const phone = String(updateData.phoneNumber).trim();
    if (/^\+[1-9]\d{6,14}$/.test(phone)) {
      authUpdates.phoneNumber = phone;
    }
  }

  return {firestoreUpdates: updateData, authUpdates};
}

module.exports = {
  prepareCustomerWalletUpdates,
};
