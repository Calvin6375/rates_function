/**
 * @fileoverview B2B portal HTTP API — platform super-admin (Firebase `admin` claim or master
 * account per `isSuperAdminUid`) manages partners and org admins; partner org admins use Bearer ID token.
 * Base path: /b2bPortal (function name).
 */

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const config = require("../config");
const { isSuperAdminUid } = require("../utils/adminClaims");
const { verifyFirebaseAuth } = require("../libs/auth");
const partnerService = require("../services/partnerService");
const b2bMemberService = require("../services/b2bMemberService");
const b2bOnboardingService = require("../services/b2bOnboardingService");
const platformConsumerService = require("../services/platformConsumerService");
const dashboardUserDeletionService = require("../services/dashboardUserDeletionService");

const { ALL_PARTNER_ROLES } = b2bMemberService;

/** Must match `exports.<name>` in `functions/index.js` (URL path segment before routes). */
const B2B_PORTAL_FUNCTION_SEGMENT = "b2bPortal";

const app = express();
app.use(express.json());

/**
 * Gen2 HTTP URLs are `.../b2bPortal/platform/...` but routes are `/platform/...`.
 * Strip the function segment when present so DELETE and all paths match.
 */
app.use((req, res, next) => {
  const raw = req.url || "/";
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const query = qIdx === -1 ? "" : raw.slice(qIdx);
  const prefix = `/${B2B_PORTAL_FUNCTION_SEGMENT}`;
  if (pathPart === prefix || pathPart.startsWith(`${prefix}/`)) {
    const rest =
        pathPart === prefix ? "/" : pathPart.slice(prefix.length) || "/";
    req.url = rest + query;
  }
  next();
});

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

/**
 * Platform admin: Firebase custom claim `admin: true`, or master account (see `isSuperAdminUid`).
 */
async function requirePlatformAdmin(req, res, next) {
  try {
    if (req.decodedToken?.admin === true) {
      next();
      return;
    }
    if (await isSuperAdminUid(req.userId)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: "Platform admin access required" });
  } catch (err) {
    console.error("requirePlatformAdmin:", err.message);
    res.status(500).json({ success: false, error: "Authorization check failed" });
  }
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

// --- Platform (super admin = claim admin: true OR master email in adminClaims.js) ---

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

/**
 * Platform admin: add a member to a partner org (same rules as POST /portal/members).
 * Body: { email, password?, role, displayName? } — password required only when creating a new Auth user.
 */
app.post("/platform/partners/:partnerId/members", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const partnerId = req.params.partnerId;
    const partner = await partnerService.getPartner(partnerId);
    if (!partner) {
      res.status(404).json({ success: false, error: "Partner not found" });
      return;
    }
    const { email, password, role, displayName } = req.body || {};
    const out = await b2bMemberService.addMember(
        partnerId,
        { email, password, role, displayName },
        req.userId,
    );
    res.status(201).json({
      success: true,
      data: out,
      message: "User should sign in and refresh token to receive partner claims.",
    });
  } catch (err) {
    console.error("b2bPortal POST /platform/partners/:id/members:", err.message);
    const status =
      err.message && err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
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

/**
 * DELETE /platform/users/:userId
 * Platform master admin only (Firebase `admin` claim or super-admin email):
 * deletes Firebase Auth user (if present), partner claims, and Firestore/RTDB data.
 */
app.delete("/platform/users/:userId", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    const actorIsSuperAdmin = await isSuperAdminUid(req.userId);
    const data = await dashboardUserDeletionService.deleteUserAsPlatformAdmin(
        req.userId,
        req.params.userId,
        { actorIsSuperAdmin },
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    const msg = err.message || "Delete failed";
    console.error("b2bPortal DELETE /platform/users/:userId:", msg);
    let status = 400;
    if (msg.includes("not found") || msg.includes("Member not found")) {
      status = 404;
    } else if (
      msg.includes("Cannot delete") ||
      msg.includes("Only the platform owner") ||
      msg.includes("administrator account")
    ) {
      status = 403;
    }
    res.status(status).json({ success: false, error: msg });
  }
});

/**
 * Session/bootstrap for platform super-admins (claim admin: true or master account).
 * Unlike GET /portal/me, does not require B2B partnerId / partnerRole claims.
 */
