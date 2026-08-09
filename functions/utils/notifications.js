const admin = require("../admin");
const config = require("../config");
const firestore = admin.firestore();
const messaging = admin.messaging();

/**
 * Notification types
 */
const NOTIFICATION_TYPES = {
  PAYMENT_COMPLETED: "payment_completed",
  /** Customer requested a bank/manual direct top-up (not IntaSend checkout, not admin credit) */
  DIRECT_TOPUP_REQUESTED: "direct_topup_requested",
  /** Admin dashboard + optional FCM to configured admin UIDs */
  DIRECT_TOPUP_ADMIN_ALERT: "direct_topup_admin_alert",
  /** Customer requested a manual / bank payout (ops settles outside app) */
  DIRECT_PAYOUT_REQUESTED: "direct_payout_requested",
  DIRECT_PAYOUT_ADMIN_ALERT: "direct_payout_admin_alert",
  /** B2B partner requested go-live review from platform super admin */
  GO_LIVE_REQUESTED: "go_live_requested",
  GO_LIVE_REQUEST_ADMIN_ALERT: "go_live_request_admin_alert",
  /** B2B partner submitted a Send / payout for ops fulfillment */
  B2B_SEND_REQUESTED: "b2b_send_requested",
  B2B_SEND_ADMIN_ALERT: "b2b_send_admin_alert",
  WALLET_CREDITED: "wallet_credited",
  WALLET_DEBITED: "wallet_debited",
  TRANSACTION_COMPLETED: "transaction_completed",
  BALANCE_LOW: "balance_low",
  SECURITY_ALERT: "security_alert",
  SYSTEM_ALERT: "system_alert",
};

/**
 * Create a notification and send it to both dashboard and mobile app
 * @param {Object} options - Notification options
 * @param {string} options.userId - User ID (`null` → `"system"` for platform admin alerts only)
 * @param {string} options.type - Notification type
 * @param {string} options.title - Notification title
 * @param {string} options.message - Notification message
 * @param {string} options.actionUrl - Optional URL for dashboard action
 * @param {Object} options.metadata - Additional metadata
 * @param {boolean} options.sendPush - Whether to send FCM push notification (default: true)
 * @returns {Promise<{notificationId: string, sent: boolean}>}
 */
