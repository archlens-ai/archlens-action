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
- Never include raw file contents verbatim beyond short identifiers.`;

export function buildPrompt(files: DiffFile[], diagramType: DiagramTypeHint): string {
  const hint =
    diagramType === "auto"
      ? ""
      : `\nUse diagram type: ${diagramType === "sequence" ? "sequenceDiagram" : "flowchart TD"}.\n`;

  const fileBlocks = files
    .map((f) => `### ${f.filename} (${f.status})\n${f.patch}`)
    .join("\n\n");

  return `${hint}\nCompressed diff (${files.length} file(s)):\n\n${fileBlocks}`;
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
