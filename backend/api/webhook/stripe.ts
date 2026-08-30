import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { buildPriceMap } from "../../lib/billing.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { handleStripeWebhookRequest, type WebhookDeps } from "../../lib/webhook-handler.js";

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
  const priceMap = buildPriceMap(process.env);

  const deps: WebhookDeps = {
    verifyEvent(body, sig) {
      return stripe.webhooks.constructEvent(body, sig, webhookSecret);
    },
    async getCheckoutSessionPriceId(sessionId) {
      const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 1 });
      return lineItems.data[0]?.price?.id;
    },
    async upsertApiKeyForCheckout(record) {
      const client = getSupabaseClient();
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
    },
    async setApiKeysActiveByCustomer(customerId, active) {
      const client = getSupabaseClient();
      await client.from("api_keys").update({ active }).eq("stripe_customer_id", customerId);
    },
  };

  const result = await handleStripeWebhookRequest(rawBody, signature as string | undefined, priceMap, deps);
  res.status(result.status).json(result.body);
}
