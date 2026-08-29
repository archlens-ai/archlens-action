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
  [stripePriceId: string]: Plan;
}

/**
 * Maps a Stripe Price ID (from checkout.session.completed /
 * customer.subscription.* webhook events) to an internal plan name. Kept as
 * a pure function so the webhook handler's provisioning logic is testable
 * without a live Stripe account — just pass in the price ID map from env.
 */
export function resolvePlan(stripePriceId: string, priceMap: PriceMap): Plan | null {
  return priceMap[stripePriceId] ?? null;
}

export function buildPriceMap(env: {
  STRIPE_PRICE_SOLO?: string;
  STRIPE_PRICE_TEAM?: string;
}): PriceMap {
  const map: PriceMap = {};
  if (env.STRIPE_PRICE_SOLO) map[env.STRIPE_PRICE_SOLO] = "solo";
  if (env.STRIPE_PRICE_TEAM) map[env.STRIPE_PRICE_TEAM] = "team";
  return map;
}

export interface OrgRecord {
  orgId: string;
  apiKey: string;
  plan: Plan;
  stripeCustomerId: string;
}

/**
 * Pure provisioning decision: given a completed checkout session's plan and
 * customer ID, decide what row to write. Actual Supabase upsert lives in
 * api/webhook/stripe.ts — this function contains the business logic so it
 * can be unit tested without a database.
 */
export function buildProvisioningRecord(params: {
  plan: Plan;
  stripeCustomerId: string;
  existingOrgId?: string;
}): OrgRecord {
  return {
    orgId: params.existingOrgId ?? `org_${randomBytes(8).toString("hex")}`,
    apiKey: generateApiKey(),
    plan: params.plan,
    stripeCustomerId: params.stripeCustomerId,
  };
}
