import type { CompressedDiff } from "./diff.js";

export interface GenerateRequest {
  apiKey: string;
  owner: string;
  repo: string;
  prNumber: number;
  diagramType: "flowchart" | "sequence" | "auto";
  diff: CompressedDiff;
}

export interface GenerateResponse {
  svgUrl: string;
  mermaidSource: string;
  diagramType: "flowchart" | "sequence";
  cached: boolean;
}

export class ArchLensApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "ArchLensApiError";
  }
}

/**
 * Thin client for the ArchLens generation endpoint. All the interesting
 * logic (LLM call, quota, rendering, caching) lives server-side — the
 * Action deliberately stays dumb so a customer's CI runner never needs a
 * Puppeteer/Chromium toolchain and never sees the raw API key of any
 * upstream LLM provider.
 */
export async function generateDiagram(
  baseUrl: string,
  req: GenerateRequest,
  fetchImpl: typeof fetch = fetch
): Promise<GenerateResponse> {
  const res = await fetchImpl(`${baseUrl}/v1/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
      "user-agent": "archlens-action",
    },
    body: JSON.stringify({
      owner: req.owner,
      repo: req.repo,
      prNumber: req.prNumber,
      diagramType: req.diagramType,
      files: req.diff.files,
      truncated: req.diff.truncated,
    }),
  });

  if (res.status === 401) {
    throw new ArchLensApiError(
      "ArchLens API key is missing, invalid, or expired. Get one at https://archlens.dev/dashboard.",
      401,
      "unauthorized"
    );
  }
  if (res.status === 402 || res.status === 429) {
    const body = await safeJson(res);
    throw new ArchLensApiError(
      body?.message ??
        "Monthly diagram quota exceeded for this plan. Upgrade at https://archlens.dev/pricing.",
      res.status,
      "quota_exceeded"
    );
  }
  if (!res.ok) {
    const body = await safeJson(res);
    throw new ArchLensApiError(
      body?.message ?? `ArchLens API returned ${res.status}`,
      res.status,
      body?.code ?? "unknown_error"
    );
  }

  const data = (await res.json()) as GenerateResponse;
  if (!data.svgUrl || !data.mermaidSource) {
    throw new ArchLensApiError(
      "ArchLens API returned an incomplete response",
      500,
      "malformed_response"
    );
  }
  return data;
}

async function safeJson(res: Response): Promise<{ message?: string; code?: string } | null> {
  try {
    return (await res.json()) as { message?: string; code?: string };
  } catch {
    return null;
  }
}
