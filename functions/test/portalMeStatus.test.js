/**
 * @fileoverview GET /portal/me merchant status shaping.
 */

const {
  normalizeMerchantStatus,
  normalizeMemberStatus,
  shapePartnerForPortalMe,
  portalMeStatusFields,
} = require("../services/portalMeStatus");

describe("portalMeStatus", () => {
  it("maps pending_review and missing status to inactive", () => {
    expect(normalizeMerchantStatus("pending_review")).toBe("inactive");
    expect(normalizeMerchantStatus(null)).toBe("inactive");
    expect(normalizeMerchantStatus("Active")).toBe("active");
    expect(normalizeMerchantStatus("SUSPENDED")).toBe("suspended");
  });

  it("always sets partner.status for the header pill", () => {
    expect(shapePartnerForPortalMe(null, null)).toEqual({
      id: null,
      status: "inactive",
      statusRaw: null,
    });
    expect(shapePartnerForPortalMe({id: "p1", name: "Lodge"}, "p1").status)
        .toBe("inactive");
    expect(shapePartnerForPortalMe({id: "p1", status: "active"}, "p1")).toMatchObject({
      id: "p1",
      status: "active",
      statusRaw: "active",
    });
  });

  it("exposes merchantActive separately from member status", () => {
    const fields = portalMeStatusFields(
        {id: "p1", status: "pending_review"},
        "p1",
        "active",
    );
    expect(fields.status).toBe("active");
    expect(fields.partner.status).toBe("inactive");
    expect(fields.merchantStatus).toBe("inactive");
    expect(fields.merchantActive).toBe(false);
  });

  it("treats blank member status as null", () => {
    expect(normalizeMemberStatus("")).toBeNull();
    expect(normalizeMemberStatus("Active")).toBe("active");
  });
});
