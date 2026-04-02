const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: "truepay-72060",
    databaseURL: "https://truepay-72060-default-rtdb.firebaseio.com",
  });
}

module.exports = admin;
