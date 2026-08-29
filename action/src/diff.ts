import { minimatch } from "minimatch";

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CompressedDiff {
  /** true if at least one changed file matched an include pattern */
  matched: boolean;
  /** the compact, model-ready payload */
  files: Array<{ filename: string; status: string; patch: string }>;
  totalBytes: number;
  truncated: boolean;
}

/**
 * Lines that are pure noise for an architecture diagram: comments, blank
 * lines, and logging calls. Stripping these before the diff ever leaves the
 * runner means (a) less to pay the LLM to read, (b) less chance a customer's
 * PR description or log strings leak into the request, (c) a much better
 * signal-to-noise ratio for the model, which improves diagram accuracy.
 */
const NOISE_LINE_PATTERNS: RegExp[] = [
  /^[+-]\s*\/\/.*$/, // // line comments
  /^[+-]\s*#.*$/, // # line comments (python/ruby/yaml)
  /^[+-]\s*--.*$/, // -- line comments (sql) — a first-class file type for this product, not an afterthought
  /^[+-]\s*\*.*$/, // block-comment continuation lines
  /^[+-]\s*(console\.|logger\.|log\.|print\()/i, // logging/debug calls
  /^[+-]\s*$/, // blank added/removed lines
];

function isNoiseLine(line: string): boolean {
  return NOISE_LINE_PATTERNS.some((re) => re.test(line));
}

/**
 * Strips a unified diff patch down to structural signal: file headers,
 * hunk headers, and non-noise +/- lines. Context lines (no leading +/-) are
 * dropped entirely — they're not a change, so they don't inform the diagram.
 */
export function compressPatch(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => {
      if (line.startsWith("@@")) return true; // hunk headers give line context
      if (line.startsWith("+") || line.startsWith("-")) {
        return !isNoiseLine(line);
      }
      return false; // drop unchanged context lines
    })
    .join("\n")
    .trim();
}

export function matchesIncludePatterns(
  filename: string,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => minimatch(filename, pattern, { dot: true }));
}

/**
 * Builds the compact, structural payload sent to the ArchLens API from the
 * raw list of changed files GitHub reports for a PR. Enforces maxDiffBytes
 * by dropping the smallest-signal files first (keeps the largest structural
 * changes, since those are what actually move the diagram) rather than
 * crudely truncating mid-file.
 */
export function buildCompressedDiff(
  files: ChangedFile[],
  includePatterns: string[],
  maxDiffBytes: number
): CompressedDiff {
  const matchingFiles = files.filter((f) =>
    matchesIncludePatterns(f.filename, includePatterns)
  );

  if (matchingFiles.length === 0) {
    return { matched: false, files: [], totalBytes: 0, truncated: false };
  }

  const compressed = matchingFiles
    .map((f) => ({
      filename: f.filename,
      status: f.status,
      patch: f.patch ? compressPatch(f.patch) : "",
      changeSize: f.additions + f.deletions,
    }))
    .filter((f) => f.patch.length > 0)
    // Largest structural change first: if we have to drop files to fit the
    // byte cap, drop the least-informative ones, not an arbitrary suffix.
    .sort((a, b) => b.changeSize - a.changeSize);

  const kept: Array<{ filename: string; status: string; patch: string }> = [];
  let totalBytes = 0;
  let truncated = false;

  for (const file of compressed) {
    const entryBytes = Buffer.byteLength(file.patch, "utf8") + file.filename.length;
    if (totalBytes + entryBytes > maxDiffBytes) {
      truncated = true;
      continue;
    }
    kept.push({ filename: file.filename, status: file.status, patch: file.patch });
    totalBytes += entryBytes;
  }

  // Restore a stable, readable order (by filename) for the payload we send —
  // the size-sort above was only to decide what to drop.
  kept.sort((a, b) => a.filename.localeCompare(b.filename));

  return { matched: true, files: kept, totalBytes, truncated };
}
