/**
 * Deterministic, code-side diff-state classification — added after a
 * harsh-review loop (2026-08-30) caught that trusting the LLM to decide
 * "did this PR actually change this node, or is it just referenced
 * context" collapses under complexity: on a realistic 10-file diff, Claude
 * Haiku marked every single node as "changed," using the Context/removed
 * variants zero times, even for nodes that were obviously pre-existing
 * systems (a payment gateway, an event bus) merely being called by new
 * code. That's not a cosmetic bug — diff-awareness is the actual product
 * thesis, not decoration on top of a static architecture snapshot, so it
 * can't be left resting on an LLM's inconsistent instruction-following.
 *
 * This module recomputes "was this node actually touched by the diff" from
 * the diff patches themselves — a lookup, not an inference — and overrides
 * whatever changed/Context/removed suffix the model assigned. The model
 * still decides the *base* category (endpoint/logic/datastore), which
 * layer a node belongs to, and the overall graph shape; it just no longer
 * gets the deciding vote on "is this new."
 *
 * The key design choice, and the thing that makes this actually work where
 * a naive "does this word appear anywhere in an added line" approach
 * doesn't: only DEFINITION-shaped lines count as evidence something was
 * changed — `function foo(...)`, `class Foo`, `router.post('/x', ...)`,
 * `CREATE TABLE x`, etc. A mere call-site reference like
 * `await PaymentGateway.refund(...)` does NOT make "PaymentGateway"
 * count as changed, because that line doesn't match any definition
 * pattern — it only ever shows up as something being called. That's
 * exactly the distinction the LLM was failing to make. Every file that
 * still exists after the PR (added or modified) also contributes its own
 * basename as changed-evidence (so `refundWorker.ts` ties to a
 * "RefundWorker" node, and a modified `ordersController.ts` ties to an
 * "OrdersController" node, even when nothing inside the patch matches a
 * definition pattern by itself) — this matters especially in COARSE MODE
 * (see llm.ts), where a whole file collapses into one node named after
 * it rather than one node per function, so the node's label often has no
 * literal overlap with the specific functions that changed inside it. A
 * wholly removed file contributes its basename to the removed set the
 * same way.
 *
 * Deliberately scoped, not a full static-analysis engine: this is a
 * regex/token heuristic over the diff's own text, not an AST-aware diff,
 * and it pools tokens across the whole diff rather than strictly
 * per-file. It can still mis-tag an edge case (e.g. two unrelated files
 * that happen to define same-named functions), but it can no longer
 * reproduce the specific collapse that was caught (100% of nodes marked
 * "changed") — a node whose label matches no definition anywhere in the
 * diff is now always forced to Context, regardless of what the model
 * guessed.
 */

export interface DiffPatchFile {
  filename: string;
  status: string;
  patch: string;
}

