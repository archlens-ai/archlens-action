export interface DiffFile {
  filename: string;
  status: string;
  patch: string;
}

export type DiagramTypeHint = "flowchart" | "sequence" | "auto";

export interface GenerateMermaidOpts {
  /**
   * Number of files in the diff this prompt was built from. Optional and
   * additive -- existing callers/mocks that only implement
   * generateMermaid(prompt) remain valid LlmProviders. Used by
   * createTieredAnthropicProvider to decide which model tier handles this
   * request (see the 2026-09-04 model-tier decision below): the reliability
   * problems repeatedly found in adversarial review (node-cap overshoot,
   * self-loop edges, hallucinated relationships) concentrate specifically
   * in COARSE MODE (files.length > COARSE_MODE_THRESHOLD), not in ordinary
   * small diffs -- so escalating model tier only there gets most of the
   * reliability win without paying the higher per-call cost on every PR.
   */
  fileCount?: number;
}

export interface LlmProvider {
  name: string;
  generateMermaid(prompt: string, opts?: GenerateMermaidOpts): Promise<string>;
}

export interface OpenAiCompatConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const SYSTEM_PROMPT = `You are ArchLens, a senior software architect. You are given a compressed,
structural diff from a single GitHub pull request (comment/log lines already
stripped). Produce ONE Mermaid diagram describing the system-level impact of
this diff: what components/endpoints/tables/functions changed and how they
relate to each other. Rules:
- Output ONLY raw Mermaid syntax. No markdown fences, no prose, no explanation.
- The first line MUST be a valid Mermaid diagram declaration: "flowchart TD",
  "flowchart LR", or "sequenceDiagram".
- Prefer "sequenceDiagram" when the diff is primarily about call/request flow
  between services or endpoints. Prefer "flowchart TD" when it is primarily
  about data/schema/module structure.
- Keep node/participant labels short (under 40 chars) and derived from actual
  identifiers in the diff (table names, route paths, function/class names) —
  never invent components that aren't evidenced by the diff.
- If the diff is too small or unclear to depict a meaningful diagram, output
  exactly: flowchart TD\\n  A["No structural change detected"]
- Never include raw file contents verbatim beyond short identifiers.

Visual structure — this determines whether the diagram actually reads as an
architecture map or just a scatter of boxes, so follow it closely:
- For "flowchart" diagrams, when the nodes naturally fall into distinct
  architectural layers (e.g. API/routing, business logic, data/storage),
  group them with Mermaid \`subgraph\` blocks using a short human-readable
  title, e.g. \`subgraph API["API Layer"]\` ... \`end\`. Use at most 3-4
  subgraphs. Skip subgraphs entirely for a small diagram (2-3 nodes total)
  where grouping would add noise rather than clarity. Give each subgraph
  a region class matching its dominant category — \`class API
  endpointRegion\`, \`class Logic logicRegion\`, \`class Data
  datastoreRegion\`, \`class ThirdParty externalRegion\` — right after its
  \`end\`. Never put a genuine external dependency (see \`external\` below)
  in the same subgraph as this system's own tables/queues just because
  they're both "data-ish" — give it its own subgraph, or leave it outside
  any subgraph, rather than implying this codebase owns it.
- Every flowchart node MUST get exactly one category via a \`class\` line —
  never a \`classDef\` (ArchLens applies its own fixed color palette
  server-side; a classDef you emit is discarded). The four base categories
  are: \`endpoint\` (routes, controllers, API handlers — something that
  directly receives an incoming HTTP/RPC/event request over the network; a
  file merely named \`*Service\` or \`*.service.ts\` is NOT an endpoint just
  because it's reachable from one — classify it by what it IS, not by what
  calls it. A shell script, CI/CD workflow file (e.g. \`prestart.sh\`,
  \`test-backend.yml\`, a Dockerfile), or any other operational/deployment
  script is NEVER \`endpoint\` either, even though it's technically "an
  entry point" in the sense that something else invokes it — this category
  means "receives HTTP/RPC traffic," not "gets executed/run"; a container
  startup script that never handles a request belongs in \`logic\` — this
  exact confusion was found in a real generated diagram, where
  \`prestart.sh\`/\`tests-start.sh\`/\`test-backend.yml\` were all wrongly
  colored the same blue as a real API route, actively misleading a
  reviewer scanning for "which HTTP endpoints changed"),
  \`logic\` (services, business logic, background jobs, operational/
  deployment/CI scripts (prestart/entrypoint shell scripts, GitHub Actions
  workflow files, Dockerfiles), and also config/dependency files —
  \`package.json\`, \`pyproject.toml\`, lockfiles, env/settings files —
  when they're worth showing at all),
  \`datastore\` (things this system itself implements/owns to store or
  persist application data: its own tables, schemas, migrations, caches,
  message queues/topics — NEVER a config file, lockfile, or dependency
  manifest, even one that lists a database driver as a dependency),
  \`external\` (a third-party system this codebase only CALLS OUT to via a
  client/SDK/API and does not itself implement — a payment gateway, an
  outside email/SMS/push-notification provider, a hosted message broker or
  webhook target owned by another company. The test: does this repo define
  this thing's schema/queue/implementation, or does it only invoke it from
  the outside? \`EventBus\`, \`NotificationService\`, \`PaymentGateway\` and
  similarly-named collaborators referenced only by a method call (never
  defined in this diff) are \`external\`/\`externalContext\`, NOT
  \`datastore\`/\`datastoreContext\` — a purple "datastore" box must mean
  "an actual table/queue this system owns," never "some other service we
  talk to," even when the diff happens to introduce both in the same
  handful of lines).
- **Distinguish what this PR actually changed from pre-existing context.**
  This diagram's whole purpose is showing a diff's impact, not just a
  static picture of the resulting architecture — so a node the diff adds
  or modifies gets its plain category (\`endpoint\`/\`logic\`/\`datastore\`/
  \`external\`); a node that's only referenced for context (e.g. an
  existing table a new column has a foreign key to, an existing service a
  new endpoint calls, an existing third-party integration a new code path
  merely invokes, but the diff doesn't touch that table/service/dependency
  itself) gets the \`Context\`-suffixed variant instead: \`endpointContext\`,
  \`logicContext\`, \`datastoreContext\`, \`externalContext\`. If the diff
  removes something entirely (a deleted endpoint, dropped table, removed
  function), still show it so the removal is visible, but give it the
  \`removed\` category instead of its usual one. **\`removed\` means THIS
  SPECIFIC node's own file/definition was deleted by the diff — never
  apply it to a node just because something ELSE it calls, is called by,
  or references was removed.** (e.g. if \`OrderService\` is deleted but
  \`OrdersController\` — which merely calls it — was only modified,
  \`OrdersController\` keeps its normal category; only \`OrderService\` gets
  \`removed\`.) If you cannot tell from the diff whether something existed
  before, default it to Context rather than guessing it's new — and if you
  cannot tell whether a node was actually deleted vs. merely modified,
  default it to its normal category (or Context) rather than guessing
  \`removed\`, since a wrongly-\`removed\` node is a worse error than an
  under-highlighted one. Example: \`class A,B endpoint\` (new/changed),
  \`class C datastoreContext\` (pre-existing table, referenced only),
  \`class E externalContext\` (pre-existing third-party API, referenced
  only), \`class D removed\` (deleted by this diff) in the same diagram.
  Every node must appear in exactly one class line total (combine multiple
  nodes of the same category into one line rather than repeating a node).
- **Never draw an edge from a node to itself** (e.g. \`A -->|uses| A\`).
  A self-loop conveys no real relationship and only adds visual clutter —
  confirmed as real, wasted width in a generated diagram where 6 of a
  14-edge flowchart were bare self-loops apparently invented just to
  "attach" a node to the diagram. If a node changed but has no genuine
  caller/callee edge to show, its category color alone (plain vs.
  \`Context\`) already communicates that — it needs no edge at all, fake or
  otherwise. Every edge must run between two DIFFERENT nodes.
- **Publish/subscribe (event-driven) relationships are NOT the same as a
  direct function call, and must never be labeled or drawn as one.** A
  direct call (\`OrdersController -->|calls| OrderService\`) means "this
  code path definitely executes this other code," every time, unconditionally.
  A pub/sub relationship means something weaker: "this code registers a
  handler for an event, WHICH ONLY RUNS if something, somewhere, actually
  emits that event" — that may or may not be true, may happen on a totally
  separate deploy/schedule, and may not even exist yet in this PR. Collapsing
  both into the same generic arrow actively misleads a reviewer into
  believing a wiring exists that may not. So: when a node's own code REGISTERS
  a handler on a bus/broker/queue (\`.subscribe(...)\`, \`.on(...)\`, an event
  listener/consumer), label that edge starting with the literal word
  "subscribes to" or "listens for" (include the event/topic name if the diff
  shows one, e.g. \`|subscribes to refund.issued|\` — do NOT wrap it in
  quotation marks: unlike a node's own \`["..."]\` label, Mermaid's
  pipe-delimited \`|...|\` edge-label syntax does not support a quote
  character inside it and will fail to parse if you include one), and draw
  it FROM the bus/broker node TO the subscribing node (the event flows
  outward from the bus to its listener — never the reverse). When a node's
  own code SENDS an event onto a bus/broker/queue (\`.publish(...)\`,
  \`.emit(...)\`, an event producer), label that edge starting with the
  literal word "publishes" or "emits" (again including the event/topic name,
  unquoted, if shown), drawn FROM the producing node TO the bus/broker node.
  Never use a generic label like "calls" or "uses" for either of these — the
  exact words above are what let ArchLens's own server-side code tell a real
  dependency apart from an event-driven maybe-dependency, so use them
  exactly even though they read slightly more verbose than your other edge
  labels.
- For "sequenceDiagram" diagrams, start with \`autonumber\` so steps are
  referenceable in review comments. Declare with \`actor Name\` anything
  outside this codebase's own control — a human user, or an external
  third-party system/API (a payment gateway, an outside email provider) —
  and everything this codebase actually implements with \`participant
  Name\`; this distinguishes "outside the system" from "inside it" at a
  glance, the same actor/participant split flowchart's own \`external\`
  category exists to draw. **Also show diff-awareness here, the same way flowchart does**:
  wrap the message exchanges that are genuinely new in this PR in
  \`rect rgba(88, 166, 255, 0.3)\` ... \`end\` (exact color, so every
  diagram's "new" highlight matches — round 8 raised this from 0.18 after
  pixel-sampling a real render proved 0.18 WAS technically compositing
  correctly, measured, but was so close to the near-black canvas that a
  reviewer looking at the actual screenshot couldn't perceive any
  highlight at all; 0.3 is a real, meaningfully more visible tint on the
  same dark canvas, still short of overpowering the message text it sits
  behind) — leave pre-existing call flow the
  diff doesn't touch outside any rect block. If the whole exchange is new,
  wrap the entire sequence; if only part of it is new (e.g. an existing
  flow gained one new step), wrap only that part. **If the diff adds new
  messages at more than one separate point in an existing flow (not one
  contiguous run), use a SEPARATE \`rect rgba(88, 166, 255, 0.3)\` ... \`end\`
  block for each new run — never merge disjoint new runs into a single
  block that would also cover the untouched existing messages between
  them** (Mermaid fully supports multiple separate rect blocks in one
  diagram — confirmed by live rendering, not an assumption — so there is
  no reason to ever over-wrap for that reason). Every \`rect\` you open
  MUST have its own matching \`end\` — never leave one open, since an
  unclosed block fails the entire render, not just that highlight. Add a
  brief
  \`Note over X: ...\` only where it clarifies a non-obvious side effect
  (an external API call, a DB write, an async job) — not on every message,
  at most 2-3 notes total.`;

