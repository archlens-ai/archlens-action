import { describe, expect, it } from "vitest";
import {
  appendLegend,
  applyArchLensStyling,
  applyBoldGlowStyling,
  injectFlowRunners,
  injectFlowRunnersCss,
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

  // Round-10 finding: a real, reproducible (2/2 live API runs) case of the
  // model bleeding flowchart-only `class`/`classDef` syntax into a
  // sequenceDiagram response. Without this check, validateMermaidSyntax
  // reported "valid" (it only looked at the first line's declared type and
  // a fixed disallowed-content list), so generate-handler's one repair
  // retry never fired -- the real mermaid parser only rejected it much
  // later, inside the render step, as an unrecoverable failure.
  it("rejects a sequenceDiagram that contains a flowchart-only 'class' statement", () => {
    const result = validateMermaidSyntax(
      "sequenceDiagram\n  A->>B: hi\n  class A,B endpoint"
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/class.*classDef/i);
  });

  it("rejects a sequenceDiagram that contains a flowchart-only 'classDef' statement", () => {
    const result = validateMermaidSyntax(
      "sequenceDiagram\n  A->>B: hi\n  classDef endpoint fill:#000"
    );
    expect(result.valid).toBe(false);
  });

  it("does not flag a flowchart's own legitimate 'class' statement", () => {
    const result = validateMermaidSyntax('flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint');
    expect(result.valid).toBe(true);
  });
});

