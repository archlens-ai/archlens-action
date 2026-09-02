import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);

const ALLOWED_DECLARATIONS = [/^flowchart\s+(TD|LR|BT|RL)\b/i, /^sequenceDiagram\b/i];

// Mermaid supports "click" bindings that can invoke arbitrary JS, and raw
// SVG can carry <script>/<foreignObject>. A PR diff's content is
// attacker-influenced (anyone can open a PR), and it flows through the LLM
// into a diagram we host and embed in other people's PR pages — so we
// validate the model's output defensively before ever rendering it,
// treating this exactly like untrusted user input, not as this app's own
// trusted template.
const DISALLOWED_PATTERNS = [
  /click\s+\S+/i,
  /<\s*script/i,
  /javascript\s*:/i,
  /on\w+\s*=/i,
  /<\s*foreignObject/i,
];

const MAX_SOURCE_LENGTH = 20_000;

// ArchLens's visual identity: a GitHub-Primer-derived dark theme, chosen so
// the diagram feels native to a GitHub PR page rather than a generic
// chart-library export. `htmlLabels: false` renders labels as plain SVG
// <text> instead of HTML-in-<foreignObject> — kept as a defensive
// portability choice (foreignObject content is a documented compatibility
// gap across SVG consumers in general — see Mermaid's own issue tracker),
// not because of a confirmed GitHub-specific rendering failure. An earlier
// version of this comment claimed a confirmed bug here; that claim did not
// hold up under a properly controlled re-test and was corrected in
// CLAUDE.md / docs/ARCHITECTURE.md. Sequence diagrams render text as plain
// SVG <text> regardless of this setting.
const FONT_STACK = "-apple-system, BlinkMacSystemFont, Segoe UI, Inter, Roboto, sans-serif";

export const ARCHLENS_THEME_CONFIG = {
  theme: "base",
  themeVariables: {
    darkMode: true,
    background: "#0d1117",
    primaryColor: "#1c2128",
    primaryTextColor: "#e6edf3",
    primaryBorderColor: "#58a6ff",
    // Round-5 fix, direct user feedback ("keep entire background dark...
    // make the text and line bright and bold, so its clearly visible"):
    // the previous muted gray-blue (#8b949e) read as washed out against
    // the near-black background. Bumped to GitHub's own bright accent
    // blue so connecting lines and arrowheads (which inherit lineColor)
    // actually pop — applyBoldGlowStyling() below layers a stroke-width
    // bump and a glow filter on top of this in the rendered SVG.
    lineColor: "#79c0ff",
    secondaryColor: "#161b22",
    tertiaryColor: "#161b22",
    fontFamily: FONT_STACK,
    fontSize: "16px",
    clusterBkg: "#161b22",
    // Round-6 fix, from the round-5 adversarial review ("low-contrast
    // subgraph borders"): #30363d against the #0d1117 canvas measures only
    // 1.55:1 contrast (WCAG's own floor for a graphical boundary like this
    // is 3:1) — computed, not eyeballed, with the same relative-luminance
    // formula WCAG 2.1 SC 1.4.11 uses. At that ratio a subgraph's outline is
    // effectively invisible against the near-black canvas, which undercuts
    // the one piece of structure (API/Logic/Data grouping) the product's
    // whole pitch depends on being legible at a glance. #6e7681 — a neutral
    // GitHub Primer gray, not a fourth accent color competing with the
    // endpoint/logic/datastore blue/green/purple — measures 4.12:1 against
    // the canvas and 3.77:1 against the legend card's own #161b22 fill
    // (also updated below to match), comfortably clearing the bar while
    // still reading as "a muted boundary," not "another category."
    clusterBorder: "#6e7681",
    titleColor: "#e6edf3",
    edgeLabelBackground: "#0d1117",
    nodeTextColor: "#e6edf3",
    actorBkg: "#1c2128",
    actorBorder: "#58a6ff",
    actorTextColor: "#e6edf3",
    // Same low-contrast mistake as clusterBorder above, same fix, applied
    // here too for consistency: a sequence diagram's actor lifelines were
    // just as washed out against the dark canvas as flowchart subgraph
    // borders were.
    actorLineColor: "#6e7681",
    signalColor: "#e6edf3",
    signalTextColor: "#e6edf3",
    // Round-2 fix: a review caught that Mermaid's default note styling
    // (pale yellow) was left untouched and clashed hard against the dark
    // theme applied to everything else. Notes get their own accent
    // (amber, distinct from the 3 category colors) so a "side effect"
    // callout still reads as visually distinct from a node, on purpose.
    noteBkgColor: "#2d2410",
    noteBorderColor: "#d29922",
    noteTextColor: "#e6edf3",
  },
  // nodeSpacing/rankSpacing bumped modestly above dagre's defaults (50/50).
  // Tested directly against the 14-node/18-edge stress case that exposed
  // Mermaid's layout limitations: this softens crowding but does NOT fix
  // edges crossing through unrelated nodes or cross-subgraph containment —
  // those are structural to how dagre lays out subgraphs with cross-cutting
  // edges, not a spacing problem. Kept anyway since it's a strict
  // improvement with no downside; the real mitigation for scale is the
  // LLM's coarse-mode node-count cap (see llm.ts's COARSE_MODE_THRESHOLD),
  // not this.
  flowchart: { curve: "basis", padding: 16, htmlLabels: false, nodeSpacing: 45, rankSpacing: 65 },
  sequence: {
    actorFontFamily: FONT_STACK,
    noteFontFamily: FONT_STACK,
    messageFontFamily: FONT_STACK,
  },
  htmlLabels: false,
} as const;

