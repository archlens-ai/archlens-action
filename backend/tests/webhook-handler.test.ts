import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { buildPriceMap } from "../lib/billing.js";
import { handleStripeWebhookRequest, type WebhookDeps } from "../lib/webhook-handler.js";

// A real Stripe SDK instance (no network access needed for what we use it
// for: signature generation/verification is pure local HMAC crypto). Using
// the SDK's own generateTestHeaderString means these tests exercise the
// EXACT signature-verification code path production uses — not a stand-in.
const stripe = new Stripe("sk_test_dummy_key_unused_for_signing");
const WEBHOOK_SECRET = "whsec_test_secret_abc123";
const PRICE_MAP = buildPriceMap({ STRIPE_PRICE_SOLO: "price_solo_123", STRIPE_PRICE_TEAM: "price_team_456" });

function signedPayload(eventOverrides: Record<string, unknown>): { rawBody: Buffer; signature: string } {
  const payload = JSON.stringify({
    id: "evt_test_1",
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    ...eventOverrides,
  });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { rawBody: Buffer.from(payload), signature };
}

function fakeDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    verifyEvent: (rawBody, signature) => stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET),
    getCheckoutSessionPriceId: vi.fn().mockResolvedValue(undefined),
    upsertApiKeyForCheckout: vi.fn().mockResolvedValue(undefined),
    setApiKeysActiveByCustomer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("handleStripeWebhookRequest — signature verification", () => {
  it("rejects a payload with an invalid signature", async () => {
    const { rawBody } = signedPayload({ type: "checkout.session.completed", data: { object: {} } });
    const result = await handleStripeWebhookRequest(rawBody, "t=123,v1=deadbeef", PRICE_MAP, fakeDeps());
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_signature");
  });

  it("rejects when the signature header is missing entirely", async () => {
    const { rawBody } = signedPayload({ type: "checkout.session.completed", data: { object: {} } });
    const result = await handleStripeWebhookRequest(rawBody, undefined, PRICE_MAP, fakeDeps());
    expect(result.status).toBe(400);
  });

  it("rejects a payload that was tampered with after signing", async () => {
    const { rawBody, signature } = signedPayload({ type: "checkout.session.completed", data: { object: {} } });
    const tampered = Buffer.from(rawBody.toString().replace("checkout.session.completed", "customer.subscription.deleted"));
    const result = await handleStripeWebhookRequest(tampered, signature, PRICE_MAP, fakeDeps());
    expect(result.status).toBe(400);
  });

  it("accepts a genuinely validly-signed payload", async () => {
    const { rawBody, signature } = signedPayload({
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", customer: "cus_abc" } },
    });
    const getCheckoutSessionPriceId = vi.fn().mockResolvedValue("price_solo_123");
    const result = await handleStripeWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ getCheckoutSessionPriceId }));
    expect(result.status).toBe(200);
  });
});

describe("handleStripeWebhookRequest — checkout.session.completed", () => {
  it("provisions an API key for a recognized price and string customer id", async () => {
    const { rawBody, signature } = signedPayload({
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", customer: "cus_abc" } },
    });
    const getCheckoutSessionPriceId = vi.fn().mockResolvedValue("price_team_456");
    const upsertApiKeyForCheckout = vi.fn().mockResolvedValue(undefined);
    const result = await handleStripeWebhookRequest(
      rawBody,
      signature,
      PRICE_MAP,
      fakeDeps({ getCheckoutSessionPriceId, upsertApiKeyForCheckout })
    );
    expect(result.status).toBe(200);
    expect(upsertApiKeyForCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "team", stripeCustomerId: "cus_abc" })
    );
  });

  it("does not provision anything for an unrecognized price id, but still 200s", async () => {
    const { rawBody, signature } = signedPayload({
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", customer: "cus_abc" } },
    });
    const getCheckoutSessionPriceId = vi.fn().mockResolvedValue("price_unknown_999");
    const upsertApiKeyForCheckout = vi.fn();
    const result = await handleStripeWebhookRequest(
      rawBody,
      signature,
      PRICE_MAP,
      fakeDeps({ getCheckoutSessionPriceId, upsertApiKeyForCheckout })
    );
    expect(result.status).toBe(200);
    expect(result.body.warning).toBeDefined();
    expect(upsertApiKeyForCheckout).not.toHaveBeenCalled();
  });

  it("does not provision anything when the customer id is missing (e.g. expanded object)", async () => {
    const { rawBody, signature } = signedPayload({
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", customer: { id: "cus_abc" } } },
    });
    const getCheckoutSessionPriceId = vi.fn().mockResolvedValue("price_solo_123");
    const upsertApiKeyForCheckout = vi.fn();
    const result = await handleStripeWebhookRequest(
      rawBody,
      signature,
      PRICE_MAP,
      fakeDeps({ getCheckoutSessionPriceId, upsertApiKeyForCheckout })
    );
    expect(result.status).toBe(200);
    expect(upsertApiKeyForCheckout).not.toHaveBeenCalled();
  });
});

