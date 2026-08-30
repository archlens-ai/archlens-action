import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { handleCheckoutRequest, type CheckoutDeps } from "../lib/checkout-handler.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    res.status(500).json({ code: "not_configured", message: "Stripe is not configured." });
    return;
  }

  const stripe = new Stripe(stripeSecretKey);
  const deps: CheckoutDeps = {
    async createCheckoutSession({ priceId, email, successUrl, cancelUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: email,
        success_url: successUrl,
        cancel_url: cancelUrl,
        allow_promotion_codes: true,
      });
      return { url: session.url };
    },
  };

  const result = await handleCheckoutRequest(req.method ?? "GET", req.body ?? {}, process.env, deps);
  res.status(result.status).json(result.body);
}
