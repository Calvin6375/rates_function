# Deployment and Testing Guide

## Prerequisites

1. Make sure you're logged into Firebase:
   ```bash
   firebase login
   ```

2. Verify you're using the correct project:
   ```bash
   firebase use truepay-72060
   ```

## Deployment Commands

### 1. Deploy All Functions
```bash
firebase deploy --only functions
```

### 2. Deploy Only the Customer Wallets API
```bash
firebase deploy --only functions:api
```

### 3. Deploy with Specific Region (if needed)
The function will be deployed to the default region. To specify a region, you'll need to update `customerWallets.js` with region configuration.

## Getting Your Function URL

After deployment, Firebase will output the function URLs. The customer wallets API will be available at:

```
https://{region}-truepay-72060.cloudfunctions.net/api/customer-wallets
```

Common regions:
- `us-central1` (default)
- `us-east1`
- `europe-west1`
- `asia-southeast1`

**Example URL:**
```
https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets
```

## Live Testing Commands

### Using cURL (Windows PowerShell)

#### 1. List All Customer Wallets
```powershell
curl -X GET "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets?limit=100" -H "Content-Type: application/json"
```

#### 2. Get Specific Wallet
```powershell
curl -X GET "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{WALLET_ID}" -H "Content-Type: application/json"
```

#### 3. Create New Customer Wallet
```powershell
curl -X POST "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets" `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"John Doe\",\"email\":\"john@example.com\",\"phone\":\"+1234567890\",\"initialBalance\":100}'
```

#### 4. Update Customer Wallet
```powershell
curl -X PUT "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{WALLET_ID}" `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"John Updated\",\"phone\":\"+9876543210\"}'
```

#### 5. Credit Money to Wallet
```powershell
curl -X POST "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{WALLET_ID}/credit" `
  -H "Content-Type: application/json" `
  -d '{\"amount\":50,\"description\":\"Top up payment\"}'
```

#### 6. Debit Money from Wallet
```powershell
curl -X POST "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{WALLET_ID}/debit" `
  -H "Content-Type: application/json" `
  -d '{\"amount\":25,\"description\":\"Payment for service\"}'
```

### Using PowerShell Invoke-RestMethod

#### 1. List All Customer Wallets
```powershell
Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets?limit=100" -Method Get -ContentType "application/json"
```

#### 2. Create New Customer Wallet
```powershell
$body = @{
    name = "John Doe"
    email = "john@example.com"
    phone = "+1234567890"
    initialBalance = 100
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets" -Method Post -Body $body -ContentType "application/json"
```

#### 3. Credit Money to Wallet
```powershell
$body = @{
    amount = 50
    description = "Top up payment"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{WALLET_ID}/credit" -Method Post -Body $body -ContentType "application/json"
```

#### 4. Debit Money from Wallet
```powershell
$body = @{
    amount = 25
    description = "Payment for service"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{WALLET_ID}/debit" -Method Post -Body $body -ContentType "application/json"
```

## Monitoring and Logs

### View Function Logs
```bash
firebase functions:log
```

### View Logs for Specific Function
```bash
firebase functions:log --only api
```

### View Real-time Logs
```bash
firebase functions:log --follow
```

### View Logs in Firebase Console
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: `truepay-72060`
3. Navigate to Functions → Logs

## Testing Workflow

### Step 1: Deploy
```bash
firebase deploy --only functions:api
```

### Step 2: Get the Function URL
Look for the output like:
```
✔  functions[api(us-central1)] Successful create operation.
Function URL (api): https://us-central1-truepay-72060.cloudfunctions.net/api
```

### Step 3: Test with a Simple Request
```powershell
Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets?limit=10" -Method Get
```

### Step 4: Create a Test Wallet
```powershell
$body = @{
    name = "Test User"
    email = "test@example.com"
    phone = "+1234567890"
    initialBalance = 0
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets" -Method Post -Body $body -ContentType "application/json"
$walletId = $response.data.id
Write-Host "Created wallet with ID: $walletId"
```