async function createNotification({
  userId = null,
  type,
  title,
  message,
  actionUrl = null,
  metadata = {},
  sendPush = true,
}) {
  try {
    const notificationData = {
      userId: userId || "system", // "system" for admin notifications
      type,
      title,
      message,
      actionUrl,
      metadata,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Save to Firestore (for dashboard)
    const notificationRef = firestore
        .collection("notifications")
        .doc();
    
    await notificationRef.set(notificationData);
    const notificationId = notificationRef.id;

    // Send FCM push notification to mobile app (if userId provided and sendPush is true)
    let pushSent = false;
    if (userId && sendPush) {
      try {
        await sendPushNotification(userId, {
          notificationId,
          type,
          title,
          message,
          data: {
            type,
            actionUrl,
            ...metadata,
          },
        });
        pushSent = true;
      } catch (pushError) {
        console.error("⚠️ Failed to send push notification:", pushError.message);
        // Don't fail the notification creation if push fails
      }
    }

    console.log(`✅ Notification created: ${notificationId}`, {
      userId,
      type,
      title,
      pushSent,
    });

    return {
      notificationId,
      sent: pushSent,
    };
  } catch (error) {
    console.error("❌ Error creating notification:", {
      userId,
      type,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Send FCM push notification to user's device
 * @param {string} userId - User ID
 * @param {Object} payload - Notification payload
 * @returns {Promise<void>}
 */
async function sendPushNotification(userId, payload) {
  try {
    // Get user's FCM token from Firestore
    const userDoc = await firestore.collection("users").doc(userId).get();
    
    if (!userDoc.exists) {
      throw new Error(`User ${userId} not found`);
    }

    const userData = userDoc.data();
    const fcmToken = userData.fcmToken;

    if (!fcmToken) {
      console.log(`ℹ️ No FCM token found for user ${userId}, skipping push notification`);
      return;
    }

    const message = {
      token: fcmToken,
      notification: {
        title: payload.title,
        body: payload.message,
      },
      data: {
        notificationId: payload.notificationId || "",
        type: payload.type || "",
        ...Object.fromEntries(
            Object.entries(payload.data || {}).map(([k, v]) => [k, String(v)])
        ),
      },
      android: {
        priority: "high",
        notification: {
          channelId: "default",
          sound: "default",
          priority: "high",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
          },
        },
      },
    };

    await messaging.send(message);
    console.log(`✅ Push notification sent to user ${userId}`);
  } catch (error) {
    if (error.code === "messaging/invalid-registration-token" || 
        error.code === "messaging/registration-token-not-registered") {
      // Token is invalid, remove it from user document
      console.warn(`⚠️ Invalid FCM token for user ${userId}, removing token`);
      await firestore.collection("users").doc(userId).update({
        fcmToken: admin.firestore.FieldValue.delete(),
      });
    }
    throw error;
  }
}

/**
 * Firestore config doc: config/directTopup — { adminUserIds: string[] }
 * Pushes to each UID with an fcmToken; also writes one "system" notification for the admin web dashboard.
 * @param {Object} params
 * @param {string} params.customerUserId
 * @param {string|null} [params.customerPhone]
 * @param {string} params.orderId
 * @param {string} params.referenceId
 * @param {number} params.amount
 * @param {string} params.currency
 * @returns {Promise<void>}
 */
async function notifyDirectTopupAdmins(params) {
  const {
    customerUserId,
    customerPhone = null,
    orderId,
    referenceId,
    amount,
    currency,
  } = params;

  const title = "New direct top-up request";
  const phonePart = customerPhone ? ` · ${customerPhone}` : "";
  const message =
    `${currency} ${amount} · ${referenceId} · user ${customerUserId}` +
    phonePart;

  const meta = {
    orderId,
    referenceId,
    amount,
    currency,
    customerUserId,
    customerPhone: customerPhone || "",
    orderType: "direct_topup",
  };

  try {
    await createNotification({
      userId: null,
      type: NOTIFICATION_TYPES.DIRECT_TOPUP_ADMIN_ALERT,
      title,
      message,
      metadata: meta,
      sendPush: false,
    });
  } catch (err) {
    console.warn(
        "⚠️ Failed to save admin direct-top-up notification:",
        err.message,
    );
  }

  let adminUserIds = [];
  try {
    const cfgSnap = await firestore
        .collection(config.collections.config)
        .doc("directTopup")
        .get();
    if (cfgSnap.exists) {
      const raw = cfgSnap.data().adminUserIds;
      adminUserIds = Array.isArray(raw) ? raw : [];
    }
  } catch (err) {
    console.warn(
        "⚠️ Could not read config/directTopup for admin push:",
        err.message,
    );
    return;
  }

  for (const adminId of adminUserIds) {
    if (typeof adminId !== "string" || !adminId.trim()) {
      continue;
    }
    try {
      await sendPushNotification(adminId.trim(), {
        notificationId: "",
        type: NOTIFICATION_TYPES.DIRECT_TOPUP_ADMIN_ALERT,
        title,
        message,
        data: meta,
      });
    } catch (pushErr) {
      console.warn(
          `⚠️ Admin push failed for ${adminId}:`,
          pushErr.message,
      );
    }
  }
}

/**
 * Same as direct-top-up admin alerts; reads config/directPayout then falls back to directTopup.
 * @param {Object} params
 * @param {string} params.customerUserId
 * @param {string|null} [params.customerPhone]
 * @param {string} params.orderId
 * @param {string} params.referenceId
 * @param {number} params.amount
 * @param {string} params.currency
 * @returns {Promise<void>}
 */
async function notifyDirectPayoutAdmins(params) {
  const {
    customerUserId,
    customerPhone = null,
    orderId,
    referenceId,
    amount,
    currency,
  } = params;

  const title = "New direct payout request";
  const phonePart = customerPhone ? ` · ${customerPhone}` : "";
  const message =
    `${currency} ${amount} · ${referenceId} · user ${customerUserId}` +
    phonePart;

  const meta = {
    orderId,
    referenceId,
    amount,
    currency,
    customerUserId,
    customerPhone: customerPhone || "",
    orderType: "direct_payout",
  };

  try {
    await createNotification({
      userId: null,
      type: NOTIFICATION_TYPES.DIRECT_PAYOUT_ADMIN_ALERT,
      title,
      message,
      metadata: meta,
      sendPush: false,
    });
  } catch (err) {
    console.warn(
        "⚠️ Failed to save admin direct-payout notification:",
        err.message,
    );
  }

  let adminUserIds = [];
  try {
    const payoutCfg = await firestore
        .collection(config.collections.config)
        .doc("directPayout")
        .get();
    if (payoutCfg.exists) {
      const raw = payoutCfg.data().adminUserIds;
      adminUserIds = Array.isArray(raw) ? raw : [];
    }
    if (adminUserIds.length === 0) {
      const topupCfg = await firestore
          .collection(config.collections.config)
          .doc("directTopup")
          .get();
      if (topupCfg.exists) {
        const raw = topupCfg.data().adminUserIds;
        adminUserIds = Array.isArray(raw) ? raw : [];
      }
    }
  } catch (err) {
    console.warn(
        "⚠️ Could not read config for direct payout admin push:",
        err.message,
    );
    return;
  }

  for (const adminId of adminUserIds) {
    if (typeof adminId !== "string" || !adminId.trim()) {
      continue;
    }
    try {
      await sendPushNotification(adminId.trim(), {
        notificationId: "",
        type: NOTIFICATION_TYPES.DIRECT_PAYOUT_ADMIN_ALERT,
        title,
        message,
        data: meta,
      });
    } catch (pushErr) {
      console.warn(
          `⚠️ Admin payout push failed for ${adminId}:`,
          pushErr.message,
      );
    }
  }
}

/**
 * Mark notification as read
 * @param {string} notificationId - Notification ID
 * @returns {Promise<void>}
 */
async function markNotificationAsRead(notificationId) {
  await firestore
      .collection("notifications")
      .doc(notificationId)
      .update({
        read: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
}

/**
 * @param {string} notificationId
 * @returns {Promise<Object|null>}
 */
async function getNotificationById(notificationId) {
  const doc = await firestore.collection("notifications").doc(notificationId).get();
  if (!doc.exists) {
    return null;
  }
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
  };
}

/**
 * Get user notifications
 * @param {string} userId - User ID (or "system" for admin notifications)
 * @param {number} limit - Number of notifications to return
 * @returns {Promise<Array>} Notifications
 */
async function getUserNotifications(userId, limit = 50) {
  try {
    // Try query with index first (most efficient)
    const snapshot = await firestore
        .collection("notifications")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
    }));
  } catch (error) {
    // Fallback if index doesn't exist: fetch all and sort in memory
    if (error.code === 9 || error.message?.includes("index")) {
      console.warn("⚠️ Firestore index missing for notifications. Using fallback query. Create the index for better performance.");
      
      const snapshot = await firestore
          .collection("notifications")
          .where("userId", "==", userId)
          .get();

      // Sort in memory and limit
      const notifications = snapshot.docs
          .map((doc) => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
            updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
          }))
          .sort((a, b) => {
            // Sort by createdAt descending
            const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return dateB - dateA;
          })
          .slice(0, limit);

      return notifications;
    }
    throw error;
  }
}

