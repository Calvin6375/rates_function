/**
 * @fileoverview Local Turnkey auth probe. Uses process.env / Secret Manager
 * values already present in the shell. Does not create wallets.
 *
 *   cd functions && node scripts/test-turnkey-connection.js
 */

const {
  testTurnkeyConnection,
} = require("../services/crypto/turnkey/turnkeyClient");

testTurnkeyConnection()
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message || "Turnkey connection test failed");
      process.exit(1);
    });
