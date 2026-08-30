import type { Plan } from "./billing.js";

export interface CheckoutRequestBody {
  plan?: string;
  email?: string;
}

export interface CheckoutEnv {
  STRIPE_PRICE_SOLO?: string;
  STRIPE_PRICE_TEAM?: string;
  ARCHLENS_APP_URL?: string;
}

export interface CheckoutDeps {
  /** Creates the actual Stripe Checkout Session. Injected so this is testable without a live Stripe account. */
  createCheckoutSession(params: {
    priceId: string;
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
 * fake Stripe client instead of requiring a live account and network calls.
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

  const priceByPlan: Record<string, string | undefined> = {
    solo: env.STRIPE_PRICE_SOLO,
    team: env.STRIPE_PRICE_TEAM,
  };
  const plan = body.plan as Plan | undefined;
  const priceId = plan ? priceByPlan[plan] : undefined;
  if (!priceId) {
    return { status: 400, body: { code: "bad_request", message: "plan must be 'solo' or 'team'." } };
  }

  const appUrl = env.ARCHLENS_APP_URL ?? "https://archlens.dev";
  const session = await deps.createCheckoutSession({
    priceId,
    email: body.email,
    successUrl: `${appUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl}/pricing?checkout=cancelled`,
  });

  return { status: 200, body: { url: session.url } };
}
