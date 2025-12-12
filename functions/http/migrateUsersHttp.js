/**
 * @fileoverview HTTP handlers for user migration endpoints
 * Thin controllers that delegate to business logic in libs/migrateUsers.js
 */

const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const migrateUsersLib = require("../libs/migrateUsers");

const migrateApp = express();

migrateApp.use(express.json());

// CORS middleware
migrateApp.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ];
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : "*";
  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * Callable function to migrate existing users
 */
exports.migrateExistingUsers = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      try {
        return await migrateUsersLib.migrateExistingUsers();
      } catch (error) {
        console.error("Error during user migration:", error);
        throw new HttpsError(
            "internal",
            `Migration failed: ${error.message}`,
        );
      }
    },
);

/**
 * HTTP endpoint version for migration
 */
migrateApp.post("/migrateUsers", async (req, res) => {
  try {
    console.log("Starting user migration via HTTP...");
    const result = await migrateUsersLib.migrateExistingUsers();
    res.status(200).json(result);
  } catch (error) {
    console.error("Error during user migration:", error);
    res.status(500).json({
      success: false,
      error: "Migration failed",
      message: error.message,
    });
  }
});

exports.migrateUsersHttp = onRequest(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    migrateApp,
);