// Fixed, server-owned category styling. The LLM is instructed (see
// llm.ts's SYSTEM_PROMPT) to emit only `class NodeId,NodeId2 <category>`
// references — never its own `classDef` — so ArchLens's palette stays
// consistent across every diagram regardless of what the model does, and
// so a model that ignores that instruction can't push arbitrary CSS-like
// styling through. applyArchLensStyling() below strips any classDef lines
// the model emits anyway and appends these instead.
//
// Round-2 addition: a review pointed out the first version only showed a
// static "resulting architecture," with no visual distinction between
// what this PR actually changed and pre-existing context it merely
// touches — a real gap for a product whose whole pitch is visualizing a
// diff's impact. Each category now has a "Context" variant (dashed
// border, dimmed fill) for nodes that are referenced but not
// added/modified by the diff; the plain (solid, full-color) variant is
// reserved for nodes the diff actually changes.
// Round-3 addition, from a second review: refactors and outright removals
// are a routine PR category for this product's own target audience
// (backend/DevOps leads), and there was no way to show "this PR deletes
// X" — only changed/context. A single generic `removed` category (not
// split per endpoint/logic/datastore — once something's gone, which
// category it used to be matters less than the fact it's gone) covers it.
// Round-5 fix, direct user feedback ("its bit messy, keep entire
// background dark blue or github black"): the three Region classDefs
// used to each tint their subgraph a different hue (navy/green/purple),
// which read as a patchwork rather than one coherent dark canvas. They
// now share one identical, background-matching fill — the subgraph
// boundary is still visible (a neutral border + its label), but the
// canvas itself stays uniformly dark everywhere, per the ask.
const CATEGORY_CLASS_DEFS = [
  "classDef endpoint fill:#1c2128,stroke:#58a6ff,stroke-width:2px,color:#e6edf3",
  "classDef logic fill:#1c2128,stroke:#7ee787,stroke-width:2px,color:#e6edf3",
  "classDef datastore fill:#1c2128,stroke:#bc8cff,stroke-width:2px,color:#e6edf3",
  "classDef endpointContext fill:#161b22,stroke:#58a6ff,stroke-width:1px,stroke-dasharray:4 3,color:#8b949e",
  "classDef logicContext fill:#161b22,stroke:#7ee787,stroke-width:1px,stroke-dasharray:4 3,color:#8b949e",
  "classDef datastoreContext fill:#161b22,stroke:#bc8cff,stroke-width:1px,stroke-dasharray:4 3,color:#8b949e",
  // Round-6 fix: matches clusterBorder's #6e7681 (see
  // ARCHLENS_THEME_CONFIG above for the contrast-ratio math). These
  // *Region classDefs carry `!important` and are what the model actually
  // applies to each subgraph (per llm.ts's SYSTEM_PROMPT: `class API
  // endpointRegion` etc. right after the subgraph's `end`), so they're the
  // rule that wins in the real rendered output — clusterBorder is the
  // fallback for the rarer case a subgraph goes unclassed.
  "classDef endpointRegion fill:#0d1117,stroke:#6e7681,color:#e6edf3",
  "classDef logicRegion fill:#0d1117,stroke:#6e7681,color:#e6edf3",
  "classDef datastoreRegion fill:#0d1117,stroke:#6e7681,color:#e6edf3",
  "classDef removed fill:#2d1a1f,stroke:#f85149,stroke-width:1.5px,stroke-dasharray:2 2,color:#ffa198",
].join("\n");

