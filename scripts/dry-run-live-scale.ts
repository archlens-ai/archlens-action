/**
 * A third live example, deliberately large (roughly the "10 files across
 * schemas, endpoints, and workers" scenario the product's own brief uses
 * to justify itself) — two reviews of the v1/v2 visual redesign both
 * flagged that the shipped examples were toy-sized (6-7 nodes) and proved
 * nothing about whether the diagram holds up at the scale the product
 * claims to solve. This is that stress test, run for real rather than
 * assumed fine.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";

import { buildCompressedDiff } from "../action/src/diff.js";
import { generateDiagram } from "../action/src/client.js";
import { buildCommentBody } from "../action/src/comment.js";
import { SCALE_TEST_FILES } from "./fixtures/scale-test-files.js";

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

const TEST_API_KEY = "alk_live_dryrun_scale";
const svgStore = new Map<string, string>();

async function main() {
  console.log("=== ArchLens LIVE dry run #3: realistic scale (10 files) ===\n");
  const provider = getProvider(env);

  const changedFiles = SCALE_TEST_FILES;

  const includePatterns = ["**/routes/**", "**/controllers/**", "**/services/**", "**/workers/**", "**/migrations/**"];
  const diff = buildCompressedDiff(changedFiles, includePatterns, 60_000);
  console.log(`✓ diff compressed: ${diff.files.length} matching file(s), ${diff.totalBytes} bytes`);

  const quotaStore = new InMemoryQuotaStore();
  quotaStore.seed(TEST_API_KEY, { active: true, orgId: "org_dryrun", plan: "team", planLimit: 500, usedThisMonth: 0 });
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
          render: (source) => renderMermaidToSvg(source, { executablePath: process.env.ARCHLENS_TEST_CHROMIUM_PATH }),
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

  console.log("Calling the real Anthropic API (10-file diff, diagramType: auto)...");
  const generated = await generateDiagram(`http://127.0.0.1:${port}`, {
    apiKey: TEST_API_KEY,
    owner: "acme",
    repo: "shop",
    prNumber: 512,
    diagramType: "auto",
    diff,
  });
  console.log(`✓ REAL Anthropic call succeeded -> ${generated.diagramType} diagram`);
  console.log("--- Mermaid source ---");
  console.log(generated.mermaidSource);
  console.log("----------------------");
  const nodeCount = (generated.mermaidSource.match(/^\s*\w+\[/gm) ?? []).length;
  console.log(`Approx node count: ${nodeCount}`);

  const svg = svgStore.get(generated.svgUrl.split("/").pop()!.replace(".svg", ""));
  console.log(`✓ mmdc rendered a real SVG document (${svg!.length} bytes)`);

  const commentBody = buildCommentBody({
    svgUrl: generated.svgUrl,
    mermaidSource: generated.mermaidSource,
    diagramType: generated.diagramType,
    truncated: diff.truncated,
    repoFullName: "acme/shop",
    prNumber: 512,
    filesMatched: diff.files.length,
  });

  await mkdir("scripts/.dry-run-output", { recursive: true });
  await writeFile("scripts/.dry-run-output/live-scale-comment.md", commentBody, "utf8");
  await writeFile("scripts/.dry-run-output/live-scale-diagram.svg", svg!, "utf8");
  console.log("\n✓ wrote live-scale-comment.md and live-scale-diagram.svg");

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
