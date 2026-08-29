import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";

const PRICE_BY_PLAN: Record<string, string | undefined> = {
  solo: process.env.STRIPE_PRICE_SOLO,
  team: process.env.STRIPE_PRICE_TEAM,
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ code: "method_not_allowed", message: "Use POST." });
    return;
  }

  const { plan, email } = req.body as { plan?: string; email?: string };
  const priceId = plan ? PRICE_BY_PLAN[plan] : undefined;
  if (!priceId) {
    res.status(400).json({ code: "bad_request", message: "plan must be 'solo' or 'team'." });
    return;
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    res.status(500).json({ code: "not_configured", message: "Stripe is not configured." });
    return;
  }

  const stripe = new Stripe(stripeSecretKey);
  const appUrl = process.env.ARCHLENS_APP_URL ?? "https://archlens.dev";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: email,
    success_url: `${appUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/pricing?checkout=cancelled`,
    allow_promotion_codes: true,
  });

  res.status(200).json({ url: session.url });
}
