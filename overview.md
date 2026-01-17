# TruePay Backend - Application Overview

## What is TruePay?

TruePay is a **cryptocurrency exchange platform** that simplifies converting USD to African fiat currencies (like Kenyan Shillings, Nigerian Naira, or Ghanaian Cedis) using USDT as an intermediary. Think of it as a digital bridge that connects US dollars to African currencies through cryptocurrency markets.

The backend is built entirely on **Firebase Cloud Functions** - a serverless platform that automatically scales, handles traffic spikes, and never requires server management.

---

## The Problem TruePay Solves

Traditional currency exchange can be expensive, slow, and complex. TruePay makes it easier:

- **Real-time exchange rates** from Binance P2P marketplace
- **Automated payment processing** via mobile money (M-PESA, etc.)
- **Secure wallet management** with transaction history
- **Transparent fee structure** with clear pricing

---

## What the Application Does

### 1. 💱 Exchange Rate Service

**What it does:** Fetches real-time cryptocurrency exchange rates from Binance P2P marketplace and applies service fees.

**Example:**
- A user wants to know: "How much is 1 USDT worth in Kenyan Shillings right now?"
- The system queries Binance P2P marketplace
- Finds the current market rate (e.g., 129.50 KES per USDT)
- Applies a 1.5% service fee
- Returns: **131.44 KES per USDT** (customer price)

**Real-world scenario:**
```
Sarah in Kenya wants to buy 100 USDT worth of mobile money credit.
→ System checks Binance: Market rate is 129.50 KES/USDT
→ Applies 1.5% fee: 131.44 KES/USDT  
→ Sarah pays: 13,144 KES for 100 USDT
```

---

### 2. 🔄 Arbitrage Calculation Engine

**What it does:** Calculates profitable conversion paths for USD → USDT → Local Fiat currency, showing users exactly how much they'll receive.

**Example:**
- User has $1,000 USD and wants Kenyan Shillings
- System calculates:
  - USD → USDT: 1:1 (exchange $1,000 for 1,000 USDT)
  - USDT → KES: 129.50 KES/USDT = 129,500 KES
  - After fees (1.5%): **127,557.5 KES** payout to customer
  - Platform profit: **1,942.5 KES**

**Real-world scenario:**
```
James sends $1,000 from the US to his family in Kenya.
→ System calculates: $1,000 USD → 1,000 USDT → 129,500 KES
→ After platform fee of 1.5%: Family receives 127,557.5 KES
→ All automated, transparent, and fast
```

---

### 3. 💳 Payment Processing System

**What it does:** Handles mobile money payments (like M-PESA) through IntaSend gateway and automatically credits user wallets when payments are received.

**Example flow:**
1. User initiates top-up: "I want to add 10,000 KES to my wallet"
2. System creates payment order and checkout link
3. User pays via M-PESA on their phone
4. IntaSend sends webhook notification
5. System automatically credits the user's wallet
6. Transaction is logged and user balance updates in real-time

**Real-world scenario:**
```
Mary wants to top up her TruePay wallet with 5,000 KES:
1. Opens TruePay app, selects "Add Funds"
2. Enters amount: 5,000 KES
3. Gets checkout link from IntaSend
4. Pays via M-PESA (enters PIN on phone)
5. Payment completes → Webhook triggers
6. System automatically adds 5,000 KES to Mary's wallet
7. Mary sees balance update instantly: 5,000 KES added ✅
```

---

### 4. 👛 Digital Wallet Management

**What it does:** Manages user balances across multiple currencies (USD, KES, NGN, GHS, USDT) with secure transaction logging.

**Key features:**
- Multi-currency support (USD, KES, NGN, GHS, USDT)
- Transaction history tracking
- Real-time balance updates
- Secure balance management (prevents race conditions)
- Currency-specific balances

**Example:**
```
David's wallet shows:
- USD Balance: $500.00
- KES Balance: 50,000.00
- USDT Balance: 0.00

When David makes a transaction:
→ System logs: "Credit 10,000 KES"
→ Previous balance: 50,000 KES
→ New balance: 60,000 KES
→ Transaction ID: tx_1234567890
→ Timestamp: 2024-01-15 10:30 AM
→ Status: Completed
```

---

### 5. 👥 User Management

**What it does:** Handles user accounts, authentication, profiles, and KYC (Know Your Customer) verification status.

**Features:**
- Firebase Authentication integration
- User profile management (name, email, phone, country)
- KYC status tracking
- Automatic account initialization when users sign up

**Example:**
```
When Sarah creates an account:
→ Firebase Auth creates user ID
→ System automatically:
  - Creates user profile document
  - Initializes wallet with $0.00 balance
  - Sets KYC status to "pending"
  - Logs account creation timestamp
→ Sarah can immediately start using the platform
```

---

### 6. 🛡️ Admin Dashboard Support

**What it does:** Provides administrative functions for managing users, adjusting balances, verifying KYC status, and configuring platform settings.

**Admin capabilities:**
- View all transactions across all users
- Adjust user balances (credit/debit)
- Update user profiles
- Verify KYC documents
- Configure exchange rate fees
- Track payment status
- View comprehensive transaction history

**Example:**
```
Admin wants to help a user who lost funds:
→ Opens dashboard
→ Searches user: "Sarah Johnson"
→ Views transaction history (all deposits, withdrawals, exchanges)
→ Sees issue: Payment completed but wallet not credited
→ Manually credits wallet: 5,000 KES
→ System logs admin action for audit trail
→ User receives notification: "Balance updated"
```

---

## How It Works: Real-World Examples

### Example 1: Currency Exchange

**Scenario:** A user in the US wants to send money to Kenya

