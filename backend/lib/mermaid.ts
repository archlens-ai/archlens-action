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

  try {
    await writeFile(inputPath, source, "utf8");
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
