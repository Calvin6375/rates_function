# Payment client fixes

## 1. `handlePaymentWebhook` – FIXED (backend)

The callable `handlePaymentWebhook` is now implemented and exported. Deploy functions so the client stops getting `[firebase_functions/not-found]`:

```bash
firebase deploy --only functions:handlePaymentWebhook
```

The callable accepts:

- `{ "invoiceId": "..." }` or  
- `{ "intasendCheckoutId": "..." }` or  
- `{ "paymentId": "..." }` or  
- a raw string (the checkout/invoice id)

It marks the order’s `linkOpenedAt` and returns `{ "success": true }`.

---

## 2. C2B top-up – remove client-side IntaSend checkout (Flutter change required)

C2B tourist card top-up now uses **Paystack hosted checkout** initialized **server-side** by `createPayment`. The backend returns `checkoutUrl` (e.g. `https://checkout.paystack.com/…`).

**Do not** create an IntaSend checkout session in Flutter before calling `createPayment`. If the app still sends `intasendCheckoutId` or an IntaSend `checkoutUrl`, the callable returns `failed-precondition` and the app must be updated.

### Wrong (current bug)

```dart
// 1. Creates IntaSend checkout client-side
final intaSendUrl = await intaSendService.createCheckout(...);

// 2. Calls createPayment with IntaSend fields
final result = await createPayment({
  'amount': 200,
  'currency': 'KES',
  'checkoutUrl': intaSendUrl,           // remove
  'intasendCheckoutId': checkoutId,     // remove
});

// 3. BUG: opens IntaSend URL instead of Paystack URL from response
await launchUrl(Uri.parse(intaSendUrl));
```

### Correct (Paystack C2B)

```dart
final result = await createPayment({
  'amount': 200,
  'currency': 'KES',   // or USD — backend converts to KES for Paystack
  'email': user.email,
});

final data = result.data as Map<String, dynamic>;
final checkoutUrl = data['checkoutUrl'] as String;  // Paystack URL from server

await launchUrl(
  Uri.parse(checkoutUrl),
  mode: LaunchMode.externalApplication,
);

// After Paystack redirect / deep link:
await handlePaymentWebhook({'invoiceId': data['invoiceId']});
```

**Request:** `amount`, `currency`, optional `email` only.

**Response:** use `checkoutUrl` (aliases: `url`, `authorization_url`) — never a locally built IntaSend URL.

The `orders` collection remains **write-protected**; `createPayment` creates the funding order on the server. Do not write to `orders` from the client.

---

## 3. “Creating order” – Firestore permission-denied (client change required)

The `orders` collection is **write-protected**: only Cloud Functions (admin SDK) can create or update orders. The `createPayment` callable creates the funding order on the server via the Paystack C2B bridge.

Your Flutter app must **not** create an order document in Firestore from the client. That causes:

```text
[cloud_firestore/permission-denied] The caller does not have permission to execute the specified operation.
```

**What to do in the Flutter app**

1. Remove any client-side logic that writes to the `orders` collection (e.g. in `PaymentService`, `IntaSendService`, or `topup_page.dart` when you see logs like “Creating order for user”).
2. Remove client-side **IntaSend checkout session** creation for C2B top-up (see section 2 above).
3. Call **`createPayment`** with `amount`, `currency`, and optional `email` only — **not** `checkoutUrl` / `intasendCheckoutId`.
4. Open **`checkoutUrl` from the createPayment response** (Paystack) in the browser.
5. Optionally call **`handlePaymentWebhook`** with `invoiceId` from the response when the user returns from checkout.

If you need an “order” reference in the client after `createPayment`, use the `orderId` (and `invoiceId` / `paymentId`) returned by `createPayment`; do not create a new `orders` document from the client.

---

## 4. "Creating order" for swap – use `createSwapOrder` callable

The `orders` collection is write-protected. For **swap** (e.g. USDT → USD), do not create an order document from the client. Call the **`createSwapOrder`** callable instead. It creates the order in Firestore, debits the source currency and credits the destination in one transaction, and returns `orderId` and `newBalances`.

**Request data:** `fromCurrency`, `toCurrency`, `fromAmount`, `exchangeRate` (required); `fee` or `feeRate`, `toAmount` (optional). Example: `{ fromCurrency: "USDT", toCurrency: "USD", fromAmount: 6.0, fee: 0.03, exchangeRate: 1.01297 }`.

---

## 5. "Creating order" for send money – use `createSendMoneyOrder` callable

The `orders` collection is write-protected. For **send money** (P2P transfer), do not create an order document from the client. Call the **`createSendMoneyOrder`** callable instead. It creates the order in Firestore, debits the sender and credits the recipient in one transaction, and returns `orderId`, `senderNewBalances`, and `recipientNewBalances`.

**Request data:** `amount`, `currency` (required); either `recipientUserId` or `recipientPhoneNumber` (required); `note` (optional). Example: `{ recipientUserId: "abc123", amount: 1.0, currency: "USD", note: "Lunch" }`. See **FRONTEND_SEND_MONEY_IMPLEMENTATION.md** for full steps.