interface LegendSwatch {
  fill: string;
  stroke: string;
  dashed: boolean;
}

interface LegendRow {
  label: string;
  swatches: LegendSwatch[];
}

// Round-3 redesign, from a second review: v2's legend listed
// changed/context and endpoint/logic/datastore as five disconnected
// swatches, so a viewer had to mentally cross two independent lists to
// decode what "solid blue" actually means. Each category now gets one row
// showing its solid (changed) and dashed (context) swatch side by side —
// the combination the diagram actually uses — with the solid/dashed
// meaning explained once, up top, rather than repeated per row.
const LEGEND_ROWS: LegendRow[] = [
  {
    // A middle-dot separator, not repeated spaces: SVG <text> collapses
    // consecutive whitespace to a single space (a real rendering gap
    // caught in visual QA — the two clauses ran together illegibly), so
    // spacing needs an actual character, not just more space characters.
    label: "solid = changed by this PR  ·  dashed = existing context",
    swatches: [],
  },
  {
    label: "Endpoint",
    swatches: [
      { fill: "#1c2128", stroke: "#58a6ff", dashed: false },
      { fill: "#161b22", stroke: "#58a6ff", dashed: true },
    ],
  },
  {
    label: "Logic",
    swatches: [
      { fill: "#1c2128", stroke: "#7ee787", dashed: false },
      { fill: "#161b22", stroke: "#7ee787", dashed: true },
    ],
  },
  {
    label: "Datastore",
    swatches: [
      { fill: "#1c2128", stroke: "#bc8cff", dashed: false },
      { fill: "#161b22", stroke: "#bc8cff", dashed: true },
    ],
  },
  {
    label: "Removed by this PR",
    swatches: [{ fill: "#2d1a1f", stroke: "#f85149", dashed: true }],
  },
];

/**
 * Applies ArchLens's fixed visual identity to already-validated Mermaid
 * source: strips any `classDef` the model emitted (untrusted styling; the
 * model should only reference the fixed categories) and, for flowchart
 * diagrams only, appends ArchLens's own classDef block so the
 * `class NodeId <category>` lines the model was asked to emit actually
 * render. A no-op for sequenceDiagram (classDef doesn't apply there).
 */
export function applyArchLensStyling(source: string): string {
  const withoutModelClassDefs = source
    .split("\n")
    .filter((line) => !/^\s*classDef\b/.test(line))
    .join("\n");

  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(withoutModelClassDefs.trim());
  if (!isFlowchart) {
    return withoutModelClassDefs;
  }

  return `${withoutModelClassDefs.trimEnd()}\n\n${CATEGORY_CLASS_DEFS}\n`;
}

/**
 * Appends a legend card to a rendered flowchart SVG: one row per category
 * showing its solid (changed-by-this-PR) and dashed (existing-context)
 * swatch side by side — the actual combination the diagram uses — plus a
 * one-line caption explaining what solid/dashed means, instead of listing
 * category and changed-status as separate, uncombined swatches (a real
 * gap a review caught: a viewer had to cross-reference two lists to
 * decode "solid blue"). Drawn inside a bordered card so it reads as a
 * designed legend rather than loose text floating below the diagram.
 * Server-side post-processing (rather than asking the LLM to draw it)
 * means it's always present, always correct, and can never be corrupted
 * by model output. A no-op for sequenceDiagram, where this category
 * system doesn't apply.
 */
