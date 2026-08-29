/**
 * End-to-end smoke test: wires the ACTUAL Action logic to the ACTUAL
 * backend logic over a real HTTP connection — not two sets of unit tests
 * mocking each other's boundary. This is what proves the seam between
 * "what the Action sends" and "what the backend expects" actually lines
 * up, and that a real Mermaid diagram gets rendered by mmdc end to end.
 *
 * Uses a stub LLM (no OpenAI key required) so this runs anywhere, but every
 * other component — diff compression, HTTP client, quota/cache logic,
 * mermaid validation, real mmdc rendering, comment body construction — is
 * the real production code.
 */
import http from "node:http";
import { writeFile, mkdir } from "node:fs/promises";

import { buildCompressedDiff, type ChangedFile } from "../action/src/diff.js";
import { generateDiagram } from "../action/src/client.js";
import { buildCommentBody } from "../action/src/comment.js";

import { handleGenerateRequest, type GenerateRequestBody } from "../backend/lib/generate-handler.js";
import { InMemoryQuotaStore } from "../backend/lib/quota.js";
import { InMemoryDiagramCache } from "../backend/lib/cache.js";
import { renderMermaidToSvg } from "../backend/lib/mermaid.js";
import type { LlmProvider } from "../backend/lib/llm.js";

const TEST_API_KEY = "alk_live_dryrun";
const svgStore = new Map<string, string>();

// A stub model: reads the compressed diff and produces a plausible,
// syntactically valid diagram — standing in for a real OpenAI call so this
// script has zero external dependencies.
const stubLlm: LlmProvider = {
  name: "stub",
  async generateMermaid(prompt: string): Promise<string> {
    const routeAdded = /router\.(post|get|put|delete)\(['"]([^'"]+)['"]/i.exec(prompt);
    const tableAdded = /CREATE TABLE (\w+)/i.exec(prompt);
    const route = routeAdded?.[2] ?? "/resource";
    const table = tableAdded?.[1] ?? "resource";
    return [
      "sequenceDiagram",
      "  participant Client",
      "  participant API",
      `  participant ${table}_table as ${table}`,
      `  Client->>API: request ${route}`,
      `  API->>${table}_table: query/write`,
      `  ${table}_table-->>API: result`,
      "  API-->>Client: response",
    ].join("\n");
  },
};

async function main() {
  console.log("=== ArchLens dry run: synthetic PR -> Action -> backend -> mmdc -> comment ===\n");

  // 1. A synthetic PR: a new route + a new SQL migration, plus a noisy
  //    unrelated file that should be filtered out entirely.
  const changedFiles: ChangedFile[] = [
    {
      filename: "src/routes/users.ts",
      status: "modified",
      additions: 6,
      deletions: 0,
      patch: [
        "@@ -10,4 +10,10 @@",
        " // existing routes above",
        "+// register the new users endpoint",
        "+router.post('/users', createUser)",
        "+console.log('route registered')",
      ].join("\n"),
    },
    {
      filename: "db/migrations/0007_create_users.sql",
      status: "added",
      additions: 4,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,4 @@",
        "+-- create the users table",
        "+CREATE TABLE users (",
        "+  id SERIAL PRIMARY KEY",
        "+);",
      ].join("\n"),
    },
    {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1,1 +1,2 @@\n+Updated docs, unrelated to architecture.",
    },
  ];

  const includePatterns = [
    "**/*.sql",
    "**/*.prisma",
    "**/*.graphql",
    "**/schema.json",
    "**/routes/**",
    "**/controllers/**",
    "**/migrations/**",
  ];

  const diff = buildCompressedDiff(changedFiles, includePatterns, 60_000);
  assert(diff.matched, "expected the synthetic diff to match include-patterns");
  assert(
    !diff.files.some((f) => f.filename === "README.md"),
    "README.md must be filtered out by include-patterns"
  );
  assert(
    !diff.files.some((f) => f.patch.includes("console.log")),
    "noise lines (comments/logs) must be stripped from the compressed diff"
  );
  console.log(`✓ diff compressed: ${diff.files.length} matching file(s), ${diff.totalBytes} bytes`);

  // 2. Real backend, served over real HTTP, with a real mmdc render.
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
          llm: stubLlm,
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

  // 3. The Action's real HTTP client hitting that real backend.
  const generated = await generateDiagram(`http://127.0.0.1:${port}`, {
    apiKey: TEST_API_KEY,
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    diagramType: "auto",
    diff,
  });
  assert(generated.svgUrl.length > 0, "expected a svgUrl back from the backend");
  assert(generated.mermaidSource.includes("sequenceDiagram"), "expected a sequence diagram");
  console.log(`✓ backend generated diagram: ${generated.diagramType} (cached=${generated.cached})`);

  // 4. Confirm the actual SVG bytes are a real, well-formed SVG document
  //    (not just that the pipeline returned *a* string).
  const svg = svgStore.get(generated.svgUrl.split("/").pop()!.replace(".svg", ""));
  assert(!!svg && svg.includes("<svg") && svg.includes("</svg>"), "expected a real rendered SVG document");
  console.log(`✓ mmdc rendered a real SVG document (${svg!.length} bytes)`);

  // 5. Re-run the identical diff to prove the content-hash cache works end
  //    to end (no second stub-LLM call, usage counter unchanged).
  const before = await quotaStore.getKeyStatus(TEST_API_KEY);
  const cachedRun = await generateDiagram(`http://127.0.0.1:${port}`, {
    apiKey: TEST_API_KEY,
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    diagramType: "auto",
    diff,
  });
  const after = await quotaStore.getKeyStatus(TEST_API_KEY);
  assert(cachedRun.cached === true, "expected the second identical request to be served from cache");
  assert(before?.usedThisMonth === after?.usedThisMonth, "cache hit must not consume quota");
  console.log(`✓ resubmitting an unchanged diff served from cache, quota unaffected`);

  // 6. The final PR comment body, exactly as a real user would see it.
  const commentBody = buildCommentBody({
    svgUrl: generated.svgUrl,
    mermaidSource: generated.mermaidSource,
    diagramType: generated.diagramType,
    truncated: diff.truncated,
    repoFullName: "acme/widgets",
  });

  await mkdir("scripts/.dry-run-output", { recursive: true });
  await writeFile("scripts/.dry-run-output/comment.md", commentBody, "utf8");
  await writeFile("scripts/.dry-run-output/diagram.svg", svg!, "utf8");
  console.log("\n✓ wrote scripts/.dry-run-output/comment.md and diagram.svg for inspection");

  server.close();
  console.log("\n=== ALL DRY-RUN CHECKS PASSED ===");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Dry-run assertion failed: ${message}`);
  }
}

main().catch((err) => {
  console.error("\n=== DRY RUN FAILED ===");
  console.error(err);
  process.exit(1);
});
