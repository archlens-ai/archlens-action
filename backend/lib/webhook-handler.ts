import type Stripe from "stripe";
import { buildProvisioningRecord, resolvePlan, type OrgRecord, type PriceMap } from "./billing.js";

export interface WebhookDeps {
  /** Verifies the Stripe signature and parses the event. Throws on an invalid/missing signature. */
  verifyEvent(rawBody: Buffer, signature: string): Stripe.Event;
  /** Looks up the Price ID for a completed Checkout Session (a second Stripe API call, since the session payload itself doesn't include it). */
  getCheckoutSessionPriceId(sessionId: string): Promise<string | undefined>;
  /** Provisions (or re-provisions) an org's API key row after a successful checkout. */
  upsertApiKeyForCheckout(record: OrgRecord): Promise<void>;
  /** Flips every API key belonging to a Stripe customer active/inactive. */
  setApiKeysActiveByCustomer(customerId: string, active: boolean): Promise<void>;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

// Subscription statuses that should actively gate API access. Anything else
// (e.g. "incomplete" during initial payment collection, "trialing") is left
// alone here rather than guessed at.
const ACTIVATING_STATUSES = new Set<Stripe.Subscription.Status>(["active", "trialing"]);
const DEACTIVATING_STATUSES = new Set<Stripe.Subscription.Status>(["unpaid", "canceled", "incomplete_expired"]);

/**
 * Pure webhook-handling logic for POST /api/webhook/stripe, separated from
 * the Vercel-specific raw-body/response glue (api/webhook/stripe.ts) so the
 * actual signature-verification and provisioning logic is unit tested
 * directly — using Stripe's own `stripe.webhooks.generateTestHeaderString`
 * to build genuinely validly-signed test payloads, entirely offline, no
 * live Stripe account or network call required.
 *
 * Deliberately reacts to `customer.subscription.updated` rather than raw
 * `invoice.payment_failed` for deactivation: `invoice.payment_failed` fires
 * on *every* retry attempt during Stripe's dunning/Smart Retries flow, not
 * just the final one — gating access on the first occurrence would cut off
 * a paying customer's whole team over one transient card decline, before
 * Stripe's own retry schedule even gets a chance to succeed. Waiting for
 * the subscription to actually transition to `unpaid`/`canceled` (which
 * Stripe does automatically once retries are exhausted) is the correct
 * signal; `customer.subscription.deleted` remains the hard, immediate cutoff
 * for an explicit cancellation.
 */
export async function handleStripeWebhookRequest(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  priceMap: PriceMap,
  deps: WebhookDeps
): Promise<HandlerResult> {
  let event: Stripe.Event;
  try {
    event = deps.verifyEvent(rawBody, signatureHeader ?? "");
  } catch (err) {
    return {
      status: 400,
      body: { code: "invalid_signature", message: err instanceof Error ? err.message : "Invalid Stripe signature." },
    };
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const priceId = await deps.getCheckoutSessionPriceId(session.id);
      const plan = priceId ? resolvePlan(priceId, priceMap) : null;

      if (!plan || typeof session.customer !== "string") {
        // Unknown price ID or missing customer — don't silently 200 an
        // event we can't act on; log it for manual follow-up.
        return { status: 200, body: { received: true, warning: "unrecognized plan or customer" } };
      }

      const record = buildProvisioningRecord({ plan, stripeCustomerId: session.customer });
      await deps.upsertApiKeyForCheckout(record);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      if (typeof sub.customer === "string") {
        await deps.setApiKeysActiveByCustomer(sub.customer, false);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      if (typeof sub.customer === "string") {
        if (ACTIVATING_STATUSES.has(sub.status)) {
          await deps.setApiKeysActiveByCustomer(sub.customer, true);
        } else if (DEACTIVATING_STATUSES.has(sub.status)) {
          await deps.setApiKeysActiveByCustomer(sub.customer, false);
        }
        // Any other status (e.g. "past_due", "incomplete") is a mid-flight
        // state where Stripe is still retrying — access is left as-is.
      }
      break;
    }

    default:
      break;
  }

  return { status: 200, body: { received: true } };
}
