/**
 * Runs the FULL real ArchLens pipeline (real git diff -> real Anthropic
 * call -> deterministic diff-classification -> real mmdc render) against an
 * ACTUAL historical commit from a real, unrelated GitHub repo, diffed
 * against its own parent — i.e. exactly the diff GitHub would have shown
 * for that PR. This is not a synthetic example we wrote to make the
 * product look good: it's real code, in a style/ecosystem we didn't
 * design the classifier for (decorator-based routes, Alembic/TypeORM
 * migrations, real import churn, real refactor noise), used to find out
 * where ArchLens actually breaks on the kind of PR a real customer would
 * open it against.
 *
 * Usage:
 *   tsx scripts/dry-run-real-repo.ts <repoDir> <baseSha> <headSha> <outName> [includeGlob...]
 *
 * <repoDir> is a local clone (already on disk). <baseSha>/<headSha> are
 * real commit SHAs in that repo's own history — typically headSha's own
 * parent as baseSha, reproducing a real single-commit PR diff. Output
 * files land in scripts/.dry-run-output/<outName>-{comment.md,diagram.svg}.
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
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

const [, , repoDir, baseSha, headSha, outName, ...includeGlobArgs] = process.argv;
if (!repoDir || !baseSha || !headSha || !outName) {
  console.error("usage: tsx scripts/dry-run-real-repo.ts <repoDir> <baseSha> <headSha> <outName> [includeGlob...]");
  process.exit(1);
}
const includePatterns = includeGlobArgs.length > 0 ? includeGlobArgs : ["**/*"];

const STATUS_MAP: Record<string, string> = { A: "added", M: "modified", D: "removed", R: "modified", C: "added" };

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
}

/** Builds ChangedFile[] straight from `git diff <base>..<head>` — the same
 * shape @actions/github's compare API gives the real GitHub Action. */
function realChangedFiles(base: string, head: string): ChangedFile[] {
  const nameStatus = git(["diff", "--name-status", "-M", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
  const numstat = new Map<string, { additions: number; deletions: number }>();
  for (const line of git(["diff", "--numstat", "-M", `${base}..${head}`]).split("\n").filter(Boolean)) {
    const [add, del, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").split(" => ").pop()!.replace(/[{}]/g, "");
    numstat.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 });
  }

  const files: ChangedFile[] = [];
  for (const line of nameStatus) {
    const parts = line.split("\t");
    const statusCode = parts[0]![0]!;
    const filename = parts[parts.length - 1]!;
    const status = STATUS_MAP[statusCode] ?? "modified";
    const patch = git(["diff", `${base}..${head}`, "--", filename]);
    const counts = numstat.get(filename) ?? { additions: 0, deletions: 0 };
    files.push({ filename, status, additions: counts.additions, deletions: counts.deletions, patch });
  }
  return files;
}

async function main() {
  console.log(`=== ArchLens REAL-REPO dry run: ${repoDir} ${baseSha.slice(0, 10)}..${headSha.slice(0, 10)} ===\n`);
  const subject = git(["log", "-1", "--format=%s", headSha]).trim();
  console.log(`PR (real commit): "${subject}"`);

  const provider = getProvider(env);
  const changedFiles = realChangedFiles(baseSha, headSha);
  console.log(`✓ real git diff: ${changedFiles.length} file(s) changed total`);

  const diff = buildCompressedDiff(changedFiles, includePatterns, 60_000);
  console.log(`✓ diff compressed: ${diff.files.length} matching file(s) after include-pattern filter, ${diff.totalBytes} bytes`);
  if (!diff.matched) {
    console.error("No files matched the include patterns — nothing to diagram. Pick a different commit.");
    process.exit(1);
  }
  for (const f of diff.files) console.log(`   - ${f.status.padEnd(9)} ${f.filename}`);

  const apiKey = `alk_live_realrepo_${outName}`;
  const quotaStore = new InMemoryQuotaStore();
  quotaStore.seed(apiKey, { active: true, orgId: "org_dryrun", plan: "team", planLimit: 500, usedThisMonth: 0 });
  const cache = new InMemoryDiagramCache();
  const svgStore = new Map<string, string>();

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
        const key = (req.headers.authorization ?? "").replace(/^Bearer /, "") || null;
        const result = await handleGenerateRequest(body, key, {
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

  console.log("\nCalling the real Anthropic API on this real diff (diagramType: auto)...");
  const generated = await generateDiagram(`http://127.0.0.1:${port}`, {
    apiKey,
    owner: "real-repo-test",
    repo: outName,
    prNumber: 1,
    diagramType: "auto",
    diff,
  });
  console.log(`✓ REAL Anthropic call succeeded -> ${generated.diagramType} diagram`);
  console.log("--- Mermaid source (after deterministic reconciliation) ---");
  console.log(generated.mermaidSource);
  console.log("-------------------------------------------------------------");

  const svg = svgStore.get(generated.svgUrl.split("/").pop()!.replace(".svg", ""));
  console.log(`✓ mmdc rendered a real SVG document (${svg!.length} bytes)`);

  const commentBody = buildCommentBody({
    svgUrl: generated.svgUrl,
    mermaidSource: generated.mermaidSource,
    diagramType: generated.diagramType,
    truncated: diff.truncated,
    repoFullName: outName,
    prNumber: 1,
    filesMatched: diff.files.length,
  });

  await mkdir("scripts/.dry-run-output", { recursive: true });
  await writeFile(`scripts/.dry-run-output/${outName}-comment.md`, commentBody, "utf8");
  await writeFile(`scripts/.dry-run-output/${outName}-diagram.svg`, svg!, "utf8");
  console.log(`\n✓ wrote ${outName}-comment.md and ${outName}-diagram.svg`);

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
