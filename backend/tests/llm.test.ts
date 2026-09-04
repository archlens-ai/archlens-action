import { describe, expect, it, vi } from "vitest";
import {
  buildPrompt,
  buildRepairPrompt,
  createAnthropicProvider,
  createOpenAiCompatProvider,
  createTieredAnthropicProvider,
  getProvider,
} from "../lib/llm.js";

describe("buildPrompt", () => {
  it("includes file contents and a diagram-type hint", () => {
    const prompt = buildPrompt(
      [{ filename: "routes/users.ts", status: "modified", patch: "+router.post('/users')" }],
      "sequence"
    );
    expect(prompt).toContain("routes/users.ts");
    expect(prompt).toContain("router.post('/users')");
    expect(prompt).toContain("sequenceDiagram");
  });

  it("omits the hint when diagramType is auto", () => {
    const prompt = buildPrompt(
      [{ filename: "a.sql", status: "added", patch: "+CREATE TABLE a();" }],
      "auto"
    );
    expect(prompt).not.toContain("Use diagram type");
  });

  // Added after a harsh-review loop found the LLM's diagrams become
  // unreadable (edges crossing nodes, subgraph containment breaking) past
  // ~10-14 nodes on realistic multi-file PRs. The trigger for asking the
  // model to switch to a coarser view is computed in code from
  // files.length, not left for the model to notice on its own.
  it("switches to COARSE MODE once the file count passes the threshold", () => {
    const manyFiles = Array.from({ length: 7 }, (_, i) => ({
      filename: `src/services/service${i}.ts`,
      status: "modified",
      patch: `+export function handle${i}() {}`,
    }));
    const prompt = buildPrompt(manyFiles, "auto");
    expect(prompt).toContain("COARSE MODE");
    expect(prompt).toContain("7 files");
  });

  it("does not mention COARSE MODE for a small diff", () => {
    const prompt = buildPrompt(
      [{ filename: "a.ts", status: "modified", patch: "+export function a() {}" }],
      "auto"
    );
    expect(prompt).not.toContain("COARSE MODE");
  });
});

describe("buildRepairPrompt", () => {
  it("includes the validation error and previous output", () => {
    const prompt = buildRepairPrompt("garbage output", "unrecognized declaration");
    expect(prompt).toContain("unrecognized declaration");
    expect(prompt).toContain("garbage output");
  });
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

describe("createOpenAiCompatProvider", () => {
  it("extracts message content from a successful response", async () => {
    const provider = createOpenAiCompatProvider(
      { name: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-test", model: "gpt-4o-mini" },
      fakeFetch(200, { choices: [{ message: { content: "flowchart TD\n  A --> B" } }] })
    );
    const result = await provider.generateMermaid("some prompt");
    expect(result).toBe("flowchart TD\n  A --> B");
  });

  it("strips a markdown code fence if the model adds one anyway", async () => {
    const provider = createOpenAiCompatProvider(
      { name: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-test", model: "gpt-4o-mini" },
      fakeFetch(200, {
        choices: [{ message: { content: "```mermaid\nflowchart TD\n  A --> B\n```" } }],
      })
    );
    const result = await provider.generateMermaid("some prompt");
    expect(result).toBe("flowchart TD\n  A --> B");
  });

  it("throws when the API key is missing", async () => {
    const provider = createOpenAiCompatProvider({
      name: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "",
      model: "gpt-4o-mini",
    });
    await expect(provider.generateMermaid("x")).rejects.toThrow(/Missing API key/);
  });

  it("throws with the status code on a non-ok response", async () => {
    const provider = createOpenAiCompatProvider(
      { name: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-test", model: "gpt-4o-mini" },
      fakeFetch(500, { error: "boom" })
    );
    await expect(provider.generateMermaid("x")).rejects.toThrow(/500/);
  });
});

describe("createAnthropicProvider", () => {
  it("extracts the text block from a successful Messages API response", async () => {
    const provider = createAnthropicProvider(
      { apiKey: "sk-ant-test", model: "claude-haiku-4-5" },
      fakeFetch(200, { content: [{ type: "text", text: "flowchart TD\n  A --> B" }] })
    );
    const result = await provider.generateMermaid("some prompt");
    expect(result).toBe("flowchart TD\n  A --> B");
  });

  it("strips a markdown code fence if the model adds one anyway", async () => {
    const provider = createAnthropicProvider(
      { apiKey: "sk-ant-test", model: "claude-haiku-4-5" },
      fakeFetch(200, { content: [{ type: "text", text: "```mermaid\nflowchart TD\n  A --> B\n```" }] })
    );
    const result = await provider.generateMermaid("some prompt");
    expect(result).toBe("flowchart TD\n  A --> B");
  });

  it("throws when the API key is missing", async () => {
    const provider = createAnthropicProvider({ apiKey: "", model: "claude-haiku-4-5" });
    await expect(provider.generateMermaid("x")).rejects.toThrow(/Missing API key/);
  });

  it("throws with the status code on a non-ok response", async () => {
    const provider = createAnthropicProvider(
      { apiKey: "sk-ant-test", model: "claude-haiku-4-5" },
      fakeFetch(500, { error: "boom" })
    );
    await expect(provider.generateMermaid("x")).rejects.toThrow(/500/);
  });

  it("throws when the response has no text content block", async () => {
    const provider = createAnthropicProvider(
      { apiKey: "sk-ant-test", model: "claude-haiku-4-5" },
      fakeFetch(200, { content: [] })
    );
    await expect(provider.generateMermaid("x")).rejects.toThrow(/no text content/);
  });

  // Real, measured API behavior (2026-09-04, not a guess): a direct call to
  // claude-sonnet-5 with `temperature` set was rejected outright with 400
  // "`temperature` is deprecated for this model." createAnthropicProvider
  // must retry once without it rather than surfacing that as a hard failure.
  it("retries once without temperature when the API says it's deprecated for this model", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ type: "error", error: { message: "`temperature` is deprecated for this model." } }),
        text: async () => JSON.stringify({ error: { message: "`temperature` is deprecated for this model." } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "flowchart TD\n  A --> B" }] }),
        text: async () => "",
      });

    const provider = createAnthropicProvider(
      { apiKey: "sk-ant-test", model: "claude-sonnet-5" },
      fetchImpl as unknown as typeof fetch
    );
    const result = await provider.generateMermaid("some prompt");
    expect(result).toBe("flowchart TD\n  A --> B");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(firstBody.temperature).toBe(0.2);
    expect(secondBody.temperature).toBeUndefined();
  });

  it("does not retry a 400 for an unrelated reason", async () => {
    const provider = createAnthropicProvider(
      { apiKey: "sk-ant-test", model: "claude-haiku-4-5" },
      fakeFetch(400, { error: { message: "invalid request: messages must not be empty" } })
    );
    await expect(provider.generateMermaid("x")).rejects.toThrow(/400/);
  });
});

