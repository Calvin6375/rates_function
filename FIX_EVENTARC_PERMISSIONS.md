# Fix Eventarc Permission Error

## Problem
When deploying Firestore triggers with Firebase Functions v2, you may encounter:
```
Permission denied while using the Eventarc Service Agent
```

## Solutions

### Solution 1: Wait and Retry (Easiest)
The error message says permissions may take a few minutes to propagate. Try:

```powershell
# Wait 5-10 minutes, then retry
firebase deploy --only functions:onUserCreated
```

### Solution 2: Grant Eventarc Permissions Manually

1. Go to [Google Cloud Console - IAM](https://console.cloud.google.com/iam-admin/iam?project=truepay-72060)

2. Find the service account: `service-{PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com`

3. Ensure it has the **Eventarc Service Agent** role

4. If it doesn't exist or lacks permissions:
   - Click "Grant Access"
   - Add the service account email
   - Grant role: **Eventarc Service Agent**
   - Save

5. Wait 2-3 minutes for permissions to propagate

6. Retry deployment:
   ```powershell
   firebase deploy --only functions:onUserCreated
   ```

### Solution 3: Use Functions v1 (No Eventarc Required)

If Eventarc continues to cause issues, we can use Functions v1 syntax which doesn't require Eventarc. This is simpler but has some limitations.

**Update `functions/users.js` to use v1:**

```javascript
const functions = require("firebase-functions");
const admin = require("./admin");

const db = admin.firestore();

exports.onUserCreated = functions.firestore
    .document("users/{userId}")
    .onCreate(async (snap, context) => {
      try {
        const userId = context.params.userId;
        const userData = snap.data();

        // ... rest of the code stays the same
      } catch (error) {
        // ... error handling
      }
    });
```

Then deploy:
```powershell
firebase deploy --only functions:onUserCreated
```

### Solution 4: Enable Eventarc API

1. Go to [Google Cloud Console - APIs](https://console.cloud.google.com/apis/library?project=truepay-72060)

2. Search for "Eventarc API"

3. Click "Enable" if not already enabled

4. Wait 2-3 minutes

5. Retry deployment

## Recommended Approach

**Try in this order:**
1. Wait 5-10 minutes and retry (Solution 1)
2. If still failing, grant permissions manually (Solution 2)
3. If still having issues, use Functions v1 (Solution 3)

## Verify Deployment

After successful deployment, check logs:
```powershell
firebase functions:log --only onUserCreated
```

Test by creating a user document in Firestore and verify the default fields are added.

