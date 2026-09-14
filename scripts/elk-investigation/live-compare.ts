/**
 * One real Anthropic call (the same 10-file scale fixture every prior ELK
 * tuning round used) to get a real, production-shaped mermaid source, then
 * render that SAME source twice -- once with the current production
 * ORTHOGONAL edge routing, once with the POLYLINE candidate from the
 * synthetic repro -- so the only variable that changes is the layout
 * setting, not LLM output variance. This is the real-world regression
 * check for the item-33 ELK routing fix, on top of the synthetic repro.
 */
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import http from "node:http";

import { buildCompressedDiff } from "../../action/src/diff.js";
import { generateDiagram } from "../../action/src/client.js";
import { SCALE_TEST_FILES } from "../fixtures/scale-test-files.js";
import { handleGenerateRequest, type GenerateRequestBody } from "../../backend/lib/generate-handler.js";
import { InMemoryQuotaStore } from "../../backend/lib/quota.js";
import { InMemoryDiagramCache } from "../../backend/lib/cache.js";
import { renderMermaidToSvg } from "../../backend/lib/mermaid.js";
import { getProvider } from "../../backend/lib/llm.js";

const envPath = new URL("../../backend/.env", import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
);

const TEST_API_KEY = "alk_live_dryrun_elkcompare";
const svgStore = new Map<string, string>();

async function main() {
  const provider = getProvider(env);
  const changedFiles = SCALE_TEST_FILES;
  const includePatterns = ["**/routes/**", "**/controllers/**", "**/services/**", "**/workers/**", "**/migrations/**"];
  const diff = buildCompressedDiff(changedFiles, includePatterns, 60_000);

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
          // No render here -- we only want the raw mermaidSource this once;
          // rendering happens twice, manually, below.
          render: async (source) => ({ svg: "<svg/>", warnings: [] }),
          storeSvg: async () => "unused",
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

  console.log("Calling the real Anthropic API once (10-file scale fixture)...");
  const generated = await generateDiagram(`http://127.0.0.1:${port}`, {
    apiKey: TEST_API_KEY,
    owner: "acme",
    repo: "shop",
    prNumber: 512,
    diagramType: "auto",
    diff,
  });
  server.close();
  console.log(`✓ got real mermaid source (${generated.mermaidSource.length} chars)`);

  await mkdir("scripts/elk-investigation", { recursive: true });
  await writeFile("scripts/elk-investigation/live-source.mmd", generated.mermaidSource, "utf8");

  for (const routing of ["ORTHOGONAL", "POLYLINE"]) {
    process.env.ARCHLENS_ELK_EDGE_ROUTING = routing;
    const { svg } = await renderMermaidToSvg(generated.mermaidSource, {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    await writeFile(`scripts/elk-investigation/live-scale-${routing}.svg`, svg, "utf8");
    console.log(`✓ rendered live-scale-${routing}.svg (${svg.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
