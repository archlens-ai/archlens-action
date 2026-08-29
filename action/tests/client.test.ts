import { describe, expect, it, vi } from "vitest";
import { ArchLensApiError, generateDiagram } from "../src/client.js";
import type { CompressedDiff } from "../src/diff.js";

const sampleDiff: CompressedDiff = {
  matched: true,
  files: [{ filename: "a.sql", status: "modified", patch: "+CREATE TABLE a();" }],
  totalBytes: 42,
  truncated: false,
};

function fakeFetch(status: number, jsonBody: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  }) as unknown as typeof fetch;
}

describe("generateDiagram", () => {
  it("returns the parsed response on success", async () => {
    const result = await generateDiagram(
      "https://api.archlens.dev",
      { apiKey: "alk_live_x", owner: "acme", repo: "widgets", prNumber: 1, diagramType: "auto", diff: sampleDiff },
      fakeFetch(200, {
        svgUrl: "https://cdn.archlens.dev/abc.svg",
        mermaidSource: "flowchart TD\n  A --> B",
        diagramType: "flowchart",
        cached: false,
      })
    );
    expect(result.svgUrl).toBe("https://cdn.archlens.dev/abc.svg");
  });

  it("throws a typed unauthorized error on 401", async () => {
    await expect(
      generateDiagram(
        "https://api.archlens.dev",
        { apiKey: "bad", owner: "acme", repo: "widgets", prNumber: 1, diagramType: "auto", diff: sampleDiff },
        fakeFetch(401, {})
      )
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 } satisfies Partial<ArchLensApiError>);
  });

  it("throws a typed quota_exceeded error on 402", async () => {
    await expect(
      generateDiagram(
        "https://api.archlens.dev",
        { apiKey: "alk_live_x", owner: "acme", repo: "widgets", prNumber: 1, diagramType: "auto", diff: sampleDiff },
        fakeFetch(402, { message: "quota exceeded" })
      )
    ).rejects.toMatchObject({ code: "quota_exceeded", status: 402 });
  });

  it("throws malformed_response when required fields are missing", async () => {
    await expect(
      generateDiagram(
        "https://api.archlens.dev",
        { apiKey: "alk_live_x", owner: "acme", repo: "widgets", prNumber: 1, diagramType: "auto", diff: sampleDiff },
        fakeFetch(200, { svgUrl: "" })
      )
    ).rejects.toMatchObject({ code: "malformed_response" });
  });
});
