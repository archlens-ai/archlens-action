import { describe, expect, it } from "vitest";
import { InMemoryQuotaStore } from "../lib/quota.js";

describe("InMemoryQuotaStore", () => {
  it("returns null for an unknown key", async () => {
    const store = new InMemoryQuotaStore();
    expect(await store.getKeyStatus("nope")).toBeNull();
  });

  it("increments usage on recordUsage", async () => {
    const store = new InMemoryQuotaStore();
    store.seed("alk_live_x", {
      active: true,
      orgId: "org_1",
      plan: "solo",
      planLimit: 500,
      usedThisMonth: 0,
    });
    await store.recordUsage("alk_live_x", { owner: "acme", repo: "widgets", prNumber: 1 });
    const status = await store.getKeyStatus("alk_live_x");
    expect(status?.usedThisMonth).toBe(1);
  });
});
