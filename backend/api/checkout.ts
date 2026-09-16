import type { VercelRequest, VercelResponse } from "@vercel/node";
import Razorpay from "razorpay";
import { handleCheckoutRequest, type CheckoutDeps } from "../lib/checkout-handler.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    res.status(500).json({ code: "not_configured", message: "Razorpay is not configured." });
    return;
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  const deps: CheckoutDeps = {
    async createSubscription({ planId, email }) {
      // Razorpay's Subscription-create API has no success_url/cancel_url —
      // post-authorization redirect is set account-wide in the dashboard,
      // not per-request, so successUrl/cancelUrl aren't forwarded here (see
      // the comment on CheckoutDeps in lib/checkout-handler.ts).
      //
      // total_count is mandatory and finite for Razorpay (no "forever"
      // option like Stripe) — 120 monthly cycles (10 years) is the
      // pragmatic stand-in for an indefinite subscription; canceling early
      // is a normal, supported operation regardless of this number.
      const subscription = await razorpay.subscriptions.create({
        plan_id: planId,
        total_count: 120,
        customer_notify: 1,
        notes: email ? { email } : undefined,
      });
      return { url: subscription.short_url ?? null };
    },
  };

  const result = await handleCheckoutRequest(req.method ?? "GET", req.body ?? {}, process.env, deps);
  res.status(result.status).json(result.body);
}