app.get("/platform/me", loadFirebaseUser, requirePlatformAdmin, async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        userId: req.userId,
        admin: true,
        email: (req.decodedToken && req.decodedToken.email) || null,
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /platform/me:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Idempotent: create or patch Firestore `users/{uid}` using Admin SDK (matches userBootstrap shape).
 * Call from the dashboard immediately after Firebase sign-in with the ID token, before loading profile
 * by email — fixes missing docs for legacy B2B users and email case mismatches on queries.
 */
app.post("/portal/ensure-dashboard-profile", loadFirebaseUser, async (req, res) => {
  try {
    let provisioning = {};
    try {
      const parsed = b2bMemberService.parsePortalProvisioningFields(req.body);
      if (parsed) {
        provisioning = parsed;
      }
    } catch (parseErr) {
      res.status(400).json({ success: false, error: parseErr.message });
      return;
    }
    await b2bMemberService.ensureUserDashboardProfileFromAuthUid(
        req.userId,
        provisioning,
    );
    res.status(200).json({
      success: true,
      message: "Dashboard profile ensured",
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/ensure-dashboard-profile:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Self-serve onboarding (Firebase user; no partner claims required) ---

app.get("/portal/onboarding", loadFirebaseUser, async (req, res) => {
  try {
    const dt = req.decodedToken || {};
    const onboarding = await b2bOnboardingService.getOnboarding(req.userId);
    res.status(200).json({
      success: true,
      data: {
        onboarding,
        emailVerified: dt.email_verified === true,
        sandbox: {
          publicApiKey: config.b2bSandbox.apiKey,
          virtualPartnerId: config.b2bSandbox.partnerId,
          hint:
            "Use the partnerSandbox HTTP function base URL with header X-API-KEY: publicApiKey " +
            "(see B2B_SANDBOX.md). Machine Partner API is blocked until platform sets partner status active.",
        },
      },
    });
  } catch (err) {
    console.error("b2bPortal GET /portal/onboarding:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch("/portal/onboarding", loadFirebaseUser, async (req, res) => {
  try {
    const updated = await b2bOnboardingService.patchOnboarding(req.userId, req.body || {});
    res.status(200).json({ success: true, data: { onboarding: updated } });
  } catch (err) {
    console.error("b2bPortal PATCH /portal/onboarding:", err.message);
    const status = err.message.includes("Provide at least one") ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

/**
 * Create partners/{partnerId} (status pending_review), assign caller as org_admin, persist onboarding.
 * Returns apiKey once when newly created; idempotent retries omit apiKey (alreadyRegistered: true).
 */
app.post("/portal/onboarding/register-partner", loadFirebaseUser, async (req, res) => {
  try {
    const { name, settlementCurrency, webhookUrl } = req.body || {};
    const out = await b2bOnboardingService.registerSelfServePartner(req.userId, {
      name,
      settlementCurrency,
      webhookUrl,
    });
    const payload = {
      partnerId: out.partnerId,
      orgAdminUid: out.orgAdminUid,
      alreadyRegistered: out.alreadyRegistered === true,
    };
    if (out.apiKey) {
      payload.apiKey = out.apiKey;
    }
    res.status(out.alreadyRegistered ? 200 : 201).json({
      success: true,
      data: payload,
      message: "Refresh your ID token (sign out/in) so partner claims apply to this session.",
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/onboarding/register-partner:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/** Require terms + AML attestation; sets onboardingStatus submitted (live API still requires platform activation). */
app.post("/portal/onboarding/complete", loadFirebaseUser, async (req, res) => {
  try {
    const { termsAccepted, amlAccepted } = req.body || {};
    const out = await b2bOnboardingService.completeOnboarding(req.userId, { termsAccepted, amlAccepted });
    res.status(200).json({
      success: true,
      data: out,
      message: "Onboarding submitted. Live Partner API remains blocked until a platform admin sets status active.",
    });
  } catch (err) {
    console.error("b2bPortal POST /portal/onboarding/complete:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Partner portal (org admin) ---

/**
 * GET /portal/me — partner session, or platform admin without B2B claims.
 * Master admin dashboards often call this path; allow admin + no partnerId (403 was wrong).
 */
app.get("/portal/me", loadFirebaseUser, async (req, res) => {
  try {
    const dt = req.decodedToken || {};
    const isPlatformAdmin =
      dt.admin === true || (await isSuperAdminUid(req.userId));
    const pid = dt.partnerId;
    const role = dt.partnerRole;

    const hasPartner =
      typeof pid === "string" &&
      pid.length > 0 &&
      typeof role === "string" &&
      ALL_PARTNER_ROLES.includes(role);

    if (isPlatformAdmin && !hasPartner) {
      res.status(200).json({
        success: true,
        data: {
          userId: req.userId,
          admin: true,
          partnerId: null,
          partnerRole: null,
          partner: null,
        },
      });
      return;
    }

    if (!hasPartner) {
      res.status(403).json({
        success: false,
        error: "Not a B2B partner user (missing partnerId claim)",
      });
      return;
    }

    const partner = await partnerService.getPartner(pid);
    res.status(200).json({
      success: true,
      data: {
        userId: req.userId,
        admin: isPlatformAdmin,
        partnerId: pid,
        partnerRole: role,
        partner: partner || { id: pid },
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

/**
 * DELETE /portal/users/:userId
 * Partner org admin: removes member from org, deletes Firebase Auth user (if any),
 * and Firestore/RTDB user data. Cannot remove org_admin (use platform flow).
 */
app.delete("/portal/users/:userId", loadFirebaseUser, attachPartnerContext, requirePartnerOrgAdmin, async (req, res) => {
  try {
    const data = await dashboardUserDeletionService.deleteUserAsPartnerOrgAdmin(
        req.userId,
        req.partnerId,
        req.params.userId,
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    const msg = err.message || "Delete failed";
    console.error("b2bPortal DELETE /portal/users/:userId:", msg);
    let status = 400;
    if (msg.includes("not found") || msg.includes("Member not found")) {
      status = 404;
    } else if (
      msg.includes("Cannot delete") ||
      msg.includes("platform owner") ||
      msg.includes("org admin")
    ) {
      status = 403;
    }
    res.status(status).json({ success: false, error: msg });
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
