/**
 * @fileoverview Turnkey rail adapter — wallet/key/signing provider for Avalanche Fuji.
 * Ledger, reservations, and Flutter response shapes stay the same as Circle.
 */

const {collection, serverTimestamp} = require("../../../libs/firestore");
const ledgerService = require("../../ledger/ledgerService");
const reservationService = require("../../ledger/reservationService");
const sendIdempotencyService = require("../../circle/sendIdempotencyService");
const turnkeyClient = require("../turnkey/turnkeyClient");
const turnkeyWalletService = require("../turnkey/turnkeyWalletService");
const evmRpcService = require("../evm/evmRpcService");
const {getFujiNetwork, isValidEvmAddress} = require("../evm/fujiNetwork");
const {isValidUsdcAmount, toUsdcUnits} = require("../evm/usdcUnits");
const {
  CryptoRailError,
  invalidAddress,
  invalidAmount,
  unsupportedAsset,
  turnkeySigningFailure,
} = require("../cryptoErrors");

const ASSET = "USDC";
const PROVIDER = "turnkey";

/**
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getBalance(userId) {
  return ledgerService.getAvailableBalance(userId, ASSET);
}

/**
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function createWallet(userId) {
  return turnkeyWalletService.createWallet(userId);
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getWallet(userId) {
  return turnkeyWalletService.getWallet(userId);
}

/**
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<Array<Object>>}
 */
async function listTransactions(userId, limit = 50) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const snap = await collection("cryptoTransactions")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(cap)
      .get();

  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || null,
    };
  });
}

/**
 * @param {string} unsignedHex
 * @param {string} signWith
 * @returns {Promise<string>}
 */
async function signTransaction(unsignedHex, signWith) {
  try {
    const client = turnkeyClient.getApiClient();
    const unsignedTransaction = String(unsignedHex).replace(/^0x/i, "");
    const response = await client.signTransaction({
      signWith,
      unsignedTransaction,
      type: "TRANSACTION_TYPE_ETHEREUM",
    });
    const signed = response.signedTransaction ||
      response.activity?.result?.signTransactionResult?.signedTransaction;
    if (!signed) {
      throw turnkeySigningFailure("no signed transaction returned");
    }
    return signed.startsWith("0x") ? signed : `0x${signed}`;
  } catch (err) {
    if (err instanceof CryptoRailError) throw err;
    throw turnkeySigningFailure(err.message || "signTransaction failed");
  }
}

/**
 * @param {string} signedHex
 * @returns {Promise<string>}
 */
async function broadcastTransaction(signedHex) {
  return evmRpcService.broadcastTransaction(signedHex);
}

/**
 * @param {string} txHash
 * @returns {Promise<Object>}
 */
async function getTransactionStatus(txHash) {
  return evmRpcService.getTransactionStatus(txHash);
}

/**
 * @param {Object} params
 * @returns {Promise<{ unsignedHex: string, gasLimit: bigint, maxFeePerGas: bigint }>}
 */
async function buildUnsignedTransfer(params) {
  const {fromAddress, toAddress, amount, asset} = params;
  const network = getFujiNetwork();
  if (asset && String(asset).toUpperCase() !== ASSET && String(asset).toUpperCase() !== "AVAX") {
    throw unsupportedAsset(asset);
  }

  if (!isValidEvmAddress(toAddress)) {
    throw invalidAddress();
  }

  const sendAsset = String(asset || ASSET).toUpperCase();
  const isNative = sendAsset === "AVAX";
  if (!isNative && !isValidUsdcAmount(amount)) {
    throw invalidAmount();
  }

  const nonce = await evmRpcService.getTransactionCount(fromAddress);
  const fee = await evmRpcService.getFeeData();

  let to = toAddress;
  let data = "0x";
  let value = 0n;
  if (isNative) {
    const {ethers} = require("ethers");
    value = ethers.parseEther(String(amount));
  } else {
    to = network.usdcContract;
    data = evmRpcService.encodeUsdcTransfer(toAddress, toUsdcUnits(amount));
  }

  const gasLimit = await evmRpcService.estimateGas({
    from: fromAddress,
    to,
    data,
    value,
  });
  await evmRpcService.assertSufficientGas(fromAddress, gasLimit, fee.maxFeePerGas);

  const unsignedHex = evmRpcService.serializeUnsignedTransaction({
    chainId: network.chainId,
    nonce,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    maxFeePerGas: fee.maxFeePerGas,
    gasLimit,
    to,
    value,
    data,
  });

  return {unsignedHex, gasLimit, maxFeePerGas: fee.maxFeePerGas};
}

