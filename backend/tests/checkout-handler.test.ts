import { describe, expect, it, vi } from "vitest";
import { handleCheckoutRequest, type CheckoutDeps } from "../lib/checkout-handler.js";

const ENV = { STRIPE_PRICE_SOLO: "price_solo_123", STRIPE_PRICE_TEAM: "price_team_456" };

function fakeDeps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_123" }),
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

  it("creates a checkout session for the solo plan with the correct price id", async () => {
    const createCheckoutSession = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_solo" });
    const result = await handleCheckoutRequest("POST", { plan: "solo", email: "a@b.com" }, ENV, fakeDeps({ createCheckoutSession }));
    expect(result.status).toBe(200);
    expect(result.body.url).toBe("https://checkout.stripe.com/c/pay/cs_test_solo");
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: "price_solo_123", email: "a@b.com" })
    );
  });

  it("creates a checkout session for the team plan with the correct price id", async () => {
    const createCheckoutSession = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_team" });
    const result = await handleCheckoutRequest("POST", { plan: "team" }, ENV, fakeDeps({ createCheckoutSession }));
    expect(result.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ priceId: "price_team_456" }));
  });

  it("defaults the redirect URLs to archlens.dev when ARCHLENS_APP_URL is unset", async () => {
    const createCheckoutSession = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/x" });
    await handleCheckoutRequest("POST", { plan: "solo" }, ENV, fakeDeps({ createCheckoutSession }));
    const call = createCheckoutSession.mock.calls[0]![0];
    expect(call.successUrl).toContain("https://archlens.dev/dashboard");
    expect(call.cancelUrl).toContain("https://archlens.dev/pricing");
  });

  it("honors a configured ARCHLENS_APP_URL for redirect URLs", async () => {
    const createCheckoutSession = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/x" });
    await handleCheckoutRequest(
      "POST",
      { plan: "solo" },
      { ...ENV, ARCHLENS_APP_URL: "https://app.archlens.dev" },
      fakeDeps({ createCheckoutSession })
    );
    const call = createCheckoutSession.mock.calls[0]![0];
    expect(call.successUrl).toContain("https://app.archlens.dev/dashboard");
  });
});