// Past this many matched files, Mermaid's own dagre layout engine starts
// crossing edges through unrelated nodes and losing subgraph containment —
// a confirmed, unresolved limitation (see CLAUDE.md item 8/9), not fixed
// by this prompt switch alone. Asking for fewer, coarser nodes reduces how
// often the diagram actually hits that node/edge count, which is a real
// mitigation even though it doesn't touch the layout engine itself — and
// unlike the diagram's content, THIS decision is made in code from a
// number we already have (files.length), not left to the model to notice
// and self-regulate.
// Round-7 finding: on a real 14-file NestJS diff, the actual production
// model (claude-haiku-4-5 — see backend/.env; this product's $12-29/mo
// pricing can't run every diagram through a frontier model) still produced
// 15 nodes against a stated cap of 12 — a confirmed, measured overshoot,
// not a hypothetical. That extra width is exactly what made the rendered
// diagram illegible once scaled down to GitHub's fixed PR-comment column
// (a 2942x632 natural SVG, ~4.7:1, crushed to ~165px tall at 768px wide).
// The cap dropped from 12 to 10 to build in headroom against that observed
// overshoot rate, and the instruction now states the number twice with
// "HARD CAP" framing rather than once with softer language — a cap a
// smaller model already blew past by 25% needs to be stated more
// forcefully, not just left as-is and hoped to land better next time.
// Exported so getProvider()'s model-tier escalation (see
// createTieredAnthropicProvider) uses the exact same number that triggers
// COARSE MODE in the prompt, rather than a second, independently-tunable
// threshold that could quietly drift out of sync with this one.
export const COARSE_MODE_THRESHOLD = 6;
const COARSE_MODE_MAX_NODES = 10;

