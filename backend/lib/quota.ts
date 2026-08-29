export interface ApiKeyStatus {
  active: boolean;
  orgId: string;
  plan: "free" | "solo" | "team";
  planLimit: number; // diagrams/month; Number.POSITIVE_INFINITY for unmetered
  usedThisMonth: number;
}

export interface UsageMeta {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface QuotaStore {
  getKeyStatus(apiKey: string): Promise<ApiKeyStatus | null>;
  recordUsage(apiKey: string, meta: UsageMeta): Promise<void>;
}

export const PLAN_LIMITS: Record<ApiKeyStatus["plan"], number> = {
  // Free tier (public repos, shared key): capped hard so one noisy repo
  // can't burn the whole free-tier LLM budget for everyone else.
  free: 100,
  solo: 500,
  team: 3000,
};

/**
 * Deterministic in-memory store used by tests and as the fallback for local
 * development without Supabase configured. Never used in production.
 */
export class InMemoryQuotaStore implements QuotaStore {
  private keys = new Map<string, ApiKeyStatus>();

  seed(apiKey: string, status: ApiKeyStatus): void {
    this.keys.set(apiKey, status);
  }

  async getKeyStatus(apiKey: string): Promise<ApiKeyStatus | null> {
    return this.keys.get(apiKey) ?? null;
  }

  async recordUsage(apiKey: string, _meta: UsageMeta): Promise<void> {
    const status = this.keys.get(apiKey);
    if (status) status.usedThisMonth += 1;
  }
}

export interface SupabaseLike {
  from(table: string): {
    select: (...args: any[]) => any;
    update: (...args: any[]) => any;
    insert: (...args: any[]) => any;
  };
  rpc?(fn: string, args?: Record<string, unknown>): any;
}

/**
 * Production quota store backed by Supabase. Schema: see db/schema.sql
 * (api_keys, usage_logs). Kept behind the QuotaStore interface so
 * api/generate.ts never talks to Supabase directly — swapping providers or
 * unit-testing the billing logic never requires a live database.
 */
export function createSupabaseQuotaStore(client: SupabaseLike): QuotaStore {
  return {
    async getKeyStatus(apiKey: string): Promise<ApiKeyStatus | null> {
      const { data, error } = await client
        .from("api_keys")
        .select("org_id, plan, active, used_this_month")
        .eq("key", apiKey)
        .maybeSingle();

      if (error || !data) return null;

      return {
        active: data.active,
        orgId: data.org_id,
        plan: data.plan,
        planLimit: PLAN_LIMITS[data.plan as ApiKeyStatus["plan"]] ?? PLAN_LIMITS.free,
        usedThisMonth: data.used_this_month ?? 0,
      };
    },

    async recordUsage(apiKey: string, meta: UsageMeta): Promise<void> {
      await client.from("usage_logs").insert({
        api_key: apiKey,
        owner: meta.owner,
        repo: meta.repo,
        pr_number: meta.prNumber,
        created_at: new Date().toISOString(),
      });
      // Monthly counter reset is handled by a scheduled Supabase function
      // (see db/schema.sql) that zeroes used_this_month on the 1st — kept
      // out of the request path so a billing-cycle bug can't take down
      // diagram generation.
      await client.rpc?.("increment_api_key_usage", { p_key: apiKey });
    },
  };
}
