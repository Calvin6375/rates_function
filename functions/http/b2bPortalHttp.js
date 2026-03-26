/**
 * @fileoverview B2B portal HTTP API — platform super-admin (Firebase admin claim) manages partners
 * and org admins; each partner org admin manages team members and roles via Bearer ID token.
 * Base path: /b2bPortal (function name).
 */

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const { verifyFirebaseAuth } = require("../libs/auth");
const partnerService = require("../services/partnerService");
const b2bMemberService = require("../services/b2bMemberService");
const platformConsumerService = require("../services/platformConsumerService");

const { ALL_PARTNER_ROLES } = b2bMemberService;

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function loadFirebaseUser(req, res, next) {
  const result = await verifyFirebaseAuth(req);
  if (!result.success) {
    res.status(401).json({ success: false, error: result.error || "Unauthorized" });
    return;
  }
  req.userId = result.userId;
  req.decodedToken = result.decodedToken;
  next();
}

function requirePlatformAdmin(req, res, next) {
  if (req.decodedToken?.admin !== true) {
    res.status(403).json({ success: false, error: "Platform admin access required" });
    return;
  }
  next();
}

function attachPartnerContext(req, res, next) {
  const pid = req.decodedToken?.partnerId;
  const role = req.decodedToken?.partnerRole;
  if (!pid || typeof pid !== "string") {
    res.status(403).json({ success: false, error: "Not a B2B partner user (missing partnerId claim)" });
    return;
  }
  if (!role || !ALL_PARTNER_ROLES.includes(role)) {
    res.status(403).json({ success: false, error: "Invalid or missing partnerRole claim" });
    return;
  }
  req.partnerId = pid;
  req.partnerRole = role;
  next();
}

function requirePartnerOrgAdmin(req, res, next) {
  if (req.partnerRole !== "org_admin") {
    res.status(403).json({ success: false, error: "Partner org admin access required" });
    return;
  }
  next();
}

// --- Platform (super admin = Firebase custom claim admin: true) ---

app.get("/platform/partners", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 100);
    const { partners, lastDoc } = await partnerService.listPartners(limit, null);
    res.status(200).json({
      success: true,
      data: {
        partners,
        nextPageCursor: lastDoc ? lastDoc.id : null,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/partners:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/platform/partners", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const { name, settlementCurrency, webhookUrl } = req.body || {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ success: false, error: "name is required" });
      return;
    }
    const created = await partnerService.createPartner({
      name: name.trim(),
      settlementCurrency: settlementCurrency || "KES",
      webhookUrl: webhookUrl || null,
    });
    res.status(201).json({
      success: true,
      data: {
        partnerId: created.partnerId,
        apiKey: created.apiKey,
        partner: { id: created.partnerId, name: created.partner.name, orgAdminUid: null },
      },
      message: "Store apiKey securely; it is only shown once. Assign org admin with PUT .../org-admin",
    });
  } catch (err) {
    console.error("b2bPortal POST /platform/partners:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/platform/partners/:partnerId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const partner = await partnerService.getPartner(req.params.partnerId);
    if (!partner) {
      res.status(404).json({ success: false, error: "Partner not found" });
      return;
    }
    res.status(200).json({ success: true, data: partner });
  } catch (err) {
    console.error("b2bPortal GET /platform/partners/:id:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch("/platform/partners/:partnerId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const updated = await partnerService.updatePartner(req.params.partnerId, req.body || {});
    const { apiKey, ...safe } = updated;
    res.status(200).json({
      success: true,
      data: { id: safe.id || req.params.partnerId, ...safe, apiKeyMasked: apiKey ? `${String(apiKey).slice(0, 8)}...` : null },
    });
  } catch (err) {
    console.error("b2bPortal PATCH /platform/partners/:id:", err.message);
    const status = err.message.includes("not found") ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.put("/platform/partners/:partnerId/org-admin", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const { uid } = req.body || {};
    if (!uid || typeof uid !== "string") {
      res.status(400).json({ success: false, error: "uid (Firebase Auth user id) is required" });
      return;
    }
    const out = await b2bMemberService.setPartnerOrgAdmin(req.params.partnerId, uid.trim(), req.userId);
    res.status(200).json({
      success: true,
      data: out,
      message: "User must refresh their ID token (sign out/in) for partner claims to apply.",
    });
  } catch (err) {
    console.error("b2bPortal PUT org-admin:", err.message);
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.get("/platform/partners/:partnerId/members", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const members = await b2bMemberService.listMembers(req.params.partnerId);
    res.status(200).json({ success: true, data: { members } });
  } catch (err) {
    console.error("b2bPortal GET platform members:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Unified dashboard: counts for consumer app users vs B2B partners */
app.get("/platform/overview", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const counts = await platformConsumerService.getPlatformOverviewCounts();
    res.status(200).json({ success: true, data: counts });
  } catch (err) {
    console.error("b2bPortal GET /platform/overview:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Paginated list of customer-app users (Firestore users) — platform admin only */
app.get("/platform/consumer-users", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    const startAfter = req.query.startAfter ? String(req.query.startAfter) : null;
    const { users, nextCursor } = await platformConsumerService.listConsumerUsers(limit, startAfter);
    res.status(200).json({
      success: true,
      data: { users, nextCursor },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/consumer-users:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Single customer-app user profile (read-only summary for super-admin dashboard) */
app.get("/platform/consumer-users/:userId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const user = await platformConsumerService.getConsumerUser(req.params.userId);
    if (!user) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    console.error("b2bPortal GET /platform/consumer-users/:userId:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Partner portal (org admin) ---

app.get("/portal/me", loadFirebaseUser, attachPartnerContext, async (req, res) => {
  try {
    const partner = await partnerService.getPartner(req.partnerId);
    res.status(200).json({
      success: true,
      data: {
        userId: req.userId,
        partnerId: req.partnerId,
        partnerRole: req.partnerRole,
        partner: partner || { id: req.partnerId },
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/me:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/portal/members", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const members = await b2bMemberService.listMembers(req.partnerId);
    res.status(200).json({ success: true, data: { members } });
  } catch (err) {
    console.error("b2bPortal GET /portal/members:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/portal/members", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const { email, password, role, displayName } = req.body || {};
    const out = await b2bMemberService.addMember(
      req.partnerId,
      { email, password, role, displayName },
      req.userId,
    );
    res.status(201).json({
      success: true,
      data: out,
      message: "User should sign in and refresh token to receive partner claims.",
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/members:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch("/portal/members/:userId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!role) {
      res.status(400).json({ success: false, error: "role is required" });
      return;
    }
    if (req.params.userId === req.userId) {
      res.status(400).json({ success: false, error: "Cannot change your own role here" });
      return;
    }
    await b2bMemberService.updateMemberRole(req.partnerId, req.params.userId, role);
    res.status(200).json({
      success: true,
      message: "Member updated; user must refresh ID token.",
    });
  } catch (err) {
    console.error("b2bPortal PATCH /portal/members:", err.message);
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.delete("/portal/members/:userId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    if (req.params.userId === req.userId) {
      res.status(400).json({ success: false, error: "Cannot remove yourself; ask platform admin to reassign org admin" });
      return;
    }
    await b2bMemberService.removeMember(req.partnerId, req.params.userId);
    res.status(200).json({ success: true, message: "Member removed from partner" });
  } catch (err) {
    console.error("b2bPortal DELETE /portal/members:", err.message);
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

exports.b2bPortal = onRequest(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
  },
  app,
);
