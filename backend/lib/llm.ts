export interface DiffFile {
  filename: string;
  status: string;
  patch: string;
}

export type DiagramTypeHint = "flowchart" | "sequence" | "auto";

export interface LlmProvider {
  name: string;
  generateMermaid(prompt: string): Promise<string>;
}

export interface OpenAiCompatConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SYSTEM_PROMPT = `You are ArchLens, a senior software architect. You are given a compressed,
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
  datastoreRegion\` — right after its \`end\`.
- Every flowchart node MUST get exactly one category via a \`class\` line —
  never a \`classDef\` (ArchLens applies its own fixed color palette
  server-side; a classDef you emit is discarded). The three base categories
  are: \`endpoint\` (routes, controllers, API handlers — something that
  directly receives an incoming HTTP/RPC/event request; a file merely
  named \`*Service\` or \`*.service.ts\` is NOT an endpoint just because it's
  reachable from one — classify it by what it IS, not by what calls it),
  \`logic\` (services, business logic, background jobs, and also
  config/dependency files — \`package.json\`, \`pyproject.toml\`,
  lockfiles, env/settings files — when they're worth showing at all),
  \`datastore\` (things that actually store or persist application data:
  tables, schemas, migrations, caches, message queues/topics — NEVER a
  config file, lockfile, or dependency manifest, even one that lists a
  database driver as a dependency).
- **Distinguish what this PR actually changed from pre-existing context.**
  This diagram's whole purpose is showing a diff's impact, not just a
  static picture of the resulting architecture — so a node the diff adds
  or modifies gets its plain category (\`endpoint\`/\`logic\`/\`datastore\`);
  a node that's only referenced for context (e.g. an existing table a new
  column has a foreign key to, an existing service a new endpoint calls,
  but the diff doesn't touch that table/service itself) gets the
  \`Context\`-suffixed variant instead: \`endpointContext\`,
  \`logicContext\`, \`datastoreContext\`. If the diff removes something
  entirely (a deleted endpoint, dropped table, removed function), still
  show it so the removal is visible, but give it the \`removed\` category
  instead of its usual one. **\`removed\` means THIS SPECIFIC node's own
  file/definition was deleted by the diff — never apply it to a node
  just because something ELSE it calls, is called by, or references was
  removed.** (e.g. if \`OrderService\` is deleted but \`OrdersController\`
  — which merely calls it — was only modified, \`OrdersController\` keeps
  its normal category; only \`OrderService\` gets \`removed\`.) If you
  cannot tell from the diff whether something existed before, default it
  to Context rather than guessing it's new — and if you cannot tell
  whether a node was actually deleted vs. merely modified, default it to
  its normal category (or Context) rather than guessing \`removed\`, since
  a wrongly-\`removed\` node is a worse error than an under-highlighted
  one. Example: \`class A,B endpoint\` (new/changed), \`class C
  datastoreContext\` (pre-existing, referenced only), \`class D removed\`
  (deleted by this diff) in the same diagram. Every node must appear in
  exactly one class line total (combine multiple nodes of the same
  category into one line rather than repeating a node).
- For "sequenceDiagram" diagrams, start with \`autonumber\` so steps are
  referenceable in review comments. Declare with \`actor Name\` anything
  outside this codebase's own control — a human user, or an external
  third-party system/API (a payment gateway, an outside email provider) —
  and everything this codebase actually implements with \`participant
  Name\`; this distinguishes "outside the system" from "inside it" at a
  glance, the sequence-diagram equivalent of the endpoint/logic/datastore
  split. **Also show diff-awareness here, the same way flowchart does**:
  wrap the message exchanges that are genuinely new in this PR in
  \`rect rgba(88, 166, 255, 0.18)\` ... \`end\` (exact color, so every
  diagram's "new" highlight matches) — leave pre-existing call flow the
  diff doesn't touch outside any rect block. If the whole exchange is new,
  wrap the entire sequence; if only part of it is new (e.g. an existing
  flow gained one new step), wrap only that part. Add a brief
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
const COARSE_MODE_THRESHOLD = 6;
const COARSE_MODE_MAX_NODES = 12;

export function buildPrompt(files: DiffFile[], diagramType: DiagramTypeHint): string {
  const hint =
    diagramType === "auto"
      ? ""
      : `\nUse diagram type: ${diagramType === "sequence" ? "sequenceDiagram" : "flowchart TD"}.\n`;

  const coarseModeHint =
    files.length > COARSE_MODE_THRESHOLD
      ? `\nCOARSE MODE — this diff touches ${files.length} files, too many for a legible one-node-per-function diagram. Represent one node per FILE or logical module (e.g. "OrdersController", "RefundService"), not one per function/route inside it — fold a file's functions into a single node and let its category reflect the file's dominant role. Merge closely-related files in the same directory into one combined node if that keeps things clearer. Keep the total node count at or under ${COARSE_MODE_MAX_NODES} even if that means grouping further. This applies to flowchart diagrams; for a sequenceDiagram, keep participants at the service level for the same reason.\n`
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
  return {
    name: "anthropic",
    async generateMermaid(prompt: string): Promise<string> {
      if (!cfg.apiKey) {
        throw new Error('Missing API key for LLM provider "anthropic"');
      }

      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 800,
          temperature: 0.2,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }),
      });

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

export interface LlmEnv {
  ARCHLENS_LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  ARCHLENS_ANTHROPIC_MODEL?: string;
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

  return createAnthropicProvider(
    {
      apiKey: env.ANTHROPIC_API_KEY ?? "",
      model: env.ARCHLENS_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
    },
    fetchImpl
  );
}