/**
 * Collect platform admin UIDs for push (platformAdmins + config/directTopup + master email).
 * @returns {Promise<string[]>}
 */
async function resolvePlatformAdminUserIds() {
  /** @type {Set<string>} */
  const ids = new Set();

  try {
    const snap = await firestore.collection(config.collections.platformAdmins).get();
    for (const doc of snap.docs) {
      if (doc.id && typeof doc.id === "string") {
        ids.add(doc.id);
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not list platformAdmins:", err.message);
  }

  try {
    const cfgSnap = await firestore
        .collection(config.collections.config)
        .doc("directTopup")
        .get();
    if (cfgSnap.exists) {
      const raw = cfgSnap.data().adminUserIds;
      if (Array.isArray(raw)) {
        for (const id of raw) {
          if (typeof id === "string" && id.trim()) {
            ids.add(id.trim());
          }
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ Could not read config/directTopup adminUserIds:", err.message);
  }

  try {
    const masterEmail = (
      process.env.MASTER_ADMIN_EMAIL || "calvinrumba8@gmail.com"
    ).trim().toLowerCase();
    if (masterEmail) {
      const user = await admin.auth().getUserByEmail(masterEmail);
      if (user?.uid) {
        ids.add(user.uid);
      }
    }
  } catch (err) {
    // Master may not exist in Auth yet — non-fatal.
    if (err.code !== "auth/user-not-found") {
      console.warn("⚠️ Could not resolve master admin UID:", err.message);
    }
  }

  return [...ids];
}

/**
 * Notify platform super admins that a B2B partner requested go-live.
 *
 * @param {Object} params
 * @param {string} params.partnerId
 * @param {string} params.partnerName
 * @param {string} params.requestedByUid
 * @param {string|null} [params.requestedByEmail]
 * @param {string|null} [params.ownerName]
 * @returns {Promise<{ notificationId: string|null, pushCount: number }>}
 */
async function notifyGoLiveRequestAdmins(params) {
  const {
    partnerId,
    partnerName,
    requestedByUid,
    requestedByEmail = null,
    ownerName = null,
  } = params;

  const title = "Go-live request";
  const who = ownerName || requestedByEmail || requestedByUid;
  const message = `${partnerName || partnerId} requested to go live · ${who}`;

  const meta = {
    partnerId: String(partnerId),
    partnerName: partnerName || "",
    requestedByUid: String(requestedByUid),
    requestedByEmail: requestedByEmail || "",
    ownerName: ownerName || "",
    action: "go_live_request",
  };

  let notificationId = null;
  try {
    const created = await createNotification({
      userId: null,
      type: NOTIFICATION_TYPES.GO_LIVE_REQUEST_ADMIN_ALERT,
      title,
      message,
      actionUrl: `/dashboard/partners/${partnerId}`,
      metadata: meta,
      sendPush: false,
    });
    notificationId = created.notificationId;
  } catch (err) {
    console.warn("⚠️ Failed to save go-live admin notification:", err.message);
  }

  const adminUserIds = await resolvePlatformAdminUserIds();
  let pushCount = 0;
  for (const adminId of adminUserIds) {
    try {
      await sendPushNotification(adminId, {
        notificationId: notificationId || "",
        type: NOTIFICATION_TYPES.GO_LIVE_REQUEST_ADMIN_ALERT,
        title,
        message,
        data: meta,
      });
      pushCount += 1;
    } catch (pushErr) {
      console.warn(`⚠️ Go-live admin push failed for ${adminId}:`, pushErr.message);
    }
  }

  return {notificationId, pushCount};
}

module.exports = {
  createNotification,
  sendPushNotification,
  notifyDirectTopupAdmins,
  notifyDirectPayoutAdmins,
  notifyGoLiveRequestAdmins,
  resolvePlatformAdminUserIds,
  markNotificationAsRead,
  getNotificationById,
  getUserNotifications,
  NOTIFICATION_TYPES,
};
