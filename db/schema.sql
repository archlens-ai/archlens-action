-- ArchLens AI — Supabase schema
-- Run via the Supabase SQL editor or `supabase db push`.

create extension if not exists "pgcrypto";

create table if not exists orgs (
  id text primary key,
  name text,
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  key text primary key,
  org_id text not null references orgs(id) on delete cascade,
  plan text not null check (plan in ('free', 'solo', 'team')),
  stripe_customer_id text,
  active boolean not null default true,
  used_this_month integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_api_keys_stripe_customer on api_keys (stripe_customer_id);

create table if not exists usage_logs (
  id uuid primary key default gen_random_uuid(),
  api_key text not null references api_keys(key) on delete cascade,
  owner text not null,
  repo text not null,
  pr_number integer not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_usage_logs_api_key_created on usage_logs (api_key, created_at);

-- Content-addressed cache: one row per unique (diagram_type + normalized
-- diff) hash. Lets a resubmitted/rerun PR skip the LLM call and re-render
-- entirely — see backend/lib/cache.ts.
create table if not exists diagram_cache (
  hash text primary key,
  svg_url text not null,
  mermaid_source text not null,
  diagram_type text not null check (diagram_type in ('flowchart', 'sequence')),
  created_at timestamptz not null default now()
);

-- Atomically increments an API key's monthly usage counter. Called from
-- the request path (backend/lib/quota.ts) instead of a read-modify-write
-- from application code, to avoid a race between two PRs landing on the
-- same repo in the same second both reading a stale count.
create or replace function increment_api_key_usage(p_key text)
returns void
language sql
as $$
  update api_keys set used_this_month = used_this_month + 1 where key = p_key;
$$;

-- Scheduled monthly reset (wire up via Supabase's pg_cron or a Vercel Cron
-- Job hitting a small /api/cron/reset-usage endpoint that calls this).
create or replace function reset_monthly_usage()
returns void
language sql
as $$
  update api_keys set used_this_month = 0;
$$;

-- Row-level security: service-role key (used exclusively by the backend,
-- never shipped to the Action or any client) bypasses RLS by design, so
-- these tables have no public policies — there is no anon/public access
-- path to them at all.
alter table orgs enable row level security;
alter table api_keys enable row level security;
alter table usage_logs enable row level security;
alter table diagram_cache enable row level security;
