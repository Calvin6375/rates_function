# Integration Guide: IntaSend Payment Status in Admin Dashboard

This guide will walk you through integrating the `getIntaSendPaymentStatus` endpoint into your TruePay admin dashboard's "IntaSend Deposits" section.

## Prerequisites

- Firebase CLI installed and authenticated
- Admin dashboard codebase access
- IntaSend API credentials (Secret Key and Publishable Key)

---

## Step 1: Configure Firebase Secrets

First, you need to set up IntaSend API credentials as Firebase secrets so the Cloud Function can authenticate with IntaSend.

### 1.1 Get Your IntaSend API Keys

1. Log in to your IntaSend dashboard
2. Navigate to **Settings** > **API Keys**
3. Copy your:
   - **Secret Key** (API Token)
   - **Publishable Key** (optional but recommended)

### 1.2 Set Firebase Secrets

Run these commands in your terminal:

```bash
# Navigate to your functions directory
cd functions

# Set the IntaSend Secret Key (REQUIRED)
firebase functions:secrets:set INTASEND_SECRET_KEY

# When prompted, paste your IntaSend Secret Key

# Set the IntaSend Publishable Key (OPTIONAL but recommended)
firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY

# When prompted, paste your IntaSend Publishable Key
```

### 1.3 Deploy the Function

After setting secrets, deploy your functions:

```bash
# From the project root
firebase deploy --only functions:getIntaSendPaymentStatus
```

Or deploy all functions:

```bash
firebase deploy --only functions
```

---

## Step 2: Frontend Integration

### 2.1 Install Firebase Functions (if not already installed)

```bash
npm install firebase
# or
yarn add firebase
```

### 2.2 Create a Service/Utility File

Create a new file `src/services/intasendService.js` (or `.ts` if using TypeScript):

```javascript
import { getFunctions, httpsCallable } from 'firebase/functions';

/**
 * Get IntaSend payment status by invoice ID
 * @param {string} invoiceId - IntaSend invoice ID
 * @returns {Promise<Object>} Payment status data
 */
export async function getIntaSendPaymentStatus(invoiceId) {
  try {
    const functions = getFunctions();
    const getPaymentStatus = httpsCallable(functions, 'getIntaSendPaymentStatus');
    
    const result = await getPaymentStatus({ invoiceId });
    
    if (result.data.success) {
      return {
        success: true,
        data: result.data,
      };
    } else {
      throw new Error('Failed to get payment status');
    }
  } catch (error) {
    // Handle Firebase callable function errors
    const errorCode = error.code || 'unknown';
    const errorMessage = error.message || 'Unknown error occurred';
    
    // Map Firebase error codes to user-friendly messages
    const errorMessages = {
      'not-found': `Invoice ${invoiceId} not found in IntaSend`,
      'permission-denied': 'Admin access required or invalid IntaSend API credentials',
      'failed-precondition': 'IntaSend API keys not configured. Please contact support.',
      'deadline-exceeded': 'Request timed out. Please try again.',
      'invalid-argument': 'Invalid invoice ID provided',
      'unauthenticated': 'You must be logged in to perform this action',
    };
    
    return {
      success: false,
      error: errorMessages[errorCode] || errorMessage,
      code: errorCode,
    };
  }
}
```

### 2.3 Create a React Hook (Optional but Recommended)

Create `src/hooks/useIntaSendPaymentStatus.js`:

```javascript
import { useState } from 'react';
import { getIntaSendPaymentStatus } from '../services/intasendService';

/**
 * Custom hook to fetch IntaSend payment status
 */
export function useIntaSendPaymentStatus() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const fetchStatus = async (invoiceId) => {
    if (!invoiceId || invoiceId.trim() === '') {
      setError('Invoice ID is required');
      return;
    }

    setLoading(true);
    setError(null);
    setData(null);

    try {
      const result = await getIntaSendPaymentStatus(invoiceId.trim());
      
      if (result.success) {
        setData(result.data);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch payment status');
    } finally {
      setLoading(false);
    }
  };

  return {
    fetchStatus,
    loading,
    error,
    data,
  };
}
```

---

## Step 3: Integrate into IntaSend Deposits Table

### 3.1 Update Your IntaSend Deposits Component

Assuming you have a component like `IntaSendDeposits.jsx` or `IntaSendDeposits.tsx`, here's how to integrate it:

