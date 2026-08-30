/**
 * Same end-to-end pipeline as scripts/dry-run.ts, but with the STUB LLM
 * swapped for the REAL Anthropic provider (backend/lib/llm.ts's
 * getProvider), reading real credentials from backend/.env. This is the
 * one that actually proves the configured ANTHROPIC_API_KEY produces a
 * usable diagram through the full real pipeline — not just that the key
 * authenticates in isolation (scripts/verify-anthropic.mjs already proved
 * that part). Costs real tokens on every run — don't wire this into CI.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";

import { buildCompressedDiff, type ChangedFile } from "../action/src/diff.js";
import { generateDiagram } from "../action/src/client.js";
import { buildCommentBody } from "../action/src/comment.js";

import { handleGenerateRequest, type GenerateRequestBody } from "../backend/lib/generate-handler.js";
import { InMemoryQuotaStore } from "../backend/lib/quota.js";
import { InMemoryDiagramCache } from "../backend/lib/cache.js";
import { renderMermaidToSvg } from "../backend/lib/mermaid.js";
import { getProvider } from "../backend/lib/llm.js";

const envPath = new URL("../backend/.env", import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
);

const TEST_API_KEY = "alk_live_dryrun";
const svgStore = new Map<string, string>();

async function main() {
  console.log("=== ArchLens LIVE dry run: real Anthropic call -> real validation -> real mmdc render ===\n");

  const provider = getProvider(env);
  console.log(`Using LLM provider: ${provider.name}, model: ${env.ARCHLENS_ANTHROPIC_MODEL ?? "(default)"}`);

  const changedFiles: ChangedFile[] = [
    {
      filename: "src/routes/orders.ts",
      status: "modified",
      additions: 5,
      deletions: 0,
      patch: [
        "@@ -20,3 +20,8 @@",
        " // existing routes above",
        "+router.post('/orders', createOrder)",
        "+router.get('/orders/:id', getOrder)",
      ].join("\n"),
    },
    {
      filename: "db/migrations/0012_create_orders.sql",
      status: "added",
      additions: 5,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,5 @@",
        "+CREATE TABLE orders (",
        "+  id SERIAL PRIMARY KEY,",
        "+  user_id INTEGER REFERENCES users(id),",
        "+  total_cents INTEGER NOT NULL",
        "+);",
      ].join("\n"),
    },
  ];

  const includePatterns = ["**/*.sql", "**/routes/**", "**/migrations/**"];
  const diff = buildCompressedDiff(changedFiles, includePatterns, 60_000);
  assert(diff.matched, "expected the synthetic diff to match include-patterns");
  console.log(`✓ diff compressed: ${diff.files.length} matching file(s), ${diff.totalBytes} bytes`);

  const quotaStore = new InMemoryQuotaStore();
  quotaStore.seed(TEST_API_KEY, {
    active: true,
    orgId: "org_dryrun",
    plan: "solo",
    planLimit: 500,
    usedThisMonth: 0,
  });
  const cache = new InMemoryDiagramCache();

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/generate") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      void (async () => {
        const body = JSON.parse(raw) as GenerateRequestBody;
        const apiKey = (req.headers.authorization ?? "").replace(/^Bearer /, "") || null;

        const result = await handleGenerateRequest(body, apiKey, {
          quotaStore,
          cache,
          llm: provider,
          render: (source) =>
            renderMermaidToSvg(source, {
              executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH,
            }),
          storeSvg: async (hash, svg) => {
            svgStore.set(hash, svg);
            return `http://127.0.0.1:${port}/svg/${hash}.svg`;
          },
        });

        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      })();
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  console.log(`✓ local backend listening on 127.0.0.1:${port}`);

  console.log("Calling the real Anthropic API (claude-haiku-4-5)...");
  const generated = await generateDiagram(`http://127.0.0.1:${port}`, {
    apiKey: TEST_API_KEY,
    owner: "acme",
    repo: "shop",
    prNumber: 7,
    diagramType: "auto",
    diff,
  });
  assert(generated.svgUrl.length > 0, "expected a svgUrl back from the backend");
  console.log(`✓ REAL Anthropic call succeeded -> ${generated.diagramType} diagram (cached=${generated.cached})`);
  console.log("--- Mermaid source returned by the model ---");
  console.log(generated.mermaidSource);
  console.log("---------------------------------------------");

  const svg = svgStore.get(generated.svgUrl.split("/").pop()!.replace(".svg", ""));
  assert(!!svg && svg.includes("<svg") && svg.includes("</svg>"), "expected a real rendered SVG document");
  console.log(`✓ mmdc rendered a real SVG document from the model's output (${svg!.length} bytes)`);

  const commentBody = buildCommentBody({
    svgUrl: generated.svgUrl,
    mermaidSource: generated.mermaidSource,
    diagramType: generated.diagramType,
    truncated: diff.truncated,
    repoFullName: "acme/shop",
  });

  await mkdir("scripts/.dry-run-output", { recursive: true });
  await writeFile("scripts/.dry-run-output/live-comment.md", commentBody, "utf8");
  await writeFile("scripts/.dry-run-output/live-diagram.svg", svg!, "utf8");
  console.log("\n✓ wrote scripts/.dry-run-output/live-comment.md and live-diagram.svg for inspection");

  server.close();
  console.log("\n=== LIVE DRY RUN PASSED — real key, real model, real render, real pipeline ===");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Live dry-run assertion failed: ${message}`);
  }
}

main().catch((err) => {
  console.error("\n=== LIVE DRY RUN FAILED ===");
  console.error(err);
  process.exit(1);
});
