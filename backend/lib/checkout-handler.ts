import type { Plan } from "./billing.js";

export interface CheckoutRequestBody {
  plan?: string;
  email?: string;
}

export interface CheckoutEnv {
  RAZORPAY_PLAN_SOLO?: string;
  RAZORPAY_PLAN_TEAM?: string;
  ARCHLENS_APP_URL?: string;
}

export interface CheckoutDeps {
  /**
   * Creates the actual Razorpay Subscription and returns its hosted
   * authorization URL (`short_url`) — the page the customer visits to enter
   * payment details and authorize recurring billing. Injected so this is
   * testable without a live Razorpay account.
   *
   * Note this is a genuine platform difference from Stripe, not just a
   * rename: Razorpay's Subscription-create API has no `success_url` /
   * `cancel_url` parameters — post-authorization redirect is configured
   * account-wide in the Razorpay dashboard (Settings > Subscriptions),
   * not per-request. `successUrl`/`cancelUrl` are still computed and passed
   * through here (kept for interface parity and because the dashboard
   * redirect target should point at `ARCHLENS_APP_URL`), but the live
   * Razorpay API wrapper (api/checkout.ts) does not forward them to
   * Razorpay's own `subscriptions.create` call — see the comment there.
   */
  createSubscription(params: {
    planId: string;
    email?: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string | null }>;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Pure request-handling logic for POST /api/checkout, separated from the
 * Vercel-specific request/response glue (api/checkout.ts) so it can be unit
 * tested the same way backend/lib/generate-handler.ts is — by injecting a
 * fake Razorpay client instead of requiring a live account and network calls.
 */
export async function handleCheckoutRequest(
  method: string,
  body: CheckoutRequestBody,
  env: CheckoutEnv,
  deps: CheckoutDeps
): Promise<HandlerResult> {
  if (method !== "POST") {
    return { status: 405, body: { code: "method_not_allowed", message: "Use POST." } };
  }

  const planIdByPlan: Record<string, string | undefined> = {
    solo: env.RAZORPAY_PLAN_SOLO,
    team: env.RAZORPAY_PLAN_TEAM,
  };
  const plan = body.plan as Plan | undefined;
  const planId = plan ? planIdByPlan[plan] : undefined;
  if (!planId) {
    return { status: 400, body: { code: "bad_request", message: "plan must be 'solo' or 'team'." } };
  }

  const appUrl = env.ARCHLENS_APP_URL ?? "https://archlens.dev";
  const subscription = await deps.createSubscription({
    planId,
    email: body.email,
    successUrl: `${appUrl}/dashboard?checkout=success`,
    cancelUrl: `${appUrl}/pricing?checkout=cancelled`,
  });

  return { status: 200, body: { url: subscription.url } };
}
