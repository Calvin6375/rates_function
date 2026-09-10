/**
 * @fileoverview Human-readable labels and direction for C2B transaction feed / recon.
 */

/** Types that represent money leaving the user's wallet */
const DEBIT_TYPES = new Set([
  "debit",
  "withdrawal",
  "send",
  "merchant_payment",
  "merchant_settlement",
  "direct_payout",
  "crypto_offramp",
  "settlement",
]);

/** Types that represent money entering the user's wallet */
const CREDIT_TYPES = new Set([
  "credit",
  "topup",
  "funding",
  "direct_topup",
  "receive",
  "crypto_onramp",
  "b2b_funding",
]);

/**
 * @param {string|null|undefined} provider
 * @returns {string|null}
 */
function providerDisplayName(provider) {
  if (!provider) {
    return null;
  }
  const key = String(provider).toLowerCase();
  const map = {
    paystack: "Paystack",
    intasend: "IntaSend",
    transak: "Transak",
    transfi: "TransFi",
    circle: "Circle",
    stripe: "Stripe",
    customer_direct_topup: "Direct deposit",
  };
  return map[key] || String(provider);
}

/**
 * @param {Object} tx
 * @returns {"credit"|"debit"}
 */
function resolveTransactionDirection(tx) {
  const type = String(tx.type || "").toLowerCase();
  const meta = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
  const metaType = String(meta.type || "").toLowerCase();

  if (DEBIT_TYPES.has(type) || DEBIT_TYPES.has(metaType)) {
    return "debit";
  }
  if (CREDIT_TYPES.has(type) || CREDIT_TYPES.has(metaType)) {
    return "credit";
  }
  if (meta.source === "safari_card_payout") {
    return "debit";
  }

  const prev = Number(tx.previousBalance);
  const next = Number(tx.newBalance);
  if (Number.isFinite(prev) && Number.isFinite(next) && prev !== next) {
    return next < prev ? "debit" : "credit";
  }

  return "credit";
}

/**
 * Stable machine-readable category for reconciliation exports.
 * @param {Object} tx
 * @returns {string}
 */
function resolveReconType(tx) {
  const type = String(tx.type || "").toLowerCase();
  const meta = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
  const provider = String(
      meta.provider || meta.source || tx.provider || "",
  ).toLowerCase();

  if (type === "merchant_payment") {
    return "merchant_payment";
  }
  if (type === "direct_topup") {
    return "direct_topup";
  }
  if (type === "direct_payout") {
    return "direct_payout";
  }
  if (type === "funding") {
    return provider ? `funding_${provider}` : "funding";
  }
  if (type === "topup") {
    return provider ? `topup_${provider}` : "topup_intasend";
  }
  if (meta.source === "truepay_merchant_profile") {
    return "merchant_payment";
  }
  if (meta.source === "safaritap_wallet_transfer") {
    if (type === "funding" || type === "credit") {
      return "p2p_receive";
    }
    return "p2p_send";
  }
  if (type === "withdrawal" || meta.source === "safari_card_payout") {
    return "safari_card_payout";
  }
  if (type === "debit" && String(meta.type || "").toLowerCase() === "send") {
    return "p2p_send";
  }
  if (type === "credit" && String(meta.type || "").toLowerCase() === "receive") {
    return "p2p_receive";
  }
  if (type === "credit" && meta.source === "admin_api") {
    return "admin_credit";
  }
  if (type === "debit" && meta.source === "admin_api") {
    return "admin_debit";
  }

  return type || "unknown";
}

/**
 * @param {Object} tx
 * @returns {string}
 */
function resolveTransactionDisplayName(tx) {
  const type = String(tx.type || "").toLowerCase();
  const meta = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
  const metaType = String(meta.type || "").toLowerCase();
  const provider = providerDisplayName(
      meta.provider || meta.source || tx.provider || null,
  );

  switch (type) {
    case "merchant_payment": {
      if (meta.merchantName) {
        return `Pay ${meta.merchantName}`;
      }
      if (meta.merchantId) {
        return `Merchant payment (${meta.merchantId})`;
      }
      return "Merchant payment";
    }
    case "funding":
      if (meta.source === "safaritap_wallet_transfer") {
        const from = meta.senderName || meta.counterpartName || null;
        return from ? `Received from ${from}` : "SafariTap transfer received";
      }
      return provider ? `Wallet top-up (${provider})` : "Wallet top-up";
    case "topup":
      return provider ? `Wallet top-up (${provider})` : "Wallet top-up (IntaSend)";
    case "direct_topup":
      return "Direct top-up";
    case "direct_payout":
      return "Withdrawal request";
    case "withdrawal":
      if (meta.source === "truepay_merchant_profile") {
        const to = meta.merchantName || meta.recipientName || null;
        return to ? `Pay ${to}` : "TruePay merchant";
      }
      if (meta.source === "safaritap_wallet_transfer") {
        const to = meta.merchantName ||
          meta.recipientName ||
          meta.recipient?.name ||
          null;
        return to ? `Sent to ${to}` : "SafariTap transfer sent";
      }
      if (meta.source === "safari_card_payout" || meta.payoutType) {
        if (meta.merchantName) {
          return meta.merchantName;
        }
        const recipient = meta.recipient && typeof meta.recipient === "object" ?
          meta.recipient :
          null;
        if (recipient?.name) {
          return recipient.name;
        }
        if (recipient?.account_type === "TillNumber" && recipient.account) {
          return `Till ${recipient.account}`;
        }
        if (String(meta.payoutType || "").toLowerCase() === "bank") {
          return "Safari Card bank payout";
        }
        return "Safari Card M-Pesa payout";
      }
      return "Withdrawal";
    case "debit":
      if (metaType === "send") {
        return "Send money";
      }
      if (meta.source === "admin_api") {
        return "Admin debit";
      }
      return "Payment sent";
    case "credit":
      if (metaType === "receive") {
        return "Money received";
      }
      if (meta.source === "admin_api") {
        return "Admin credit";
      }
      return provider ? `Wallet top-up (${provider})` : "Wallet top-up";
    case "send":
      return "Send money";
    case "receive":
      return "Money received";
    case "crypto_onramp":
      return "USDC deposit";
    case "crypto_offramp":
      return "USDC withdrawal";
    case "swap":
      return "Currency swap";
    default:
      break;
  }

  const direction = resolveTransactionDirection(tx);
  if (direction === "debit") {
    return "Payment sent";
  }
  return provider ? `Wallet top-up (${provider})` : "Wallet top-up";
}

/**
 * Add display fields for Flutter UI and reconciliation.
 * @param {Object} tx
 * @returns {Object}
 */
function enrichTransactionForFeed(tx) {
  if (!tx || typeof tx !== "object") {
    return tx;
  }

  const direction = resolveTransactionDirection(tx);
  const amount = Math.abs(Number(tx.amount) || 0);
  const displayName = resolveTransactionDisplayName(tx);
  const reconType = resolveReconType(tx);
  const signedAmount = direction === "debit" ? -amount : amount;

  return {
    ...tx,
    displayName,
    title: displayName,
    label: displayName,
    direction,
    reconType,
    signedAmount,
  };
}

module.exports = {
  enrichTransactionForFeed,
  resolveTransactionDirection,
  resolveTransactionDisplayName,
  resolveReconType,
};
