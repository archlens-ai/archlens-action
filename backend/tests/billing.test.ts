import { describe, expect, it } from "vitest";
import { buildPriceMap, buildProvisioningRecord, generateApiKey, resolvePlan } from "../lib/billing.js";

describe("generateApiKey", () => {
  it("produces a recognizable, high-entropy key", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^alk_live_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe("resolvePlan / buildPriceMap", () => {
  it("maps a known Razorpay plan ID to its plan", () => {
    const map = buildPriceMap({ RAZORPAY_PLAN_SOLO: "plan_solo", RAZORPAY_PLAN_TEAM: "plan_team" });
    expect(resolvePlan("plan_solo", map)).toBe("solo");
    expect(resolvePlan("plan_team", map)).toBe("team");
  });

  it("returns null for an unrecognized plan ID", () => {
    const map = buildPriceMap({ RAZORPAY_PLAN_SOLO: "plan_solo" });
    expect(resolvePlan("plan_unknown", map)).toBeNull();
  });
});

describe("buildProvisioningRecord", () => {
  it("creates a new org id when none exists yet", () => {
    const record = buildProvisioningRecord({ plan: "solo", razorpaySubscriptionId: "sub_1" });
    expect(record.orgId).toMatch(/^org_/);
    expect(record.plan).toBe("solo");
  });

  it("reuses an existing org id when provided", () => {
    const record = buildProvisioningRecord({
      plan: "team",
      razorpaySubscriptionId: "sub_1",
      existingOrgId: "org_existing",
    });
    expect(record.orgId).toBe("org_existing");
  });
});
