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
  flowchart: { curve: "basis", padding: 16, htmlLabels: false },
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
].join("\n");

const LEGEND_ENTRIES: Array<{ label: string; fill: string; stroke: string; dashed: boolean }> = [
  { label: "Changed by this PR", fill: "#1c2128", stroke: "#e6edf3", dashed: false },
  { label: "Existing context", fill: "#161b22", stroke: "#8b949e", dashed: true },
  { label: "Endpoint", fill: "#1c2128", stroke: "#58a6ff", dashed: false },
  { label: "Logic", fill: "#1c2128", stroke: "#7ee787", dashed: false },
  { label: "Datastore", fill: "#1c2128", stroke: "#bc8cff", dashed: false },
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
 * Appends a small legend to a rendered flowchart SVG: a colored swatch +
 * label per category, so the endpoint/logic/datastore/context color
 * convention is self-explanatory to a first-time PR viewer instead of
 * something they'd have to already know. Server-side post-processing
 * (rather than asking the LLM to draw it) means it's always present,
 * always correct, and can never be corrupted by model output. A no-op for
 * sequenceDiagram, where the category system doesn't apply.
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

  const rowHeight = 30;
  const swatchSize = 12;
  const gap = 10;
  const fontSize = 12;
  const padding = 12;
  // Narrow diagrams (a 2-node flowchart is ~470 units wide) can't fit all 5
  // legend entries on one row — a bug caught in visual QA where the last
  // 1-2 entries silently clipped off the right edge of the SVG's own
  // viewBox instead of wrapping. Wrap to a new row instead of assuming the
  // diagram is wide enough.
  const availableWidth = Math.max(width, 260);

  let cursorX = padding;
  let row = 0;
  const itemGroups: string[] = [];
  for (const entry of LEGEND_ENTRIES) {
    const estimatedWidth = swatchSize + 6 + entry.label.length * (fontSize * 0.58) + gap * 2;
    if (cursorX + estimatedWidth > availableWidth && cursorX > padding) {
      row += 1;
      cursorX = padding;
    }
    const rowY = row * rowHeight;
    const dash = entry.dashed ? ' stroke-dasharray="3 2"' : "";
    const textX = cursorX + swatchSize + 6;
    const swatch = `<rect x="${cursorX}" y="${rowY + (rowHeight - swatchSize) / 2}" width="${swatchSize}" height="${swatchSize}" rx="2" fill="${entry.fill}" stroke="${entry.stroke}" stroke-width="1.5"${dash}/>`;
    const label = `<text x="${textX}" y="${rowY + rowHeight / 2}" dominant-baseline="middle" font-family="${FONT_STACK}" font-size="${fontSize}" fill="#8b949e">${escapeXml(entry.label)}</text>`;
    itemGroups.push(swatch + label);
    cursorX = textX + entry.label.length * (fontSize * 0.58) + gap * 2;
  }
  const legendHeight = (row + 1) * rowHeight + 4;
  const itemsSvg = itemGroups.join("");

  const newHeight = height + legendHeight;
  const newWidth = Math.max(width, availableWidth);
  // mmdc's root <svg> also carries a `max-width: <old-width>px` inline
  // style alongside width="100%" — since the aspect ratio changes when the
  // legend adds height (and possibly width), that style has to move with
  // the viewBox or the browser clamps display width to the stale value and
  // the added legend row renders squashed.
  const resized = svg
    .replace(
      /viewBox="[\d.\-]+ [\d.\-]+ [\d.\-]+ [\d.\-]+"/,
      `viewBox="${minX} ${minY} ${newWidth} ${newHeight}"`
    )
    .replace(/max-width:\s*[\d.]+px/, `max-width: ${newWidth}px`);

  const legendGroup = `<g transform="translate(0, ${height})"><rect x="0" y="0" width="${newWidth}" height="${legendHeight}" fill="#0d1117"/>${itemsSvg}</g>`;

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
