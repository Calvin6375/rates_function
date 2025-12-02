# Migrate Existing Users

## Overview

The `onUserCreated` trigger only works for **new users** created after deployment. To add default fields (`fiatBalance`, `cryptoBalance`, `phoneNumber`) to **existing users**, use the migration function.

## Migration Functions

Two options are available:

### Option 1: Callable Function (Recommended)
- Function: `migrateExistingUsers`
- Type: Firebase Callable Function
- Requires: Firebase Auth (optional - can add admin check)

### Option 2: HTTP Endpoint
- Function: `migrateUsersHttp`
- Type: HTTP POST endpoint
- URL: `https://us-central1-truepay-72060.cloudfunctions.net/migrateUsersHttp/migrateUsers`

## How to Run Migration

### Method 1: Using PowerShell Script (Easiest - Windows)

```powershell
# Make sure you're in the project root directory
.\run-migration.ps1
```

### Method 2: Using Direct PowerShell Command

```powershell
$url = "https://us-central1-truepay-72060.cloudfunctions.net/migrateUsersHttp/migrateUsers"
$body = @{} | ConvertTo-Json
Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json"
```

### Method 3: Using Node.js Script

```bash
node run-migration.js
```

### Method 4: Using cURL (if installed on Windows)

```powershell
# Deploy first
firebase deploy --only functions:migrateUsersHttp

# Then call the endpoint
$body = @{} | ConvertTo-Json
Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/migrateUsersHttp/migrateUsers" -Method Post -Body $body -ContentType "application/json"
```

### Method 5: From Your Frontend/Admin Dashboard

```javascript
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();
const migrateUsers = httpsCallable(functions, 'migrateExistingUsers');

// Run migration
const result = await migrateUsers({});
console.log(result.data);
// {
//   success: true,
//   message: "Migration completed successfully",
//   totalUsers: 50,
//   updatedUsers: 45,
//   skippedUsers: 5,
//   batches: 1
// }
```

## What the Migration Does

For each existing user in the `users` collection, it:

1. **Checks** if the user has:
   - `fiatBalance` (if missing/null/undefined → sets to `0`)
   - `cryptoBalance` (if missing/null/undefined → sets to `0`)
   - `phoneNumber` (if missing/null/undefined → sets to `""`)

2. **Updates** only users that need migration (skips users that already have all fields)

3. **Adds** `migratedAt` timestamp to track when migration ran

4. **Preserves** existing values (doesn't overwrite if field exists)

## Response Format

```json
{
  "success": true,
  "message": "Migration completed successfully",
  "totalUsers": 50,
  "updatedUsers": 45,
  "skippedUsers": 5,
  "batches": 1
}
```

## Deployment

Deploy the migration functions:

```powershell
# Deploy both migration functions
firebase deploy --only functions:migrateExistingUsers,functions:migrateUsersHttp

# Or deploy all functions
firebase deploy --only functions
```

## Safety Features

- ✅ **Non-destructive**: Only adds missing fields, never overwrites existing values
- ✅ **Batch processing**: Handles large user collections efficiently (500 users per batch)
- ✅ **Error handling**: Logs errors but doesn't crash
- ✅ **Idempotent**: Safe to run multiple times (skips users that already have fields)

## Example: Before and After

### Before Migration
```json
{
  "email": "user@example.com",
  "firstName": "John",
  "lastName": "Doe",
  "createdAt": "2025-01-01T00:00:00Z"
}
```

### After Migration
```json
{
  "email": "user@example.com",
  "firstName": "John",
  "lastName": "Doe",
  "fiatBalance": 0,
  "cryptoBalance": 0,
  "phoneNumber": "",
  "createdAt": "2025-01-01T00:00:00Z",
  "updatedAt": "2025-12-01T18:00:00Z",
  "migratedAt": "2025-12-01T18:00:00Z"
}
```

## Monitoring

Check migration logs:

```powershell
firebase functions:log --only migrateExistingUsers
```

Or view in [Firebase Console - Functions Logs](https://console.firebase.google.com/project/truepay-72060/functions/logs)

## Notes

- Migration is **one-time** - run it once after deploying the trigger
- New users created after deployment will automatically get these fields via the `onUserCreated` trigger
- The migration function can be run multiple times safely (it will skip users that already have the fields)