describe("applyArchLensStyling", () => {
  it("appends the fixed category classDefs to a flowchart", () => {
    const styled = applyArchLensStyling('flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint');
    expect(styled).toContain("classDef endpoint");
    expect(styled).toContain("classDef logic");
    expect(styled).toContain("classDef datastore");
    expect(styled).toContain("classDef external");
  });

  // Round-2 addition: distinguishing "changed by this PR" from "pre-existing
  // context" is the actual product thesis (a diff-impact visualizer, not a
  // static architecture snapshot) — a review caught that v1 didn't do this
  // at all. Every category needs both a plain and a *Context variant.
  it("appends Context variants and Region variants alongside the base categories", () => {
    const styled = applyArchLensStyling(
      'flowchart TD\n  subgraph API["API Layer"]\n    A["x"]\n  end\n  class A endpoint\n  class API endpointRegion'
    );
    for (const name of ["endpointContext", "logicContext", "datastoreContext", "externalContext"]) {
      expect(styled).toContain(`classDef ${name}`);
    }
    for (const name of ["endpointRegion", "logicRegion", "datastoreRegion", "externalRegion"]) {
      expect(styled).toContain(`classDef ${name}`);
    }
  });

  // Round-7 addition: `external` (a third-party dependency this system only
  // calls, e.g. a payment gateway) must render visually distinct from
  // `datastore` (a table/queue this system owns) — a real adversarial
  // review caught PaymentGateway/EventBus/NotificationService rendered
  // identically to actual SQL tables because there was no fourth category.
  it("gives external its own stroke color, distinct from datastore", () => {
    const styled = applyArchLensStyling('flowchart TD\n  A["x"]\n  class A external');
    const externalDef = styled.split("\n").find((l) => l.startsWith("classDef external "));
    const datastoreDef = styled.split("\n").find((l) => l.startsWith("classDef datastore "));
    expect(externalDef).toBeDefined();
    expect(datastoreDef).toBeDefined();
    const externalStroke = /stroke:(#[0-9a-f]+)/.exec(externalDef!)?.[1];
    const datastoreStroke = /stroke:(#[0-9a-f]+)/.exec(datastoreDef!)?.[1];
    expect(externalStroke).toBeDefined();
    expect(externalStroke).not.toBe(datastoreStroke);
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

  // Bug fix (2026-09-02): an edge touching a `removed` node used to get
  // the exact same "live traffic" animated arrow as any other edge — an
  // animation reading as "actively flowing" is exactly backwards for a
  // connection touching something this PR deletes. applyBoldGlowStyling()
  // (which runs immediately before injectFlowRunners in the real
  // pipeline, see renderMermaidToSvg) tags such edges with the
  // archlens-removed-edge marker class; injectFlowRunners must honor that
  // marker and skip them.
  it("skips edges already tagged archlens-removed-edge", () => {
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

// Added 2026-09-06 (CLAUDE.md item 23/24): a real GitHub PR test found the
// SMIL-based injectFlowRunners() runner does not play when the SVG is
// embedded via <img src="...">, GitHub's actual PR-comment mechanism.
// injectFlowRunnersCss() is the candidate fix -- same visual effect via
// CSS offset-path/offset-distance + @keyframes instead of
// <animateMotion>/<mpath>, on the theory (unverified until the next
// real-PR round-trip) that browsers commonly keep running CSS animations
// in image context even when they suspend SMIL's own timeline.
describe("injectFlowRunnersCss", () => {
  const sampleEdgeSvg =
    '<svg id="my-svg" viewBox="0 0 100 200">' +
    '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal edge-pattern-solid flowchart-link" style=""/>' +
    "</svg>";

  it("attaches a CSS offset-path runner reading the edge's own d geometry", () => {
    const result = injectFlowRunnersCss(sampleEdgeSvg);
    expect(result).toContain("offset-path:path('M10,10 L10,90')");
    expect(result).toContain("archlens-flow-runner");
  });

  it("declares a @keyframes rule driving offset-distance, and an animation rule referencing it", () => {
    const result = injectFlowRunnersCss(sampleEdgeSvg);
    expect(result).toMatch(/@keyframes archlens-flow\{from\{offset-distance:0%;\}to\{offset-distance:100%;\}\}/);
    expect(result).toMatch(/\.archlens-flow-runner\{[^}]*animation:archlens-flow 2\.8s linear infinite;/);
  });

  it("orients the runner along the path's own tangent via offset-rotate", () => {
    expect(injectFlowRunnersCss(sampleEdgeSvg)).toContain("offset-rotate:auto");
  });

  it("uses no SMIL elements at all", () => {
    const result = injectFlowRunnersCss(sampleEdgeSvg);
    expect(result).not.toContain("<animateMotion");
    expect(result).not.toContain("<mpath");
  });

  it("adds one runner per edge when there are multiple", () => {
    const twoEdges =
      '<svg id="my-svg" viewBox="0 0 100 200">' +
      '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal flowchart-link"/>' +
      '<path d="M10,90 L10,170" id="my-svg-L_B_C_0" class="edge-thickness-normal flowchart-link"/>' +
      "</svg>";
    const result = injectFlowRunnersCss(twoEdges);
    expect(result.match(/class="archlens-flow-runner"/g)?.length).toBe(2);
    expect(result).toContain("offset-path:path('M10,10 L10,90')");
    expect(result).toContain("offset-path:path('M10,90 L10,170')");
  });

  it("leaves an SVG with no flowchart-link edges untouched", () => {
    const noEdges = '<svg id="my-svg" viewBox="0 0 100 200"><rect width="10" height="10"/></svg>';
    expect(injectFlowRunnersCss(noEdges)).toBe(noEdges);
  });

  // Same root cause and same fix shape as injectFlowRunners()'s equivalent
  // test above: an edge touching a `removed` node must not get a "live
  // traffic" animation either way.
  it("skips edges already tagged archlens-removed-edge", () => {
    const mixedEdges =
      '<svg id="my-svg" viewBox="0 0 100 200">' +
      '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal flowchart-link archlens-removed-edge" data-id="L_A_B_0"/>' +
      '<path d="M10,90 L10,170" id="my-svg-L_B_C_0" class="edge-thickness-normal flowchart-link" data-id="L_B_C_0"/>' +
      "</svg>";
    const result = injectFlowRunnersCss(mixedEdges);
    expect(result.match(/class="archlens-flow-runner"/g)?.length).toBe(1);
    expect(result).not.toContain("offset-path:path('M10,10 L10,90')");
    expect(result).toContain("offset-path:path('M10,90 L10,170')");
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
  //
  // Round-6 correction, from a fresh review against a REAL FastAPI diff:
  // the rule originally only marked an edge when BOTH endpoints were
  // `removed`. Real data showed that was wrong — a live node's bold,
  // glowing "calls" edge pointing INTO a deleted node read as a flat
  // contradiction ("a file cannot simultaneously be deleted by this PR
  // and actively invoked by live code"). D/E below is exactly that case:
  // D is a normal endpoint, E is removed, D->E must now be marked too.
  const removedPairSvg =
    '<svg id="my-svg" viewBox="0 0 100 200">' +
    '<g class="nodes">' +
    '<g class="node default removed" id="my-svg-flowchart-A-0"></g>' +
    '<g class="node default removed" id="my-svg-flowchart-B-1"></g>' +
    '<g class="node default endpoint" id="my-svg-flowchart-C-2"></g>' +
    '<g class="node default endpoint" id="my-svg-flowchart-D-3"></g>' +
    '<g class="node default removed" id="my-svg-flowchart-E-4"></g>' +
    "</g>" +
    '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal flowchart-link" data-id="L_A_B_0"/>' +
    '<path d="M10,90 L10,170" id="my-svg-L_C_D_0" class="edge-thickness-normal flowchart-link" data-id="L_C_D_0"/>' +
    '<path d="M20,10 L20,90" id="my-svg-L_D_E_0" class="edge-thickness-normal flowchart-link" data-id="L_D_E_0"/>' +
    "</svg>";

  it("tags an edge touching a `removed` node on EITHER end with the archlens-removed-edge marker class", () => {
    const result = applyBoldGlowStyling(removedPairSvg);
    // A -> B: both removed -> marked.
    expect(result).toMatch(/id="my-svg-L_A_B_0"[^>]*class="[^"]*\barchlens-removed-edge\b/);
    // D -> E: D is a normal live node, E is removed -> still marked (the
    // round-6 fix: a removed node can't be part of live data flow from
    // either direction).
    expect(result).toMatch(/id="my-svg-L_D_E_0"[^>]*class="[^"]*\barchlens-removed-edge\b/);
    // C -> D: neither endpoint removed -> stays unmarked (positive control).
    expect(result).not.toMatch(/id="my-svg-L_C_D_0"[^>]*class="[^"]*\barchlens-removed-edge\b/);
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

  // Round-9 addition, from a fresh adversarial review against a real
  // FastAPI diagram: the model collapsed a deleted intermediate file into
  // an edge LABEL ("removed call to") between two otherwise perfectly
  // normal, live nodes -- neither endpoint was ever classed `removed`, so
  // touchesRemovedNode() had nothing to catch, and the edge rendered with
  // the full bold/glowing "actively alive" treatment while its own label
  // said the opposite. Shape below matches a real render exactly (`<g
  // class="edgeLabel">...<g class="label" data-id="L_..."`), confirmed
  // against scripts/.dry-run-output/real-fastapi-round9-diagram.svg.
  const labelRemovedSvg =
    '<svg id="my-svg" viewBox="0 0 100 200">' +
    '<g class="nodes">' +
    '<g class="node default endpoint" id="my-svg-flowchart-A-0"></g>' +
    '<g class="node default logic" id="my-svg-flowchart-B-1"></g>' +
    "</g>" +
    '<path d="M10,10 L10,90" id="my-svg-L_A_B_0" class="edge-thickness-normal flowchart-link" data-id="L_A_B_0"/>' +
    '<g class="edgeLabel"><g class="label" data-id="L_A_B_0"><g><text><tspan>removed call to</tspan></text></g></g></g>' +
    "</svg>";

  it("tags an edge whose own label starts with 'removed', even when neither endpoint is classed `removed`", () => {
    const result = applyBoldGlowStyling(labelRemovedSvg);
    expect(result).toMatch(/id="my-svg-L_A_B_0"[^>]*class="[^"]*\barchlens-removed-edge\b/);
  });

  it("does not tag a live edge whose label merely mentions 'removed' mid-sentence, not as its opening word", () => {
    const svg = labelRemovedSvg.replace("removed call to", "the tenacity dependency was removed");
    const result = applyBoldGlowStyling(svg);
    expect(result).not.toMatch(/id="my-svg-L_A_B_0"[^>]*class="[^"]*\barchlens-removed-edge\b/);
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

  // Round-14 redesign, from the repeated "high legend/decoding overhead"
  // review complaint (round 12): the round-3 layout cost 9 swatches (4
  // categories x solid+dashed, plus removed) to teach only 5 distinct
  // facts, since the solid/dashed pairing is identical across every
  // category. Each category now shows ONE solid swatch only, and the
  // dashed pattern is taught exactly once via a dedicated "Existing
  // context" item — 6 total swatches, no information lost.
  it("shows one solid swatch per category plus a single generic dashed example, instead of a dashed swatch repeated per category", () => {
    const withLegend = appendLegend(sampleSvg, "flowchart");
    expect(withLegend).toContain("solid = changed by this PR");
    expect(withLegend).toContain("dashed = existing context");
    expect(withLegend).toContain("Existing context");
    expect(withLegend).toContain("Removed by this PR");
    // Exactly 2 dashed swatches total: the single generic "Existing
    // context" example and "Removed by this PR" — NOT one per category.
    const dashedSwatches = withLegend.match(/stroke-dasharray="3 2"/g) ?? [];
    expect(dashedSwatches.length).toBe(2);
    // 4 categories + "Existing context" + "Removed by this PR" = 6 total
    // swatch <rect>s on the legend, down from 9 in the round-3 design.
    const totalSwatches = withLegend.match(/<rect x="[\d.]+" y="[\d.]+" width="12" height="12"/g) ?? [];
    expect(totalSwatches.length).toBe(6);
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
    expect(withLegend).toContain("External");
    expect(withLegend).toContain("Existing context");
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
  // an arrow running along it. Round-14 (2026-09-07): the runner is no
  // longer the DEFAULT (see the no-op test below and CLAUDE.md item 28),
  // so this now opts in explicitly to confirm the capability itself still
  // works end to end, same as before.
  it("renders a real solid (non-dashed) edge with a moving arrow runner when explicitly requested", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint\n  class B logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH, flowAnimation: "smil" }
    );
    expect(svg).toContain("<animateMotion"); // the moving arrowhead, not a dashed line
    expect(svg).toContain("stroke-dasharray:none !important"); // edges stay solid
    expect(svg).toContain("archlens-glow");
    expect(svg).toContain("font-weight:700");
  }, 30_000);

  // Round-14 (2026-09-07): both real GitHub PR tests (items 23-24) found
  // neither SMIL nor CSS motion survives GitHub's actual `<img>`-embedded
  // PR comment — the only place a real customer sees this — so shipping
  // either one by default meant every production diagram carried a dead,
  // frozen runner artifact for zero visible benefit. Confirms the
  // production default (no flowAnimation option passed, exactly how
  // api/generate.ts calls this) no longer attaches either implementation,
  // while the bold/glow styling itself (the part that DOES survive the
  // embed, per the same two real-PR tests) is unaffected.
  it("does not attach any flow-runner animation by default, since neither survives a real GitHub `<img>` embed", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["x"] --> B["y"]\n  class A endpoint\n  class B logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }
    );
    expect(svg).not.toContain("<animateMotion");
    expect(svg).not.toContain("archlens-flow-runner");
    expect(svg).not.toContain("@keyframes archlens-flow");
    expect(svg).toContain("stroke-dasharray:none !important"); // edges still render bold/solid
    expect(svg).toContain("archlens-glow"); // the glow itself is unaffected, only the runner is gone
  }, 30_000);

  // Bug fix (2026-09-02), end-to-end through the real Puppeteer/ELK harness:
  // an edge touching a `removed` node — on EITHER end — must NOT get the
  // same "actively flowing" glow + animated arrow as a normal edge, since
  // that directly contradicts the dashed-red "gone" node styling. A/B are
  // both removed; E is a normal LIVE node with an edge pointing INTO
  // removed node B (E->B) — this is the exact shape of a real bug a
  // round-6 adversarial review caught on a genuine FastAPI diff:
  // `prestart.sh -->|calls| backend_pre_start.py` rendered as a bold,
  // glowing, actively-animated edge into a node explicitly marked deleted,
  // which the review correctly called a flat contradiction. All edges
  // touching A or B (however connected) must render dim/dashed/no-glow;
  // only the fully-live C->D edge keeps the active look.
  it("renders any edge touching a removed node as dim/dashed/no-glow with no animated runner, while a fully-live edge keeps the active look", async () => {
    const { svg } = await renderMermaidToSvg(
      'flowchart TD\n  A["gone service"] --> B["gone dependency"]\n  E["live caller"] --> B\n  C["kept service"] --> D["kept dependency"]\n  class A,B removed\n  class C,D,E logic',
      { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH, flowAnimation: "smil" }
    );
    const removedEdge = /<path[^>]*data-id="L_A_B_0"[^>]*>/.exec(svg)?.[0];
    const liveIntoRemovedEdge = /<path[^>]*data-id="L_E_B_0"[^>]*>/.exec(svg)?.[0];
    const activeEdge = /<path[^>]*data-id="L_C_D_0"[^>]*>/.exec(svg)?.[0];
    expect(removedEdge).toBeDefined();
    expect(liveIntoRemovedEdge).toBeDefined();
    expect(activeEdge).toBeDefined();
    expect(removedEdge).toContain("archlens-removed-edge");
    expect(liveIntoRemovedEdge).toContain("archlens-removed-edge"); // the round-6 fix
    expect(activeEdge).not.toContain("archlens-removed-edge");

    const activeEdgeId = /\bid="([^"]+)"/.exec(activeEdge!)?.[1];
    const removedEdgeId = /\bid="([^"]+)"/.exec(removedEdge!)?.[1];
    const liveIntoRemovedEdgeId = /\bid="([^"]+)"/.exec(liveIntoRemovedEdge!)?.[1];
    expect(svg).not.toContain(`href="#${removedEdgeId}"`); // no animated runner on either removed-touching edge
    expect(svg).not.toContain(`href="#${liveIntoRemovedEdgeId}"`);
    expect(svg).toContain(`href="#${activeEdgeId}"`); // the fully-live edge still gets one
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
