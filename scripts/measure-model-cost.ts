/**
 * Real, measured token-cost comparison between claude-haiku-4-5 and
 * claude-sonnet-5 on ArchLens's ACTUAL system prompt + ACTUAL compressed
 * diffs from the two real repo commits already used throughout this
 * project's adversarial review rounds (FastAPI, NestJS). Not an estimate —
 * every number printed here is a real `usage.input_tokens`/`output_tokens`
 * from a real Anthropic Messages API response, multiplied by the real,
 * current per-MTok prices (verified against platform.claude.com/docs
 * 2026-09-04: haiku-4-5 $1/$5 in/out, sonnet-5 $2/$10 in/out).
 *
 * Usage: tsx scripts/measure-model-cost.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { buildCompressedDiff, type ChangedFile } from "../action/src/diff.js";
import { buildPrompt, SYSTEM_PROMPT } from "../backend/lib/llm.js";
import { SCALE_TEST_FILES } from "./fixtures/scale-test-files.js";

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

const STATUS_MAP: Record<string, string> = { A: "added", M: "modified", D: "removed", R: "modified", C: "added" };

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
}

function realChangedFiles(repoDir: string, base: string, head: string): ChangedFile[] {
  const nameStatus = git(repoDir, ["diff", "--name-status", "-M", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
  const numstat = new Map<string, { additions: number; deletions: number }>();
  for (const line of git(repoDir, ["diff", "--numstat", "-M", `${base}..${head}`]).split("\n").filter(Boolean)) {
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
    const patch = git(repoDir, ["diff", `${base}..${head}`, "--", filename]);
    const counts = numstat.get(filename) ?? { additions: 0, deletions: 0 };
    files.push({ filename, status, additions: counts.additions, deletions: counts.deletions, patch });
  }
  return files;
}

interface CaseDef {
  name: string;
  repoDir: string;
  base: string;
  head: string;
  includePatterns: string[];
}

const CASES: CaseDef[] = [
  {
    name: "fastapi (real, structural: db.py/engine change)",
    repoDir: "/home/claude/repo-tests/full-stack-fastapi-template",
    base: "f8dd304~1",
    head: "f8dd304",
    includePatterns: ["**/*"],
  },
  {
    name: "nestjs (real, 14 files, readonly-modifier only -- NO real structural change)",
    repoDir: "/home/claude/repo-tests/nestjs-boilerplate",
    base: "5257ca1~1",
    head: "5257ca1",
    includePatterns: ["**/*"],
  },
];

const MODELS = [
  { key: "claude-haiku-4-5", inPrice: 1, outPrice: 5 },
  { key: "claude-sonnet-5", inPrice: 2, outPrice: 10 },
];

// Generous headroom: the very first probe of claude-sonnet-5 hit the old
// max_tokens=800 ceiling (stop_reason=max_tokens, truncated mid-diagram,
// invalid syntax) on the fastapi case -- a real, measured incompatibility,
// not a hypothetical -- because sonnet-5 produces meaningfully longer
// output than haiku-4-5 for the same prompt. 800 was tuned for haiku;
// comparing at 800 would unfairly penalize sonnet-5 for a harness bug
// rather than a model quality difference.
const MAX_TOKENS = 2000;

