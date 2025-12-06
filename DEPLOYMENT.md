# Deployment Guide - Firebase Cloud Functions

Complete guide for deploying TruePay Cloud Functions to Firebase.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Deployment Commands](#deployment-commands)
4. [Deploy Specific Functions](#deploy-specific-functions)
5. [View Logs](#view-logs)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. Install Firebase CLI

```bash
# Install globally via npm
npm install -g firebase-tools

# Verify installation
firebase --version
```

### 2. Login to Firebase

```bash
# Login to Firebase
firebase login

# Verify you're logged in
firebase projects:list
```

### 3. Initialize Project (If Not Already Done)

```bash
# Navigate to project directory
cd C:\Users\admin\Desktop\Projects\TP\rates_function

# Initialize Firebase (only if not already initialized)
firebase init functions
```

### 4. Install Dependencies

```bash
# Navigate to functions directory
cd functions

# Install dependencies
npm install

# Return to root directory
cd ..
```

---

## Deployment Commands

### Quick Deployment (All Functions)

Deploy all Cloud Functions at once:

```bash
# From project root directory
firebase deploy --only functions
```

**What this does:**
- Deploys all functions defined in `functions/index.js`
- Updates existing functions or creates new ones
- Takes 2-5 minutes depending on number of functions

---

### Deploy Specific Function

Deploy only one function (faster):

```bash
# Deploy only getBinanceRates
firebase deploy --only functions:getBinanceRates

# Deploy only updateUserBalance
firebase deploy --only functions:updateUserBalance

# Deploy only api (REST endpoints)
firebase deploy --only functions:api
```

---

### Deploy Multiple Specific Functions

```bash
# Deploy multiple functions
firebase deploy --only functions:getBinanceRates,functions:getArbitrageRates
```

---

## Complete Deployment Workflow

### Step-by-Step Deployment

```bash
# 1. Navigate to project root
cd C:\Users\admin\Desktop\Projects\TP\rates_function

# 2. Verify you're in the right project
firebase use

# Should show: Using project truepay-72060

# 3. Install/update dependencies (if needed)
cd functions
npm install
cd ..

# 4. Deploy all functions
firebase deploy --only functions

# 5. Wait for deployment to complete
# You'll see output showing deployment progress
```

---

## Available Functions to Deploy

Here are all the functions you can deploy:

### Callable Functions
```bash
firebase deploy --only functions:getBinanceRates
firebase deploy --only functions:getArbitrageRates
firebase deploy --only functions:updateUserProfile
firebase deploy --only functions:updateUserBalance
firebase deploy --only functions:getUserData
firebase deploy --only functions:updateKYCStatus
firebase deploy --only functions:syncUserBalanceToRealtime
```

### HTTP Endpoints
```bash
firebase deploy --only functions:fetchBinanceRatesHttp
firebase deploy --only functions:handleTopUpWebhook
firebase deploy --only functions:api
```

### Scheduled Functions
```bash
firebase deploy --only functions:fetchBinanceRates
firebase deploy --only functions:fetchArbitrageRates
```

### Triggers
```bash
firebase deploy --only functions:userBootstrap
firebase deploy --only functions:syncBalance
firebase deploy --only functions:onUserCreated
```

---

## View Deployment Status

### List All Deployed Functions

```bash
firebase functions:list
```

### Check Function Details

```bash
# Get details about a specific function
firebase functions:describe getBinanceRates
```

---

## View Logs

### View All Function Logs

```bash
# View recent logs
firebase functions:log

# View last 50 log entries
firebase functions:log --limit 50
```

### View Logs for Specific Function

```bash
# View logs for getBinanceRates
firebase functions:log --only getBinanceRates

# View logs with filtering
firebase functions:log --only getBinanceRates --limit 20
```

### Follow Logs in Real-Time

```bash
# Follow logs (like tail -f)
firebase functions:log --only getBinanceRates --follow
```

---

## Deployment Options

### Force Deployment

If deployment fails, you can force it:

```bash
firebase deploy --only functions --force
```

### Deploy with Debug Output

```bash
# Show detailed deployment information
firebase deploy --only functions --debug
```

### Dry Run (Test Without Deploying)

```bash
# Preview what would be deployed (not available for functions)
# For functions, you need to actually deploy
```

---

## Common Deployment Scenarios

### Scenario 1: First Time Deployment

```bash
# 1. Login to Firebase
firebase login

# 2. Select project
firebase use truepay-72060

# 3. Install dependencies
cd functions
npm install
cd ..

# 4. Deploy all functions
firebase deploy --only functions
```

### Scenario 2: Update Single Function After Code Change

```bash
# After modifying functions/rates.js for example

# Deploy only the affected function
firebase deploy --only functions:getBinanceRates

# Or deploy all rate-related functions
firebase deploy --only functions:getBinanceRates,functions:fetchBinanceRatesHttp
```

### Scenario 3: Deploy Only Callable Functions

```bash
firebase deploy --only functions:getBinanceRates,functions:getArbitrageRates,functions:updateUserBalance,functions:getUserData,functions:updateUserProfile,functions:updateKYCStatus,functions:syncUserBalanceToRealtime
```

### Scenario 4: Deploy Only HTTP Endpoints

```bash
firebase deploy --only functions:fetchBinanceRatesHttp,functions:handleTopUpWebhook,functions:api
```

---

## Post-Deployment Verification

### 1. Check Function Status

```bash
firebase functions:list
```

Expected output should show all your functions with status "ACTIVE".

### 2. Test Callable Function

Test via Firebase Console or using curl/Postman:

```bash
# Get your Firebase project region (usually us-central1)
# Test HTTP endpoint
curl "https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp?fiat=KES&asset=USDT"
```

### 3. Check Logs for Errors

```bash
firebase functions:log --limit 10
```

---

## Environment Setup

### Set Environment Variables (Secrets)

If your functions use secrets (like `INTASEND_SECRET`):

```bash
# Set a secret
firebase functions:secrets:set INTASEND_SECRET

# You'll be prompted to enter the secret value
# Or set via file
echo "your-secret-value" | firebase functions:secrets:set INTASEND_SECRET

# Set challenge secret
firebase functions:secrets:set INTASEND_CHALLENGE

# List all secrets
firebase functions:secrets:access

# Grant access to a secret for a function
# This is done automatically when function uses defineSecret()
```

**Note**: Functions using secrets need to be redeployed after setting secrets:

```bash
firebase deploy --only functions:handleTopUpWebhook
```

---

## PowerShell Commands (Windows)

If you're using PowerShell on Windows:

```powershell
# Navigate to project
cd C:\Users\admin\Desktop\Projects\TP\rates_function

# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:getBinanceRates

# View logs
firebase functions:log
```

---

## Troubleshooting

### Error: "Functions directory does not exist"

**Solution**: Ensure you're in the correct directory:
```bash
cd C:\Users\admin\Desktop\Projects\TP\rates_function
ls functions  # Should show index.js, package.json, etc.
```

### Error: "npm install failed"

**Solution**: 
```bash
cd functions
rm -rf node_modules package-lock.json  # Linux/Mac
# OR
Remove-Item -Recurse -Force node_modules, package-lock.json  # Windows PowerShell

npm install
cd ..
```

### Error: "Permission denied"

**Solution**: Ensure you're logged in:
```bash
firebase login
firebase projects:list  # Verify you can see your projects
```

### Error: "Quota exceeded"

**Solution**: Check Firebase billing and quotas in Firebase Console.

### Deployment is Slow

**Normal behavior**: First deployment takes 5-10 minutes. Subsequent deployments are faster (2-5 minutes).

**To speed up**: Deploy only the function you changed:
```bash
firebase deploy --only functions:getBinanceRates
```

---

## Quick Reference Commands

```bash
# Deploy all functions
firebase deploy --only functions

# Deploy single function
firebase deploy --only functions:FUNCTION_NAME

# View logs
firebase functions:log
firebase functions:log --only FUNCTION_NAME

# List functions
firebase functions:list

# Check project
firebase use
firebase projects:list

# Login/Logout
firebase login
firebase logout
```

---

## Deployment Checklist

Before deploying:

- [ ] All code changes committed
- [ ] Dependencies installed (`npm install` in functions directory)
- [ ] Firebase CLI installed and logged in
- [ ] Correct project selected (`firebase use`)
- [ ] Secrets configured (if needed)
- [ ] Tested locally (if possible)

After deploying:

- [ ] Check deployment success message
- [ ] Verify functions list: `firebase functions:list`
- [ ] Check logs for errors: `firebase functions:log`
- [ ] Test at least one function manually
- [ ] Verify in Firebase Console

---

## Additional Resources

- [Firebase Functions Documentation](https://firebase.google.com/docs/functions)
- [Firebase CLI Reference](https://firebase.google.com/docs/cli)
- Check `readme.md` for function details
- Check `api.md` for API documentation

---

**Last Updated**: 2025-01-04

