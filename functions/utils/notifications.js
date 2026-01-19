const admin = require("../admin");
const firestore = admin.firestore();
const messaging = admin.messaging();

/**
 * Notification types
 */
const NOTIFICATION_TYPES = {
  PAYMENT_COMPLETED: "payment_completed",
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
 * @param {string} options.userId - User ID (null for system-wide notifications)
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

module.exports = {
  createNotification,
  sendPushNotification,
  markNotificationAsRead,
  getUserNotifications,
  NOTIFICATION_TYPES,
};
