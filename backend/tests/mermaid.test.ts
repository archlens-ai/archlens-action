import { describe, expect, it } from "vitest";
import {
  appendLegend,
  applyArchLensStyling,
  applyBoldGlowStyling,
  injectEdgeFlowAnimation,
  renderMermaidToSvg,
  validateMermaidSyntax,
} from "../lib/mermaid.js";

describe("validateMermaidSyntax", () => {
  it("accepts a valid flowchart", () => {
    expect(validateMermaidSyntax("flowchart TD\n  A --> B").valid).toBe(true);
  });

  it("accepts a valid sequence diagram", () => {
    expect(validateMermaidSyntax("sequenceDiagram\n  A->>B: hi").valid).toBe(true);
  });

  it("rejects an empty diagram", () => {
    expect(validateMermaidSyntax("   ").valid).toBe(false);
  });

  it("rejects an unrecognized diagram type", () => {
    const result = validateMermaidSyntax("pie title x\n  \"a\" : 50");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unrecognized/);
  });

  it("rejects click bindings that could invoke arbitrary JS", () => {
    const result = validateMermaidSyntax(
      'flowchart TD\n  A --> B\n  click A call myJsFunction()'
    );
    expect(result.valid).toBe(false);
  });

  it("rejects embedded script tags", () => {
    const result = validateMermaidSyntax(
      "flowchart TD\n  A[\"<script>alert(1)</script>\"] --> B"
    );
    expect(result.valid).toBe(false);
  });

  it("rejects oversized diagram source", () => {
    const huge = "flowchart TD\n" + "  A --> B\n".repeat(5000);
    expect(validateMermaidSyntax(huge).valid).toBe(false);
  });
});

describe("applyArchLensStyling", () => {
  it("appends the fixed category classDefs to a flowchart", () => {
    const styled = applyArchLensStyling('flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint');
    expect(styled).toContain("classDef endpoint");
    expect(styled).toContain("classDef logic");
    expect(styled).toContain("classDef datastore");
  });

  // Round-2 addition: distinguishing "changed by this PR" from "pre-existing
  // context" is the actual product thesis (a diff-impact visualizer, not a
  // static architecture snapshot) — a review caught that v1 didn't do this
  // at all. Every category needs both a plain and a *Context variant.
  it("appends Context variants and Region variants alongside the base categories", () => {
    const styled = applyArchLensStyling(
      'flowchart TD\n  subgraph API["API Layer"]\n    A["x"]\n  end\n  class A endpoint\n  class API endpointRegion'
    );
    for (const name of ["endpointContext", "logicContext", "datastoreContext"]) {
      expect(styled).toContain(`classDef ${name}`);
    }
    for (const name of ["endpointRegion", "logicRegion", "datastoreRegion"]) {
      expect(styled).toContain(`classDef ${name}`);
    }
  });

  // Round-3 addition, from a second review: refactors/removals are a
  // routine PR category for this audience and there was no visual state
  // for "this PR deletes X" — only changed/context.
  it("appends a removed classDef for diffs that delete a node entirely", () => {
    const styled = applyArchLensStyling('flowchart TD\n  A["x"]\n  class A removed');
    expect(styled).toContain("classDef removed");
  });

  it("strips any classDef the model emitted anyway, keeping only ArchLens's own", () => {
    const styled = applyArchLensStyling(
      'flowchart TD\n  A["x"]\n  classDef endpoint fill:#ff0000\n  class A endpoint'
    );
    expect(styled).not.toContain("#ff0000");
    expect(styled.match(/classDef endpoint\b/g)?.length).toBe(1);
  });

  it("is a no-op for sequenceDiagram (classDef doesn't apply there)", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    expect(applyArchLensStyling(source)).toBe(source);
  });
});

describe("injectEdgeFlowAnimation", () => {
  it("rewrites a plain edge with a generated edge id and appends an animate directive", () => {
    const result = injectEdgeFlowAnimation('flowchart TD\n  A --> B');
    expect(result).toMatch(/A archFlow1@--> B/);
    expect(result).toContain("archFlow1@{ animate: true }");
  });

  it("preserves an edge's label when rewriting it", () => {
    const result = injectEdgeFlowAnimation('flowchart TD\n  A -->|creates| B');
    expect(result).toMatch(/A archFlow1@-->\|creates\| B/);
  });

  it("assigns a distinct id to each edge in a multi-edge diagram", () => {
    const result = injectEdgeFlowAnimation('flowchart TD\n  A --> B\n  B --> C');
    expect(result).toContain("archFlow1@{ animate: true }");
    expect(result).toContain("archFlow2@{ animate: true }");
  });

  it("leaves non-edge lines (node declarations, class/subgraph lines) untouched", () => {
    const source = 'flowchart TD\n  A["x"]\n  class A endpoint';
    expect(injectEdgeFlowAnimation(source)).toBe(source);
  });

  it("is a no-op for sequenceDiagram, whose arrow syntax doesn't support edge ids", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    expect(injectEdgeFlowAnimation(source)).toBe(source);
  });
});

