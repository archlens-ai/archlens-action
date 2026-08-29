import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { buildPriceMap, buildProvisioningRecord, resolvePlan } from "../../lib/billing.js";
import { getSupabaseClient } from "../../lib/supabase.js";

// Vercel needs the raw body to verify the Stripe signature — disable the
// default JSON body parser for this route.
export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecretKey || !webhookSecret) {
    res.status(500).json({ code: "not_configured", message: "Stripe is not configured." });
    return;
  }

  const stripe = new Stripe(stripeSecretKey);
  const rawBody = await readRawBody(req);
  const signature = req.headers["stripe-signature"];

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature as string, webhookSecret);
  } catch (err) {
    res.status(400).json({
      code: "invalid_signature",
      message: err instanceof Error ? err.message : "Invalid Stripe signature.",
    });
    return;
  }

  const priceMap = buildPriceMap(process.env);
  const client = getSupabaseClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
      const priceId = lineItems.data[0]?.price?.id;
      const plan = priceId ? resolvePlan(priceId, priceMap) : null;

      if (!plan || typeof session.customer !== "string") {
        // Unknown price ID or missing customer — don't silently 200 an
        // event we can't act on; log it for manual follow-up.
        res.status(200).json({ received: true, warning: "unrecognized plan or customer" });
        return;
      }

      const record = buildProvisioningRecord({ plan, stripeCustomerId: session.customer });
      await client.from("api_keys").insert({
        key: record.apiKey,
        org_id: record.orgId,
        plan: record.plan,
        stripe_customer_id: record.stripeCustomerId,
        active: true,
        used_this_month: 0,
      });
      // The customer's actual key delivery (dashboard + email) is a
      // separate, non-webhook-blocking step — see docs/ARCHITECTURE.md.
      break;
    }

    case "customer.subscription.deleted":
    case "invoice.payment_failed": {
      const obj = event.data.object as { customer: string };
      await client
        .from("api_keys")
        .update({ active: false })
        .eq("stripe_customer_id", obj.customer);
      break;
    }

    default:
      break;
  }

  res.status(200).json({ received: true });
}
