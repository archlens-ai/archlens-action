import { randomBytes } from "node:crypto";

export type Plan = "solo" | "team";

/**
 * Generates a customer-facing API key. Prefixed and high-entropy so it's
 * recognizable in logs/support tickets (like Stripe's own `sk_live_...`
 * convention) without ever needing a lookup to know what kind of key it is.
 */
export function generateApiKey(): string {
  return `alk_live_${randomBytes(24).toString("hex")}`;
}

export interface PriceMap {
  [razorpayPlanId: string]: Plan;
}

/**
 * Maps a Razorpay Plan ID (from `subscription.*` webhook events —
 * `payload.subscription.entity.plan_id`) to an internal plan name. Kept as a
 * pure function so the webhook handler's provisioning logic is testable
 * without a live Razorpay account — just pass in the plan-id map from env.
 *
 * Unlike Stripe's `checkout.session.completed`, Razorpay's subscription
 * webhooks include `plan_id` directly on the event payload — no second API
 * call (Stripe needed `checkout.sessions.listLineItems`) is required to
 * find out which plan a subscription is on.
 */
export function resolvePlan(razorpayPlanId: string, priceMap: PriceMap): Plan | null {
  return priceMap[razorpayPlanId] ?? null;
}

export function buildPriceMap(env: {
  RAZORPAY_PLAN_SOLO?: string;
  RAZORPAY_PLAN_TEAM?: string;
}): PriceMap {
  const map: PriceMap = {};
  if (env.RAZORPAY_PLAN_SOLO) map[env.RAZORPAY_PLAN_SOLO] = "solo";
  if (env.RAZORPAY_PLAN_TEAM) map[env.RAZORPAY_PLAN_TEAM] = "team";
  return map;
}

export interface OrgRecord {
  orgId: string;
  apiKey: string;
  plan: Plan;
  razorpaySubscriptionId: string;
}

/**
 * Pure provisioning decision: given an activated subscription's plan and
 * subscription id, decide what row to write. Actual Supabase upsert lives in
 * api/webhook/razorpay.ts — this function contains the business logic so it
 * can be unit tested without a database.
 *
 * Keyed on the Razorpay *subscription* id, not a customer id: Razorpay only
 * populates `customer_id` on the subscription entity after the customer
 * completes the authorization payment, and even then it identifies the
 * underlying payment method/contact rather than "this org's subscription"
 * the way Stripe's Customer object does. The subscription id is present
 * from the very first webhook and is already 1:1 with one paying org under
 * this product's plan model (one Solo or Team subscription per org), so it's
 * the simpler and more reliable correlation key.
 */
export function buildProvisioningRecord(params: {
  plan: Plan;
  razorpaySubscriptionId: string;
  existingOrgId?: string;
}): OrgRecord {
  return {
    orgId: params.existingOrgId ?? `org_${randomBytes(8).toString("hex")}`,
    apiKey: generateApiKey(),
    plan: params.plan,
    razorpaySubscriptionId: params.razorpaySubscriptionId,
  };
}