describe("applyBoldGlowStyling", () => {
  const sampleSvg = '<svg id="my-svg" viewBox="0 0 100 200"><rect width="100" height="200"/></svg>';

  it("injects a glow filter definition", () => {
    const result = applyBoldGlowStyling(sampleSvg);
    expect(result).toContain("<filter id=\"archlens-glow\"");
    expect(result).toContain("feGaussianBlur");
  });

  it("forces bold text and brighter/thicker edge lines via an override stylesheet", () => {
    const result = applyBoldGlowStyling(sampleSvg);
    expect(result).toContain("font-weight:700 !important");
    expect(result).toContain(".flowchart-link{stroke-width:2.5px !important;filter:url(#archlens-glow)");
    expect(result).toContain(".messageLine0,.messageLine1{stroke-width:2.2px !important;filter:url(#archlens-glow)");
  });

  it("preserves the rest of the SVG content", () => {
    const result = applyBoldGlowStyling(sampleSvg);
    expect(result).toContain('<rect width="100" height="200"/>');
    expect(result).toContain("</svg>");
  });
});

describe("appendLegend", () => {
  const sampleSvg =
    '<svg id="my-svg" viewBox="0 0 100 200" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="200"/></svg>';

  it("grows the viewBox to fit the legend card below the diagram", () => {
    const withLegend = appendLegend(sampleSvg, "flowchart");
    const match = withLegend.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    expect(match).not.toBeNull();
    // A 100-unit-wide diagram is far narrower than the legend card needs —
    // width must grow too, or the card clips off the edge (a real bug
    // caught in visual QA: only height was ever adjusted, never width).
    expect(Number(match?.[1])).toBeGreaterThan(100);
    expect(Number(match?.[2])).toBeGreaterThan(200);
    expect(withLegend).toContain("</svg>");
  });

  // Round-3 redesign, from a second review: v2 listed changed/context and
  // endpoint/logic/datastore as five disconnected swatches, so a viewer
  // had to cross-reference two lists to decode "solid blue". Each category
  // now gets one row pairing its solid (changed) and dashed (context)
  // swatch together, with the solid/dashed meaning explained once.
  it("pairs a solid and dashed swatch on the same row per category, not as separate disconnected entries", () => {
    const withLegend = appendLegend(sampleSvg, "flowchart");
    expect(withLegend).toContain("solid = changed by this PR");
    expect(withLegend).toContain("dashed = existing context");
    expect(withLegend).toContain("Removed by this PR");
    // Each of the 3 categories renders two swatch <rect>s on its row (solid
    // + dashed) — count non-dashed vs dashed swatch rects to confirm both
    // variants are actually present, not just the labels.
    const dashedSwatches = withLegend.match(/stroke-dasharray="3 2"/g) ?? [];
    expect(dashedSwatches.length).toBeGreaterThanOrEqual(3); // one per category row
  });

  it("draws the legend inside a bordered card rather than loose floating text", () => {
    const withLegend = appendLegend(sampleSvg, "flowchart");
    expect(withLegend).toContain('stroke="#30363d"');
  });

  it("is a no-op for sequenceDiagram, where the category legend doesn't apply", () => {
    expect(appendLegend(sampleSvg, "sequence")).toBe(sampleSvg);
  });

  it("leaves malformed SVG (no viewBox) untouched rather than corrupting it", () => {
    const noViewBox = "<svg><rect/></svg>";
    expect(appendLegend(noViewBox, "flowchart")).toBe(noViewBox);
  });
});

describe("renderMermaidToSvg (integration)", () => {
  it("renders valid mermaid source to an SVG document", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["PR: add /users endpoint"] --> B["UsersController"]\n  B --> C["users table"]',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  }, 30_000);

  // Mermaid's default flowchart config renders node/subgraph labels as HTML
  // inside <foreignObject> rather than plain SVG <text>. ARCHLENS_THEME_CONFIG
  // sets `htmlLabels: false` as a defensive portability choice (plain <text>
  // is more broadly compatible across SVG consumers in general), not because
  // of a confirmed GitHub-specific rendering failure — an earlier version of
  // this comment claimed one, and that claim didn't hold up under a properly
  // controlled re-test (see the correction in CLAUDE.md / ARCHITECTURE.md).
  // Kept as a regression test regardless: it's still testing a real property
  // worth guaranteeing (plain-text labels, not HTML-in-foreignObject).
  it("never renders flowchart labels as <foreignObject>", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  subgraph API["API Layer"]\n    A["POST /orders"]\n  end\n  A --> B["createOrder()"]\n  class A endpoint\n  class B logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(svg).not.toContain("foreignObject");
    expect(svg).toContain("<text");
  }, 30_000);

  it("applies ArchLens's dark theme palette (not mermaid's default colors)", async () => {
    const { svg } = await renderMermaidToSvg('flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint', {
      executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
    });
    expect(svg).toContain("#0d1117"); // background
    expect(svg).toContain("#58a6ff"); // endpoint accent
  }, 30_000);

  it("bakes a legend into the real rendered flowchart output end to end", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint\n  class B datastoreContext',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(svg).toContain("solid = changed by this PR");
    expect(svg).toContain("dashed = existing context");
  }, 30_000);

  // Round-5 addition, direct user feedback: confirms the animated-flow-arrow
  // and bold/glow requests actually reach the real rendered output through
  // mmdc, not just the string-manipulation unit tests above.
  it("renders a real animated, glowing edge end to end", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint\n  class B logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(svg).toContain("edge-animation-fast"); // Mermaid's real moving-dash animation class
    expect(svg).toContain("archlens-glow");
    expect(svg).toContain("font-weight:700");
  }, 30_000);

  it("refuses to render invalid mermaid source", async () => {
    await expect(renderMermaidToSvg("not a real diagram")).rejects.toThrow(/invalid diagram/);
  });
});
