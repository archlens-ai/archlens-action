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

const TEST_API_KEY = "alk_live_dryrun_scale";
const svgStore = new Map<string, string>();

async function main() {
  console.log("=== ArchLens LIVE dry run #3: realistic scale (10 files) ===\n");
  const provider = getProvider(env);

  const changedFiles: ChangedFile[] = [
    {
      filename: "src/routes/orders.ts",
      status: "modified",
      additions: 6,
      deletions: 0,
      patch: [
        "@@ -3,2 +3,8 @@",
        "+router.post('/orders', ordersController.create)",
        "+router.get('/orders/:id', ordersController.get)",
        "+router.post('/orders/:id/cancel', ordersController.cancel)",
      ].join("\n"),
    },
    {
      filename: "src/routes/refunds.ts",
      status: "added",
      additions: 4,
      deletions: 0,
      patch: ["@@ -0,0 +1,4 @@", "+router.post('/refunds', refundsController.create)"].join("\n"),
    },
    {
      filename: "src/controllers/ordersController.ts",
      status: "modified",
      additions: 12,
      deletions: 2,
      patch: [
        "@@ -10,2 +10,12 @@",
        "+export async function create(req, res) {",
        "+  const order = await OrderService.createOrder(req.user.id, req.body.cart)",
        "+  await InventoryService.reserveStock(order.items)",
        "+  res.json(order)",
        "+}",
        "+export async function cancel(req, res) {",
        "+  await OrderService.cancelOrder(req.params.id)",
        "+  await RefundService.issueRefund(req.params.id)",
        "+}",
      ].join("\n"),
    },
    {
      filename: "src/controllers/refundsController.ts",
      status: "added",
      additions: 6,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,6 @@",
        "+export async function create(req, res) {",
        "+  const refund = await RefundService.issueRefund(req.body.orderId)",
        "+  res.json(refund)",
        "+}",
      ].join("\n"),
    },
    {
      filename: "src/services/orderService.ts",
      status: "modified",
      additions: 10,
      deletions: 1,
      patch: [
        "@@ -5,1 +5,10 @@",
        "+export async function createOrder(userId, cart) {",
        "+  const order = await db.orders.insert({ userId, cart })",
        "+  await EventBus.publish('order.created', order)",
        "+  return order",
        "+}",
        "+export async function cancelOrder(orderId) {",
        "+  await db.orders.update(orderId, { status: 'cancelled' })",
        "+}",
      ].join("\n"),
    },
    {
      filename: "src/services/refundService.ts",
      status: "added",
      additions: 8,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,8 @@",
        "+export async function issueRefund(orderId) {",
        "+  const order = await db.orders.findById(orderId)",
        "+  const refund = await db.refunds.insert({ orderId, amount: order.total })",
        "+  await PaymentGateway.refund(order.paymentId, order.total)",
        "+  return refund",
        "+}",
      ].join("\n"),
    },
    {
      filename: "src/services/inventoryService.ts",
      status: "modified",
      additions: 3,
      deletions: 0,
      patch: ["@@ -8,0 +8,3 @@", "+export async function reserveStock(items) {", "+  await db.inventory.decrement(items)", "+}"].join(
        "\n"
      ),
    },
    {
      filename: "src/workers/refundWorker.ts",
      status: "added",
      additions: 5,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,5 @@",
        "+EventBus.subscribe('refund.issued', async (refund) => {",
        "+  await NotificationService.sendRefundConfirmation(refund)",
        "+})",
      ].join("\n"),
    },
    {
      filename: "db/migrations/024_add_refunds_table.sql",
      status: "added",
      additions: 7,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,7 @@",
        "+CREATE TABLE refunds (",
        "+  id uuid PRIMARY KEY,",
        "+  order_id uuid REFERENCES orders(id),",
        "+  amount integer NOT NULL,",
        "+  created_at timestamptz DEFAULT now()",
        "+);",
      ].join("\n"),
    },
    {
      filename: "db/migrations/025_add_cancelled_status.sql",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: ["@@ -4,0 +4,1 @@", "+ALTER TABLE orders ADD COLUMN status text DEFAULT 'active';"].join("\n"),
    },
  ];

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
