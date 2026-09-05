/**
 * @fileoverview Super-admin custom push + in-app notifications to C2B users.
 */

const admin = require("../admin");
const config = require("../config");
const {logAdminAction} = require("../utils/transactions");
const {
  createNotification,
  NOTIFICATION_TYPES,
} = require("../utils/notifications");

const MAX_USER_IDS = 100;
const MAX_BROADCAST = 300;
const TITLE_MAX = 80;
const MESSAGE_MAX = 500;

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function uniqueUserIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @param {string} audience
 * @returns {Promise<string[]>}
 */
async function resolveC2bUserIds() {
  const col = admin.firestore().collection(config.collections.users);
  const ids = [];
  try {
    const snap = await col.where("channel", "==", "C2B").limit(MAX_BROADCAST).get();
    for (const doc of snap.docs) ids.push(doc.id);
    return ids;
  } catch (err) {
    console.warn("platformNotification: channel query failed, scanning:", err.message);
  }

  const snap = await col.limit(1500).get();
  for (const doc of snap.docs) {
    const ch = String(doc.data().channel || "").toUpperCase();
    const inst = String(doc.data().institution || "");
    if (ch === "C2B" || inst === "Customer App" || inst === "Safari Tap") {
      ids.push(doc.id);
      if (ids.length >= MAX_BROADCAST) break;
    }
  }
  return ids;
}

/**
 * @param {string} actorUid
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function sendCustomNotification(actorUid, body) {
  const payload = body && typeof body === "object" ? body : {};
  const title = String(payload.title || "").trim();
  const message = String(payload.message || "").trim();
  const actionUrl = payload.actionUrl ? String(payload.actionUrl).trim() : null;
  const audience = String(payload.audience || "").trim().toLowerCase();

  if (!title || title.length > TITLE_MAX) {
    const err = new Error(`title is required (max ${TITLE_MAX} characters)`);
    err.statusCode = 400;
    throw err;
  }
  if (!message || message.length > MESSAGE_MAX) {
    const err = new Error(`message is required (max ${MESSAGE_MAX} characters)`);
    err.statusCode = 400;
    throw err;
  }

  let userIds = uniqueUserIds(payload.userIds);
  if (payload.userId) {
    userIds = uniqueUserIds([payload.userId, ...userIds]);
  }

  if (audience === "c2b" || audience === "all") {
    if (userIds.length === 0) {
      userIds = await resolveC2bUserIds();
    }
  }

  if (userIds.length === 0) {
    const err = new Error("Provide userId, userIds, or audience: \"c2b\"");
    err.statusCode = 400;
    throw err;
  }
  if (userIds.length > MAX_USER_IDS && audience !== "c2b" && audience !== "all") {
    const err = new Error(`At most ${MAX_USER_IDS} userIds per request`);
    err.statusCode = 400;
    throw err;
  }

  const results = [];
  let pushSent = 0;
  let inboxWritten = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const created = await createNotification({
        userId,
        type: NOTIFICATION_TYPES.ADMIN_CUSTOM,
        title,
        message,
        actionUrl,
        metadata: {
          source: "platform_admin_custom",
          sentBy: actorUid,
        },
        sendPush: true,
      });
      inboxWritten += 1;
      if (created.sent) pushSent += 1;
      results.push({
        userId,
        notificationId: created.notificationId,
        pushSent: Boolean(created.sent),
      });
    } catch (err) {
      failed += 1;
      results.push({
        userId,
        error: err.message || "Failed",
      });
    }
  }

  await logAdminAction(
      actorUid,
      "system",
      "sendCustomNotification",
      {},
      {
        title,
        audience: audience || "explicit",
        recipientCount: userIds.length,
        pushSent,
        inboxWritten,
        failed,
      },
  );

  return {
    title,
    message,
    audience: audience || "explicit",
    requested: userIds.length,
    inboxWritten,
    pushSent,
    failed,
    results,
  };
}

module.exports = {
  sendCustomNotification,
  MAX_USER_IDS,
  MAX_BROADCAST,
};
