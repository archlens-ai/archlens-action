import { describe, expect, it } from "vitest";
import { InMemoryDiagramCache, computeDiffHash } from "../lib/cache.js";

describe("computeDiffHash", () => {
  it("is deterministic for the same input", () => {
    const files = [{ filename: "a.sql", status: "modified", patch: "+CREATE TABLE a();" }];
    expect(computeDiffHash(files, "auto")).toBe(computeDiffHash(files, "auto"));
  });

  it("is independent of input file order", () => {
    const a = [
      { filename: "a.sql", status: "modified", patch: "+1" },
      { filename: "b.sql", status: "modified", patch: "+2" },
    ];
    const b = [
      { filename: "b.sql", status: "modified", patch: "+2" },
      { filename: "a.sql", status: "modified", patch: "+1" },
    ];
    expect(computeDiffHash(a, "auto")).toBe(computeDiffHash(b, "auto"));
  });

  it("changes when the diagram type hint changes", () => {
    const files = [{ filename: "a.sql", status: "modified", patch: "+1" }];
    expect(computeDiffHash(files, "auto")).not.toBe(computeDiffHash(files, "sequence"));
  });

  it("changes when patch content changes", () => {
    const a = [{ filename: "a.sql", status: "modified", patch: "+1" }];
    const b = [{ filename: "a.sql", status: "modified", patch: "+2" }];
    expect(computeDiffHash(a, "auto")).not.toBe(computeDiffHash(b, "auto"));
  });
});

describe("InMemoryDiagramCache", () => {
  it("returns null on miss and the stored value on hit", async () => {
    const cache = new InMemoryDiagramCache();
    expect(await cache.get("abc")).toBeNull();
    await cache.put("abc", {
      svgUrl: "https://cdn/x.svg",
      mermaidSource: "flowchart TD\n  A --> B",
      diagramType: "flowchart",
    });
    expect(await cache.get("abc")).toMatchObject({ svgUrl: "https://cdn/x.svg" });
  });
});
