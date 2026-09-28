import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGenerateRequest, resolveApiKey, type GenerateRequestBody } from "../lib/generate-handler.js";
import { createSupabaseQuotaStore } from "../lib/quota.js";
import { createSupabaseDiagramCache } from "../lib/cache.js";
import { getProvider } from "../lib/llm.js";
import { renderMermaidToSvg } from "../lib/mermaid.js";
import { getSupabaseClient, storeSvgInSupabase } from "../lib/supabase.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ code: "method_not_allowed", message: "Use POST." });
    return;
  }

  const apiKey = resolveApiKey(req.headers.authorization);
  const body = req.body as GenerateRequestBody;

  const client = getSupabaseClient();
  const { status, body: responseBody } = await handleGenerateRequest(body, apiKey, {
    quotaStore: createSupabaseQuotaStore(client),
    cache: createSupabaseDiagramCache(client),
    llm: getProvider(process.env),
    render: renderMermaidToSvg,
    storeSvg: storeSvgInSupabase,
  });

  res.status(status).json(responseBody);
}