export function appendLegend(svg: string, diagramType: "flowchart" | "sequence"): string {
  if (diagramType !== "flowchart") {
    return svg;
  }

  const viewBoxMatch = svg.match(/viewBox="([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+)"/);
  if (!viewBoxMatch) {
    return svg; // Defensive: if mmdc's output shape ever changes, skip rather than corrupt the SVG.
  }
  const [, minX, minY, width, height] = viewBoxMatch.map(Number) as unknown as [
    number,
    number,
    number,
    number,
    number,
  ];

  const rowHeight = 26;
  const swatchSize = 12;
  const swatchGap = 6;
  const fontSize = 12;
  const cardPadding = 14;
  const labelColX = cardPadding + 92; // fixed column so every row's swatches line up

  // A row's width is driven by however many swatches it has (1 or 2) plus
  // its label length — used only to size the card, since layout itself is
  // a fixed label column followed by swatches, not a wrapping flow.
  const widestLabelChars = Math.max(...LEGEND_ROWS.map((r) => r.label.length));
  const neededWidth = labelColX + widestLabelChars * (fontSize * 0.56) + cardPadding;
  const cardWidth = Math.max(Math.min(width, neededWidth), 320);

  const rows = LEGEND_ROWS.map((row, i) => {
    const y = cardPadding + i * rowHeight;
    let swatchesSvg = "";
    if (row.swatches.length > 0) {
      let sx = cardPadding;
      swatchesSvg = row.swatches
        .map((sw) => {
          const dash = sw.dashed ? ' stroke-dasharray="3 2"' : "";
          const rect = `<rect x="${sx}" y="${y + (rowHeight - swatchSize) / 2}" width="${swatchSize}" height="${swatchSize}" rx="2" fill="${sw.fill}" stroke="${sw.stroke}" stroke-width="1.5"${dash}/>`;
          sx += swatchSize + swatchGap;
          return rect;
        })
        .join("");
    }
    const labelX = row.swatches.length > 0 ? labelColX : cardPadding;
    const labelColor = row.swatches.length === 0 ? "#8b949e" : "#e6edf3";
    const label = `<text x="${labelX}" y="${y + rowHeight / 2}" dominant-baseline="middle" font-family="${FONT_STACK}" font-size="${fontSize}" fill="${labelColor}">${escapeXml(row.label)}</text>`;
    return swatchesSvg + label;
  }).join("");

  const cardHeight = cardPadding + LEGEND_ROWS.length * rowHeight;
  const outerMargin = 10;
  const legendHeight = cardHeight + outerMargin * 2;

  const newHeight = height + legendHeight;
  const newWidth = Math.max(width, cardWidth + outerMargin * 2);
  // mmdc's root <svg> also carries a `max-width: <old-width>px` inline
  // style alongside width="100%" — since the aspect ratio changes when the
  // legend adds height (and possibly width), that style has to move with
  // the viewBox or the browser clamps display width to the stale value and
  // the added legend renders squashed.
  const resized = svg
    .replace(
      /viewBox="[\d.\-]+ [\d.\-]+ [\d.\-]+ [\d.\-]+"/,
      `viewBox="${minX} ${minY} ${newWidth} ${newHeight}"`
    )
    .replace(/max-width:\s*[\d.]+px/, `max-width: ${newWidth}px`);

  const legendGroup = `<g transform="translate(0, ${height})">` +
    `<rect x="0" y="0" width="${newWidth}" height="${legendHeight}" fill="#0d1117"/>` +
    `<g transform="translate(${outerMargin}, ${outerMargin})">` +
    `<rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="6" fill="#161b22" stroke="#6e7681" stroke-width="1"/>` +
    rows +
    `</g></g>`;

  return resized.replace(/<\/svg>\s*$/, `${legendGroup}</svg>`);
}

// A single reusable glow filter, injected once per rendered SVG. Applied
// via CSS (below) to edge/message-line paths only — never to text or node
// fill areas, since blurring those would make labels illegible rather than
// "bold and bright."
const GLOW_FILTER_ID = "archlens-glow";
// filterUnits="userSpaceOnUse" (not the SVG default, objectBoundingBox) is
// deliberate, not cosmetic: with the default, x/y/width/height percentages
// are computed against the FILTERED ELEMENT's OWN bounding box — and for a
// perfectly straight vertical or horizontal edge (one shared x or y across
// every point in its path) that box has zero width or height, so any
// percentage of it is still zero. A zero-size filter region clips the
// entire filtered edge to nothing — invisible line, only its (unfiltered)
// arrowhead marker left floating with no visible line into it. Found via a
// real end-to-end render (a PR diff whose ELK layout happened to place two
// nodes in a dead-straight vertical line — routine for ELK's orthogonal
// routing, much rarer for dagre's, which is presumably why this never
// surfaced against the old mmdc/dagre pipeline). userSpaceOnUse resolves
// the same percentages against the SVG's own viewport instead, which is
// never zero.
const GLOW_DEFS = `<defs><filter id="${GLOW_FILTER_ID}" filterUnits="userSpaceOnUse" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="archlens-blur"/><feMerge><feMergeNode in="archlens-blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;

// Marker class stamped onto an edge's own <path class="..."> attribute (by
// applyBoldGlowStyling(), the first post-processing step to run) when BOTH
// its endpoints are `removed`-category nodes. injectFlowRunners() — which
// runs immediately after in the pipeline — reads this same marker back off
// the tag rather than re-deriving node categories itself, so there's one
// source of truth for "is this a removed-to-removed edge" shared by both
// functions.
const REMOVED_EDGE_CLASS = "archlens-removed-edge";

/**
 * Reads every flowchart node's assigned category straight out of the
 * rendered SVG: Mermaid emits each node as `<g class="node default
 * {category}" id="{svgId}-flowchart-{NodeName}-{idx}" ...>` (confirmed
 * against a real render), so the category is the one class token besides
 * the fixed "node"/"default" pair, and the node's own Mermaid id is
 * recovered from its id attribute by stripping the "-flowchart-" prefix and
 * the trailing "-{idx}" mermaid appends for uniqueness.
 */
