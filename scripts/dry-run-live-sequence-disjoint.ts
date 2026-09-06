/**
 * Round-14 live verification: a sequence-diagram diff whose new content sits
 * at TWO separate, non-adjacent points in an existing flow (two distinct
 * git hunks in the same file, each a single new call, with the untouched
 * calls between and around them never appearing in the diff at all — that's
 * what buildCompressedDiff's own context-line stripping guarantees). This is
 * exactly the shape round-12's review flagged as unsupported ("a PR that
 * adds new calls at two disjoint points in an existing flow can't be
 * highlighted accurately") — before assuming that's a real Mermaid ceiling,
 * scripts/rect-edge-cases.ts already confirmed live that Mermaid itself
 * renders multiple separate `rect...end` blocks correctly. This script is
 * the other half of that verification: does the ACTUAL PRODUCTION PROMPT,
 * against the REAL model, produce two separate rect blocks for this shape,
 * or does it collapse them into one (incorrectly highlighting the untouched
 * calls in between as if they were new)?
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

const TEST_API_KEY = "alk_live_dryrun_seq_disjoint";
const svgStore = new Map<string, string>();

async function main() {
  console.log("=== ArchLens LIVE dry run: disjoint new-segments sequence diagram ===\n");
  const provider = getProvider(env);

  // Two separate hunks in the SAME file/function: FraudCheckService.verify
  // is a new call inserted early in an existing checkout flow; several
  // unchanged calls later, NotificationService.sendReceipt is a second new
  // call inserted near the end. Nothing between them appears in the diff at
  // all -- compressPatch strips context lines, so the model sees exactly
  // two isolated additions, structurally implying they are NOT part of one
  // contiguous new run.
  const changedFiles: ChangedFile[] = [
    {
      filename: "src/controllers/checkoutController.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      patch: [
        "@@ -13,0 +14 @@",
        "+  await FraudCheckService.verify(req.user.id, cart)",
        "@@ -17,0 +19 @@",
        "+  await NotificationService.sendReceipt(req.user.email, payment.id)",
      ].join("\n"),
    },
  ];

  const includePatterns = ["**/controllers/**"];
  const diff = buildCompressedDiff(changedFiles, includePatterns, 60_000);
  console.log(`✓ diff compressed: ${diff.files.length} matching file(s), ${diff.totalBytes} bytes`);
  console.log("--- compressed diff sent to the model ---");
  console.log(diff.files.map((f) => f.patch).join("\n"));
  console.log("------------------------------------------");

  const quotaStore = new InMemoryQuotaStore();
  quotaStore.seed(TEST_API_KEY, { active: true, orgId: "org_dryrun", plan: "solo", planLimit: 500, usedThisMonth: 0 });
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

  console.log("Calling the real Anthropic API (diagramType: sequence)...");
  const generated = await generateDiagram(`http://127.0.0.1:${port}`, {
    apiKey: TEST_API_KEY,
    owner: "acme",
    repo: "shop",
    prNumber: 33,
    diagramType: "sequence",
    diff,
  });
  console.log(`✓ REAL Anthropic call succeeded -> ${generated.diagramType} diagram`);
  console.log("--- Mermaid source ---");
  console.log(generated.mermaidSource);
  console.log("----------------------");

  const rectOpenCount = (generated.mermaidSource.match(/^\s*rect\s+rgba/gm) ?? []).length;
  console.log(`rect-block count in generated source: ${rectOpenCount}`);
  if (rectOpenCount >= 2) {
    console.log("✓ model produced multiple separate highlight blocks for the two disjoint new calls.");
  } else if (rectOpenCount === 1) {
    console.log(
      "⚠ model produced only ONE highlight block -- check the source above for whether it incorrectly " +
        "spans both new calls (and everything between them) or only covers one of the two."
    );
  } else {
    console.log("⚠ model produced NO highlight block at all.");
  }

  const svg = svgStore.get(generated.svgUrl.split("/").pop()!.replace(".svg", ""));
  console.log(`✓ mmdc rendered a real SVG document (${svg!.length} bytes)`);

  const commentBody = buildCommentBody({
    svgUrl: generated.svgUrl,
    mermaidSource: generated.mermaidSource,
    diagramType: generated.diagramType,
    truncated: diff.truncated,
    repoFullName: "acme/shop",
  });

  await mkdir("scripts/.dry-run-output", { recursive: true });
  await writeFile("scripts/.dry-run-output/live-sequence-disjoint-comment.md", commentBody, "utf8");
  await writeFile("scripts/.dry-run-output/live-sequence-disjoint-diagram.svg", svg!, "utf8");
  console.log("\n✓ wrote live-sequence-disjoint-comment.md and live-sequence-disjoint-diagram.svg");

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
