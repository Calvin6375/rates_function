# Database Structure Diagram

## Visual Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FIRESTORE (Source of Truth)                    │
└─────────────────────────────────────────────────────────────────────────┘

/users/{userId}
├── name, email, phoneNumber, country
├── balance (MASTER) ─────────────────┐
├── currency, fiatCurrency            │
├── kycStatus, kycData                │
├── role: "admin" | null              │
├── createdAt, updatedAt              │
└── lastTopUp                         │
                                      │
        ┌─────────────────────────────┘
        │ onUpdate Trigger
        ↓
    syncBalance()
        │
        ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                        REALTIME DATABASE (Cache/Mirror)                  │
└─────────────────────────────────────────────────────────────────────────┘

/wallet/{userId}/fiat/{currency}
└── balance (SYNCED FROM FIRESTORE)
    currency, createdAt, updatedAt


┌─────────────────────────────────────────────────────────────────────────┐
│                         TRANSACTION FLOW                                 │
└─────────────────────────────────────────────────────────────────────────┘

/transactions/{userId}/transactions/{txId}
├── type: "credit" | "debit" | "topup"
├── amount, status
├── previousBalance, newBalance
├── timestamp
└── metadata: { paymentId, source, reason, ... }


┌─────────────────────────────────────────────────────────────────────────┐
│                           ADMIN & AUDIT                                  │
└─────────────────────────────────────────────────────────────────────────┘

/adminLogs/{logId}
├── adminId, userId
├── action: "updateBalance" | "updateProfile" | "updateKYC"
├── before, after
└── timestamp


┌─────────────────────────────────────────────────────────────────────────┐
│                           RATES & CONFIG                                 │
└─────────────────────────────────────────────────────────────────────────┘

/p2pRates/binance
├── marketPrice, customerPrice
├── feePercentage
├── currencyPair: "USDT/KES"
├── validUntil (5 min)
└── updatedAt

/p2pRates/arbitrage
├── usdRate, localRate
├── usdAmount, usdtBought
├── localReceived, customerPayout
├── profit, feePercentage
├── currencyPair: "USD/KES"
├── validUntil (10 min)
└── updatedAt

/config/fees
├── serviceFee: 150 (1.5%)
└── arbitrageFee: 150 (1.5%)


┌─────────────────────────────────────────────────────────────────────────┐
│                         PAYMENT PROCESSING                               │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ IntaSend Invoice │ ───> │ pendingTopups    │ ───> │ Webhook Handler  │
│   Created        │      │ {invoiceId}      │      │                  │
└──────────────────┘      └──────────────────┘      └──────────────────┘
                              │                            │
                              │ userId mapping             │
                              │                            ↓
                          ┌──────────────────────────────────────────┐
                          │ 1. Lookup user from invoiceId            │
                          │ 2. Update Firestore balance (txn)        │
                          │ 3. Sync to Realtime DB                   │
                          │ 4. Log transaction                       │
                          │ 5. Record payment                        │
                          └──────────────────────────────────────────┘

/orders/{orderId}              /wallet/pendingTopups/{invoiceId}
├── userId                    ├── userId
├── orderType: "topup"        ├── amount, currency
├── status: "pending"         └── createdAt
├── amount, currency
├── invoiceId
└── metadata

/payments/{paymentId}
├── invoice_id
├── state: "COMPLETE"
├── net_amount, currency
├── account (phone)
├── user_id
└── processed_at


┌─────────────────────────────────────────────────────────────────────────┐
│                         REALTIME DATABASE PATHS                          │
└─────────────────────────────────────────────────────────────────────────┘

/
├── balances/{uid}/              (Legacy - being phased out)
│   └── balance, lastUpdated
│
├── wallet/
│   ├── {userId}/
│   │   └── fiat/
│   │       └── {currency}/
│   │           ├── balance
│   │           ├── currency
│   │           ├── createdAt
│   │           └── updatedAt
│   │
│   ├── rates/
│   │   ├── binance/
│   │   │   └── {currencyPair}/
│   │   │       ├── customerPrice
│   │   │       ├── marketPrice
│   │   │       ├── feePercentage
│   │   │       ├── validUntil
│   │   │       └── updatedAt
│   │   │
│   │   └── arbitrage/
│   │       └── {currencyPair}/
│   │           ├── usdRate, localRate
│   │           ├── customerPayout, profit
│   │           ├── validUntil
│   │           └── updatedAt
│   │
│   └── pendingTopups/
│       └── {invoiceId}/
│           ├── userId
│           ├── amount
│           └── currency
│
└── payments/
    └── {paymentId}/
        ├── invoice_id
        ├── state
        ├── net_amount
        ├── user_id
        └── processed_at


