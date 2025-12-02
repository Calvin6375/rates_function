#!/usr/bin/env node

/**
 * Script to update phone numbers only from terminal
 * Usage: node run-update-phones.js
 */

const https = require("https");

const PROJECT_ID = "truepay-72060";
const REGION = "us-central1";
const FUNCTION_NAME = "updatePhoneNumbersHttp";

const url = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${FUNCTION_NAME}/updatePhoneNumbers`;

console.log("📱 Starting phone number update...");
console.log(`📡 Calling: ${url}\n`);

const options = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
};

const req = https.request(url, options, (res) => {
  let data = "";

  res.on("data", (chunk) => {
    data += chunk;
  });

  res.on("end", () => {
    try {
      const result = JSON.parse(data);
      console.log("✅ Phone number update completed!");
      console.log("\n📊 Results:");
      console.log(JSON.stringify(result, null, 2));

      if (result.success) {
        console.log(`\n✨ Successfully updated ${result.updatedUsers} out of ${result.totalUsers} users`);
        if (result.skippedUsers > 0) {
          console.log(`ℹ️  ${result.skippedUsers} users already had phone numbers`);
        }
        process.exit(0);
      } else {
        console.error("\n❌ Update failed:", result.error || result.message);
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error parsing response:", error.message);
      console.log("Raw response:", data);
      process.exit(1);
    }
  });
});

req.on("error", (error) => {
  console.error("❌ Request failed:", error.message);
  process.exit(1);
});

req.write(JSON.stringify({}));
req.end();

