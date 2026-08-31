import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
    lineColor: "#8b949e",
    secondaryColor: "#161b22",
    tertiaryColor: "#161b22",
    fontFamily: FONT_STACK,
    fontSize: "16px",
    clusterBkg: "#161b22",
    clusterBorder: "#30363d",
    titleColor: "#e6edf3",
    edgeLabelBackground: "#0d1117",
    nodeTextColor: "#e6edf3",
    actorBkg: "#1c2128",
    actorBorder: "#58a6ff",
    actorTextColor: "#e6edf3",
    actorLineColor: "#30363d",
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
// reserved for nodes the diff actually changes. Region variants (subtle
// tinted subgraph fills, one hue per layer) replace the old flat
// clusterBkg so grouped layers read as instantly distinct regions rather
// than text labels inside thin outlines.
// Round-3 addition, from a second review: refactors and outright removals
// are a routine PR category for this product's own target audience
// (backend/DevOps leads), and there was no way to show "this PR deletes
// X" — only changed/context. A single generic `removed` category (not
// split per endpoint/logic/datastore — once something's gone, which
// category it used to be matters less than the fact it's gone) covers it.
const CATEGORY_CLASS_DEFS = [
  "classDef endpoint fill:#1c2128,stroke:#58a6ff,stroke-width:2px,color:#e6edf3",
  "classDef logic fill:#1c2128,stroke:#7ee787,stroke-width:2px,color:#e6edf3",
  "classDef datastore fill:#1c2128,stroke:#bc8cff,stroke-width:2px,color:#e6edf3",
  "classDef endpointContext fill:#161b22,stroke:#58a6ff,stroke-width:1px,stroke-dasharray:4 3,color:#8b949e",
  "classDef logicContext fill:#161b22,stroke:#7ee787,stroke-width:1px,stroke-dasharray:4 3,color:#8b949e",
  "classDef datastoreContext fill:#161b22,stroke:#bc8cff,stroke-width:1px,stroke-dasharray:4 3,color:#8b949e",
  "classDef endpointRegion fill:#12202e,stroke:#1c2128,color:#e6edf3",
  "classDef logicRegion fill:#122417,stroke:#1c2128,color:#e6edf3",
  "classDef datastoreRegion fill:#1c1a2e,stroke:#1c2128,color:#e6edf3",
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
    `<rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="6" fill="#161b22" stroke="#30363d" stroke-width="1"/>` +
    rows +
    `</g></g>`;

  return resized.replace(/<\/svg>\s*$/, `${legendGroup}</svg>`);
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

/**
 * Renders validated Mermaid source to SVG via the mermaid-cli (mmdc)
 * binary. mmdc bundles its own headless Chromium via puppeteer, which is
 * why this step is deliberately NOT run inside a customer's CI runner (that
 * would mean installing Puppeteer's Chromium on every single PR, adding
 * real minutes to CI) — it runs once, here, on ArchLens's own render
 * worker, and the Action just gets back a URL.
 */
export async function renderMermaidToSvg(
  source: string,
  opts: { mmdcPath?: string; timeoutMs?: number; executablePath?: string } = {}
): Promise<RenderResult> {
  const validation = validateMermaidSyntax(source);
  if (!validation.valid) {
    throw new Error(`Refusing to render invalid diagram: ${validation.error}`);
  }

  const mmdcPath = opts.mmdcPath ?? "mmdc";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // The render worker owns its own Chromium (via a Docker base image or
  // @sparticuz/chromium on serverless) — never assumed to be the system
  // default, since that varies wildly across deployment targets.
  const executablePath = opts.executablePath ?? process.env.PUPPETEER_EXECUTABLE_PATH;

  const dir = await mkdtemp(join(tmpdir(), "archlens-render-"));
  const inputPath = join(dir, `${randomUUID()}.mmd`);
  const outputPath = join(dir, `${randomUUID()}.svg`);
  const puppeteerConfigPath = join(dir, "puppeteer-config.json");
  const themeConfigPath = join(dir, "theme-config.json");

  try {
    await writeFile(inputPath, applyArchLensStyling(source), "utf8");
    await writeFile(themeConfigPath, JSON.stringify(ARCHLENS_THEME_CONFIG), "utf8");
    // --no-sandbox is required to run headless Chromium as root/in most
    // containerized CI and serverless environments.
    await writeFile(
      puppeteerConfigPath,
      JSON.stringify({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        ...(executablePath ? { executablePath } : {}),
      }),
      "utf8"
    );

    await runMmdc(mmdcPath, [
      "-i",
      inputPath,
      "-o",
      outputPath,
      "-b",
      "transparent",
      "-c",
      themeConfigPath,
      "-p",
      puppeteerConfigPath,
    ], timeoutMs);

    const rawSvg = await readFile(outputPath, "utf8");
    const diagramType = /^sequenceDiagram/i.test(source.trim()) ? "sequence" : "flowchart";
    return { svg: appendLegend(rawSvg, diagramType) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runMmdc(mmdcPath: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(mmdcPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`mmdc timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`mmdc exited with code ${code}: ${stderr.slice(0, 1000)}`));
      }
    });
  });
}
