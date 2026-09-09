import { buildPrompt, buildRepairPrompt, type DiffFile, type DiagramTypeHint, type LlmProvider } from "./llm.js";
import { validateMermaidSyntax } from "./mermaid.js";
import {
  reconcileDiffClassification,
  stripSelfLoopEdges,
  assignMissingCategories,
  collapseSingleNodeSubgraphs,
  annotateFullyNewSequence,
  groupUngroupedExternalNodes,
  annotatePublishSubscribeEdges,
  sanitizeEdgeLabelQuotes,
  closeUnclosedSequenceBlocks,
  reconcileDatastoreNodeLabels,
  canonicalizeSubgraphTitles,
} from "./diff-classify.js";
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
    // fileCount is passed through so a tiered LlmProvider (see
    // createTieredAnthropicProvider in llm.ts) can escalate model quality
    // for large/complex diffs specifically -- that's where the model
    // reliability problems this project kept finding actually concentrate,
    // not on ordinary small diffs.
    const genOpts = { fileCount: body.files.length };
    let mermaidSource = await deps.llm.generateMermaid(prompt, genOpts);
    let validation = validateMermaidSyntax(mermaidSource);

    if (!validation.valid) {
      const repaired = await deps.llm.generateMermaid(
        buildRepairPrompt(mermaidSource, validation.error ?? "invalid syntax"),
        genOpts
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

    // Deterministic backstop, round-13 finding, found running a real live
    // API call against the real 10-file scale diff: the model quoted an
    // event name inside a pipe-delimited edge label (`|publishes
    // "order.created"|`), which Mermaid's flowchart parser rejects outright
    // — a real render failure validateMermaidSyntax's cheap regex check
    // doesn't catch. Runs first, before anything else touches the source,
    // since a syntax-breaking issue should never survive to any later step.
    mermaidSource = sanitizeEdgeLabelQuotes(mermaidSource);

    // Deterministic backstop, round-14 finding: investigating a round-12
    // review complaint about disjoint multi-segment sequence highlighting
    // found (via live testing, see diff-classify.ts's own docstring on this
    // function) that the actual real risk wasn't disjoint highlighting
    // itself -- it already works -- but that asking the model to emit more
    // separate rect blocks per diagram means more open/close pairs it has
    // to track, and a single unclosed `rect`/`loop`/`alt`/`opt`/`par`/
    // `critical`/`break` block breaks the ENTIRE render (confirmed via a
    // real reproduced parse error), a failure validateMermaidSyntax's cheap
    // regex check doesn't catch. Runs early, alongside the other syntax-
    // safety backstop above, since a parse-breaking issue should never
    // survive to any later step. A no-op for flowchart.
    mermaidSource = closeUnclosedSequenceBlocks(mermaidSource);

    // Deterministic override, not another LLM-trusting step: recompute
    // changed/Context/removed from the diff's own +/- lines rather than
    // the model's guess — see diff-classify.ts for why this exists (a
    // real, reviewer-caught, self-verified failure mode where the model
    // marked every node "changed" on a realistic diff).
    mermaidSource = reconcileDiffClassification(mermaidSource, body.files);

    // Deterministic backstop, same reasoning as above: a real generated
    // diagram (NestJS real-repo test) had 6 of its 14 edges be meaningless
    // self-loops (`RoleSeedService -->|accesses| RoleSeedService`) despite
    // the SYSTEM_PROMPT explicitly forbidding them — the prompt rule alone
    // wasn't reliable enough on the smaller model this product actually
    // runs in production, so this strips any that slip through.
    mermaidSource = stripSelfLoopEdges(mermaidSource);

    // Deterministic backstop, round-13 finding (head-to-head diff-only vs.
    // diff+diagram validation, CLAUDE.md item 25): a real generated diagram
    // (live-scale stress test) drew `Worker -->|calls| EventBus` for what
    // the diff actually shows as an event *subscription*, not a direct
    // call — visually implying a working pipeline the diff never actually
    // wires up, which a no-diagram reviewer of the same diff caught on
    // their own. Restyles any edge whose label already reads as a
    // subscribe relationship to a dotted arrow (so it can never look like
    // a direct call again) and appends an honestly-scoped warning when
    // that edge's own endpoints show no corresponding publish anywhere in
    // the SAME diagram. See annotatePublishSubscribeEdges's own docstring
    // for what this deliberately does NOT attempt to fix (backwards edge
    // direction, or a subscribe relationship the model labeled with a
    // fully generic word like "calls" with no subscribe-language at all —
    // both rely on the SYSTEM_PROMPT change in llm.ts actually landing).
    mermaidSource = annotatePublishSubscribeEdges(mermaidSource);

    // Deterministic backstop, round-11 finding: a fresh adversarial review
    // of the tiered-model output flagged a subgraph wrapping a SINGLE node
    // (`subgraph Data["Database"] ... Tables["orders + refunds tables"] ...
    // end`) as unnecessary visual clutter — a colored border around a node
    // that already has its own colored border, since grouping only one
    // thing conveys nothing a subgraph exists to show. Strips any subgraph
    // whose entire body is exactly one bare node, leaving the node at the
    // top level.
    mermaidSource = collapseSingleNodeSubgraphs(mermaidSource);

    // Deterministic backstop, same reasoning again: a real generated
    // diagram (live-scale stress test) declared and wired up
    // `RefundWorker` but never gave it a `class` line at all — mermaid
    // silently falls back to the theme's primaryBorderColor for an
    // unclassed node, which happens to be the exact same blue as
    // `endpoint`, so a background worker rendered as if it were a real API
    // route. Catches any node left with no category whatsoever.
    mermaidSource = assignMissingCategories(mermaidSource);

    // Deterministic backstop, round-14 finding: the head-to-head validation
    // disclosed a real, unfixed gap where a genuinely-touched table
    // (`InventoryService`'s own new `db.inventory.decrement(...)` write)
    // never appeared anywhere in the diagram — the shared datastore node's
    // label silently omitted it even though the write edge itself was drawn
    // correctly. A SYSTEM_PROMPT fix (llm.ts) landed correctly on the first
    // live re-test but reproduced the same omission again on a second live
    // call with the identical prompt — the same "prompt alone isn't
    // reliable enough" pattern behind every other backstop in this file.
    // Reconciles a datastore node's own label text against write-edges the
    // model already drew, rather than inventing new structure — see
    // reconcileDatastoreNodeLabels's own docstring in diff-classify.ts for
    // why that distinction matters here specifically.
    mermaidSource = reconcileDatastoreNodeLabels(mermaidSource);

    // Deterministic backstop, round-12 finding: a fresh adversarial review
    // of a real generated diagram (live-scale stress test) flagged
    // `EventBus`/`PaymentGateway`/`NotificationService` as bare top-level
    // nodes with no subgraph at all, each reached by a long connector
    // snaking across the canvas — exactly the "reconstruct the graph
    // yourself" cost this product exists to remove. The SYSTEM_PROMPT
    // permits leaving a single external dependency ungrouped, but the
    // model over-applied that permission to three nodes at once. Wraps
    // 2+ contiguous, still-ungrouped external/externalContext nodes into
    // their own "External Services" subgraph; conservatively a no-op if
    // they aren't contiguous in the source (see its own docstring).
    mermaidSource = groupUngroupedExternalNodes(mermaidSource);

    // Deterministic backstop, round-14 review finding (2026-09-07),
    // reproduced live: running the IDENTICAL diff through two separate
    // live Anthropic calls produced different subgraph titles each time
    // for the same region ("Business Logic" vs. "Service Layer," etc.) —
    // a real trust problem for a product whose pitch depends on being a
    // team's stable shared reference. No sampling-parameter fix exists
    // (claude-sonnet-5 rejects both temperature and top_p, confirmed via a
    // direct live API probe), so this removes the model's freedom to
    // choose the wording at all for the one piece of text where that's
    // safe: a subgraph's own title conveys nothing beyond what its own
    // `*Region` class already states deterministically. Runs after
    // groupUngroupedExternalNodes (which can itself create a new
    // subgraph) so it sees the diagram's final subgraph structure.
    mermaidSource = canonicalizeSubgraphTitles(mermaidSource);

    // Deterministic backstop, round-11 finding (sequence diagram side of
    // the same review that flagged the single-node subgraph above): when
    // the ENTIRE sequence is new, the diff-highlight `rect` has nothing
    // un-highlighted to contrast against, so a reviewer scanning quickly
    // can miss that it's a diff-awareness signal at all. A no-op for
    // flowcharts and for any sequence diagram that isn't fully new (see
    // annotateFullyNewSequence's own docstring for the exact conditions).
    mermaidSource = annotateFullyNewSequence(mermaidSource);

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