function extractNodeCategories(svg: string): Map<string, string> {
  const categories = new Map<string, string>();
  const nodeTagRe = /<g class="(node[^"]*)"[^>]*\bid="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = nodeTagRe.exec(svg))) {
    const classTokens = match[1]!.split(/\s+/);
    const category = classTokens.find((t) => t !== "node" && t !== "default");
    const nameMatch = /-flowchart-(.+)-\d+$/.exec(match[2]!);
    if (category && nameMatch) {
      categories.set(nameMatch[1]!, category);
    }
  }
  return categories;
}

/**
 * Determines whether an edge (identified by its `data-id`, always
 * `L_{source}_{target}_{index}` — confirmed against a real render) connects
 * two nodes that are BOTH categorized `removed`. Node names can themselves
 * contain underscores, so `source`/`target` can't just be split on "_" —
 * instead this tries every known node name as a candidate source prefix and
 * accepts the split only when the remainder (minus the trailing index) is
 * *also* a known node name, which is unambiguous in practice since a real
 * split must land on two real node names.
 */
function isRemovedToRemovedEdge(dataId: string | null, categories: Map<string, string>): boolean {
  if (!dataId) return false;
  const m = /^L_(.+)_\d+$/.exec(dataId);
  if (!m) return false;
  const sourceAndTarget = m[1]!;
  for (const source of categories.keys()) {
    if (!sourceAndTarget.startsWith(`${source}_`)) continue;
    const target = sourceAndTarget.slice(source.length + 1);
    if (categories.has(target)) {
      return categories.get(source) === "removed" && categories.get(target) === "removed";
    }
  }
  return false;
}

/**
 * User ask (2026-08-31): "make the text and line bright and bold... clearly
 * visible", plus the glow half of the animated-flow request. mmdc's stock
 * stylesheet ships edges at a flat 1px (flowchart) / 1.5px (sequence) with
 * no glow — this overrides both with `!important` (simplest reliable way to
 * beat rules already baked into the SVG's own embedded <style>, since we
 * don't control mmdc's stylesheet generation directly) and forces bold text
 * throughout. Applies to both diagram types.
 *
 * Round-6 correction, direct user feedback: the first version of "dynamic"
 * used Mermaid's built-in `animate: true` edge metadata, which works by
 * animating a dashed stroke (`stroke-dasharray` + moving `stroke-dashoffset`)
 * — the user correctly called this out as "dotted," not what they asked
 * for ("arrow running on fix[ed] line"). Edges here stay a normal SOLID
 * line (no dasharray at all); direction is instead shown by a small glowing
 * arrowhead that physically travels along the edge's own path via SVG's
 * native `<animateMotion>` — see injectFlowRunners() below, which reads
 * each edge's own `d` geometry straight out of the rendered SVG rather
 * than asking Mermaid/the model to cooperate with anything.
 *
 * Bug fix (found generating a real removed-state example, 2026-09-02): the
 * blanket `.flowchart-link` rule below used to apply to every edge with no
 * awareness of what it connects, so a link between two nodes THIS PR
 * DELETES rendered with the exact same vivid "alive and pulsing" glow as a
 * link between two brand-new nodes — flatly contradicting the dashed-red
 * "gone" styling already applied to the nodes themselves. Edges whose
 * endpoints are both `removed` are now re-tagged with REMOVED_EDGE_CLASS
 * and given their own rule (declared after the general one, so its
 * `!important`s win) matching the removed-node palette: dim red, dashed, no
 * glow — "this connection is gone too," not "this connection is thriving."
 */
