// One-off connectivity check: confirms SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// in backend/.env actually authenticate against the live archlens-ai project
// and that the expected tables + storage bucket are reachable. Not part of
// the test suite — run manually after provisioning credentials.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envPath = new URL("../backend/.env", import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
);

const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env");
  process.exit(1);
}

console.log(`Connecting to ${url} ...`);
const client = createClient(url, key, { auth: { persistSession: false } });

const tables = ["orgs", "api_keys", "usage_logs", "diagram_cache"];
let allOk = true;

for (const table of tables) {
  const { error, count } = await client.from(table).select("*", { count: "exact", head: true });
  if (error) {
    console.error(`FAIL  ${table}: ${error.message}`);
    allOk = false;
  } else {
    console.log(`OK    ${table} (${count ?? 0} rows) — reachable with service-role key`);
  }
}

const { data: buckets, error: bucketErr } = await client.storage.listBuckets();
if (bucketErr) {
  console.error(`FAIL  storage.listBuckets: ${bucketErr.message}`);
  allOk = false;
} else {
  const diagrams = buckets.find((b) => b.name === "diagrams");
  if (diagrams) {
    console.log(`OK    storage bucket "diagrams" exists (public: ${diagrams.public})`);
  } else {
    console.error(`FAIL  storage bucket "diagrams" not found (buckets: ${buckets.map((b) => b.name).join(", ") || "none"})`);
    allOk = false;
  }
}

// Sanity check the two RPC functions from schema.sql are callable.
const { error: rpcErr } = await client.rpc("increment_api_key_usage", { p_key: "__verify_nonexistent__" });
if (rpcErr) {
  console.error(`FAIL  rpc increment_api_key_usage: ${rpcErr.message}`);
  allOk = false;
} else {
  console.log("OK    rpc increment_api_key_usage callable (no-op on nonexistent key)");
}

console.log(allOk ? "\nAll checks passed — live Supabase credentials are wired correctly." : "\nSome checks FAILED — see above.");
process.exit(allOk ? 0 : 1);