describe("createTieredAnthropicProvider", () => {
  function fetchRecording() {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.model as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "flowchart TD\n  A --> B" }] }),
        text: async () => "",
      };
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }

  it("uses the small model when fileCount is at/below the threshold", async () => {
    const { fetchImpl, calls } = fetchRecording();
    const provider = createTieredAnthropicProvider(
      { apiKey: "sk-ant-test", smallModel: "claude-haiku-4-5", largeModel: "claude-sonnet-5", threshold: 6 },
      fetchImpl
    );
    await provider.generateMermaid("prompt", { fileCount: 3 });
    await provider.generateMermaid("prompt", { fileCount: 6 });
    expect(calls).toEqual(["claude-haiku-4-5", "claude-haiku-4-5"]);
  });

  it("escalates to the large model once fileCount exceeds the threshold", async () => {
    const { fetchImpl, calls } = fetchRecording();
    const provider = createTieredAnthropicProvider(
      { apiKey: "sk-ant-test", smallModel: "claude-haiku-4-5", largeModel: "claude-sonnet-5", threshold: 6 },
      fetchImpl
    );
    await provider.generateMermaid("prompt", { fileCount: 7 });
    expect(calls).toEqual(["claude-sonnet-5"]);
  });

  it("defaults to the small model when no fileCount is given at all", async () => {
    const { fetchImpl, calls } = fetchRecording();
    const provider = createTieredAnthropicProvider(
      { apiKey: "sk-ant-test", smallModel: "claude-haiku-4-5", largeModel: "claude-sonnet-5" },
      fetchImpl
    );
    await provider.generateMermaid("prompt");
    expect(calls).toEqual(["claude-haiku-4-5"]);
  });
});

describe("getProvider", () => {
  it("defaults to anthropic when no provider is configured", () => {
    const provider = getProvider({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(provider.name).toBe("anthropic");
  });

  it("defaults to the tiered small/large split when no single model is forced", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.model as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "flowchart TD\n  A --> B" }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const provider = getProvider({ ANTHROPIC_API_KEY: "sk-ant-test" }, fetchImpl);
    await provider.generateMermaid("p", { fileCount: 2 });
    await provider.generateMermaid("p", { fileCount: 20 });
    expect(calls).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
  });

  it("ARCHLENS_ANTHROPIC_MODEL forces a single model and disables tiering", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.model as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "flowchart TD\n  A --> B" }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const provider = getProvider(
      { ANTHROPIC_API_KEY: "sk-ant-test", ARCHLENS_ANTHROPIC_MODEL: "claude-opus-5" },
      fetchImpl
    );
    await provider.generateMermaid("p", { fileCount: 20 });
    expect(calls).toEqual(["claude-opus-5"]);
  });

  it("uses openai only when explicitly opted in", () => {
    const provider = getProvider({ ARCHLENS_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
    expect(provider.name).toBe("openai");
  });

  it("uses deepseek only when explicitly opted in", () => {
    const provider = getProvider({ ARCHLENS_LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "ds-test" });
    expect(provider.name).toBe("deepseek");
  });
});
