import { buildProvisioningRecord, resolvePlan, type OrgRecord, type PriceMap } from "./billing.js";

export interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  status: string;
}

export interface RazorpayWebhookEvent {
  event: string;
  payload: {
    subscription?: {
      entity: RazorpaySubscriptionEntity;
    };
  };
}

export interface WebhookDeps {
  /** Verifies the Razorpay `X-Razorpay-Signature` header and parses the event. Throws on an invalid/missing signature. */
  verifyEvent(rawBody: Buffer, signature: string): RazorpayWebhookEvent;
  /** Provisions (or re-provisions) an org's API key row after a subscription is activated. */
  upsertApiKeyForSubscription(record: OrgRecord): Promise<void>;
  /** Flips every API key belonging to a Razorpay subscription active/inactive. */
  setApiKeysActiveBySubscription(subscriptionId: string, active: boolean): Promise<void>;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

// Subscription statuses/events that should actively gate API access.
// `subscription.pending` (a failed charge attempt still being retried) is
// deliberately NOT in either set, same reasoning this file always used for
// Stripe's `past_due`: Razorpay retries a failed recurring charge several
// times before giving up, and gating access on the first failed attempt
// would cut off a paying customer's whole team over one transient decline,
// before Razorpay's own retry schedule even gets a chance to succeed.
// `subscription.halted` is the signal that retries are exhausted — the
// direct equivalent of Stripe's subscription transitioning to `unpaid`.
// `subscription.activated` is deliberately NOT in this set — it has its own
// `case` above (provisioning, not just re-activating), so it never reaches
// the `default` branch these sets are checked in.
const ACTIVATING_EVENTS = new Set(["subscription.charged", "subscription.resumed"]);
const DEACTIVATING_EVENTS = new Set(["subscription.halted", "subscription.cancelled", "subscription.paused"]);

/**
 * Pure webhook-handling logic for POST /api/webhook/razorpay, separated from
 * the Vercel-specific raw-body/response glue (api/webhook/razorpay.ts) so the
 * actual signature-verification and provisioning logic is unit tested
 * directly — using Razorpay's own HMAC-SHA256 signature scheme (plain
 * `crypto.createHmac`, no live account or network call required to generate
 * a genuinely validly-signed test payload).
 */
export async function handleRazorpayWebhookRequest(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  priceMap: PriceMap,
  deps: WebhookDeps
): Promise<HandlerResult> {
  let event: RazorpayWebhookEvent;
  try {
    event = deps.verifyEvent(rawBody, signatureHeader ?? "");
  } catch (err) {
    return {
      status: 400,
      body: {
        code: "invalid_signature",
        message: err instanceof Error ? err.message : "Invalid Razorpay signature.",
      },
    };
  }

  const subscription = event.payload.subscription?.entity;

  switch (event.event) {
    case "subscription.activated": {
      if (!subscription) {
        return { status: 200, body: { received: true, warning: "missing subscription entity" } };
      }
      const plan = resolvePlan(subscription.plan_id, priceMap);
      if (!plan) {
        // Unrecognized plan id — don't silently 200 an event we can't act
        // on without a trace; log it for manual follow-up.
        return { status: 200, body: { received: true, warning: "unrecognized plan" } };
      }
      const record = buildProvisioningRecord({ plan, razorpaySubscriptionId: subscription.id });
      await deps.upsertApiKeyForSubscription(record);
      break;
    }

    default: {
      if (!subscription) break;
      if (ACTIVATING_EVENTS.has(event.event)) {
        await deps.setApiKeysActiveBySubscription(subscription.id, true);
      } else if (DEACTIVATING_EVENTS.has(event.event)) {
        await deps.setApiKeysActiveBySubscription(subscription.id, false);
      }
      // Any other event (e.g. `subscription.pending`, `subscription.completed`)
      // is left as-is — see the comment on ACTIVATING_EVENTS/DEACTIVATING_EVENTS.
      break;
    }
  }

  return { status: 200, body: { received: true } };
}
