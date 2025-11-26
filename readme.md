# Rates Function - Firebase Cloud Functions

A Firebase Cloud Functions application that provides cryptocurrency exchange rate services and payment processing capabilities. The application fetches real-time P2P exchange rates from Binance, calculates arbitrage opportunities, and handles payment webhooks for wallet top-ups.

## Features

### 1. **Binance P2P Rate Fetcher**
- Automatically fetches USDT/KES (Kenyan Shilling) exchange rates from Binance P2P marketplace
- Runs every 5 minutes via scheduled function
- Applies configurable service fees to market rates
- Stores rates in Firestore for easy access

### 2. **Arbitrage Rate Calculator**
- Calculates arbitrage opportunities for USD → USDT → KES conversion path
- Fetches rates from both US and Kenya markets
- Runs every 10 minutes via scheduled function
- Applies configurable arbitrage fees
- Provides detailed breakdown including:
  - USD to USDT conversion rate
  - USDT to KES conversion rate
  - Customer payout after fees
  - Profit calculations

### 3. **Payment Webhook Handler**
- Processes IntaSend payment webhooks for wallet top-ups
- Verifies webhook signatures for security
- Updates user wallet balances in both Realtime Database and Firestore
- Handles payment completion events and maintains payment history

## Architecture

```
functions/
├── index.js        # Main entry point, exports all functions
├── admin.js        # Firebase Admin SDK initialization
├── rates.js        # Binance P2P rate fetching logic
├── arbitrage.js    # Arbitrage calculation logic
├── payments.js     # Payment webhook handler
└── package.json    # Dependencies and scripts
```

## Prerequisites

- Node.js 22
- Firebase CLI
- Firebase project with:
  - Firestore Database enabled
  - Realtime Database enabled
  - Cloud Functions enabled
  - Cloud Scheduler enabled (for scheduled functions)

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd rates_function
   ```

2. **Install dependencies**
   ```bash
   cd functions
   npm install
   ```

3. **Configure Firebase**
   ```bash
   firebase login
   firebase use <your-project-id>
   ```

4. **Set up environment variables**
   ```bash
   firebase functions:config:set intasend.secret="your-intasend-webhook-secret"
   ```

## Configuration

### Firestore Configuration

The application reads fee configuration from Firestore. Create a document at:
```
config/fees
```

With the following structure:
```json
{
  "serviceFee": 1.5,      // Service fee percentage (default: 1.5%)
  "arbitrageFee": 1.5     // Arbitrage fee percentage (default: 1.5%)
}
```

### Firebase Configuration

The application uses two codebases:
- **default**: Main functions (rates, arbitrage, payments)
- **rates**: Alternative codebase (currently placeholder)

## Deployed Functions

### Scheduled Functions

1. **`fetchBinanceRates`**
   - **Schedule**: Every 5 minutes (`*/5 * * * *`)
   - **Purpose**: Fetches and updates USDT/KES rates from Binance
   - **Storage**: `p2pRates/binance` in Firestore

2. **`fetchArbitrageRates`**
   - **Schedule**: Every 10 minutes (`*/10 * * * *`)
   - **Purpose**: Calculates and updates arbitrage rates
   - **Storage**: `p2pRates/arbitrage` in Firestore

### Callable Functions

1. **`getBinanceRates`**
   - **Type**: HTTPS Callable
   - **Purpose**: Retrieves current Binance rates from Firestore
   - **Returns**: Rate data including market price, customer price, and fee percentage

### HTTP Functions

1. **`handleTopUpWebhook`**
   - **Type**: HTTPS Request
   - **Purpose**: Handles IntaSend payment webhooks
   - **Method**: POST only
   - **Security**: Verifies webhook signature using HMAC SHA-256
   - **Updates**:
     - Realtime Database: `wallet/balance/{userId}`
     - Realtime Database: `payments/{paymentId}`
     - Firestore: `users/{userId}`

## Data Structure

### Firestore Collections

**`p2pRates/binance`**
```json
{
  "marketPrice": 129.50,
  "customerPrice": 131.44,
  "feePercentage": 1.5,
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

**`p2pRates/arbitrage`**
```json
{
  "usRate": 1.000,
  "keRate": 129.50,
  "usdAmount": 1000,
  "usdtBought": 1000,
  "kesReceived": 129500,
  "feePercentage": 1.5,
  "customerPayout": 127557.5,
  "profit": 1942.5,
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

**`users/{userId}`**
```json
{
  "balance": 5000,
  "lastTopUp": "2024-01-01T00:00:00Z"
}
```

### Realtime Database Structure

**`wallet/balance/{userId}`**
```json
{
  "available": 5000,
  "currency": "KES",
  "lastUpdated": "2024-01-01T00:00:00Z"
}
```

**`payments/{paymentId}`**
```json
{
  "payment_id": "pay_123",
  "amount": 1000,
  "currency": "KES",
  "user_id": "user_123",
  "completed_at": "2024-01-01T00:00:00Z",
  "processed_at": "2024-01-01T00:00:01Z"
}
```

## Development

### Local Development

1. **Start Firebase Emulators**
   ```bash
   npm run serve
   ```

2. **View Logs**
   ```bash
   npm run logs
   ```

### Deployment

Deploy all functions:
```bash
npm run deploy
```

Deploy specific function:
```bash
firebase deploy --only functions:fetchBinanceRates
```

## Dependencies

- **firebase-admin**: ^12.7.0 - Firebase Admin SDK
- **firebase-functions**: ^6.4.0 - Firebase Cloud Functions
- **axios**: ^1.12.2 - HTTP client for API requests
- **node-cron**: ^4.2.1 - Cron scheduling (used by Firebase Scheduler)

## Security

- Payment webhooks are secured using HMAC SHA-256 signature verification
- Webhook secret is stored in Firebase Functions config (encrypted at rest)
- All functions use Firebase Authentication and Firestore security rules (configure separately)

## Error Handling

- All scheduled functions include try-catch blocks and error logging
- Functions return `null` on error to prevent retry loops
- Webhook handler returns appropriate HTTP status codes (400, 403, 405, 500)

## Monitoring

Monitor function execution and errors through:
- Firebase Console → Functions → Logs
- Cloud Logging in Google Cloud Console

## License

Private - All rights reserved