// Generic words that show up constantly in both diffs and diagram labels
// without carrying real identifying signal — excluding them cuts down on
// coincidental token overlap.
const STOPWORDS = new Set([
  "the", "and", "for", "this", "that", "from", "with", "export", "async",
  "function", "const", "let", "var", "new", "return", "await", "import",
  "require", "table", "column", "default", "primary", "key", "references",
  "not", "null", "create", "alter", "add", "drop", "get", "post", "put",
  "delete", "patch", "req", "res", "id", "into", "values", "set", "where",
  "type", "types", "int", "text", "true", "false",
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
  return matches.filter((t) => !STOPWORDS.has(t));
}

// Only lines shaped like a *definition* count as evidence a node was
// actually created/modified — a call site referencing the same name does
// not match any of these. Each pattern's first capture group is the
// identifier (a function/class/table name, or a route/topic string) that
// gets tokenized and added as evidence.
const DEFINITION_PATTERNS: RegExp[] = [
  /\bfunction\s+([A-Za-z_]\w*)/, // function name(...) / async function name(...)
  /\bclass\s+([A-Za-z_]\w*)/, // class Name
  /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/, // const name = (...) =>
  /\.(?:get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/i, // router.verb('/path', ...) — a route being registered
  /\.subscribe\(\s*['"]([^'"]+)['"]/, // x.subscribe('topic', ...) — a new handler being wired up
  /\bCREATE\s+TABLE\s+([A-Za-z_]\w*)/i,
  /\bALTER\s+TABLE\s+([A-Za-z_]\w*)/i,
  /\bADD\s+COLUMN\s+([A-Za-z_]\w*)/i,
  /\bDROP\s+TABLE\s+([A-Za-z_]\w*)/i,
];

function extractDefinedTokens(line: string): string[] {
  const content = line.slice(1); // strip the leading +/- diff marker
  const found: string[] = [];
  for (const pattern of DEFINITION_PATTERNS) {
    const m = pattern.exec(content);
    if (m?.[1]) found.push(...tokenize(m[1]));
  }
  return found;
}

function basenameTokens(filename: string): string[] {
  const base = filename.split("/").pop()?.replace(/\.[^./]+$/, "") ?? filename;
  return tokenize(base);
}

/**
 * Scans every changed file's compressed patch for definition-shaped lines
 * and returns two token sets: `changed` (identifiers actually defined or
 * modified by an added `+` line, plus the basename of any wholly new
 * file) and `removed` (identifiers whose only definition evidence is on a
 * `-` line — i.e. genuinely deleted, not just touched — plus the
 * basename of any wholly deleted file).
 */
export function computeDiffTouchState(files: DiffPatchFile[]): {
  changed: Set<string>;
  removed: Set<string>;
} {
  const addedTokens = new Set<string>();
  const removedTokens = new Set<string>();

  for (const file of files) {
    const status = file.status.toLowerCase();
    // Any file that still exists after this PR (added OR modified)
    // contributes its own basename as "changed" evidence, not just wholly
    // new files. This matters a lot in COARSE MODE (llm.ts), where the
    // model is asked to collapse a whole file into one node named after
    // it (e.g. "OrdersController") rather than one node per function —
    // without this, a *modified* file's node had no way to match any
    // evidence at all (its label doesn't literally contain the names of
    // the functions that changed inside it), and got wrongly downgraded
    // to Context despite the file genuinely changing. Found and fixed by
    // actually reading the real reconciled output on the live 10-file
    // stress test, not assumed correct from the unit tests alone.
    if (status === "removed" || status === "deleted") {
      for (const t of basenameTokens(file.filename)) removedTokens.add(t);
    } else {
      for (const t of basenameTokens(file.filename)) addedTokens.add(t);
    }

    for (const line of file.patch.split("\n")) {
      if (line.startsWith("+")) {
        for (const t of extractDefinedTokens(line)) addedTokens.add(t);
      } else if (line.startsWith("-")) {
        for (const t of extractDefinedTokens(line)) removedTokens.add(t);
      }
    }
  }

  const removedOnly = new Set(
    [...removedTokens].filter((t) => !addedTokens.has(t))
  );
  return { changed: addedTokens, removed: removedOnly };
}

const BASE_CATEGORIES = ["endpoint", "logic", "datastore"];

/** Returns the base category (endpoint/logic/datastore) for a plain or
 * *Context-suffixed category, or null for anything else (removed, any
 * *Region category, or an unrecognized string) — those are left untouched
 * by reconciliation since there's no base to reconstruct or, for Region,
 * no diff-state concept that applies. */
function baseCategoryOf(category: string): string | null {
  for (const base of BASE_CATEGORIES) {
    if (category === base || category === `${base}Context`) return base;
  }
  return null;
}

const CLASS_LINE_RE = /^(\s*)class\s+([\w,\s]+?)\s+([A-Za-z]+)\s*$/;

/**
 * Rewrites a flowchart's `class NodeId,NodeId2 <category>` assignments so
 * the changed/Context/removed suffix reflects what the diff actually
 * touched, not what the model guessed. Runs on raw LLM output, before
 * applyArchLensStyling() strips/replaces classDefs — this only ever
 * touches `class` lines, never classDef, and only for the six
 * diff-state-bearing categories (endpoint/logic/datastore and their
 * Context variants); Region-category lines (subgraph coloring) and
 * `removed` lines the model already assigned are left as-is. A no-op for
 * sequenceDiagram, where this category system doesn't exist.
 */
export function reconcileDiffClassification(
  source: string,
  files: DiffPatchFile[]
): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const { changed, removed } = computeDiffTouchState(files);

  const subgraphIds = new Set<string>();
  for (const m of source.matchAll(/subgraph\s+(\w+)/g)) {
    subgraphIds.add(m[1]!);
  }

  const nodeLabels = new Map<string, string>();
  for (const m of source.matchAll(/(\w+)\s*\[\s*"([^"]*)"\s*\]/g)) {
    const [, id, label] = m;
    if (id && label !== undefined && !subgraphIds.has(id) && !nodeLabels.has(id)) {
      nodeLabels.set(id, label);
    }
  }

  const lines = source.split("\n");
  const outLines: Array<string | null> = [...lines];
  const additions: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = CLASS_LINE_RE.exec(lines[i]!);
    if (!match) continue;
    const [, indent, idsRaw, category] = match;
    const base = baseCategoryOf(category!);
    if (!base) continue; // Region / removed / unrecognized — leave untouched

    const ids = idsRaw!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const keepIds: string[] = [];
    const regrouped = new Map<string, string[]>();

    for (const id of ids) {
      const label = nodeLabels.get(id);
      if (!label) {
        keepIds.push(id); // no matching node declaration — can't reconcile blind
        continue;
      }
      const tokens = tokenize(label);
      const hasRemoved = tokens.some((t) => removed.has(t));
      const hasChanged = tokens.some((t) => changed.has(t));

      let newCategory: string;
      if (hasRemoved && !hasChanged) newCategory = "removed";
      else if (hasChanged) newCategory = base;
      else newCategory = `${base}Context`;

      if (newCategory === category) {
        keepIds.push(id);
      } else {
        if (!regrouped.has(newCategory)) regrouped.set(newCategory, []);
        regrouped.get(newCategory)!.push(id);
      }
    }

    if (regrouped.size === 0) continue; // nothing to change on this line

    outLines[i] = keepIds.length > 0 ? `${indent}class ${keepIds.join(",")} ${category}` : null;
    for (const [newCategory, idsForCat] of regrouped) {
      additions.push(`class ${idsForCat.join(",")} ${newCategory}`);
    }
  }

  if (additions.length === 0) {
    return source; // no reconciliation needed — don't touch the source at all
  }

  const rebuilt = outLines.filter((l): l is string => l !== null).join("\n");
  return `${rebuilt.trimEnd()}\n${additions.join("\n")}\n`;
}
