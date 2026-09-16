import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import Razorpay from "razorpay";
import { buildPriceMap } from "../lib/billing.js";
import { handleRazorpayWebhookRequest, type WebhookDeps } from "../lib/webhook-handler.js";

// Razorpay webhook signatures are plain HMAC-SHA256 hex digests of the raw
// body, keyed by the webhook secret — Razorpay's servers compute this, so
// there's no SDK "generate a test signature" helper the way Stripe has
// `generateTestHeaderString`. Signing here with plain `crypto.createHmac`
// and verifying with Razorpay's own real `validateWebhookSignature` means
// these tests exercise the EXACT verification code path production uses.
const WEBHOOK_SECRET = "test_webhook_secret_abc123";
const PRICE_MAP = buildPriceMap({ RAZORPAY_PLAN_SOLO: "plan_solo_123", RAZORPAY_PLAN_TEAM: "plan_team_456" });

function signedPayload(eventOverrides: Record<string, unknown>): { rawBody: Buffer; signature: string } {
  const payload = JSON.stringify({
    entity: "event",
    account_id: "acc_test_1",
    created_at: Math.floor(Date.now() / 1000),
    ...eventOverrides,
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  return { rawBody: Buffer.from(payload), signature };
}

function fakeDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    verifyEvent: (rawBody, signature) => {
      if (!Razorpay.validateWebhookSignature(rawBody.toString(), signature, WEBHOOK_SECRET)) {
        throw new Error("Invalid Razorpay webhook signature.");
      }
      return JSON.parse(rawBody.toString());
    },
    upsertApiKeyForSubscription: vi.fn().mockResolvedValue(undefined),
    setApiKeysActiveBySubscription: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function subscriptionEvent(event: string, entity: Record<string, unknown>) {
  return { event, payload: { subscription: { entity } } };
}

describe("handleRazorpayWebhookRequest — signature verification", () => {
  it("rejects a payload with an invalid signature", async () => {
    const { rawBody } = signedPayload(subscriptionEvent("subscription.activated", { id: "sub_1", plan_id: "plan_solo_123" }));
    const result = await handleRazorpayWebhookRequest(rawBody, "deadbeef", PRICE_MAP, fakeDeps());
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_signature");
  });

  it("rejects when the signature header is missing entirely", async () => {
    const { rawBody } = signedPayload(subscriptionEvent("subscription.activated", { id: "sub_1", plan_id: "plan_solo_123" }));
    const result = await handleRazorpayWebhookRequest(rawBody, undefined, PRICE_MAP, fakeDeps());
    expect(result.status).toBe(400);
  });

  it("rejects a payload that was tampered with after signing", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.activated", { id: "sub_1", plan_id: "plan_solo_123" })
    );
    const tampered = Buffer.from(rawBody.toString().replace("subscription.activated", "subscription.cancelled"));
    const result = await handleRazorpayWebhookRequest(tampered, signature, PRICE_MAP, fakeDeps());
    expect(result.status).toBe(400);
  });

  it("accepts a genuinely validly-signed payload", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.activated", { id: "sub_1", plan_id: "plan_solo_123" })
    );
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps());
    expect(result.status).toBe(200);
  });
});

describe("handleRazorpayWebhookRequest — subscription.activated", () => {
  it("provisions an API key for a recognized plan", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.activated", { id: "sub_abc", plan_id: "plan_team_456" })
    );
    const upsertApiKeyForSubscription = vi.fn().mockResolvedValue(undefined);
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ upsertApiKeyForSubscription }));
    expect(result.status).toBe(200);
    expect(upsertApiKeyForSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "team", razorpaySubscriptionId: "sub_abc" })
    );
  });

  it("does not provision anything for an unrecognized plan id, but still 200s", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.activated", { id: "sub_abc", plan_id: "plan_unknown_999" })
    );
    const upsertApiKeyForSubscription = vi.fn();
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ upsertApiKeyForSubscription }));
    expect(result.status).toBe(200);
    expect(result.body.warning).toBeDefined();
    expect(upsertApiKeyForSubscription).not.toHaveBeenCalled();
  });

  it("does not provision anything when the subscription entity is missing", async () => {
    const { rawBody, signature } = signedPayload({ event: "subscription.activated", payload: {} });
    const upsertApiKeyForSubscription = vi.fn();
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ upsertApiKeyForSubscription }));
    expect(result.status).toBe(200);
    expect(upsertApiKeyForSubscription).not.toHaveBeenCalled();
  });
});

