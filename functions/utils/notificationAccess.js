/**
 * @fileoverview Auth scoping for notificationsApi — platform super vs B2B partner vs consumer.
 */

const { isSuperAdmin, isPlatformAdmin } = require("./accessControl");
const { NOTIFICATION_TYPES } = require("./notifications");

/** @type {readonly string[]} */
const ADMIN_ALERT_TYPES = [
  NOTIFICATION_TYPES.DIRECT_TOPUP_ADMIN_ALERT,
  NOTIFICATION_TYPES.DIRECT_PAYOUT_ADMIN_ALERT,
];

/**
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
function isAdminAlertType(type) {
  if (!type || typeof type !== "string") {
    return false;
  }
  if (ADMIN_ALERT_TYPES.includes(type)) {
    return true;
  }
  return /^direct_.*_admin_alert$/.test(type);
}

/**
 * Platform super-admin: explicit claim, legacy admin claim, or master email.
 *
 * @param {Object|null|undefined} decodedToken
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function hasPlatformSuperAccess(decodedToken, uid) {
  if (decodedToken?.platform?.super === true) {
    return true;
  }
  if (await isSuperAdmin(decodedToken, uid)) {
    return true;
  }
  return decodedToken?.admin === true;
}

/**
 * @param {Object|null|undefined} decodedToken
 * @returns {boolean}
 */
function isB2BPartnerUser(decodedToken) {
  const pid = decodedToken?.partnerId;
  return typeof pid === "string" && pid.trim().length > 0;
}

/**
 * @param {string} uid
 * @param {Object|null|undefined} decodedToken
 * @returns {Promise<Object>}
 */
async function buildNotificationAccessScope(uid, decodedToken) {
  const platformSuper = await hasPlatformSuperAccess(decodedToken, uid);
  const partnerId =
    typeof decodedToken?.partnerId === "string" && decodedToken.partnerId.trim() ?
      decodedToken.partnerId.trim() :
      null;
  return {
    uid,
    decodedToken: decodedToken || {},
    platformSuper,
    partnerId,
    isPartner: isB2BPartnerUser(decodedToken),
  };
}

/**
 * Resolve which Firestore userId bucket to query.
 *
 * @param {string|null|undefined} requestedUserId
 * @param {Object} scope
 * @returns {{ ok: true, targetUserId: string }|{ ok: false, status: number, error: string, message?: string }}
 */
function resolveNotificationTargetUserId(requestedUserId, scope) {
  const raw =
    requestedUserId !== undefined && requestedUserId !== null ?
      String(requestedUserId).trim() :
      "";
  const target = raw || scope.uid;

  if (target === "system") {
    if (!scope.platformSuper) {
      return {
        ok: false,
        status: 403,
        error: "FORBIDDEN",
        message: "Platform super access required for system notifications.",
      };
    }
    return { ok: true, targetUserId: "system" };
  }

  if (!scope.platformSuper && target !== scope.uid) {
    return {
      ok: false,
      status: 403,
      error: "FORBIDDEN",
      message: "Cannot access notifications for another user.",
    };
  }

  return { ok: true, targetUserId: target };
}

/**
 * @param {Object} notification
 * @param {Object} scope
 * @returns {boolean}
 */
function notificationVisibleToScope(notification, scope) {
  if (!notification || typeof notification !== "object") {
    return false;
  }

  if (isAdminAlertType(notification.type)) {
    return scope.platformSuper;
  }

  if (scope.platformSuper) {
    return true;
  }

  const bucket = notification.userId != null ? String(notification.userId) : "system";

  if (bucket === "system") {
    return false;
  }

  if (bucket !== scope.uid) {
    return false;
  }

  const metaPartnerId =
    notification.metadata &&
    typeof notification.metadata === "object" &&
    notification.metadata.partnerId ?
      String(notification.metadata.partnerId).trim() :
      null;
  if (scope.partnerId && metaPartnerId && metaPartnerId !== scope.partnerId) {
    return false;
  }

  return true;
}

/**
 * @param {Object[]} notifications
 * @param {Object} scope
 * @returns {Object[]}
 */
function filterNotificationsForScope(notifications, scope) {
  return notifications.filter((n) => notificationVisibleToScope(n, scope));
}

/**
 * @param {Object} notification
 * @param {Object} scope
 * @returns {{ ok: true }|{ ok: false, status: number, error: string, message?: string }}
 */
function assertNotificationWritable(notification, scope) {
  if (!notificationVisibleToScope(notification, scope)) {
    return {
      ok: false,
      status: 403,
      error: "FORBIDDEN",
      message: "Not allowed to modify this notification.",
    };
  }
  return { ok: true };
}

module.exports = {
  isAdminAlertType,
  hasPlatformSuperAccess,
  isB2BPartnerUser,
  buildNotificationAccessScope,
  resolveNotificationTargetUserId,
  notificationVisibleToScope,
  filterNotificationsForScope,
  assertNotificationWritable,
};
