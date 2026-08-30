/**
 * A second live example, deliberately hinting diagramType: "sequence" with
 * a diff that's about request/response flow between services rather than
 * schema structure — so this and dry-run-live.ts's flowchart together show
 * the actual range of what ArchLens generates today.
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

const TEST_API_KEY = "alk_live_dryrun_seq";
const svgStore = new Map<string, string>();

async function main() {
  console.log("=== ArchLens LIVE dry run #2: sequence diagram example ===\n");
  const provider = getProvider(env);

  const changedFiles: ChangedFile[] = [
    {
      filename: "src/controllers/checkoutController.ts",
      status: "modified",
      additions: 8,
      deletions: 0,
      patch: [
        "@@ -12,3 +12,11 @@",
        " export async function checkout(req, res) {",
        "+  const cart = await CartService.getCart(req.user.id)",
        "+  const total = PricingService.calculateTotal(cart)",
        "+  const payment = await PaymentGateway.charge(req.user.id, total)",
        "+  await OrderService.createOrder(req.user.id, cart, payment.id)",
        "+  await NotificationService.sendReceipt(req.user.email, payment.id)",
        "+  res.json({ orderId: payment.id })",
      ].join("\n"),
    },
    {
      filename: "src/routes/checkout.ts",
      status: "added",
      additions: 3,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,3 @@",
        "+router.post('/checkout', checkoutController.checkout)",
      ].join("\n"),
    },
  ];

  const includePatterns = ["**/routes/**", "**/controllers/**"];
  const diff = buildCompressedDiff(changedFiles, includePatterns, 60_000);
  console.log(`✓ diff compressed: ${diff.files.length} matching file(s), ${diff.totalBytes} bytes`);

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
    prNumber: 19,
    diagramType: "sequence",
    diff,
  });
  console.log(`✓ REAL Anthropic call succeeded -> ${generated.diagramType} diagram`);
  console.log("--- Mermaid source ---");
  console.log(generated.mermaidSource);
  console.log("----------------------");

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
  await writeFile("scripts/.dry-run-output/live-sequence-comment.md", commentBody, "utf8");
  await writeFile("scripts/.dry-run-output/live-sequence-diagram.svg", svg!, "utf8");
  console.log("\n✓ wrote live-sequence-comment.md and live-sequence-diagram.svg");

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