describe("handleRazorpayWebhookRequest — subscription.cancelled / halted / paused", () => {
  it("deactivates every API key for that subscription on cancellation", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.cancelled", { id: "sub_abc", plan_id: "plan_solo_123" })
    );
    const setApiKeysActiveBySubscription = vi.fn().mockResolvedValue(undefined);
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveBySubscription }));
    expect(result.status).toBe(200);
    expect(setApiKeysActiveBySubscription).toHaveBeenCalledWith("sub_abc", false);
  });

  it("deactivates once Razorpay's retries are exhausted (subscription.halted)", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.halted", { id: "sub_abc", plan_id: "plan_solo_123" })
    );
    const setApiKeysActiveBySubscription = vi.fn().mockResolvedValue(undefined);
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveBySubscription }));
    expect(result.status).toBe(200);
    expect(setApiKeysActiveBySubscription).toHaveBeenCalledWith("sub_abc", false);
  });

  it("deactivates on an explicit pause", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.paused", { id: "sub_abc", plan_id: "plan_solo_123" })
    );
    const setApiKeysActiveBySubscription = vi.fn().mockResolvedValue(undefined);
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveBySubscription }));
    expect(setApiKeysActiveBySubscription).toHaveBeenCalledWith("sub_abc", false);
  });
});

describe("handleRazorpayWebhookRequest — subscription.pending (payment-retry handling)", () => {
  it("does NOT deactivate on a single failed-charge retry attempt", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.pending", { id: "sub_abc", plan_id: "plan_solo_123" })
    );
    const setApiKeysActiveBySubscription = vi.fn();
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveBySubscription }));
    expect(result.status).toBe(200);
    expect(setApiKeysActiveBySubscription).not.toHaveBeenCalled();
  });
});

describe("handleRazorpayWebhookRequest — subscription.charged / subscription.resumed (recovery)", () => {
  it("reactivates on a successful recurring charge", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.charged", { id: "sub_abc", plan_id: "plan_solo_123" })
    );
    const setApiKeysActiveBySubscription = vi.fn().mockResolvedValue(undefined);
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveBySubscription }));
    expect(setApiKeysActiveBySubscription).toHaveBeenCalledWith("sub_abc", true);
  });

  it("reactivates when a paused subscription resumes", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.resumed", { id: "sub_abc", plan_id: "plan_solo_123" })
    );
    const setApiKeysActiveBySubscription = vi.fn().mockResolvedValue(undefined);
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, fakeDeps({ setApiKeysActiveBySubscription }));
    expect(setApiKeysActiveBySubscription).toHaveBeenCalledWith("sub_abc", true);
  });
});

describe("handleRazorpayWebhookRequest — unhandled event types", () => {
  it("200s without calling any deps for an event type it doesn't act on", async () => {
    const { rawBody, signature } = signedPayload(
      subscriptionEvent("subscription.completed", { id: "sub_abc", plan_id: "plan_solo_123" })
    );
    const deps = fakeDeps();
    const result = await handleRazorpayWebhookRequest(rawBody, signature, PRICE_MAP, deps);
    expect(result.status).toBe(200);
    expect(deps.upsertApiKeyForSubscription).not.toHaveBeenCalled();
    expect(deps.setApiKeysActiveBySubscription).not.toHaveBeenCalled();
  });
});
