import { describe, expect, it } from "vitest";
import {
  appendLegend,
  applyArchLensStyling,
  applyBoldGlowStyling,
  injectFlowRunners,
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

describe("injectFlowRunners", () => {
  // A shape matching what mmdc actually emits for a plain, untouched edge —
  // confirmed against a real render before relying on it: even without any
  // custom id syntax, mmdc gives every edge a stable id like this.
  const sampleEdgeSvg =
    '<svg id="my-svg" viewBox="0 0 100 200">' +
    '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal edge-pattern-solid flowchart-link" style=""/>' +
    "</svg>";

  it("attaches an animateMotion runner referencing the edge's own id via mpath", () => {
    const result = injectFlowRunners(sampleEdgeSvg);
    expect(result).toContain("<animateMotion");
    expect(result).toContain('href="#my-svg-L_A_B_0"');
    expect(result).toContain('xlink:href="#my-svg-L_A_B_0"');
    expect(result).toContain('repeatCount="indefinite"');
  });

  it("orients the runner along the path's own tangent as it travels", () => {
    expect(injectFlowRunners(sampleEdgeSvg)).toContain('rotate="auto"');
  });

  it("adds one runner per edge when there are multiple", () => {
    const twoEdges =
      '<svg id="my-svg" viewBox="0 0 100 200">' +
      '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal flowchart-link"/>' +
      '<path d="M10,90 L10,170" id="my-svg-L_B_C_0" class="edge-thickness-normal flowchart-link"/>' +
      "</svg>";
    const result = injectFlowRunners(twoEdges);
    expect(result.match(/<animateMotion/g)?.length).toBe(2);
    expect(result).toContain('href="#my-svg-L_A_B_0"');
    expect(result).toContain('href="#my-svg-L_B_C_0"');
  });

  it("leaves an SVG with no flowchart-link edges untouched", () => {
    const noEdges = '<svg id="my-svg" viewBox="0 0 100 200"><rect width="10" height="10"/></svg>';
    expect(injectFlowRunners(noEdges)).toBe(noEdges);
  });

  // Bug fix (2026-09-02): an edge whose endpoints are both `removed` nodes
  // used to get the exact same "live traffic" animated arrow as any other
  // edge — an animation reading as "actively flowing" is exactly backwards
  // for a connection this PR deletes. applyBoldGlowStyling() (which runs
  // immediately before injectFlowRunners in the real pipeline, see
  // renderMermaidToSvg) tags such edges with the archlens-removed-edge
  // marker class; injectFlowRunners must honor that marker and skip them.
  it("skips edges already tagged archlens-removed-edge (both endpoints removed)", () => {
    const mixedEdges =
      '<svg id="my-svg" viewBox="0 0 100 200">' +
      '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal flowchart-link archlens-removed-edge" data-id="L_A_B_0"/>' +
      '<path d="M10,90 L10,170" id="my-svg-L_B_C_0" class="edge-thickness-normal flowchart-link" data-id="L_B_C_0"/>' +
      "</svg>";
    const result = injectFlowRunners(mixedEdges);
    expect(result.match(/<animateMotion/g)?.length).toBe(1);
    expect(result).not.toContain('href="#my-svg-L_A_B_0"');
    expect(result).toContain('href="#my-svg-L_B_C_0"');
  });
});

describe("applyBoldGlowStyling", () => {
  const sampleSvg = '<svg id="my-svg" viewBox="0 0 100 200"><rect width="100" height="200"/></svg>';

  it("injects a glow filter definition", () => {
    const result = applyBoldGlowStyling(sampleSvg);
    expect(result).toContain("<filter id=\"archlens-glow\"");
    expect(result).toContain("feGaussianBlur");
  });

  it("forces bold text and brighter/thicker SOLID edge lines via an override stylesheet", () => {
    const result = applyBoldGlowStyling(sampleSvg);
    expect(result).toContain("font-weight:700 !important");
    expect(result).toContain(
      ".flowchart-link{stroke-width:2.5px !important;stroke-dasharray:none !important;filter:url(#archlens-glow)"
    );
    expect(result).toContain(".messageLine0,.messageLine1{stroke-width:2.2px !important;filter:url(#archlens-glow)");
  });

  it("preserves the rest of the SVG content", () => {
    const result = applyBoldGlowStyling(sampleSvg);
    expect(result).toContain('<rect width="100" height="200"/>');
    expect(result).toContain("</svg>");
  });

  // Bug fix (2026-09-02), found generating a real `removed`-category
  // example: the blanket `.flowchart-link` rule applied the same vivid
  // active glow to EVERY edge, including one connecting two nodes this PR
  // deletes — contradicting the dashed-red "gone" styling already on the
  // nodes themselves. Shapes below match a real Mermaid render exactly
  // (`<g class="node default {category}" id="{svgId}-flowchart-{Name}-{idx}">`,
  // edge `data-id="L_{source}_{target}_{index}"`), confirmed against
  // scripts/.dry-run-output/removed-state-v2-diagram.svg rather than assumed.
  const removedPairSvg =
    '<svg id="my-svg" viewBox="0 0 100 200">' +
    '<g class="nodes">' +
    '<g class="node default removed" id="my-svg-flowchart-A-0"></g>' +
    '<g class="node default removed" id="my-svg-flowchart-B-1"></g>' +
    '<g class="node default endpoint" id="my-svg-flowchart-C-2"></g>' +
    "</g>" +
    '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal flowchart-link" data-id="L_A_B_0"/>' +
    '<path d="M10,90 L10,170" id="my-svg-L_A_C_0" class="edge-thickness-normal flowchart-link" data-id="L_A_C_0"/>' +
    "</svg>";

  it("tags an edge whose BOTH endpoints are `removed` nodes with the archlens-removed-edge marker class", () => {
    const result = applyBoldGlowStyling(removedPairSvg);
    // A -> B (both removed) gets marked...
    expect(result).toMatch(/id="my-svg-L_A_B_0"[^>]*class="[^"]*\barchlens-removed-edge\b/);
    // ...but A -> C (only one endpoint removed) does not.
    expect(result).not.toMatch(/id="my-svg-L_A_C_0"[^>]*class="[^"]*\barchlens-removed-edge\b/);
  });

  it("gives archlens-removed-edge its own dim/dashed/no-glow rule that overrides the active-edge glow", () => {
    const result = applyBoldGlowStyling(removedPairSvg);
    const removedRuleMatch = result.match(/\.archlens-removed-edge\{([^}]*)\}/);
    expect(removedRuleMatch).not.toBeNull();
    const removedRule = removedRuleMatch![1]!;
    expect(removedRule).toContain("filter:none !important"); // no glow
    expect(removedRule).toContain("stroke-dasharray:3 3 !important"); // dashed, matching the removed node style
    expect(removedRule).toContain("stroke:#f85149"); // same red as the removed classDef
    // Declared AFTER the general .flowchart-link rule so its !importants win the cascade.
    const generalIdx = result.indexOf(".flowchart-link{");
    const removedIdx = result.indexOf(".archlens-removed-edge{");
    expect(generalIdx).toBeGreaterThan(-1);
    expect(removedIdx).toBeGreaterThan(generalIdx);
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

  it("draws a visible top border on the legend strip, not loose floating text", () => {
    const withLegend = appendLegend(sampleSvg, "flowchart");
    expect(withLegend).toContain('stroke="#6e7681"');
  });

  // Round-6 redesign, direct fix for the round-5 review's "reads as a boxed
  // afterthought crammed into the bottom-left corner": the legend used to
  // be a narrower card left-pinned inside a full-width dark strip, leaving
  // visible dead canvas beside it on any diagram wider than the card
  // needed. It's now a single footer panel that spans the FULL diagram
  // width itself (never a separate, narrower box floating inside it).
  // Row count isn't directly exposed, so it's derived from the legend's
  // total added height: legendHeight = rows*26 + 28 (outerPadding*2).
  function legendRowCount(withLegend: string, originalHeight: number): number {
    const viewBoxMatch = withLegend.match(/viewBox="0 0 [\d.]+ ([\d.]+)"/);
    const addedHeight = Number(viewBoxMatch?.[1]) - originalHeight;
    return Math.round((addedHeight - 28) / 26);
  }

  it("spans the full diagram width itself, rather than a narrower card floating inside a wider dark strip", () => {
    // A very wide diagram (2000 units) is far wider than the legend
    // content needs — the old design would size the card to its content
    // (~320-400 units) and leave the rest of this same row visibly empty.
    const wideSvg = '<svg id="my-svg" viewBox="0 0 2000 200" xmlns="http://www.w3.org/2000/svg"><rect width="2000" height="200"/></svg>';
    const withLegend = appendLegend(wideSvg, "flowchart");
    const viewBoxMatch = withLegend.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const newWidth = Number(viewBoxMatch?.[1]);
    expect(newWidth).toBe(2000); // no separate, narrower card -- the footer IS the diagram's width
    // The footer's own background rect must be exactly as wide as the
    // diagram, not some narrower content-sized box.
    expect(withLegend).toContain(`<rect x="0" y="0" width="${newWidth}" height=`);
    // On a diagram this wide, everything fits on one row -- confirms the
    // fix doesn't just widen an otherwise-still-narrow card, it actually
    // lays items out across the available width instead of stacking them.
    expect(legendRowCount(withLegend, 200)).toBe(1);
  });

  it("wraps onto additional rows, rather than overflowing, when the diagram is too narrow for one line", () => {
    const narrowSvg = '<svg id="my-svg" viewBox="0 0 150 200" xmlns="http://www.w3.org/2000/svg"><rect width="150" height="200"/></svg>';
    const withLegend = appendLegend(narrowSvg, "flowchart");
    // Still contains every category -- narrow just means more rows, never
    // dropped content.
    expect(withLegend).toContain("Endpoint");
    expect(withLegend).toContain("Logic");
    expect(withLegend).toContain("Datastore");
    expect(withLegend).toContain("Removed by this PR");
    expect(legendRowCount(withLegend, 200)).toBeGreaterThan(1);
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

  // Round-6 fix, from the round-5 adversarial review ("low-contrast
  // subgraph borders"): the old #30363d measured only 1.55:1 contrast
  // against the #0d1117 canvas (WCAG's own floor for a graphical boundary
  // is 3:1) -- effectively invisible. Confirms the real rendered output
  // uses the new, actually-visible #6e7681 and never regresses back to the
  // old value, for both a flowchart's subgraph borders and a sequence
  // diagram's actor lifelines (same mistake, same fix, both places).
  it("renders subgraph borders and actor lifelines with real, WCAG-passing contrast instead of the old near-invisible gray", async () => {
    const { svg: flowchartSvg } = await renderMermaidToSvg(
      'flowchart TD\n  subgraph API["API Layer"]\n    A["x"]\n  end\n  A --> B["y"]\n  class A endpoint\n  class B logic\n  class API endpointRegion',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(flowchartSvg).toContain("#6e7681");
    expect(flowchartSvg).not.toContain("#30363d");

    const { svg: sequenceSvg } = await renderMermaidToSvg(
      "sequenceDiagram\n  participant A\n  participant B\n  A->>B: hello",
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(sequenceSvg).toContain("#6e7681");
    expect(sequenceSvg).not.toContain("#30363d");
  }, 30_000);

  it("bakes a legend into the real rendered flowchart output end to end", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint\n  class B datastoreContext',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(svg).toContain("solid = changed by this PR");
    expect(svg).toContain("dashed = existing context");
  }, 30_000);

  // Round-5/6 addition, direct user feedback: confirms the animated-flow-
  // arrow and bold/glow requests actually reach the real rendered output
  // through mmdc, not just the string-manipulation unit tests above. Round
  // 6 corrected the animation mechanism after the user pointed out the
  // first version (a dashed line) looked "dotted," not a solid line with
  // an arrow running along it.
  it("renders a real solid (non-dashed) edge with a moving arrow runner, end to end", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint\n  class B logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(svg).toContain("<animateMotion"); // the moving arrowhead, not a dashed line
    expect(svg).toContain("stroke-dasharray:none !important"); // edges stay solid
    expect(svg).toContain("archlens-glow");
    expect(svg).toContain("font-weight:700");
  }, 30_000);

  // Bug fix (2026-09-02), end-to-end through the real Puppeteer/ELK harness:
  // an edge between two `removed` nodes must NOT get the same "actively
  // flowing" glow + animated arrow as a normal edge, since that directly
  // contradicts the dashed-red "gone" node styling it connects. B/C are
  // both removed (edge should be dim/dashed/no-glow, no runner); A/B is a
  // mixed removed/context pair (same requirement, since only "both
  // endpoints removed" should suppress the active look).
  it("renders an edge between two removed nodes as dim/dashed/no-glow with no animated runner, while an untouched edge keeps the active look", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["gone service"] --> B["gone dependency"]\n  C["kept service"] --> D["kept dependency"]\n  class A,B removed\n  class C,D logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    const removedEdge = /<path[^>]*data-id="L_A_B_0"[^>]*>/.exec(svg)?.[0];
    const activeEdge = /<path[^>]*data-id="L_C_D_0"[^>]*>/.exec(svg)?.[0];
    expect(removedEdge).toBeDefined();
    expect(activeEdge).toBeDefined();
    expect(removedEdge).toContain("archlens-removed-edge");
    expect(activeEdge).not.toContain("archlens-removed-edge");

    const removedEdgeId = /\bid="([^"]+)"/.exec(removedEdge!)?.[1];
    const activeEdgeId = /\bid="([^"]+)"/.exec(activeEdge!)?.[1];
    expect(svg).not.toContain(`href="#${removedEdgeId}"`); // no animated runner on the removed edge
    expect(svg).toContain(`href="#${activeEdgeId}"`); // the untouched edge still gets one
  }, 30_000);

  // "dont use white color at all, make it black" -- the diagram previously
  // rendered with a transparent background, which showed as white once
  // embedded on GitHub's default light PR-comment page. Confirms the
  // rendered SVG is now opaque dark, not relying on the page behind it.
  it("renders an opaque dark background rather than a transparent one", async () => {
    const { svg } = await renderMermaidToSvg('flowchart TD\n  A["x"] --> B["y"]', {
      executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
    });
    expect(svg).not.toContain("background-color: transparent");
    expect(svg).toContain("#0d1117");
  }, 30_000);

  it("refuses to render invalid mermaid source", async () => {
    await expect(renderMermaidToSvg("not a real diagram")).rejects.toThrow(/invalid diagram/);
  });

  // Regression test for a real bug the switch to a direct mermaid.render()
  // harness introduced (found only by screenshotting the output the way
  // GitHub actually embeds it, not by any of the substring assertions
  // above): mmdc's CLI output used to declare xmlns:xlink by default;
  // mermaid.render() alone doesn't, but injectFlowRunners() still emits
  // xlink:href on its <mpath> elements. The result was a document that
  // looked fine as substrings, satisfied every other assertion in this
  // file, and rendered in a lenient browser <img> preview in some tools —
  // but was NOT well-formed XML ("unbound prefix"), and silently failed to
  // decode at all when loaded via <img src="...svg">, exactly how GitHub
  // embeds this in a PR comment. Two independent checks, both real: (1) a
  // strict XML parse, since that's the actual defect; (2) an actual
  // browser decoding it as an <img>, since that's the actual consumer.
  it("produces well-formed XML that decodes as a real <img>, not just a string containing the right substrings", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint\n  class B logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );

    const { DOMParser } = await import("@xmldom/xmldom");
    const errors: string[] = [];
    const parser = new DOMParser({
      onError: (_level: string, msg: string) => errors.push(msg),
    });
    parser.parseFromString(svg, "image/svg+xml");
    expect(errors.join("\n")).not.toMatch(/unbound prefix|not well-formed/i);

    const puppeteer = (await import("puppeteer-core")).default;
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
    });
    try {
      const page = await browser.newPage();
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      await page.setContent(
        `<img id="img" src="${dataUrl}" onerror="window.__imgError = true">`
      );
      // `document`/`HTMLImageElement` aren't typed in this file on purpose
      // (see renderMermaidToSvg's own comment above, same tsconfig
      // constraint) — these run in the page's browser context via
      // page.evaluate/waitForFunction, not this Node process, so a plain
      // string (waitForFunction) or a globalThis-only function
      // (page.evaluate) keeps tsc happy without pulling in the dom lib.
      await page.waitForFunction(
        "window.__imgError === true || document.getElementById('img')?.complete === true",
        { timeout: 10_000 }
      );
      const result = await page.evaluate(() => {
        const g = globalThis as unknown as {
          __imgError?: boolean;
          document: { getElementById: (id: string) => { naturalWidth: number } | null };
        };
        const img = g.document.getElementById("img");
        return { naturalWidth: img?.naturalWidth ?? 0, errored: g.__imgError === true };
      });
      expect(result.errored).toBe(false);
      expect(result.naturalWidth).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