export function buildPrompt(files: DiffFile[], diagramType: DiagramTypeHint): string {
  const hint =
    diagramType === "auto"
      ? ""
      : `\nUse diagram type: ${diagramType === "sequence" ? "sequenceDiagram" : "flowchart TD"}.\n`;

  const coarseModeHint =
    files.length > COARSE_MODE_THRESHOLD
      ? `\nCOARSE MODE — this diff touches ${files.length} files, too many for a legible one-node-per-function diagram. Represent one node per FILE or logical module (e.g. "OrdersController", "RefundService"), not one per function/route inside it — fold a file's functions into a single node and let its category reflect the file's dominant role. Merge closely-related files in the same directory into one combined node if that keeps things clearer. HARD CAP: ${COARSE_MODE_MAX_NODES} nodes total, no exceptions — if you're at ${COARSE_MODE_MAX_NODES} and more files remain, keep merging/dropping the least important ones rather than going over. **Every \`datastore\` table/schema/queue touched anywhere in the diff MUST still appear somewhere in the diagram, even under this cap — fold it into an existing datastore node's label (e.g. a node already labeled "orders / refunds tables" becomes "orders / refunds / inventory tables") rather than ever silently dropping it.** A reviewer needs to know every table this PR touches; a diagram that quietly omits one is actively misleading, not just incomplete. If something has to give to stay under the node cap, merge or drop service/logic-layer granularity FIRST — never drop a datastore reference to make room. This applies to flowchart diagrams; for a sequenceDiagram, keep participants at the service level for the same reason (hard cap ${COARSE_MODE_MAX_NODES} participants too).\n`
      : "";

  const fileBlocks = files
    .map((f) => `### ${f.filename} (${f.status})\n${f.patch}`)
    .join("\n\n");

  return `${hint}${coarseModeHint}\nCompressed diff (${files.length} file(s)):\n\n${fileBlocks}`;
}

