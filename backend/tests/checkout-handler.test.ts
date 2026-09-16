import { describe, expect, it, vi } from "vitest";
import { handleCheckoutRequest, type CheckoutDeps } from "../lib/checkout-handler.js";

const ENV = { RAZORPAY_PLAN_SOLO: "plan_solo_123", RAZORPAY_PLAN_TEAM: "plan_team_456" };

function fakeDeps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    createSubscription: vi.fn().mockResolvedValue({ url: "https://rzp.io/i/abc123" }),
    ...overrides,
  };
}

describe("handleCheckoutRequest", () => {
  it("rejects non-POST methods", async () => {
    const result = await handleCheckoutRequest("GET", {}, ENV, fakeDeps());
    expect(result.status).toBe(405);
  });

  it("rejects a missing/unknown plan", async () => {
    const result = await handleCheckoutRequest("POST", { plan: "enterprise" }, ENV, fakeDeps());
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("bad_request");
  });

  it("rejects when plan is omitted entirely", async () => {
    const result = await handleCheckoutRequest("POST", {}, ENV, fakeDeps());
    expect(result.status).toBe(400);
  });

  it("creates a subscription for the solo plan with the correct plan id", async () => {
    const createSubscription = vi.fn().mockResolvedValue({ url: "https://rzp.io/i/solo123" });
    const result = await handleCheckoutRequest("POST", { plan: "solo", email: "a@b.com" }, ENV, fakeDeps({ createSubscription }));
    expect(result.status).toBe(200);
    expect(result.body.url).toBe("https://rzp.io/i/solo123");
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan_solo_123", email: "a@b.com" })
    );
  });

  it("creates a subscription for the team plan with the correct plan id", async () => {
    const createSubscription = vi.fn().mockResolvedValue({ url: "https://rzp.io/i/team456" });
    const result = await handleCheckoutRequest("POST", { plan: "team" }, ENV, fakeDeps({ createSubscription }));
    expect(result.status).toBe(200);
    expect(createSubscription).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan_team_456" }));
  });

  it("defaults the redirect URLs to archlens.dev when ARCHLENS_APP_URL is unset", async () => {
    const createSubscription = vi.fn().mockResolvedValue({ url: "https://rzp.io/i/x" });
    await handleCheckoutRequest("POST", { plan: "solo" }, ENV, fakeDeps({ createSubscription }));
    const call = createSubscription.mock.calls[0]![0];
    expect(call.successUrl).toContain("https://archlens.dev/dashboard");
    expect(call.cancelUrl).toContain("https://archlens.dev/pricing");
  });

  it("honors a configured ARCHLENS_APP_URL for redirect URLs", async () => {
    const createSubscription = vi.fn().mockResolvedValue({ url: "https://rzp.io/i/x" });
    await handleCheckoutRequest(
      "POST",
      { plan: "solo" },
      { ...ENV, ARCHLENS_APP_URL: "https://app.archlens.dev" },
      fakeDeps({ createSubscription })
    );
    const call = createSubscription.mock.calls[0]![0];
    expect(call.successUrl).toContain("https://app.archlens.dev/dashboard");
  });
});
