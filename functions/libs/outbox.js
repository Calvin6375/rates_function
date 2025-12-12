/**
 * @fileoverview Outbox pattern implementation for reliable async processing
 * Ensures that Firestore updates and async operations are processed reliably
 * @typedef {Object} OutboxMessage
 * @property {string} eventType - Type of event (e.g., "payment.completed", "balance.updated")
 * @property {Object} payload - Event payload data
 * @property {string} status - Message status (pending, processing, completed, failed)
 * @property {number} retryCount - Number of retry attempts
 */

const admin = require("../admin");

const firestore = admin.firestore();
const OUTBOX_COLLECTION = "outbox";
const MAX_RETRIES = 3;

/**
 * Create an outbox message for async processing
 * @param {string} eventType - Type of event
 * @param {Object} payload - Event payload
 * @param {Object} options - Additional options
 * @param {string} options.priority - Message priority (high, normal, low)
 * @param {number} options.delaySeconds - Delay before processing (seconds)
 * @returns {Promise<string>} Outbox message ID
 */
async function createOutboxMessage(eventType, payload, options = {}) {
  try {
    const messageId = `outbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const messageRef = firestore.collection(OUTBOX_COLLECTION).doc(messageId);
    
    const scheduledAt = options.delaySeconds
      ? admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + (options.delaySeconds * 1000)),
      )
      : admin.firestore.FieldValue.serverTimestamp();
    
    await messageRef.set({
      eventType,
      payload,
      status: "pending",
      priority: options.priority || "normal",
      retryCount: 0,
      scheduledAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    console.log(`✅ Created outbox message: ${messageId}`, {
      eventType,
      priority: options.priority || "normal",
    });
    
    return messageId;
  } catch (error) {
    console.error("❌ Error creating outbox message:", {
      eventType,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Mark outbox message as processing
 * @param {string} messageId - Outbox message ID
 * @returns {Promise<void>}
 */
async function markMessageProcessing(messageId) {
  try {
    const messageRef = firestore.collection(OUTBOX_COLLECTION).doc(messageId);
    await messageRef.update({
      status: "processing",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("❌ Error marking message as processing:", {
      messageId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Mark outbox message as completed
 * @param {string} messageId - Outbox message ID
 * @param {Object} result - Processing result (optional)
 * @returns {Promise<void>}
 */
async function markMessageCompleted(messageId, result = null) {
  try {
    const messageRef = firestore.collection(OUTBOX_COLLECTION).doc(messageId);
    await messageRef.update({
      status: "completed",
      result,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("❌ Error marking message as completed:", {
      messageId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Mark outbox message as failed and schedule retry if applicable
 * @param {string} messageId - Outbox message ID
 * @param {Error} error - Error that occurred
 * @returns {Promise<void>}
 */
async function markMessageFailed(messageId, error) {
  try {
    const messageRef = firestore.collection(OUTBOX_COLLECTION).doc(messageId);
    const messageDoc = await messageRef.get();
    
    if (!messageDoc.exists) {
      console.warn(`⚠️ Outbox message not found: ${messageId}`);
      return;
    }
    
    const messageData = messageDoc.data();
    const retryCount = (messageData.retryCount || 0) + 1;
    
    if (retryCount >= MAX_RETRIES) {
      // Max retries reached, mark as permanently failed
      await messageRef.update({
        status: "failed",
        error: error.message,
        retryCount,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      console.error(`❌ Outbox message permanently failed: ${messageId}`, {
        retryCount,
        error: error.message,
      });
    } else {
      // Schedule retry with exponential backoff
      const retryDelaySeconds = Math.pow(2, retryCount) * 60; // 2, 4, 8 minutes
      const scheduledAt = admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + (retryDelaySeconds * 1000)),
      );
      
      await messageRef.update({
        status: "pending",
        error: error.message,
        retryCount,
        scheduledAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      console.log(`🔄 Scheduled retry for outbox message: ${messageId}`, {
        retryCount,
        retryDelaySeconds,
      });
    }
  } catch (updateError) {
    console.error("❌ Error marking message as failed:", {
      messageId,
      error: updateError.message,
    });
    throw updateError;
  }
}

/**
 * Get pending outbox messages ready for processing
 * @param {number} limit - Maximum number of messages to retrieve
 * @param {string} priority - Optional priority filter
 * @returns {Promise<Array<OutboxMessage>>} Array of pending messages
 */
async function getPendingMessages(limit = 10, priority = null) {
  try {
    let query = firestore.collection(OUTBOX_COLLECTION)
        .where("status", "==", "pending")
        .orderBy("scheduledAt", "asc")
        .orderBy("priority", "desc")
        .limit(limit);
    
    if (priority) {
      query = query.where("priority", "==", priority);
    }
    
    const snapshot = await query.get();
    
    const messages = [];
    const now = Date.now();
    
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      const scheduledAt = data.scheduledAt?.toMillis?.() || data.scheduledAt;
      
      // Only return messages that are ready to process
      if (!scheduledAt || scheduledAt <= now) {
        messages.push({
          id: doc.id,
          ...data,
        });
      }
    });
    
    return messages;
  } catch (error) {
    console.error("❌ Error getting pending outbox messages:", {
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  createOutboxMessage,
  markMessageProcessing,
  markMessageCompleted,
  markMessageFailed,
  getPendingMessages,
};

