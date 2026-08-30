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
// chart-library export. `htmlLabels: false` is not a style choice — it is
// a correctness fix. Mermaid v10+ defaults flowchart labels to HTML text
// rendered inside <foreignObject>, and <foreignObject> HTML content does
// not render in most browsers when the SVG is loaded through an <img> tag
// (verified against real Chromium: an <img src="diagram.svg"> shows the
// node boxes and edges but every single label is blank). That is exactly
// how GitHub embeds a PR-comment image (`![...](url)` compiles to <img>),
// so before this fix every flowchart ArchLens posted would have rendered
// with invisible node text on GitHub itself. Sequence diagrams were never
// affected — Mermaid renders sequence text as plain SVG <text>, not HTML.
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
const CATEGORY_CLASS_DEFS = [
  "classDef endpoint fill:#1c2128,stroke:#58a6ff,stroke-width:2px,color:#e6edf3",
  "classDef logic fill:#1c2128,stroke:#7ee787,stroke-width:2px,color:#e6edf3",
  "classDef datastore fill:#1c2128,stroke:#bc8cff,stroke-width:2px,color:#e6edf3",
].join("\n");

/**
 * Applies ArchLens's fixed visual identity to already-validated Mermaid
 * source: strips any `classDef` the model emitted (untrusted styling; the
 * model should only reference the three fixed categories) and, for
 * flowchart diagrams only, appends ArchLens's own classDef block so the
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

    const svg = await readFile(outputPath, "utf8");
    return { svg };
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