export function applyBoldGlowStyling(svg: string): string {
  const nodeCategories = extractNodeCategories(svg);
  const markedSvg = svg.replace(EDGE_PATH_TAG_RE, (tag) => {
    const dataId = extractAttr(tag, "data-id");
    if (!isRemovedToRemovedEdge(dataId, nodeCategories)) return tag;
    return tag.replace(/\bclass="([^"]*)"/, (_m, cls: string) => `class="${cls} ${REMOVED_EDGE_CLASS}"`);
  });

  const overrideStyle =
    `<style>` +
    `text{font-weight:700 !important;}` +
    `.flowchart-link{stroke-width:2.5px !important;stroke-dasharray:none !important;filter:url(#${GLOW_FILTER_ID});}` +
    `.${REMOVED_EDGE_CLASS}{stroke:#f85149 !important;stroke-width:1.5px !important;stroke-dasharray:3 3 !important;filter:none !important;opacity:0.7;}` +
    `.messageLine0,.messageLine1{stroke-width:2.2px !important;filter:url(#${GLOW_FILTER_ID});}` +
    `.edgeLabel{font-weight:700 !important;}` +
    `</style>`;

  return markedSvg.replace(/(<svg[^>]*>)/, `$1${GLOW_DEFS}${overrideStyle}`);
}

// Matches just the opening `<path ...>` tag, regardless of whether it's
// self-closed (`.../>`, what mmdc's CLI used to emit) or open-then-closed
// (`...></path>`, what a raw `mermaid.render()` call emits directly — no
// mmdc post-processing sits between us and the SVG anymore). Only the
// opening tag's attributes are ever read out of the match, so which form
// closes it doesn't matter for extractAttr().
const EDGE_PATH_TAG_RE = /<path\b[^>]*\bclass="[^"]*\bflowchart-link\b[^"]*"[^>]*>/g;

function extractAttr(tag: string, attr: string): string | null {
  const m = new RegExp(`\\b${attr}="([^"]*)"`).exec(tag);
  return m?.[1] ?? null;
}

/**
 * Makes the direction of data flow visible as motion, per the user's ask —
 * a small glowing arrowhead physically traveling along each edge's own
 * path, not a dashed line pretending to move. Mermaid/mmdc already gives
 * every flowchart edge a stable `id` (confirmed against a real render:
 * even a plain, untouched `A --> B` gets `id="my-svg-L_A_B_0"`), so this
 * reads that id and the edge's own `d` geometry straight out of the
 * rendered SVG and attaches an `<animateMotion>` runner via `<mpath>` —
 * no cooperation needed from Mermaid syntax or the model, and it can never
 * miss an edge the model might phrase unusually, unlike the source-level
 * rewrite this replaced. `rotate="auto"` keeps the arrowhead pointed along
 * the path's own tangent as it moves, so it still reads as "an arrow,"
 * not just a dot. Flowchart-only: sequenceDiagram message lines don't
 * expose an equivalent stable per-edge id in mmdc's output.
 *
 * Skips edges tagged REMOVED_EDGE_CLASS by applyBoldGlowStyling() (which
 * runs immediately before this in the pipeline, see renderMermaidToSvg): a
 * glowing arrowhead animating "live traffic" along a connection this PR
 * deletes is exactly backwards, the same bug the glow/bold override itself
 * had — found and fixed alongside it rather than separately, since it's the
 * same root cause (no edge here was ever aware of what it connects).
 */
export function injectFlowRunners(svg: string): string {
  const edgeTags = svg.match(EDGE_PATH_TAG_RE) ?? [];
  if (edgeTags.length === 0) {
    return svg;
  }

  const runners = edgeTags
    .map((tag) => {
      const id = extractAttr(tag, "id");
      if (!id) return null;
      const classAttr = extractAttr(tag, "class") ?? "";
      if (classAttr.split(/\s+/).includes(REMOVED_EDGE_CLASS)) return null;
      return (
        `<path d="M-5,-4 L6,0 L-5,4 L-2,0 Z" fill="#79c0ff" stroke="#0d1117" stroke-width="0.75"` +
        ` filter="url(#${GLOW_FILTER_ID})">` +
        `<animateMotion dur="2.8s" repeatCount="indefinite" rotate="auto">` +
        `<mpath href="#${id}" xlink:href="#${id}"/>` +
        `</animateMotion></path>`
      );
    })
    .filter((r): r is string => r !== null);

  if (runners.length === 0) {
    return svg;
  }

  return svg.replace(/<\/svg>\s*$/, `${runners.join("")}</svg>`);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateMermaidSyntax(source: string): ValidationResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return { valid: false, error: "empty diagram source" };
  }
  if (trimmed.length > MAX_SOURCE_LENGTH) {
    return { valid: false, error: `diagram source exceeds ${MAX_SOURCE_LENGTH} chars` };
  }

  const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
  const declaredOk = ALLOWED_DECLARATIONS.some((re) => re.test(firstLine));
  if (!declaredOk) {
    return {
      valid: false,
      error: `unrecognized or disallowed diagram declaration: "${firstLine}"`,
    };
  }

  for (const pattern of DISALLOWED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: `diagram source contains disallowed content (${pattern})` };
    }
  }

  return { valid: true };
}

