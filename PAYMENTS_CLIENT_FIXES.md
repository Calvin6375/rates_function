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

## 2. “Creating order” – Firestore permission-denied (client change required)

The `orders` collection is **write-protected**: only Cloud Functions (admin SDK) can create or update orders. The `createPayment` callable **already creates the order** in `paymentsLib.createPaymentOrder`.

Your Flutter app must **not** create an order document in Firestore from the client. That causes:

```text
[cloud_firestore/permission-denied] The caller does not have permission to execute the specified operation.
```

**What to do in the Flutter app**

1. Remove any client-side logic that writes to the `orders` collection (e.g. in `PaymentService`, `IntaSendService`, or `topup_page.dart` when you see logs like “Creating order for user”).
2. Rely only on `createPayment` for order creation. The flow should be:
   - Call **IntaSend** to create a checkout session.
   - Call **`createPayment`** with `checkoutUrl`, `intasendCheckoutId` (or `invoiceId`), `amount`, `currency`, etc.  
     → This creates the order and invoice mapping on the server.
   - Optionally call **`handlePaymentWebhook`** with the checkout/invoice id when the user opens the payment link (to set `linkOpenedAt`).
   - Open the checkout URL in the browser.

If you need an “order” reference in the client after `createPayment`, use the `orderId` (and `invoiceId` / `paymentId`) returned by `createPayment`; do not create a new `orders` document from the client.