describe("handleStripeWebhookRequest — customer.subscription.deleted", () => {
  it("deactivates every API key for that customer immediately", async () => {
    const { rawBody, signature } = signedPayload({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_abc", status: "canceled" } },
    });
    const setApiKeysActiveByCustomer = vi.fn().mockResolvedValue(undefined);
    const result = await handleStripeWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveByCustomer }));
    expect(result.status).toBe(200);
    expect(setApiKeysActiveByCustomer).toHaveBeenCalledWith("cus_abc", false);
  });
});

describe("handleStripeWebhookRequest — customer.subscription.updated (payment-failure handling)", () => {
  it("does NOT deactivate on 'past_due' — a single retry attempt must not cut off access", async () => {
    const { rawBody, signature } = signedPayload({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_abc", status: "past_due" } },
    });
    const setApiKeysActiveByCustomer = vi.fn();
    const result = await handleStripeWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveByCustomer }));
    expect(result.status).toBe(200);
    expect(setApiKeysActiveByCustomer).not.toHaveBeenCalled();
  });

  it("deactivates once Stripe's retries are exhausted and status becomes 'unpaid'", async () => {
    const { rawBody, signature } = signedPayload({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_abc", status: "unpaid" } },
    });
    const setApiKeysActiveByCustomer = vi.fn().mockResolvedValue(undefined);
    const result = await handleStripeWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveByCustomer }));
    expect(result.status).toBe(200);
    expect(setApiKeysActiveByCustomer).toHaveBeenCalledWith("cus_abc", false);
  });

  it("deactivates when a subscription is canceled via an update event (not just .deleted)", async () => {
    const { rawBody, signature } = signedPayload({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_abc", status: "canceled" } },
    });
    const setApiKeysActiveByCustomer = vi.fn().mockResolvedValue(undefined);
    const result = await handleStripeWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveByCustomer }));
    expect(setApiKeysActiveByCustomer).toHaveBeenCalledWith("cus_abc", false);
  });

  it("reactivates when a past-due subscription recovers back to 'active'", async () => {
    const { rawBody, signature } = signedPayload({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_abc", status: "active" } },
    });
    const setApiKeysActiveByCustomer = vi.fn().mockResolvedValue(undefined);
    const result = await handleStripeWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveByCustomer }));
    expect(setApiKeysActiveByCustomer).toHaveBeenCalledWith("cus_abc", true);
  });
});

describe("handleStripeWebhookRequest — unhandled event types", () => {
  it("200s without calling any deps for an event type it doesn't act on", async () => {
    const { rawBody, signature } = signedPayload({
      type: "invoice.payment_succeeded",
      data: { object: { id: "in_1", customer: "cus_abc" } },
    });
    const deps = fakeDeps();
    const result = await handleStripeWebhookRequest(rawBody, signature, PRICE_MAP, deps);
    expect(result.status).toBe(200);
    expect(deps.upsertApiKeyForCheckout).not.toHaveBeenCalled();
    expect(deps.setApiKeysActiveByCustomer).not.toHaveBeenCalled();
  });
});