async function callModel(
  model: string,
  prompt: string
): Promise<{ inTok: number; outTok: number; text: string; stopReason: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      // claude-sonnet-5 rejects `temperature` outright ("deprecated for this
      // model") -- a real, measured API incompatibility, not a guess. Only
      // send it for models that still accept it.
      ...(model.includes("-5") && !model.includes("haiku") ? {} : { temperature: 0.2 }),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`${model} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
    stop_reason?: string;
  };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  if (!text) {
    console.error(`\n  [DEBUG] ${model} content block types: ${JSON.stringify(data.content?.map((b) => b.type))}`);
    console.error(`  [DEBUG] full response: ${JSON.stringify(data).slice(0, 2000)}`);
  }
  return {
    inTok: data.usage?.input_tokens ?? 0,
    outTok: data.usage?.output_tokens ?? 0,
    text,
    stopReason: data.stop_reason ?? "unknown",
  };
}

async function main() {
  const rows: Array<{ case: string; model: string; inTok: number; outTok: number; costCents: number }> = [];
  const transcripts: string[] = [];

  const namedPrompts: Array<{ name: string; prompt: string; fileCount: number }> = [];
  for (const c of CASES) {
    const files = realChangedFiles(c.repoDir, c.base, c.head);
    const diff = buildCompressedDiff(files, c.includePatterns, 60_000);
    namedPrompts.push({
      name: c.name,
      fileCount: diff.files.length,
      prompt: buildPrompt(
        diff.files.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
        "auto"
      ),
    });
  }
  {
    // Third case: the synthetic-but-genuinely-structural 10-file diff
    // (routes -> controllers -> services -> workers -> migrations, real
    // EventBus/PaymentGateway/NotificationService externals) already used
    // by dry-run-live-scale.ts -- this is the fair node-cap/self-loop/
    // category-adherence stress test, since the real "14-file" nestjs case
    // above turned out to carry zero actual structural change (see below).
    const includePatterns = ["**/routes/**", "**/controllers/**", "**/services/**", "**/workers/**", "**/migrations/**"];
    const diff = buildCompressedDiff(SCALE_TEST_FILES, includePatterns, 60_000);
    namedPrompts.push({
      name: "synthetic scale test (10 files, genuinely structural, coarse-mode cap=10)",
      fileCount: diff.files.length,
      prompt: buildPrompt(
        diff.files.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
        "auto"
      ),
    });
  }

  for (const { name, prompt, fileCount } of namedPrompts) {
    console.log(`\n=== ${name}: ${fileCount} file(s), prompt ${prompt.length} chars ===`);

    for (const m of MODELS) {
      process.stdout.write(`  ${m.key} ... `);
      const { inTok, outTok, text, stopReason } = await callModel(m.key, prompt);
      const costCents = (inTok / 1_000_000) * m.inPrice * 100 + (outTok / 1_000_000) * m.outPrice * 100;
      console.log(
        `in=${inTok} out=${outTok} tok, stop_reason=${stopReason} -> $${(costCents / 100).toFixed(4)}/call`
      );
      rows.push({ case: name, model: m.key, inTok, outTok, costCents });
      transcripts.push(`\n### ${name} / ${m.key} (stop_reason=${stopReason})\n\`\`\`\n${text}\n\`\`\`\n`);
    }
  }

  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir("scripts/.dry-run-output", { recursive: true });
  await writeFile("scripts/.dry-run-output/model-cost-transcripts.md", transcripts.join("\n"), "utf8");
  console.log("\n(full raw model output for every cell saved to scripts/.dry-run-output/model-cost-transcripts.md)");

  console.log("\n\n=== SUMMARY (real measured usage x real current API pricing) ===");
  console.log("case".padEnd(38), "model".padEnd(20), "in_tok".padEnd(8), "out_tok".padEnd(8), "$/call");
  for (const r of rows) {
    console.log(
      r.case.padEnd(38),
      r.model.padEnd(20),
      String(r.inTok).padEnd(8),
      String(r.outTok).padEnd(8),
      `$${(r.costCents / 100).toFixed(4)}`
    );
  }

  const haikuRows = rows.filter((r) => r.model === "claude-haiku-4-5");
  const sonnetRows = rows.filter((r) => r.model === "claude-sonnet-5");
  const haikuAvgCents = haikuRows.reduce((s, r) => s + r.costCents, 0) / haikuRows.length;
  const sonnetAvgCents = sonnetRows.reduce((s, r) => s + r.costCents, 0) / sonnetRows.length;
  console.log(`\nAvg cost/generation: haiku-4-5 = $${(haikuAvgCents / 100).toFixed(4)}, sonnet-5 = $${(sonnetAvgCents / 100).toFixed(4)}`);
  console.log(`Sonnet-5 is ${(sonnetAvgCents / haikuAvgCents).toFixed(2)}x the per-call cost of haiku-4-5.`);

  for (const plan of [
    { name: "solo ($12/mo)", priceUsd: 12 },
    { name: "team ($29/mo)", priceUsd: 29 },
  ]) {
    console.log(`\n--- ${plan.name} ---`);
    for (const [genCount] of [[50], [200], [500]] as const) {
      const haikuCost = (haikuAvgCents / 100) * genCount;
      const sonnetCost = (sonnetAvgCents / 100) * genCount;
      console.log(
        `  ${genCount} diagrams/mo: haiku-4-5 API cost=$${haikuCost.toFixed(2)} (margin $${(plan.priceUsd - haikuCost).toFixed(2)}) | ` +
          `sonnet-5 API cost=$${sonnetCost.toFixed(2)} (margin $${(plan.priceUsd - sonnetCost).toFixed(2)})`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
