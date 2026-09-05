/**
 * @fileoverview C2B self-registration: POST /api/register.
 * Creates Auth user + Firestore users/{uid} with institution/channel tags.
 *
 * Flutter often creates Auth first (createUserWithEmailAndPassword) then calls
 * this endpoint. Reuse that Auth user and only write the profile — do not 409
 * unless a completed customer profile already exists.
 */

const admin = require("../admin");
const config = require("../config");
const {
  INSTITUTION_CUSTOMER_APP,
  CHANNEL_C2B,
  parseCustomerAppProvisioningFields,
} = require("../utils/customerAppProvisioning");
const { setCustomerAccessClaims, USER_TYPE_CUSTOMER } = require("../utils/accessControl");
const {validateCustomerEmail} = require("../utils/emailValidation");

const firestore = admin.firestore();

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
 * True when users/{uid} already looks like a finished C2B signup.
 * @param {FirebaseFirestore.DocumentData|null|undefined} data
 * @returns {boolean}
 */
function hasCompletedCustomerProfile(data) {
  if (!data || typeof data !== "object") return false;
  const channel = String(data.channel || "");
  const institution = String(data.institution || "");
  const userType = String(data.userType || "");
  if (channel === CHANNEL_C2B || institution === INSTITUTION_CUSTOMER_APP) {
    return true;
  }
  if (userType === USER_TYPE_CUSTOMER && data.email && data.firstName) {
    return true;
  }
  return false;
}

/**
 * Create Auth user, or reuse Auth created by the Flutter client.
 *
 * @param {{
 *   normalizedEmail: string,
 *   password: string,
 *   displayName: string,
 * }} params
 * @returns {Promise<{ userRecord: import("firebase-admin/auth").UserRecord, createdAuth: boolean }>}
 */
async function resolveAuthUserForRegister(params) {
  const {normalizedEmail, password, displayName} = params;

  try {
    const userRecord = await admin.auth().createUser({
      email: normalizedEmail,
      password,
      displayName,
      emailVerified: false,
    });
    return {userRecord, createdAuth: true};
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      const userRecord = await admin.auth().getUserByEmail(normalizedEmail);
      const userSnap = await firestore
          .collection(config.collections.users)
          .doc(userRecord.uid)
          .get();
      if (userSnap.exists && hasCompletedCustomerProfile(userSnap.data())) {
        const err = new Error("An account already exists for this email");
        err.statusCode = 409;
        throw err;
      }
      // Flutter (or a prior partial signup) already created Auth — finish profile.
      try {
        await admin.auth().updateUser(userRecord.uid, {
          password,
          displayName,
          emailVerified: false,
        });
      } catch (updateErr) {
        console.warn(
            "registerC2bCustomer updateUser (reuse Auth):",
            updateErr.code || updateErr.message,
        );
      }
      return {userRecord, createdAuth: false};
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
  const emailCheck = validateCustomerEmail(email);
  if (!emailCheck.ok) {
    const err = new Error(emailCheck.error);
    err.statusCode = 400;
    err.code = "INVALID_EMAIL";
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

  const normalizedEmail = emailCheck.email;
  const displayName = `${firstName} ${lastName}`.trim();

  const {userRecord, createdAuth} = await resolveAuthUserForRegister({
    normalizedEmail,
    password,
    displayName,
  });

  const uid = userRecord.uid;
  const userRef = firestore.collection(config.collections.users).doc(uid);

  try {
    await setCustomerAccessClaims(uid);
    await userRef.set(
        {
          uid,
          firstName,
          lastName,
          name: displayName,
          email: normalizedEmail,
          phoneNumber,
          userType: USER_TYPE_CUSTOMER,
          status: "active",
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
    // Only delete Auth if we created it in this request (don't wipe Flutter Auth).
    if (createdAuth) {
      try {
        await admin.auth().deleteUser(uid);
      } catch (delErr) {
        console.error(
            "registerC2bCustomer rollback deleteUser:",
            delErr.message,
        );
      }
    }
    const err = new Error("Could not save user profile; please try again");
    err.statusCode = 500;
    throw err;
  }

  return {
    userId: uid,
    userType: USER_TYPE_CUSTOMER,
    institution: tagging.institution,
    channel: tagging.channel,
  };
}

module.exports = {
  registerC2bCustomer,
  hasCompletedCustomerProfile,
};