### Step 5: Test Credit Operation
```powershell
$body = @{
    amount = 100
    description = "Test credit"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/$walletId/credit" -Method Post -Body $body -ContentType "application/json"
```

### Step 6: Test Debit Operation
```powershell
$body = @{
    amount = 30
    description = "Test debit"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/$walletId/debit" -Method Post -Body $body -ContentType "application/json"
```

## Quick Test Script (PowerShell)

Save this as `test-api.ps1`:

```powershell
$baseUrl = "https://us-central1-truepay-72060.cloudfunctions.net/api"

Write-Host "Testing Customer Wallets API..." -ForegroundColor Green

# 1. List wallets
Write-Host "`n1. Listing wallets..." -ForegroundColor Yellow
$wallets = Invoke-RestMethod -Uri "$baseUrl/customer-wallets?limit=10" -Method Get
Write-Host "Found $($wallets.data.Count) wallets" -ForegroundColor Cyan

# 2. Create wallet
Write-Host "`n2. Creating test wallet..." -ForegroundColor Yellow
$newWallet = @{
    name = "Test User $(Get-Date -Format 'yyyyMMddHHmmss')"
    email = "test$(Get-Date -Format 'yyyyMMddHHmmss')@example.com"
    phone = "+1234567890"
    initialBalance = 0
} | ConvertTo-Json

$created = Invoke-RestMethod -Uri "$baseUrl/customer-wallets" -Method Post -Body $newWallet -ContentType "application/json"
$walletId = $created.data.id
Write-Host "Created wallet ID: $walletId" -ForegroundColor Cyan

# 3. Credit
Write-Host "`n3. Crediting 100 to wallet..." -ForegroundColor Yellow
$credit = @{
    amount = 100
    description = "Test credit"
} | ConvertTo-Json

$creditResult = Invoke-RestMethod -Uri "$baseUrl/customer-wallets/$walletId/credit" -Method Post -Body $credit -ContentType "application/json"
Write-Host "New balance: $($creditResult.data.balance)" -ForegroundColor Cyan

# 4. Debit
Write-Host "`n4. Debiting 30 from wallet..." -ForegroundColor Yellow
$debit = @{
    amount = 30
    description = "Test debit"
} | ConvertTo-Json

$debitResult = Invoke-RestMethod -Uri "$baseUrl/customer-wallets/$walletId/debit" -Method Post -Body $debit -ContentType "application/json"
Write-Host "New balance: $($debitResult.data.balance)" -ForegroundColor Cyan

# 5. Get wallet
Write-Host "`n5. Fetching wallet details..." -ForegroundColor Yellow
$wallet = Invoke-RestMethod -Uri "$baseUrl/customer-wallets/$walletId" -Method Get
Write-Host "Wallet: $($wallet.data.name) - Balance: $($wallet.data.balance)" -ForegroundColor Cyan

Write-Host "`n✅ All tests completed!" -ForegroundColor Green
```

Run it with:
```powershell
.\test-api.ps1
```

## Troubleshooting

### Function Not Found
- Verify deployment was successful: `firebase functions:list`
- Check the function name matches: should be `api`

### CORS Errors
- CORS is already enabled in the function
- If issues persist, check Firebase Console → Functions → Configuration

### Authentication Errors
- Currently, the API doesn't require authentication
- For production, consider adding Firebase Auth middleware

### Connection Refused
- Verify the function is deployed: `firebase functions:list`
- Check the correct region in the URL
- Ensure Firestore is properly configured

## Updating Frontend URL

After deployment, update your frontend to use the deployed URL:

```javascript
// Replace localhost URL with deployed URL
const API_BASE_URL = "https://us-central1-truepay-72060.cloudfunctions.net/api";
```

Or use environment variables:
```javascript
const API_BASE_URL = process.env.REACT_APP_API_URL || "http://localhost:8080/api";
```

