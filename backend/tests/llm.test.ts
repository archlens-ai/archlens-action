import { describe, expect, it, vi } from "vitest";
import { buildPrompt, buildRepairPrompt, createOpenAiCompatProvider, getProvider } from "../lib/llm.js";

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

describe("getProvider", () => {
  it("defaults to openai when no provider is configured", () => {
    const provider = getProvider({ OPENAI_API_KEY: "sk-test" });
    expect(provider.name).toBe("openai");
  });

  it("uses deepseek only when explicitly opted in", () => {
    const provider = getProvider({ ARCHLENS_LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "ds-test" });
    expect(provider.name).toBe("deepseek");
  });
});