┌─────────────────────────────────────────────────────────────────────────┐
│                         LEGACY COLLECTIONS                               │
└─────────────────────────────────────────────────────────────────────────┘

/customerWallets/{walletId}     (Being migrated to /users)
├── firstName, lastName
├── email, phone
├── balance, cryptoBalance, fiatBalance
└── status, createdAt

/walletTransactions/{txId}      (Being replaced by /transactions)
├── walletId
├── type, amount
├── previousBalance, newBalance
└── createdAt


┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA FLOW DIAGRAMS                               │
└─────────────────────────────────────────────────────────────────────────┘

BALANCE UPDATE FLOW:
┌─────────────┐
│ Cloud Func  │
│ (any source)│
└──────┬──────┘
       │
       ↓
┌──────────────────┐
│ Firestore        │
│ Transaction      │
│ updateBalance()  │
└──────┬───────────┘
       │
       ↓
┌──────────────────┐      ┌──────────────────┐
│ /users/{id}      │      │ Transaction Log  │
│ balance updated  │      │ Created          │
└──────┬───────────┘      └──────────────────┘
       │
       │ onUpdate trigger fires
       ↓
┌──────────────────┐
│ syncBalance()    │
│ Cloud Function   │
└──────┬───────────┘
       │
       ↓
┌──────────────────────────┐
│ Realtime DB              │
│ /wallet/{id}/fiat/{curr} │
│ balance synced           │
└──────────────────────────┘


PAYMENT WEBHOOK FLOW:
┌─────────────┐
│ IntaSend    │
│ Webhook     │
└──────┬──────┘
       │
       ↓
┌──────────────────┐
│ Verify Signature │
└──────┬───────────┘
       │
       ↓
┌─────────────────────────────────┐
│ Resolve userId from:            │
│ 1. /orders (by invoiceId)       │
│ 2. /wallet/pendingTopups        │
│ 3. Phone lookup in /users       │
└──────┬──────────────────────────┘
       │
       ↓
┌──────────────────┐
│ Update Balance   │
│ (Firestore txn)  │
└──────┬───────────┘
       │
       ├──────────────────────┐
       ↓                      ↓
┌──────────────────┐  ┌──────────────────┐
│ Sync to RTDB     │  │ Log Transaction  │
└──────────────────┘  └──────────────────┘
       │
       ↓
┌──────────────────┐
│ Record Payment   │
│ /payments/{id}   │
└──────────────────┘


RATE UPDATE FLOW:
┌──────────────────┐
│ Scheduled Job    │
│ (every hour)     │
└──────┬───────────┘
       │
       ↓
┌──────────────────┐
│ Fetch from       │
│ Binance API      │
└──────┬───────────┘
       │
       ↓
┌──────────────────┐      ┌──────────────────┐
│ Calculate Rates  │      │ Apply Fees       │
│ + Fees           │      │                  │
└──────┬───────────┘      └──────────────────┘
       │
       ├──────────────────────┐
       ↓                      ↓
┌──────────────────┐  ┌──────────────────┐
│ Write to         │  │ Write to         │
│ Firestore        │  │ Realtime DB      │
│ /p2pRates/       │  │ /wallet/rates/   │
└──────────────────┘  └──────────────────┘


┌─────────────────────────────────────────────────────────────────────────┐
│                         ACCESS PATTERNS                                  │
└─────────────────────────────────────────────────────────────────────────┘

USER CLIENT (Mobile App):
  Read:  /wallet/{userId}/fiat/{currency}  (real-time balance)
  Read:  /wallet/rates/{source}/{pair}     (real-time rates)
  Read:  /users/{userId}                   (own profile)
  
ADMIN DASHBOARD:
  Read:  /users/{userId}                   (all users)
  Read:  /transactions/{userId}/...        (all transactions)
  Read:  /adminLogs/                       (audit trail)
  Write: /users/{userId}                   (update profiles, balance)
  Write: /p2pRates/                        (manual rate updates)
  Write: /config/                          (update fees)
  
CLOUD FUNCTIONS (Server):
  Read/Write: ALL collections (bypasses security rules)
  Primary: Balance updates, transactions, logging
  
PUBLIC (Unauthenticated):
  Read:  /p2pRates/                        (rates)
  Read:  /config/                          (fee config)

