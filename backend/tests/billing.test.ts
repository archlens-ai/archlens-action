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
  it("maps a known Stripe price ID to its plan", () => {
    const map = buildPriceMap({ STRIPE_PRICE_SOLO: "price_solo", STRIPE_PRICE_TEAM: "price_team" });
    expect(resolvePlan("price_solo", map)).toBe("solo");
    expect(resolvePlan("price_team", map)).toBe("team");
  });

  it("returns null for an unrecognized price ID", () => {
    const map = buildPriceMap({ STRIPE_PRICE_SOLO: "price_solo" });
    expect(resolvePlan("price_unknown", map)).toBeNull();
  });
});

describe("buildProvisioningRecord", () => {
  it("creates a new org id when none exists yet", () => {
    const record = buildProvisioningRecord({ plan: "solo", stripeCustomerId: "cus_1" });
    expect(record.orgId).toMatch(/^org_/);
    expect(record.plan).toBe("solo");
  });

  it("reuses an existing org id when provided", () => {
    const record = buildProvisioningRecord({
      plan: "team",
      stripeCustomerId: "cus_1",
      existingOrgId: "org_existing",
    });
    expect(record.orgId).toBe("org_existing");
  });
});