```javascript
import React, { useState } from 'react';
import { useIntaSendPaymentStatus } from '../hooks/useIntaSendPaymentStatus';

function IntaSendDeposits() {
  const { fetchStatus, loading, error, data } = useIntaSendPaymentStatus();
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);

  // Your existing deposits data
  const [deposits, setDeposits] = useState([]);

  // Function to check payment status
  const handleCheckStatus = async (invoiceId) => {
    setSelectedInvoiceId(invoiceId);
    await fetchStatus(invoiceId);
  };

  // Function to refresh status for a specific deposit
  const handleRefreshStatus = async (invoiceId) => {
    await fetchStatus(invoiceId);
  };

  return (
    <div className="intasend-deposits">
      <div className="flex justify-between items-center mb-4">
        <h2>IntaSend Deposits</h2>
        <button
          onClick={() => handleRefreshStatus(selectedInvoiceId)}
          className="refresh-button"
          disabled={!selectedInvoiceId || loading}
        >
          {loading ? 'Loading...' : '🔄 Refresh'}
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div className="error-message bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {/* Status Details Modal/Card */}
      {data && selectedInvoiceId && (
        <div className="status-details bg-white border rounded-lg p-4 mb-4 shadow-sm">
          <h3 className="text-lg font-semibold mb-2">Payment Status: {data.status.invoice.state}</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-600">Invoice ID</p>
              <p className="font-medium">{data.invoiceId}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Amount</p>
              <p className="font-medium">
                {data.status.invoice.net_amount} {data.status.invoice.currency}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Provider</p>
              <p className="font-medium">{data.status.invoice.provider}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Status</p>
              <span className={`inline-block px-2 py-1 rounded text-sm font-medium ${
                data.status.invoice.state === 'COMPLETE' ? 'bg-green-100 text-green-800' :
                data.status.invoice.state === 'FAILED' ? 'bg-red-100 text-red-800' :
                data.status.invoice.state === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                'bg-blue-100 text-blue-800'
              }`}>
                {data.status.invoice.state}
              </span>
            </div>
            <div>
              <p className="text-sm text-gray-600">Customer</p>
              <p className="font-medium">
                {data.status.meta.customer.first_name} {data.status.meta.customer.last_name}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Phone</p>
              <p className="font-medium">{data.status.meta.customer.phone_number || 'N/A'}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Created At</p>
              <p className="font-medium text-sm">
                {new Date(data.status.invoice.created_at).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Updated At</p>
              <p className="font-medium text-sm">
                {new Date(data.status.invoice.updated_at).toLocaleString()}
              </p>
            </div>
            {data.status.invoice.failed_reason && (
              <div className="col-span-2">
                <p className="text-sm text-gray-600">Failure Reason</p>
                <p className="font-medium text-red-600">{data.status.invoice.failed_reason}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Deposits Table */}
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-50">
            <th className="border p-2 text-left">DATE</th>
            <th className="border p-2 text-left">SOURCE</th>
            <th className="border p-2 text-left">AMOUNT</th>
            <th className="border p-2 text-left">STATUS</th>
            <th className="border p-2 text-left">REFERENCE</th>
            <th className="border p-2 text-left">ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {deposits.length === 0 ? (
            <tr>
              <td colSpan="6" className="border p-4 text-center text-gray-500">
                No deposits found for the selected period.
              </td>
            </tr>
          ) : (
            deposits.map((deposit) => (
              <tr key={deposit.id} className="hover:bg-gray-50">
                <td className="border p-2">
                  {new Date(deposit.date).toLocaleDateString()}
                </td>
                <td className="border p-2">{deposit.source}</td>
                <td className="border p-2">
                  {deposit.amount} {deposit.currency}
                </td>
                <td className="border p-2">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    deposit.status === 'COMPLETE' ? 'bg-green-100 text-green-800' :
                    deposit.status === 'FAILED' ? 'bg-red-100 text-red-800' :
                    deposit.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-blue-100 text-blue-800'
                  }`}>
                    {deposit.status || 'UNKNOWN'}
                  </span>
                </td>
                <td className="border p-2 font-mono text-sm">{deposit.reference}</td>
                <td className="border p-2">
                  <button
                    onClick={() => handleCheckStatus(deposit.reference)}
                    className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                    disabled={loading}
                  >
                    {loading && selectedInvoiceId === deposit.reference ? 'Checking...' : 'Check Status'}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default IntaSendDeposits;
```

### 3.2 Alternative: Add Status Check to Each Row

If you want to show status inline in the table:

```javascript
// In your table row component
<td className="border p-2">
  <div className="flex items-center gap-2">
    <span className={`px-2 py-1 rounded text-xs font-medium ${
      deposit.status === 'COMPLETE' ? 'bg-green-100 text-green-800' :
      deposit.status === 'FAILED' ? 'bg-red-100 text-red-800' :
      deposit.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
      'bg-gray-100 text-gray-800'
    }`}>
      {deposit.status || 'UNKNOWN'}
    </span>
    <button
      onClick={() => handleCheckStatus(deposit.reference)}
      className="text-gray-400 hover:text-gray-600"
      title="Refresh Status"
      disabled={loading}
    >
      🔄
    </button>
  </div>
