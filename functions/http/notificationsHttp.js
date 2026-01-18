/**
 * @fileoverview HTTP handlers for notifications REST API
 * Handles notification retrieval and management for dashboard
 */

const {onRequest} = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const {getUserNotifications, markNotificationAsRead} = require("../utils/notifications");

const app = express();

// Middleware
app.use(express.json());

// CORS middleware - supports credentials
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
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
    } else if (origin.includes("truepay-72060")) {
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
 * GET /notifications
 * Get notifications for a user or all admin notifications
 * 
 * Query parameters:
 * - userId (optional): User ID, defaults to "system" for admin dashboard
 * - limit (optional): Number of notifications to return, defaults to 50
 */
app.get("/notifications", async (req, res) => {
  try {
    const userId = req.query.userId || "system"; // "system" for admin dashboard
    const limit = parseInt(req.query.limit) || 50;

    const notifications = await getUserNotifications(userId, limit);

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
 * Mark notification as read
 */
app.patch("/notifications/:id/read", async (req, res) => {
  try {
    const {id} = req.params;
    await markNotificationAsRead(id);

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
 * Mark all notifications as read for a user
 * 
 * Request body:
 * - userId (optional): User ID, defaults to "system"
 */
app.post("/notifications/mark-all-read", async (req, res) => {
  try {
    const userId = req.body.userId || "system";
    const notifications = await getUserNotifications(userId, 1000); // Get all
    
    // Mark all unread notifications as read
    const unreadNotifications = notifications.filter((n) => !n.read);
    await Promise.all(
        unreadNotifications.map((n) => markNotificationAsRead(n.id))
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