/**
 * Sign and broadcast an AVAX or USDC transfer from a Turnkey-controlled address.
 * @param {Object} params
 * @returns {Promise<string>} transaction hash
 */
async function signAndBroadcast(params) {
  const built = await buildUnsignedTransfer(params);
  const signed = await signTransaction(built.unsignedHex, params.fromAddress);
  return broadcastTransaction(signed);
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function send(params) {
  const {fromWalletId, toAddress, amount, userId, idempotencyKey, asset} = params;
  const numericAmount = Number(amount);
  if (!fromWalletId || !toAddress || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid send parameters");
  }
  if (!idempotencyKey) {
    throw new Error("X-Idempotency-Key is required");
  }
  if (asset && String(asset).toUpperCase() !== ASSET) {
    throw unsupportedAsset(asset);
  }
  if (!isValidEvmAddress(toAddress)) {
    throw invalidAddress();
  }
  if (!isValidUsdcAmount(amount)) {
    throw invalidAmount();
  }

  const wallet = (userId && await turnkeyWalletService.getWallet(userId)) ||
    await turnkeyWalletService.getWalletByProviderId(fromWalletId);
  if (!wallet) throw new Error("Source wallet not found");

  const ownerId = userId || wallet.userId;
  const requestData = {
    fromWalletId,
    toAddress: String(toAddress).toLowerCase(),
    amount: numericAmount,
    userId: ownerId,
  };

  const keyResult = await sendIdempotencyService.acquireSendKey(
      idempotencyKey,
      ownerId,
      requestData,
  );
  if (!keyResult.acquired) {
    return keyResult.cachedResult;
  }

  let reservationId = null;
  let broadcastedTxHash = null;

  try {
    const reservation = await reservationService.reserveFunds(
        ownerId,
        numericAmount,
        idempotencyKey,
    );
    reservationId = reservation.reservationId;

    broadcastedTxHash = await signAndBroadcast({
      fromAddress: wallet.address,
      toAddress,
      amount: numericAmount,
      asset: ASSET,
    });

    await reservationService.attachProviderTransactionId(reservationId, broadcastedTxHash);

    const txRef = await collection("cryptoTransactions").add({
      userId: ownerId,
      circleTransactionId: broadcastedTxHash,
      providerTransactionId: broadcastedTxHash,
      txHash: broadcastedTxHash,
      type: "send",
      amount: numericAmount,
      asset: ASSET,
      status: "pending",
      toAddress,
      fromWalletId,
      provider: PROVIDER,
      network: getFujiNetwork().network,
      chainId: getFujiNetwork().chainId,
      idempotencyKey,
      reservationId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const result = {
      success: true,
      circleTransactionId: broadcastedTxHash,
      txHash: broadcastedTxHash,
      status: "pending",
      firestoreTxId: txRef.id,
      amount: numericAmount,
      reservationId,
    };

    await sendIdempotencyService.storeSendResult(
        idempotencyKey,
        result,
        broadcastedTxHash,
    );

    console.log("Turnkey USDC send initiated (async confirmation)", {
      userId: ownerId,
      txHash: broadcastedTxHash,
      amount: numericAmount,
      reservationId,
    });

    return result;
  } catch (err) {
    if (broadcastedTxHash) {
      const fallback = {
        success: true,
        circleTransactionId: broadcastedTxHash,
        txHash: broadcastedTxHash,
        status: "pending",
        firestoreTxId: null,
        amount: numericAmount,
        reservationId,
      };
      await sendIdempotencyService.storeSendResult(
          idempotencyKey,
          fallback,
          broadcastedTxHash,
      ).catch(() => {});
      throw err;
    }
    if (reservationId) {
      await reservationService.releaseReservation(reservationId).catch(() => {});
    }
    await collection("sendIdempotencyKeys").doc(idempotencyKey).delete().catch(() => {});
    throw err;
  }
}

module.exports = {
  ASSET,
  PROVIDER,
  getBalance,
  createWallet,
  getWallet,
  listTransactions,
  send,
  signTransaction,
  broadcastTransaction,
  getTransactionStatus,
  signAndBroadcast,
  buildUnsignedTransfer,
  getOnChainBalances: evmRpcService.getOnChainBalances,
  isConfigured: turnkeyClient.isTurnkeyConfigured,
};