/**
 * Builds a follow-up correction prompt when the model's first attempt
 * produced invalid Mermaid syntax. Feeding back the exact validation error
 * (rather than just "try again") measurably improves one-shot-repair rates.
 */
export function buildRepairPrompt(previousOutput: string, validationError: string): string {
  return `Your previous output was not valid Mermaid syntax.

Validation error: ${validationError}

Previous output:
${previousOutput}

Return ONLY corrected raw Mermaid syntax, following the same rules as before.`;
}

/**
 * Generic client for any OpenAI-compatible chat completions API. DeepSeek's
 * API is wire-compatible with OpenAI's, so this one function backs both
 * providers — only base URL, model, and key differ. Kept dependency-free
 * (plain fetch) so it's trivial to mock in tests and doesn't pin us to an
 * SDK's release cycle for a single-endpoint integration.
 */
export function createOpenAiCompatProvider(
  cfg: OpenAiCompatConfig,
  fetchImpl: typeof fetch = fetch
): LlmProvider {
  return {
    name: cfg.name,
    async generateMermaid(prompt: string): Promise<string> {
      if (!cfg.apiKey) {
        throw new Error(`Missing API key for LLM provider "${cfg.name}"`);
      }

      const res = await fetchImpl(`${cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.2,
          max_tokens: 800,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `LLM provider "${cfg.name}" returned ${res.status}: ${text.slice(0, 500)}`
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`LLM provider "${cfg.name}" returned no content`);
      }
      return stripCodeFence(content.trim());
    },
  };
}

/** Models sometimes wrap output in ```mermaid fences despite instructions not to. Defensive strip. */
function stripCodeFence(text: string): string {
  const fenced = /^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/m.exec(text.trim());
  return fenced?.[1] ? fenced[1].trim() : text;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /**
   * Default 800 was sized for claude-haiku-4-5's observed output length
   * (always well under 550 tokens across every real diagram this project
   * generated). A real measured test of claude-sonnet-5 on the exact same
   * prompt (scripts/measure-model-cost.ts, 2026-09-04) hit max_tokens=800
   * mid-diagram (stop_reason: "max_tokens", truncated/invalid mermaid) --
   * sonnet-5 is more verbose for the same instructions. createTieredAnthropicProvider
   * sets a higher value for its "large" tier; this default is left alone so
   * existing single-model callers (tests, other deployments still pinned to
   * haiku) are unaffected.
   */
  maxTokens?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

/**
 * Native client for Anthropic's Messages API. Not wire-compatible with
 * OpenAI's chat completions format (different auth header, different
 * request/response shape, system prompt is a top-level field rather than a
 * message), so this is a separate implementation rather than another
 * baseUrl swap on createOpenAiCompatProvider.
 */
export function createAnthropicProvider(
  cfg: AnthropicConfig,
  fetchImpl: typeof fetch = fetch
): LlmProvider {
  async function callMessages(prompt: string, includeTemperature: boolean) {
    return fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? 800,
        // Real, measured API incompatibility (not a guess): a direct
        // Messages API call with claude-sonnet-5 rejected this request
        // outright with 400 "`temperature` is deprecated for this model."
        // Rather than hardcode a model-name check (fragile -- e.g.
        // "claude-haiku-4-5" also contains the substring "-5"), send it
        // optimistically and fall back once on that specific error, so any
        // future model with the same restriction is handled automatically.
        ...(includeTemperature ? { temperature: 0.2 } : {}),
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  }

  return {
    name: "anthropic",
    async generateMermaid(prompt: string): Promise<string> {
      if (!cfg.apiKey) {
        throw new Error('Missing API key for LLM provider "anthropic"');
      }

      let res = await callMessages(prompt, true);

      if (!res.ok && res.status === 400) {
        const errBody = await res.text().catch(() => "");
        if (/temperature.*deprecated/i.test(errBody)) {
          res = await callMessages(prompt, false);
        } else {
          throw new Error(`LLM provider "anthropic" returned ${res.status}: ${errBody.slice(0, 500)}`);
        }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM provider "anthropic" returned ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = (await res.json()) as { content?: AnthropicContentBlock[] };
      const textBlock = data.content?.find((block) => block.type === "text" && block.text);
      if (!textBlock?.text) {
        throw new Error('LLM provider "anthropic" returned no text content');
      }
      return stripCodeFence(textBlock.text.trim());
    },
  };
}

export interface TieredAnthropicConfig {
  apiKey: string;
  /** Used for diffs at or below the tier threshold -- the common case. */
  smallModel: string;
  /** Used for diffs above the tier threshold (COARSE MODE), where the
   * smaller model has repeatedly, measurably failed to hold the node-count
   * cap and produced hallucinated/self-referential edges. */
  largeModel: string;
  /** Defaults to COARSE_MODE_THRESHOLD -- the same number that switches the
   * prompt itself into COARSE MODE, so the model escalation and the prompt
   * framing always agree on what counts as "a large diff." */
  threshold?: number;
}

/**
 * Escalates model tier by diff size rather than always using the pricier
 * model for every request. Decision (2026-09-04, see CLAUDE.md item 21):
 * a real measured cost comparison (scripts/measure-model-cost.ts) found
 * claude-sonnet-5 costs ~3.2x claude-haiku-4-5 per call, and the team
 * plan's existing 3000/mo quota (backend/lib/quota.ts) would run at a LOSS
 * against $29/mo if every one of those 3000 calls used sonnet-5
 * unconditionally ($60.90 in API cost alone). But the same real test also
 * showed sonnet-5 fixes the two concrete, previously-diagnosed reliability
 * failures on the exact diffs that exposed them: it held the 10-node
 * coarse-mode cap exactly where haiku-4-5 overshot to 14 (40% over), and it
 * correctly recognized a diff with no real structural content instead of
 * hallucinating detailed-but-fabricated relationships. Both failures only
 * ever showed up on large/complex diffs -- ordinary small diffs were
 * reliably fine on haiku-4-5 throughout this project's whole review
 * history -- so tiering by size captures most of the reliability benefit at
 * a fraction of the blanket-upgrade cost.
 */
export function createTieredAnthropicProvider(
  cfg: TieredAnthropicConfig,
  fetchImpl: typeof fetch = fetch
): LlmProvider {
  const threshold = cfg.threshold ?? COARSE_MODE_THRESHOLD;
  const small = createAnthropicProvider({ apiKey: cfg.apiKey, model: cfg.smallModel, maxTokens: 1200 }, fetchImpl);
  const large = createAnthropicProvider({ apiKey: cfg.apiKey, model: cfg.largeModel, maxTokens: 2500 }, fetchImpl);

  return {
    name: "anthropic",
    async generateMermaid(prompt: string, opts?: GenerateMermaidOpts): Promise<string> {
      const useLarge = (opts?.fileCount ?? 0) > threshold;
      return (useLarge ? large : small).generateMermaid(prompt);
    },
  };
}

export interface LlmEnv {
  ARCHLENS_LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  /**
   * Forces every request onto a single Anthropic model, bypassing tiering
   * below entirely. Kept for back-compat with the pre-2026-09-04 config and
   * as an escape hatch (e.g. pin everything to one model for a controlled
   * experiment) -- takes priority over ARCHLENS_ANTHROPIC_MODEL_SMALL/LARGE
   * when set.
   */
  ARCHLENS_ANTHROPIC_MODEL?: string;
  /** Model for diffs at/below the tier threshold. Default: claude-haiku-4-5. */
  ARCHLENS_ANTHROPIC_MODEL_SMALL?: string;
  /** Model for diffs above the tier threshold (COARSE MODE). Default: claude-sonnet-5. */
  ARCHLENS_ANTHROPIC_MODEL_LARGE?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
}

/**
 * Provider selection defaults to Anthropic — this deployment reuses an
 * existing Claude API key (issued under its own Anthropic Console project,
 * separate from any other product sharing the account, so spend and usage
 * stay attributable to ArchLens) rather than provisioning a fresh OpenAI
 * key. OpenAI and DeepSeek remain fully supported, opt-in via
 * ARCHLENS_LLM_PROVIDER, for deployments that don't have that constraint.
 * DeepSeek in particular stays opt-in only — sending a paying customer's
 * private-repo diff to a Chinese-domiciled model provider by default is a
 * trust and data-residency risk most SMB/enterprise buyers won't accept
 * without being asked first.
 */
export function getProvider(env: LlmEnv, fetchImpl: typeof fetch = fetch): LlmProvider {
  const selected = (env.ARCHLENS_LLM_PROVIDER ?? "anthropic").toLowerCase();

  if (selected === "openai") {
    return createOpenAiCompatProvider(
      {
        name: "openai",
        baseUrl: "https://api.openai.com",
        apiKey: env.OPENAI_API_KEY ?? "",
        model: "gpt-4o-mini",
      },
      fetchImpl
    );
  }

  if (selected === "deepseek") {
    return createOpenAiCompatProvider(
      {
        name: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: env.DEEPSEEK_API_KEY ?? "",
        model: "deepseek-chat",
      },
      fetchImpl
    );
  }

  if (env.ARCHLENS_ANTHROPIC_MODEL) {
    return createAnthropicProvider(
      { apiKey: env.ANTHROPIC_API_KEY ?? "", model: env.ARCHLENS_ANTHROPIC_MODEL },
      fetchImpl
    );
  }

  return createTieredAnthropicProvider(
    {
      apiKey: env.ANTHROPIC_API_KEY ?? "",
      smallModel: env.ARCHLENS_ANTHROPIC_MODEL_SMALL ?? "claude-haiku-4-5",
      largeModel: env.ARCHLENS_ANTHROPIC_MODEL_LARGE ?? "claude-sonnet-5",
    },
    fetchImpl
  );
}