export interface RenderResult {
  svg: string;
}

// Resolved once per process, not per render call — these files never
// change while the process is alive, and re-reading them from disk on
// every single diagram would be pure waste in a render worker handling
// many PRs.
const MERMAID_DIST = join(dirname(require.resolve("mermaid/package.json")), "dist");
const ELK_DIST = join(dirname(require.resolve("@mermaid-js/layout-elk/package.json")), "dist");

// Per-file cache, not just per-entry-point: mermaid's ESM build isn't one
// file — `mermaid.esm.min.mjs` itself pulls in several `chunks/**/*.mjs`
// files via relative `import`s at runtime (confirmed empirically — serving
// only the two named entry files 404s on those sub-imports the moment
// mermaid actually runs, even though the entry file itself loads fine).
// So the whole `dist` directory has to be servable by relative path, the
// same way any static file server would, not just two hardcoded routes.
const distFileCache = new Map<string, Buffer>();

function contentTypeFor(path: string): string {
  if (path.endsWith(".mjs") || path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

async function readDistFile(distRoot: string, relativePath: string): Promise<Buffer | null> {
  // Defensive normalize: this only ever serves paths derived from mermaid's
  // own internal imports, but a static file handler that resolves `..`
  // outside its root is a mistake worth not making anyway.
  const normalized = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const cacheKey = `${distRoot}/${normalized}`;
  const cached = distFileCache.get(cacheKey);
  if (cached) return cached;
  try {
    const buf = await readFile(join(distRoot, normalized));
    distFileCache.set(cacheKey, buf);
    return buf;
  } catch {
    return null;
  }
}

/**
 * Serves the mermaid + layout-elk ESM bundles (and every chunk file they
 * pull in) over a real (loopback-only) HTTP server rather than injecting
 * them as inline <script> content. A plain `page.setContent()` with no
 * origin doesn't give those relative sub-imports anything to resolve
 * against, so the bundle needs an actual resolvable base URL. This spins up
 * fresh on an OS-assigned port for the lifetime of one render call and is
 * torn down immediately after — nothing persists, nothing is reachable
 * from outside this process.
 */
async function startBundleServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<!doctype html><html><body><script type="module">
import mermaid from '/mermaid/mermaid.esm.min.mjs';
import elkLayouts from '/elk/mermaid-layout-elk.esm.min.mjs';
mermaid.registerLayoutLoaders(elkLayouts);
mermaid.initialize(${JSON.stringify({ startOnLoad: false, securityLevel: "strict", ...ARCHLENS_THEME_CONFIG })});
window.__archlensRender = async (id, source) => {
  const { svg } = await mermaid.render(id, source);
  return svg;
};
window.__archlensReady = true;
</script></body></html>`
        );
        return;
      }
      const mermaidMatch = url.match(/^\/mermaid\/(.+)$/);
      const elkMatch = url.match(/^\/elk\/(.+)$/);
      const [distRoot, relativePath] = mermaidMatch
        ? [MERMAID_DIST, mermaidMatch[1]]
        : elkMatch
          ? [ELK_DIST, elkMatch[1]]
          : [null, null];
      if (!distRoot || !relativePath) {
        res.writeHead(404).end();
        return;
      }
      const file = await readDistFile(distRoot, relativePath);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": contentTypeFor(relativePath) });
      res.end(file);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/**
 * Renders validated Mermaid source to SVG via a purpose-built Puppeteer
 * harness that loads Mermaid + `@mermaid-js/layout-elk` directly, rather
 * than the mermaid-cli (mmdc) binary this used to shell out to. Why the
 * switch: dagre (mmdc's only layout engine) breaks down on realistic-scale
 * diagrams — edges cross through unrelated node boxes, cross-cutting
 * edges escape their subgraph's box entirely (confirmed and disclosed
 * across several review rounds; see CLAUDE.md items 9/12/13 and the
 * Project doc). ELK ("elk.layered") is a hierarchical, subgraph-aware
 * layout engine that doesn't have this failure mode — verified with a
 * side-by-side spike against the exact 10-file stress diagram that
 * exposed the dagre problem before this was wired into production:
 * dagre left `NotificationService` and `RefundWorker` floating outside
 * every subgraph box with edges cutting across unrelated nodes; ELK put
 * every node inside its correct subgraph with clean orthogonal routing.
 * `@mermaid-js/layout-elk` isn't bundled with mmdc's own install, which is
 * why this needed a real render harness rather than a config flag.
 *
 * ELK only applies to flowcharts — it's a flowchart-specific layout
 * engine, so sequence diagrams render exactly as before (no `layout`
 * frontmatter added for them at all, deliberately, rather than risk
 * whatever an unsupported `layout` config does to a diagram type that has
 * no such concept).
 */
export async function renderMermaidToSvg(
  source: string,
  opts: { timeoutMs?: number; executablePath?: string } = {}
): Promise<RenderResult> {
  const validation = validateMermaidSyntax(source);
  if (!validation.valid) {
    throw new Error(`Refusing to render invalid diagram: ${validation.error}`);
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  // The render worker owns its own Chromium (via a Docker base image or
  // @sparticuz/chromium on serverless) — never assumed to be the system
  // default, since that varies wildly across deployment targets.
  const executablePath = opts.executablePath ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  const diagramType = /^sequenceDiagram/i.test(source.trim()) ? "sequence" : "flowchart";

  let styledSource = applyArchLensStyling(source);
  if (diagramType === "flowchart") {
    styledSource = `---\nconfig:\n  layout: elk\n---\n${styledSource}`;
  }

  const puppeteer = (await import("puppeteer-core")).default;
  const { url, close } = await startBundleServer();
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await Promise.race([
      puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        ...(executablePath ? { executablePath } : {}),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`render timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const page = await browser.newPage();
    // Kept (not just a debugging leftover): a JS error thrown inside the
    // page during mermaid.render() would otherwise surface only as an
    // opaque "waitForFunction timed out" from Puppeteer, with the real
    // cause silently lost in the page's own console. This is what actually
    // surfaced the true fix during development (a 404 on mermaid's internal
    // chunk imports) instead of a bare timeout — worth keeping for the same
    // reason in production, where a render worker with no visibility into
    // its own browser errors is much harder to debug from logs alone.
    page.on("pageerror", (err) => console.error("[archlens-render][pageerror]", err));
    await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs });
    await page.waitForFunction("window.__archlensReady === true", { timeout: timeoutMs });

    // `window` isn't typed here on purpose: this arrow function is
    // stringified by Puppeteer and executed inside the page's browser
    // context, not this Node process, and the backend's tsconfig
    // deliberately doesn't include the "dom" lib (this file has no other
    // reason to need it). `globalThis` IS `window` at runtime in a
    // browser context, and typechecks fine under a plain ES2022 lib.
    const rawSvg = await page.evaluate(
      async (src: string) =>
        (globalThis as unknown as { __archlensRender: (id: string, s: string) => Promise<string> }).__archlensRender(
          "archlens-diagram",
          src
        ),
      styledSource
    );

    // mmdc's own `-b <color>` flag used to guarantee an opaque canvas —
    // "dont use white color at all, make it black" (see CLAUDE.md item
    // 11): a transparent canvas lets the embedding page's own background
    // show through, which is white on GitHub's default light PR-comment
    // theme. Replicated here by injecting the same style directly onto
    // the rendered SVG's root element, since this harness renders via
    // mermaid.render() directly rather than mmdc's CLI, which was where
    // that behavior used to live.
    const withBackground = rawSvg.replace(
      /(<svg[^>]*\bstyle=")([^"]*)(")/,
      (_m, pre: string, style: string, post: string) =>
        `${pre}${style}${style.trim().endsWith(";") ? "" : ";"}background-color: ${ARCHLENS_THEME_CONFIG.themeVariables.background};${post}`
    );

    // mmdc's own SVG output used to declare xmlns:xlink by default; a raw
    // mermaid.render() call doesn't. injectFlowRunners() below emits
    // xlink:href on its <mpath> elements (kept alongside the unprefixed
    // href for older-renderer compatibility, per SVG2 vs SVG1.1), and
    // without this the resulting document is not well-formed XML — which
    // is invisible in a browser's lenient HTML-mode <img> rendering but
    // breaks it outright when embedded as an actual <img src="...svg">,
    // exactly how GitHub renders it in a PR comment (caught by trying to
    // screenshot this end-to-end the same way GitHub does, not by any unit
    // test — confirmed with xml.dom.minidom: "unbound prefix" before this
    // fix, clean parse after).
    const withXlinkNs = /\bxmlns:xlink=/.test(withBackground)
      ? withBackground
      : withBackground.replace(/^<svg\b/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');

    const styled = applyBoldGlowStyling(withXlinkNs);
    const withRunners = diagramType === "flowchart" ? injectFlowRunners(styled) : styled;
    return { svg: appendLegend(withRunners, diagramType) };
  } finally {
    if (browser) await browser.close();
    close();
  }
}
