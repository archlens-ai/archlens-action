import * as core from "@actions/core";

export interface ActionConfig {
  githubToken: string;
  archlensApiKey: string;
  apiBaseUrl: string;
  includePatterns: string[];
  maxDiffBytes: number;
  diagramType: "flowchart" | "sequence" | "auto";
  failOnError: boolean;
}

/**
 * Reads and validates the Action's inputs. Centralizing this means every
 * other module works with a typed, already-validated config instead of
 * re-parsing core.getInput() strings.
 */
export function loadConfig(): ActionConfig {
  const includePatternsRaw = core.getInput("include-patterns") || "";
  const includePatterns = includePatternsRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const maxDiffBytesRaw = core.getInput("max-diff-bytes") || "60000";
  const maxDiffBytes = Number.parseInt(maxDiffBytesRaw, 10);
  if (!Number.isFinite(maxDiffBytes) || maxDiffBytes <= 0) {
    throw new Error(
      `max-diff-bytes must be a positive integer, got "${maxDiffBytesRaw}"`
    );
  }

  const diagramTypeRaw = (core.getInput("diagram-type") || "auto").toLowerCase();
  if (!["flowchart", "sequence", "auto"].includes(diagramTypeRaw)) {
    throw new Error(
      `diagram-type must be one of flowchart|sequence|auto, got "${diagramTypeRaw}"`
    );
  }

  // Public repos get a shared, rate-limited free-tier key server-side if none
  // is supplied — the Action itself never assumes a key is present.
  const archlensApiKey = core.getInput("archlens-api-key") || "";

  return {
    githubToken: core.getInput("github-token", { required: true }),
    archlensApiKey,
    apiBaseUrl: (core.getInput("api-base-url") || "https://api.archlens.dev").replace(/\/+$/, ""),
    includePatterns,
    maxDiffBytes,
    diagramType: diagramTypeRaw as ActionConfig["diagramType"],
    failOnError: core.getBooleanInput("fail-on-error"),
  };
}
