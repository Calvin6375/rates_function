/**
 * @fileoverview C2B self-registration: POST /api/register.
 * Creates Auth user + Firestore users/{uid} with institution/channel tags.
 */

const admin = require("../admin");
const config = require("../config");
const {
  INSTITUTION_CUSTOMER_APP,
  CHANNEL_C2B,
  parseCustomerAppProvisioningFields,
} = require("../utils/customerAppProvisioning");

const firestore = admin.firestore();

/**
 * @param {string} email
 * @return {boolean}
 */
function isValidEmailShape(email) {
  const s = String(email).trim();
  if (s.length < 5 || s.length > 254) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * E.164: + then country code and subscriber digits (rough ITU bounds).
 * @param {string} phone
 * @return {boolean}
 */
function isValidE164(phone) {
  const s = String(phone).trim();
  return /^\+[1-9]\d{6,14}$/.test(s);
}

/**
 * @param {Object} body
 * @return {Promise<Object>} userId, institution, channel
 */
async function registerC2bCustomer(body) {
  const tagging = parseCustomerAppProvisioningFields(body);
  if (!tagging) {
    const err = new Error(
        `Request must include Institution "${INSTITUTION_CUSTOMER_APP}" ` +
        `and Channel "${CHANNEL_C2B}"`,
    );
    err.statusCode = 400;
    throw err;
  }

  const firstName = body.firstName != null ? String(body.firstName).trim() : "";
  const lastName = body.lastName != null ? String(body.lastName).trim() : "";
  const email = body.email != null ? String(body.email).trim() : "";
  const phoneNumber =
    body.phoneNumber != null ? String(body.phoneNumber).trim() : "";
  const password = body.password != null ? String(body.password) : "";

  if (!firstName || !lastName) {
    const err = new Error("firstName and lastName are required");
    err.statusCode = 400;
    throw err;
  }
  if (!email || !isValidEmailShape(email)) {
    const err = new Error("A valid email is required");
    err.statusCode = 400;
    throw err;
  }
  if (!phoneNumber || !isValidE164(phoneNumber)) {
    const err = new Error(
        "phoneNumber must be E.164 (e.g. +254744555666)",
    );
    err.statusCode = 400;
    throw err;
  }
  if (!password || password.length < 8) {
    const err = new Error("password must be at least 8 characters");
    err.statusCode = 400;
    throw err;
  }

  const normalizedEmail = email.toLowerCase();
  const displayName = `${firstName} ${lastName}`.trim();

  let userRecord;
  try {
    // Phone is stored on Firestore only; Auth email/password does not require
    // Identity Toolkit phone provider linkage for createUser.
    userRecord = await admin.auth().createUser({
      email: normalizedEmail,
      password,
      displayName,
      emailVerified: false,
    });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      const err = new Error("An account already exists for this email");
      err.statusCode = 409;
      throw err;
    }
    if (e.code === "auth/invalid-email") {
      const err = new Error("Invalid email address");
      err.statusCode = 400;
      throw err;
    }
    if (e.code === "auth/invalid-password" || e.code === "auth/weak-password") {
      const err = new Error("Password does not meet security requirements");
      err.statusCode = 400;
      throw err;
    }
    console.error("registerC2bCustomer createUser:", e.code, e.message);
    const err = new Error(e.message || "Registration failed");
    err.statusCode = 400;
    throw err;
  }

  const uid = userRecord.uid;
  const userRef = firestore.collection(config.collections.users).doc(uid);

  try {
    await userRef.set(
        {
          firstName,
          lastName,
          name: displayName,
          email: normalizedEmail,
          phoneNumber,
          institution: tagging.institution,
          channel: tagging.channel,
          balance: 0,
          country: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
    );
  } catch (firestoreErr) {
    console.error(
        "registerC2bCustomer Firestore rollback uid",
        uid,
        firestoreErr.message,
    );
    try {
      await admin.auth().deleteUser(uid);
    } catch (delErr) {
      console.error(
          "registerC2bCustomer rollback deleteUser:",
          delErr.message,
      );
    }
    const err = new Error("Could not save user profile; please try again");
    err.statusCode = 500;
    throw err;
  }

  return {
    userId: uid,
    institution: tagging.institution,
    channel: tagging.channel,
  };
}

module.exports = {
  registerC2bCustomer,
};
