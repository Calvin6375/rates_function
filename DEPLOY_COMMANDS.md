# Quick Deployment Commands Reference

Quick reference for deploying Firebase Cloud Functions.

---

## Essential Commands

### Deploy All Functions
```bash
firebase deploy --only functions
```

### Deploy Specific Function
```bash
firebase deploy --only functions:FUNCTION_NAME
```

### View Logs
```bash
firebase functions:log
firebase functions:log --only FUNCTION_NAME
```

### List Deployed Functions
```bash
firebase functions:list
```

---

## Common Deployment Scenarios

### 1. Deploy Everything (First Time)
```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

### 2. Deploy Only Rates Functions
```bash
firebase deploy --only functions:getBinanceRates,functions:fetchBinanceRatesHttp
```

### 3. Deploy Only Admin Functions
```bash
firebase deploy --only functions:updateUserBalance,functions:getUserData,functions:updateUserProfile
```

### 4. Deploy Only REST API
```bash
firebase deploy --only functions:api
```

---

## Function Names Reference

### Callable Functions
- `getBinanceRates`
- `getArbitrageRates`
- `updateUserProfile`
- `updateUserBalance`
- `getUserData`
- `updateKYCStatus`
- `syncUserBalanceToRealtime`

### HTTP Endpoints
- `fetchBinanceRatesHttp`
- `handleTopUpWebhook`
- `api` (REST API)

### Scheduled Functions
- `fetchBinanceRates`
- `fetchArbitrageRates`

### Triggers
- `userBootstrap`
- `syncBalance`
- `onUserCreated`

---

## Quick Examples

```bash
# Deploy single function
firebase deploy --only functions:getBinanceRates

# Deploy multiple functions
firebase deploy --only functions:getBinanceRates,functions:getArbitrageRates

# View logs for specific function
firebase functions:log --only getBinanceRates --limit 20

# Check which project you're using
firebase use

# Login to Firebase
firebase login
```

---

For detailed deployment guide, see `DEPLOYMENT.md`