1. **User checks exchange rate:**
   ```
   GET /getBinanceRates?fiat=KES&asset=USDT
   → Response: 131.44 KES/USDT (includes 1.5% fee)
   ```

2. **User initiates exchange:**
   - Has $100 USD in wallet
   - Wants to convert to KES
   - System calculates: $100 → 100 USDT → 13,144 KES (after fees)

3. **Transaction completes:**
   - USD balance: $100 → $0
   - KES balance: 0 → 13,144 KES
   - Transaction logged: "Exchange USD to KES"
   - Status: Completed ✅

---

### Example 2: Mobile Money Top-Up

**Scenario:** A Kenyan user wants to add funds via M-PESA

1. **User requests top-up:**
   ```
   POST /createPayment
   {
     "amount": 5000,
     "currency": "KES"
   }
   ```

2. **System creates payment order:**
   - Generates invoice ID: "INV123456"
   - Creates checkout URL from IntaSend
   - Stores order in database: status = "pending"

3. **User pays via M-PESA:**
   - Opens checkout link on phone
   - Enters M-PESA PIN
   - Payment processes on IntaSend

4. **Webhook triggers:**
   ```
   POST /handleTopUpWebhook
   → IntaSend sends payment confirmation
   → System verifies signature (security check)
   → Resolves user account via phone number
   → Credits wallet: +5,000 KES
   → Updates order status: "completed"
   → Logs transaction: "Top-up via M-PESA"
   ```

5. **User sees balance update:**
   - Previous: 0 KES
   - New: 5,000 KES
   - Transaction visible in history ✅

---

### Example 3: Admin Reviewing Transactions

**Scenario:** Admin needs to audit all transactions for the day

1. **Admin requests transaction history:**
   ```
   GET /admin/transactions?limit=100&startDate=2024-01-15
   ```

2. **System returns:**
   ```json
   {
     "transactions": [
       {
         "id": "tx_123",
         "date": "2024-01-15T10:30:00Z",
         "type": "credit",
         "client": {
           "name": "Sarah Johnson",
           "email": "sarah@example.com"
         },
         "amount": 5000,
         "currency": "KES",
         "status": "completed",
         "reference": "INV123456"
       },
       // ... more transactions
     ],
     "pagination": {
       "total": 150,
       "hasMore": true
     }
   }
   ```

3. **Admin can:**
   - Filter by type, status, currency, date range
   - View client information for each transaction
   - Export data for accounting
   - Investigate issues or discrepancies

---

## Key Technical Features

### 🔒 Security
- **Webhook signature verification** - Prevents unauthorized payment processing
- **Firebase Authentication** - Secure user login and authorization
- **Transaction safety** - Prevents race conditions and balance inconsistencies
- **Admin role verification** - Protects sensitive operations
- **Input validation** - All data validated before processing

### ⚡ Performance
- **Rate caching** - Exchange rates cached for 5-10 minutes (reduces API calls)
- **Automatic scaling** - Firebase Functions scale automatically with traffic
- **Dual database architecture** - Firestore for persistence, Realtime DB for speed
- **Idempotency** - Prevents duplicate processing (important for payments)

### 📊 Reliability
- **Transaction logging** - Every balance change is logged and auditable
- **Error handling** - Comprehensive error handling with fallbacks
- **Webhook retry logic** - Handles payment gateway failures gracefully
- **Admin audit logs** - All admin actions are logged for compliance

---

## Technology Stack

- **Firebase Cloud Functions v2** - Serverless backend (no servers to manage)
- **Firestore** - NoSQL database (stores users, transactions, rates)
- **Firebase Realtime Database** - Real-time data cache (instant balance updates)
- **Firebase Authentication** - User authentication and authorization
- **Node.js 22** - Runtime environment
- **IntaSend API** - Payment gateway for mobile money (M-PESA, etc.)
- **Binance P2P API** - Exchange rate data source

---

## Supported Markets

Currently supports African currencies:
- 🇰🇪 **KES** - Kenyan Shilling
- 🇳🇬 **NGN** - Nigerian Naira
- 🇬🇭 **GHS** - Ghanaian Cedi

And cryptocurrencies:
- 💰 **USDT** - Tether (stablecoin)
- 💵 **USD** - US Dollar (base currency)

---

## What Makes This Special?

### ✅ Fully Automated
Once set up, the system runs itself:
- Exchange rates update daily via scheduled functions
- Payments process automatically via webhooks
- Balances sync in real-time
- No manual intervention needed

### ✅ Transparent
Users always know:
- Current exchange rates
- Exact fees applied
- Transaction history
- Account balance in real-time

### ✅ Scalable
Built on serverless architecture:
- Handles traffic spikes automatically
- No server management required
- Cost-effective (pay per use)
- Global availability

### ✅ Secure
Multiple layers of security:
- Encrypted data transmission
- Secure payment processing
- Transaction integrity guarantees
- Audit trails for compliance

---

## Who Uses This?

- **End Users** - People sending/receiving money across borders
- **Businesses** - Companies needing currency exchange services
- **Remittance Services** - Money transfer businesses
- **Financial Platforms** - Apps needing exchange rate APIs
- **Admin Team** - Platform operators managing users and transactions

---

## Summary

TruePay Backend is a **comprehensive cryptocurrency exchange platform** that:

1. **Fetches real-time exchange rates** from Binance P2P marketplace
2. **Processes mobile money payments** automatically via IntaSend
3. **Manages multi-currency wallets** with secure transaction logging
4. **Calculates arbitrage opportunities** for profitable currency conversions
5. **Provides admin tools** for user management and platform operations

Built on **Firebase Cloud Functions** - a modern serverless platform that automatically scales, never requires server management, and handles everything from user authentication to payment processing seamlessly.

---

*For technical documentation, see [readme.md](./readme.md) and [api.md](./api.md)*
