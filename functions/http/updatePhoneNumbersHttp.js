/**
 * @fileoverview HTTP handlers for phone number update endpoints
 * Thin controllers that delegate to business logic in libs/updatePhoneNumbers.js
 */

const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const updatePhoneNumbersLib = require("../libs/updatePhoneNumbers");

const updatePhoneApp = express();

updatePhoneApp.use(express.json());

// CORS middleware
updatePhoneApp.use((req, res, next) => {
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
 * Callable function to update phone numbers only
 */
exports.updatePhoneNumbers = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      try {
        return await updatePhoneNumbersLib.updatePhoneNumbers();
      } catch (error) {
        console.error("Error during phone number update:", error);
        throw new HttpsError(
            "internal",
            `Phone number update failed: ${error.message}`,
        );
      }
    },
);

/**
 * HTTP endpoint version for phone number update
 */
updatePhoneApp.post("/updatePhoneNumbers", async (req, res) => {
  try {
    console.log("Starting phone number update via HTTP...");
    const result = await updatePhoneNumbersLib.updatePhoneNumbers();
    res.status(200).json(result);
  } catch (error) {
    console.error("Error during phone number update:", error);
    res.status(500).json({
      success: false,
      error: "Phone number update failed",
      message: error.message,
    });
  }
});

exports.updatePhoneNumbersHttp = onRequest(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    updatePhoneApp,
);

