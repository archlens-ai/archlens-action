import type { VercelRequest, VercelResponse } from "@vercel/node";
import Razorpay from "razorpay";
import { buildPriceMap } from "../../lib/billing.js";
import { getSupabaseClient } from "../../lib/supabase.js";
import { handleRazorpayWebhookRequest, type RazorpayWebhookEvent, type WebhookDeps } from "../../lib/webhook-handler.js";

// Vercel needs the raw body to verify the Razorpay signature — disable the
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
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    res.status(500).json({ code: "not_configured", message: "Razorpay webhook secret is not configured." });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-razorpay-signature"];
  const priceMap = buildPriceMap(process.env);

  const deps: WebhookDeps = {
    verifyEvent(body, sig) {
      if (!Razorpay.validateWebhookSignature(body.toString(), sig, webhookSecret)) {
        throw new Error("Invalid Razorpay webhook signature.");
      }
      return JSON.parse(body.toString()) as RazorpayWebhookEvent;
    },
    async upsertApiKeyForSubscription(record) {
      const client = getSupabaseClient();
      await client.from("api_keys").insert({
        key: record.apiKey,
        org_id: record.orgId,
        plan: record.plan,
        razorpay_subscription_id: record.razorpaySubscriptionId,
        active: true,
        used_this_month: 0,
      });
      // The customer's actual key delivery (dashboard + email) is a
      // separate, non-webhook-blocking step — see docs/ARCHITECTURE.md.
    },
    async setApiKeysActiveBySubscription(subscriptionId, active) {
      const client = getSupabaseClient();
      await client.from("api_keys").update({ active }).eq("razorpay_subscription_id", subscriptionId);
    },
  };

  const result = await handleRazorpayWebhookRequest(rawBody, signature as string | undefined, priceMap, deps);
  res.status(result.status).json(result.body);
}
