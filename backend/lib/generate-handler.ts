import { buildPrompt, buildRepairPrompt, type DiffFile, type DiagramTypeHint, type LlmProvider } from "./llm.js";
import { validateMermaidSyntax } from "./mermaid.js";
import { reconcileDiffClassification } from "./diff-classify.js";
import { computeDiffHash, type DiagramCache } from "./cache.js";
import type { QuotaStore } from "./quota.js";

export interface GenerateRequestBody {
  owner: string;
  repo: string;
  prNumber: number;
  diagramType: DiagramTypeHint;
  files: DiffFile[];
  truncated: boolean;
}

export interface GenerateResult {
  svgUrl: string;
  mermaidSource: string;
  diagramType: "flowchart" | "sequence";
  cached: boolean;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export interface GenerateDeps {
  quotaStore: QuotaStore;
  cache: DiagramCache;
  llm: LlmProvider;
  render: (source: string) => Promise<{ svg: string }>;
  storeSvg: (hash: string, svg: string) => Promise<string>;
}

function detectDiagramType(source: string): "flowchart" | "sequence" {
  return /^sequenceDiagram/i.test(source.trim()) ? "sequence" : "flowchart";
}

function isApiError(x: unknown): x is ApiError {
  return typeof x === "object" && x !== null && "status" in x && "code" in x;
}

/**
 * Pure request handler — no HTTP framework, no live Supabase/OpenAI. Every
 * dependency is injected, so this is unit-testable end to end with fakes
 * (see tests/generate-handler.test.ts) while api/generate.ts wires the real
 * Supabase/OpenAI/mmdc implementations for production.
 *
 * Order of operations matters for cost control: we check the content-hash
 * cache BEFORE consulting quota or calling the LLM, so a resubmitted or
 * re-run PR with an unchanged matched diff never burns quota or spends a
 * cent on inference.
 */
export async function handleGenerateRequest(
  body: GenerateRequestBody,
  apiKey: string | null,
  deps: GenerateDeps
): Promise<{ status: number; body: GenerateResult | { code: string; message: string } }> {
  if (!apiKey) {
    return err(401, "unauthorized", "Missing ArchLens API key.");
  }
  if (!body.files || body.files.length === 0) {
    return err(400, "bad_request", "No files provided.");
  }

  const keyStatus = await deps.quotaStore.getKeyStatus(apiKey);
  if (!keyStatus || !keyStatus.active) {
    return err(401, "unauthorized", "ArchLens API key is invalid, revoked, or expired.");
  }

  const hash = computeDiffHash(body.files, body.diagramType);
  const cached = await deps.cache.get(hash);
  if (cached) {
    return { status: 200, body: { ...cached, cached: true } };
  }

  if (keyStatus.usedThisMonth >= keyStatus.planLimit) {
    return err(
      402,
      "quota_exceeded",
      `Monthly diagram quota (${keyStatus.planLimit}) exceeded for the ${keyStatus.plan} plan.`
    );
  }

  try {
    const prompt = buildPrompt(body.files, body.diagramType);
    let mermaidSource = await deps.llm.generateMermaid(prompt);
    let validation = validateMermaidSyntax(mermaidSource);

    if (!validation.valid) {
      const repaired = await deps.llm.generateMermaid(
        buildRepairPrompt(mermaidSource, validation.error ?? "invalid syntax")
      );
      const repairedValidation = validateMermaidSyntax(repaired);
      if (repairedValidation.valid) {
        mermaidSource = repaired;
        validation = repairedValidation;
      } else {
        return err(
          502,
          "upstream_generation_failed",
          `Model could not produce valid Mermaid syntax: ${repairedValidation.error}`
        );
      }
    }

    // Deterministic override, not another LLM-trusting step: recompute
    // changed/Context/removed from the diff's own +/- lines rather than
    // the model's guess — see diff-classify.ts for why this exists (a
    // real, reviewer-caught, self-verified failure mode where the model
    // marked every node "changed" on a realistic diff).
    mermaidSource = reconcileDiffClassification(mermaidSource, body.files);

    const { svg } = await deps.render(mermaidSource);
    const svgUrl = await deps.storeSvg(hash, svg);
    const diagramType = detectDiagramType(mermaidSource);
    const result: GenerateResult = { svgUrl, mermaidSource, diagramType, cached: false };

    await deps.cache.put(hash, result);
    await deps.quotaStore.recordUsage(apiKey, {
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
    });

    return { status: 200, body: result };
  } catch (e) {
    if (isApiError(e)) return { status: e.status, body: { code: e.code, message: e.message } };
    const message = e instanceof Error ? e.message : String(e);
    return err(502, "upstream_generation_failed", message);
  }
}

function err(status: number, code: string, message: string) {
  return { status, body: { code, message } };
}