</td>
```

---

## Step 4: TypeScript Support (Optional)

If you're using TypeScript, create type definitions:

```typescript
// src/types/intasend.ts

export interface IntaSendInvoice {
  id: string;
  invoice_id: string;
  state: 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
  provider: string;
  charges: string;
  net_amount: number;
  currency: string;
  value: string;
  account: string;
  api_ref: string;
  host: string;
  failed_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntaSendCustomer {
  id: string;
  phone_number: string;
  email: string;
  first_name: string;
  last_name: string;
  country: string;
  address: string;
  city: string;
  state: string;
  zipcode: string;
  provider: string;
  created_at: string;
  updated_at: string;
}

export interface IntaSendMeta {
  id: string;
  customer: IntaSendCustomer;
  customer_comment: string;
  created_at: string;
  updated_at: string;
}

export interface IntaSendPaymentStatus {
  success: boolean;
  invoiceId: string;
  status: {
    invoice: IntaSendInvoice;
    meta: IntaSendMeta;
  };
  invoice: IntaSendInvoice;
  meta: IntaSendMeta;
}
```

Then update your service:

```typescript
import { IntaSendPaymentStatus } from '../types/intasend';

export async function getIntaSendPaymentStatus(
  invoiceId: string
): Promise<{ success: true; data: IntaSendPaymentStatus } | { success: false; error: string; code: string }> {
  // ... same implementation with types
}
```

---

## Step 5: Error Handling & User Feedback

### 5.1 Add Toast Notifications

Install a toast library (e.g., `react-toastify`):

```bash
npm install react-toastify
```

Then update your component:

```javascript
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const handleCheckStatus = async (invoiceId) => {
  setSelectedInvoiceId(invoiceId);
  const result = await fetchStatus(invoiceId);
  
  if (result.success) {
    toast.success('Payment status retrieved successfully');
  } else {
    toast.error(result.error || 'Failed to get payment status');
  }
};
```

### 5.2 Loading States

Add loading indicators:

```javascript
{loading && (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div className="bg-white rounded-lg p-6">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
      <p className="mt-4 text-gray-600">Checking payment status...</p>
    </div>
  </div>
)}
```

---

## Step 6: Testing

### 6.1 Test with a Valid Invoice ID

1. Get a test invoice ID from IntaSend (from a test payment)
2. Use the "Check Status" button in your dashboard
3. Verify the status is displayed correctly

### 6.2 Test Error Cases

- Invalid invoice ID (should show "not found")
- Network errors (should show timeout message)
- Unauthenticated access (should redirect to login)

---

## Step 7: Auto-Refresh (Optional)

Add auto-refresh for pending payments:

```javascript
import { useEffect } from 'react';

// Auto-refresh pending payments every 30 seconds
useEffect(() => {
  const interval = setInterval(() => {
    const pendingDeposits = deposits.filter(d => d.status === 'PENDING');
    pendingDeposits.forEach(deposit => {
      handleCheckStatus(deposit.reference);
    });
  }, 30000); // 30 seconds

  return () => clearInterval(interval);
}, [deposits]);
```

---

## Troubleshooting

### Issue: "IntaSend API keys not configured"
**Solution**: Make sure you've set the Firebase secrets:
```bash
firebase functions:secrets:set INTASEND_SECRET_KEY
firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY
```

### Issue: "Permission denied"
**Solution**: 
1. Verify the user has `role: 'admin'` in Firestore
2. Check that IntaSend API credentials are correct

### Issue: "Invoice not found"
**Solution**: 
1. Verify the invoice ID is correct
2. Check if you're using sandbox vs production keys correctly

### Issue: Function not found
**Solution**: 
1. Deploy the function: `firebase deploy --only functions:getIntaSendPaymentStatus`
2. Check function name matches exactly: `getIntaSendPaymentStatus`

---

## Next Steps

1. ✅ Set up Firebase secrets
2. ✅ Deploy the function
3. ✅ Create service file
4. ✅ Integrate into dashboard
5. ✅ Test with real invoice IDs
6. ✅ Add error handling
7. ✅ Add loading states
8. ✅ (Optional) Add auto-refresh

---

## Support

If you encounter issues:
1. Check Firebase Functions logs: `firebase functions:log`
2. Check browser console for frontend errors
3. Verify IntaSend API credentials are correct
4. Ensure admin role is set correctly in Firestore

