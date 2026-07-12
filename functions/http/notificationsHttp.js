/**
 * @fileoverview HTTP handlers for notifications REST API
 * Handles notification retrieval and management for dashboard
 */

const {onRequest} = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const {verifyFirebaseAuth} = require("../libs/auth");
const {
  getUserNotifications,
  getNotificationById,
  markNotificationAsRead,
} = require("../utils/notifications");
const {
  buildNotificationAccessScope,
  resolveNotificationTargetUserId,
  filterNotificationsForScope,
  assertNotificationWritable,
} = require("../utils/notificationAccess");

const app = express();

// Middleware
app.use(express.json());

// CORS middleware - supports credentials
app.use((req, res, next) => {
  const origin = req.headers.origin;

  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
    "https://theadmin.truepay.live",
    "https://truepay.live",
    "https://www.truepay.live",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
  ];

  let allowedOrigin = "*";
  if (origin) {
    if (allowedOrigins.includes(origin)) {
      allowedOrigin = origin;
    } else if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      allowedOrigin = origin;
    } else if (
      origin.includes("truepay-72060") ||
      /^https:\/\/([a-z0-9-]+\.)*truepay\.live$/i.test(origin)
    ) {
      allowedOrigin = origin;
    }
  }

  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function loadFirebaseUser(req, res, next) {
  const result = await verifyFirebaseAuth(req);
  if (!result.success) {
    res.status(401).json({success: false, error: result.error || "Unauthorized"});
    return;
  }
  req.userId = result.userId;
  req.decodedToken = result.decodedToken;
  try {
    req.notificationScope = await buildNotificationAccessScope(
        req.userId,
        req.decodedToken,
    );
  } catch (err) {
    console.error("notificationScope:", err.message);
    res.status(500).json({success: false, error: "Authorization check failed"});
    return;
  }
  next();
}

/**
 * GET /notifications
 * Scoped by caller: defaults to auth uid; system inbox requires platform super.
 *
 * Query parameters:
 * - userId (optional): Target inbox — defaults to caller uid (not system)
 * - limit (optional): Number of notifications to return, defaults to 50
 */
app.get("/notifications", loadFirebaseUser, async (req, res) => {
  try {
    const scope = req.notificationScope;
    const resolved = resolveNotificationTargetUserId(req.query.userId, scope);
    if (!resolved.ok) {
      res.status(resolved.status).json({
        success: false,
        error: resolved.error,
        message: resolved.message,
      });
      return;
    }

    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const raw = await getUserNotifications(resolved.targetUserId, limit);
    const notifications = filterNotificationsForScope(raw, scope);

    res.status(200).json({
      success: true,
      data: notifications,
      unreadCount: notifications.filter((n) => !n.read).length,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch notifications",
      message: error.message,
    });
  }
});

/**
 * PATCH /notifications/:id/read
 * Mark notification as read (scoped to caller).
 */
app.patch("/notifications/:id/read", loadFirebaseUser, async (req, res) => {
  try {
    const scope = req.notificationScope;
    const notification = await getNotificationById(req.params.id);
    if (!notification) {
      res.status(404).json({success: false, error: "Notification not found"});
      return;
    }

    const allowed = assertNotificationWritable(notification, scope);
    if (!allowed.ok) {
      res.status(allowed.status).json({
        success: false,
        error: allowed.error,
        message: allowed.message,
      });
      return;
    }

    await markNotificationAsRead(req.params.id);

    res.status(200).json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mark notification as read",
      message: error.message,
    });
  }
});

/**
 * POST /notifications/mark-all-read
 * Mark all notifications as read for a scoped inbox.
 *
 * Request body:
 * - userId (optional): Target inbox — defaults to caller uid (not system)
 */
app.post("/notifications/mark-all-read", loadFirebaseUser, async (req, res) => {
  try {
    const scope = req.notificationScope;
    const resolved = resolveNotificationTargetUserId(req.body?.userId, scope);
    if (!resolved.ok) {
      res.status(resolved.status).json({
        success: false,
        error: resolved.error,
        message: resolved.message,
      });
      return;
    }

    const raw = await getUserNotifications(resolved.targetUserId, 1000);
    const notifications = filterNotificationsForScope(raw, scope);
    const unreadNotifications = notifications.filter((n) => !n.read);

    await Promise.all(
        unreadNotifications.map((n) => markNotificationAsRead(n.id)),
    );

    res.status(200).json({
      success: true,
      message: `Marked ${unreadNotifications.length} notifications as read`,
      count: unreadNotifications.length,
    });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mark all notifications as read",
      message: error.message,
    });
  }
});

// Export as Firebase Function
exports.notificationsApi = onRequest(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: true,
    },
    app,
);
