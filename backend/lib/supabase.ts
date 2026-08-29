import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Server-only Supabase client using the service-role key. Never import this
 * module from anything that ships to a browser or the Action itself — the
 * service-role key bypasses row-level security by design.
 */
export function getSupabaseClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use the production data layer."
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  return cached;
}

const DIAGRAMS_BUCKET = "diagrams";

/**
 * Uploads a rendered SVG to Supabase Storage keyed by content hash and
 * returns its public URL. Content-addressed storage means re-uploading the
 * same hash is a safe no-op (upsert), which matters because the cache and
 * storage layers can, in rare races, both attempt a write for the same hash.
 */
export async function storeSvgInSupabase(hash: string, svg: string): Promise<string> {
  const client = getSupabaseClient();
  const path = `${hash}.svg`;

  const { error } = await client.storage.from(DIAGRAMS_BUCKET).upload(path, svg, {
    contentType: "image/svg+xml",
    upsert: true,
    cacheControl: "31536000, immutable",
  });
  if (error) {
    throw new Error(`Failed to store rendered SVG: ${error.message}`);
  }

  const { data } = client.storage.from(DIAGRAMS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
