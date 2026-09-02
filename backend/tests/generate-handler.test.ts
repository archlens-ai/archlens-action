import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGenerateRequest, type GenerateRequestBody } from "../lib/generate-handler.js";
import { InMemoryDiagramCache } from "../lib/cache.js";
import { InMemoryQuotaStore } from "../lib/quota.js";
import type { LlmProvider } from "../lib/llm.js";

function makeBody(overrides: Partial<GenerateRequestBody> = {}): GenerateRequestBody {
  return {
    owner: "acme",
    repo: "widgets",
    prNumber: 1,
    diagramType: "auto",
    files: [{ filename: "a.sql", status: "modified", patch: "+CREATE TABLE a();" }],
    truncated: false,
    ...overrides,
  };
}

function makeDeps(overrides: { llmOutput?: string | string[] } = {}) {
  const quotaStore = new InMemoryQuotaStore();
  quotaStore.seed("alk_live_valid", {
    active: true,
    orgId: "org_1",
    plan: "solo",
    planLimit: 500,
    usedThisMonth: 0,
  });
  const cache = new InMemoryDiagramCache();

  const outputs = Array.isArray(overrides.llmOutput)
    ? [...overrides.llmOutput]
    : [overrides.llmOutput ?? "flowchart TD\n  A --> B"];
  const generateMermaid = vi.fn(async () => outputs.shift() ?? "flowchart TD\n  A --> B");
  const llm: LlmProvider = { name: "fake", generateMermaid };

  const render = vi.fn(async (source: string) => ({ svg: `<svg>${source}</svg>` }));
  const storeSvg = vi.fn(async (hash: string) => `https://cdn.archlens.dev/${hash}.svg`);

  return { quotaStore, cache, llm, render, storeSvg, generateMermaid };
}

describe("handleGenerateRequest", () => {
  it("rejects a missing API key", async () => {
    const deps = makeDeps();
    const { status, body } = await handleGenerateRequest(makeBody(), null, deps);
    expect(status).toBe(401);
    expect((body as any).code).toBe("unauthorized");
  });

  it("rejects an unknown/inactive API key", async () => {
    const deps = makeDeps();
    const { status } = await handleGenerateRequest(makeBody(), "not-a-real-key", deps);
    expect(status).toBe(401);
  });

  it("generates, renders, stores, caches, and records usage on the happy path", async () => {
    const deps = makeDeps();
    const { status, body } = await handleGenerateRequest(makeBody(), "alk_live_valid", deps);

    expect(status).toBe(200);
    const result = body as any;
    expect(result.cached).toBe(false);
    expect(result.diagramType).toBe("flowchart");
    expect(result.svgUrl).toMatch(/^https:\/\/cdn\.archlens\.dev\//);
    expect(deps.generateMermaid).toHaveBeenCalledTimes(1);

    const keyStatus = await deps.quotaStore.getKeyStatus("alk_live_valid");
    expect(keyStatus?.usedThisMonth).toBe(1);
  });

  it("detects a sequence diagram from the model output", async () => {
    const deps = makeDeps({ llmOutput: "sequenceDiagram\n  A->>B: call" });
    const { body } = await handleGenerateRequest(makeBody(), "alk_live_valid", deps);
    expect((body as any).diagramType).toBe("sequence");
  });

  it("serves a cache hit without calling the LLM or consuming quota", async () => {
    const deps = makeDeps();
    await handleGenerateRequest(makeBody(), "alk_live_valid", deps);
    deps.generateMermaid.mockClear();

    const { status, body } = await handleGenerateRequest(makeBody(), "alk_live_valid", deps);
    expect(status).toBe(200);
    expect((body as any).cached).toBe(true);
    expect(deps.generateMermaid).not.toHaveBeenCalled();

    const keyStatus = await deps.quotaStore.getKeyStatus("alk_live_valid");
    expect(keyStatus?.usedThisMonth).toBe(1); // unchanged from the first (non-cached) call
  });

  it("rejects once quota is exhausted", async () => {
    const deps = makeDeps();
    deps.quotaStore.seed("alk_live_valid", {
      active: true,
      orgId: "org_1",
      plan: "solo",
      planLimit: 1,
      usedThisMonth: 1,
    });
    const { status, body } = await handleGenerateRequest(makeBody(), "alk_live_valid", deps);
    expect(status).toBe(402);
    expect((body as any).code).toBe("quota_exceeded");
  });

  it("retries once on invalid syntax and succeeds if the repair is valid", async () => {
    const deps = makeDeps({ llmOutput: ["not a real diagram", "flowchart TD\n  A --> B"] });
    const { status, body } = await handleGenerateRequest(makeBody(), "alk_live_valid", deps);
    expect(status).toBe(200);
    // A,B get no `class` line in this bare fixture -- assignMissingCategories
    // (round 8: a real generated diagram left a node completely unclassed,
    // which silently rendered in endpoint's own blue via mermaid's default
    // theme color) deterministically appends one rather than leaving them
    // unclassed, so the repaired source is no longer byte-identical to the
    // raw repair output.
    expect((body as any).mermaidSource).toBe("flowchart TD\n  A --> B\nclass A,B logicContext\n");
    expect(deps.generateMermaid).toHaveBeenCalledTimes(2);
  });

  it("returns upstream_generation_failed if both attempts produce invalid syntax", async () => {
    const deps = makeDeps({ llmOutput: ["garbage one", "garbage two"] });
    const { status, body } = await handleGenerateRequest(makeBody(), "alk_live_valid", deps);
    expect(status).toBe(502);
    expect((body as any).code).toBe("upstream_generation_failed");
  });

  it("rejects a request with no files", async () => {
    const deps = makeDeps();
    const { status } = await handleGenerateRequest(makeBody({ files: [] }), "alk_live_valid", deps);
    expect(status).toBe(400);
  });
});
