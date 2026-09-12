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
 * still decides the *base* category (endpoint/logic/datastore/external), which
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
  // Round-7 addition: tokenize()'s minimum token length dropped from 3
  // chars to 2 (see there for why — "db.py" was a real, confirmed false
  // negative), which now lets through short English prose/glue words that
  // never carried signal at 3+ chars. These are generic connective words,
  // never a meaningful identifier on their own, so excluding them keeps
  // the 2-char lookup from matching on noise.
  "to", "is", "in", "on", "at", "by", "as", "or", "if", "it", "an", "be",
  "do", "no", "so", "up", "of", "we", "he",
]);

// Architectural-layer suffixes that show up in nearly every file name and
// class name in nearly every codebase (AuthService, UsersController,
// ItemModel...) once camelCase/dot-case decomposition splits them out as
// their own token (see tokenize() below). Real bug found on a REAL external
// repo: "GoogleService (context)" -- a service the diff never touched --
// was wrongly promoted from Context to "changed" because it shares the
// generic word-piece "service" with an unrelated file that genuinely did
// change (auth.service.ts). These words carry the layer, not the identity.
//
// Kept separate from STOPWORDS (rather than merged in) because they're only
// noise when they ride along with something more specific: "auth.service"
// should drop "service" and match on "auth" alone, but a file whose ENTIRE
// basename is one of these words ("models.py", "utils.py") would otherwise
// lose 100% of its fallback signal -- worse than the collision it's meant
// to prevent. tokenize() below only drops these when at least one other,
// more specific token survives alongside them for that same identifier.
const ARCHITECTURAL_SUFFIX_WORDS = new Set([
  "service", "controller", "model", "models", "entity", "repository",
  "module", "provider", "handler", "manager", "component", "adapter",
  "factory", "helper", "middleware", "worker", "client", "context",
]);

/**
 * Real-world identifiers mix naming conventions across a diff and its
 * rendered diagram label: a file named auth.controller.ts vs a diagram
 * node labeled "AuthController"; a Python file items.py vs a definition
 * `def read_item(...)`. A single extraction pass that only splits on
 * characters outside [a-z0-9_] treats "AuthController" (no such
 * characters) as one indivisible blob that can never equal the two
 * pieces "auth"/"controller" it should be recognized as. This tokenizer
 * runs two passes and unions the results: the original whole-word pass
 * (kept as-is, so every previously-working match still works), plus a
 * decomposition pass that also splits camelCase/PascalCase boundaries
 * (and, redundantly with the first pass, underscore/dot/hyphen) into
 * lowercase word-pieces — so "AuthController", "auth.controller",
 * "auth_controller" and "authController" all normalize to the same
 * {"auth","controller"} regardless of which convention either side
 * happens to use. Found necessary after this collapsed to near-100%
 * *Context (i.e. "nothing here actually changed") on two REAL external
 * repos run through the full pipeline end to end (a Python/FastAPI PR,
 * a NestJS PR) — neither shares the single-word-camelCase file-naming
 * style the original synthetic test fixtures happened to use, and the
 * plural/singular and def-vs-label mismatches those repos' real code
 * produced were being silently swallowed as "unrelated pre-existing
 * code," exactly the failure mode this module was built to prevent, just
 * approached from the opposite direction.
 */
/**
 * Naive English de-pluralization, not a real stemmer — deliberately just
 * covers the common regular cases (items -> item, categories -> category,
 * boxes -> box) that make up the overwhelming majority of real
 * file/module basenames (routes.py vs a "Route" node, models.py vs a
 * "UserModel" node, users.py vs an "UpdateUser" node). Real gap found by
 * testing against tiangolo/full-stack-fastapi-template: a genuinely
 * modified `update_user(...)` whose OWN definition line wasn't touched by
 * the diff (only an inner parameter's type was) had no definition-pattern
 * evidence at all, so it depended entirely on the basename fallback —
 * which failed purely because "user" (singular, from the label) and
 * "users" (plural, from users.py) never compared equal. Only ever adds
 * tokens (called from within tokenize(), which unions everything and
 * filters after), so it can create a new match but can never remove one
 * that already worked. Can occasionally mis-stem an irregular word ending
 * in a single non-doubled "s" that isn't actually plural (status ->
 * "statu", bonus -> "bonu") — accepted: worst case is a made-up token
 * that matches nothing, not a wrong match, since it's purely additive.
 */
function singularize(word: string): string | null {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`; // categories -> category
  if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2); // boxes -> box, classes -> class
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1); // items -> item
  return null;
}

// Round-7 fix: both patterns below required 3+ total characters
// (`{2,}` after a mandatory first char) until a real, confirmed false
// negative was found on the product's own FastAPI real-repo test —
// `db.py`'s basename tokenizes to "db," exactly 2 characters, so it NEVER
// produced any token at all, meaning a `DBConfig["db.py..."]` node could
// never match its own file's basename-derived changed-evidence no matter
// what (the same failure independently sank the round-7 "removed" rescue
// logic below, which depends on this same token overlap). Lowered to 2
// chars minimum (`{1,}`) so short-but-real identifiers like "db", "io",
// "ui", "os" tokenize — the new short-word STOPWORDS entries above guard
// against the generic English glue-words this newly admits.
function tokenize(text: string): string[] {
  const wholeWordTokens = text.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? [];

  const decomposed = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .toLowerCase();
  const splitTokens = decomposed.match(/[a-z][a-z0-9]{1,}/g) ?? [];

  const base = new Set([...wholeWordTokens, ...splitTokens]);
  for (const t of [...base]) {
    const singular = singularize(t);
    if (singular) base.add(singular);
  }

  const all = [...base].filter((t) => !STOPWORDS.has(t));

  const specific = all.filter((t) => !ARCHITECTURAL_SUFFIX_WORDS.has(t));
  // If something more specific survived, drop the generic layer-suffix
  // noise. If the identifier was ENTIRELY generic (e.g. a file literally
  // named "models.py"), keep it anyway -- it's the only signal this
  // identifier has, and no signal at all is worse than an occasional
  // architectural-layer word.
  return specific.length > 0 ? specific : all;
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
  /\bdef\s+([A-Za-z_]\w*)/, // python: def name(...) / async def name(...)
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // go: func name(...) or func (r *Receiver) name(...)
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

// Round-7 addition: `external` (a third-party dependency this system only
// calls — a payment gateway, an outside notification/message provider —
// see mermaid.ts's CATEGORY_CLASS_DEFS for why this needed to be its own
// base category rather than a datastore variant) gets the same diff-aware
// changed/Context/removed reconciliation as endpoint/logic/datastore: an
// external dependency this PR newly wires up should read as "changed," not
// silently downgraded to Context just because it's a fourth category.
const BASE_CATEGORIES = ["endpoint", "logic", "datastore", "external"];

/** Returns the base category (endpoint/logic/datastore/external) for a
 * plain or *Context-suffixed category, or null for anything else (removed,
 * any *Region category, or an unrecognized string) — those are left
 * untouched by reconciliation since there's no base to reconstruct or, for
 * Region, no diff-state concept that applies. */
function baseCategoryOf(category: string): string | null {
  for (const base of BASE_CATEGORIES) {
    if (category === base || category === `${base}Context`) return base;
  }
  return null;
}

const CLASS_LINE_RE = /^(\s*)class\s+([\w,\s]+?)\s+([A-Za-z]+)\s*$/;

// Round-7 addition: every category keyword this product emits, used to
// catch a confirmed, real hallucination — a genuine Anthropic-generated
// diagram (FastAPI real-repo test, round 8) contained the literal line
// `class removed removed`, referencing a node ID that was never declared
// anywhere (no `removed["..."]`) and happens to be spelled identically to
// the category keyword itself. Almost certainly the model meant "the
// removed thing" as a concept, not a real node — a class line whose ONLY
// id is one of these reserved words, with no matching node declaration, is
// dropped outright rather than rendered as a dangling, meaningless
// reference.
const RESERVED_CATEGORY_KEYWORDS = new Set([
  "endpoint",
  "logic",
  "datastore",
  "external",
  "removed",
  "endpointContext",
  "logicContext",
  "datastoreContext",
  "externalContext",
  "endpointRegion",
  "logicRegion",
  "datastoreRegion",
  "externalRegion",
]);

/**
 * Rewrites a flowchart's `class NodeId,NodeId2 <category>` assignments so
 * the changed/Context/removed suffix reflects what the diff actually
 * touched, not what the model guessed. Runs on raw LLM output, before
 * applyArchLensStyling() strips/replaces classDefs — this only ever
 * touches `class` lines, never classDef, and only for the eight
 * diff-state-bearing categories (endpoint/logic/datastore/external and
 * their Context variants); Region-category lines (subgraph coloring) and
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
  // Tracks any real edit, not just `additions.length` — a line that's
  // purely DROPPED (the hallucinated `class removed removed` case below,
  // where a garbage id is removed and nothing takes its place) changes
  // outLines without ever pushing to `additions`, so `additions.length`
  // alone would miss it and the function would wrongly return the
  // untouched original source.
  let anyLineChanged = false;

  for (let i = 0; i < lines.length; i++) {
    const match = CLASS_LINE_RE.exec(lines[i]!);
    if (!match) continue;
    const [, indent, idsRaw, category] = match;

    const ids = idsRaw!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const keepIds: string[] = [];
    const regrouped = new Map<string, string[]>();

    // Round-7 addition: `removed` gets its own reconciliation pass, not the
    // free pass Region/unrecognized categories get. A real generated
    // diagram (FastAPI real-repo test, round 8) re-marked db.py `removed`
    // even though the diff only modified it — the exact false-positive-
    // cascading failure mode the SYSTEM_PROMPT already warns against (see
    // llm.ts), recurring despite that prompt fix because a smaller model's
    // instruction-following isn't perfectly reliable run to run. This
    // catches it deterministically: a node whose label has real evidence
    // of being CHANGED (not just possibly-removed) cannot have been
    // deleted by this same diff, so it's rescued to `logicContext` rather
    // than left rendered as torn out of the codebase — a live, merely-
    // modified file being shown as deleted is a strictly worse, more
    // actively misleading error than one file's category color being an
    // imperfect guess. `logicContext` is the deliberate, disclosed choice
    // here (not a fully general "recover the true category" fix, which
    // would need information `removed` already discarded): every
    // confirmed real occurrence of this bug so far has been a config/
    // settings/infra file, which `logic` already explicitly covers, and it
    // reads as the least alarming, most defensible neutral fallback for a
    // node we can positively prove still exists but can no longer classify
    // precisely.
    if (category === "removed") {
      let droppedAny = false;
      for (const id of ids) {
        if (RESERVED_CATEGORY_KEYWORDS.has(id) && !nodeLabels.has(id)) {
          droppedAny = true; // hallucinated self-reference (e.g. `class removed removed`) — drop it
          continue;
        }
        const label = nodeLabels.get(id);
        if (!label) {
          keepIds.push(id); // no matching node declaration — can't reconcile blind
          continue;
        }
        const tokens = tokenize(label);
        const hasChanged = tokens.some((t) => changed.has(t));
        // Round-10 fix: a real live test (fastapi real-repo, after
        // switching in a tiered model) caught this rescue firing on a
        // GENUINELY deleted file. `BackendPreStart["backend_pre_start.py"]`
        // was correctly marked `removed` by the model, but its label
        // tokenizes to {"backend","pre","start",...}, and "start" ALSO
        // happens to be a token of `tests-start.sh` — an unrelated file
        // that was merely modified elsewhere in the same diff. That
        // coincidental single-word overlap was enough to satisfy
        // `hasChanged` and rescue a real deletion back to "still exists,
        // just unclassifiable." Requiring the label to have NO removed-
        // evidence of its own closes this: `backend_pre_start.py`'s other
        // tokens ("backend", "backend_pre_start") are unique removed-
        // evidence, so hasRemoved is true here and the rescue correctly
        // does not fire. Mirrors the same hasRemoved-takes-precedence rule
        // already used for the base-category branch below.
        const hasRemoved = tokens.some((t) => removed.has(t));
        if (hasChanged && !hasRemoved) {
          if (!regrouped.has("logicContext")) regrouped.set("logicContext", []);
          regrouped.get("logicContext")!.push(id);
        } else {
          keepIds.push(id); // genuine removal — no evidence it's still present
        }
      }

      if (regrouped.size === 0 && !droppedAny) continue; // nothing to change on this line
      anyLineChanged = true;
      outLines[i] = keepIds.length > 0 ? `${indent}class ${keepIds.join(",")} ${category}` : null;
      for (const [newCategory, idsForCat] of regrouped) {
        additions.push(`class ${idsForCat.join(",")} ${newCategory}`);
      }
      continue;
    }

    const base = baseCategoryOf(category!);
    if (!base) continue; // Region / unrecognized — leave untouched

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

    anyLineChanged = true;
    outLines[i] = keepIds.length > 0 ? `${indent}class ${keepIds.join(",")} ${category}` : null;
    for (const [newCategory, idsForCat] of regrouped) {
      additions.push(`class ${idsForCat.join(",")} ${newCategory}`);
    }
  }

  if (!anyLineChanged) {
    return source; // no reconciliation needed — don't touch the source at all
  }

  const rebuilt = outLines.filter((l): l is string => l !== null).join("\n");
  return additions.length > 0 ? `${rebuilt.trimEnd()}\n${additions.join("\n")}\n` : `${rebuilt.trimEnd()}\n`;
}

// Matches a flowchart edge line and captures the raw source/target tokens,
// each optionally followed by an inline `["Shape Label"]` node declaration
// mermaid allows directly on an edge line (`A["x"] --> B["y"]`). Covers the
// arrow variants mermaid's flowchart syntax supports (solid/dotted/thick,
// with or without an `|label|`); every real generated diagram observed so
// far only ever used `-->`, but the others cost nothing to also catch.
const FLOWCHART_EDGE_RE =
  /^(\s*)(\w+)(?:\[[^\]]*\])?\s*(?:--[ox>]|-\.-[ox>]?|==[ox>])\s*(?:\|[^|]*\|\s*)?(\w+)(?:\[[^\]]*\])?\s*$/;

/**
 * Deterministically drops any flowchart edge whose source and target are
 * the SAME node (`A -->|uses| A`) — a real, confirmed failure mode found
 * in a genuine Anthropic-generated diagram (NestJS real-repo test, round
 * 7): asked to keep every node connected, the model invented meaningless
 * self-loop edges (`RoleSeedService -->|accesses| RoleSeedService`,
 * repeated for 6 of that diagram's 14 edges) for nodes that had no real
 * caller/callee relationship to show, apparently just to justify the
 * node's presence. A self-loop conveys no actual relationship — the
 * node's own category color (plain vs. Context) already communicates "this
 * PR touched this" without any edge at all — and it silently inflates edge
 * count and diagram width for zero information, worsening exactly the
 * legibility-at-GitHub's-fixed-comment-width problem a sprawling diagram
 * already has. This runs as a deterministic backstop alongside the
 * SYSTEM_PROMPT rule against self-loops (see llm.ts) rather than instead of
 * it, the same reasoning as reconcileDiffClassification above: a prompt
 * instruction alone isn't reliable enough on its own (this exact bug was
 * found on the smaller/cheaper model this product actually runs against in
 * production, not a hypothetical). A no-op for sequenceDiagram, where a
 * self-message (`A->>A: ...`) is a legitimate, meaningful construct, not a
 * mistake to strip.
 */
export function stripSelfLoopEdges(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const lines = source.split("\n");
  const kept = lines.filter((line) => {
    const m = FLOWCHART_EDGE_RE.exec(line);
    return !(m && m[2] === m[3]);
  });

  if (kept.length === lines.length) {
    return source; // nothing stripped — don't touch the source at all
  }
  return kept.join("\n");
}

/**
 * Deterministically assigns `logicContext` to any flowchart node that's
 * referenced (declared with a `["label"]` shape, or used as an edge
 * endpoint) but never appears in ANY `class` line at all — a real,
 * confirmed failure found in a genuine Anthropic-generated diagram (the
 * 10-file live-scale stress test, round 8): `RefundWorker["refundWorker"]`
 * was declared and wired into two edges but the model's own six `class`
 * lines never mentioned it. mermaid doesn't error on an unclassed node —
 * it silently falls back to the theme's base `primaryBorderColor`, which
 * happens to be the exact same blue ArchLens uses for the `endpoint`
 * category (see ARCHLENS_THEME_CONFIG in mermaid.ts). The practical effect
 * is actively misleading, not merely undecorated: a background worker
 * rendered in "endpoint blue" reads to a reviewer as a real API
 * route/controller, a wrong claim about the architecture the whole product
 * exists to represent accurately, not a cosmetic gap. `logicContext` is
 * used for the same reason it's the fallback everywhere else in this
 * module (see the `removed`-rescue above): the neutral, least-alarming
 * "we can't be sure this is new" bucket, and specifically NOT related to
 * `primaryBorderColor`'s blue, so a rescued node can never again be
 * mistaken for a real endpoint. A no-op for sequenceDiagram, where
 * `class` doesn't apply.
 */
export function assignMissingCategories(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const subgraphIds = new Set<string>();
  for (const m of source.matchAll(/subgraph\s+(\w+)/g)) {
    subgraphIds.add(m[1]!);
  }

  const referenced = new Set<string>();
  for (const m of source.matchAll(/(\w+)\s*\[\s*"[^"]*"\s*\]/g)) {
    if (!subgraphIds.has(m[1]!)) referenced.add(m[1]!);
  }
  for (const line of source.split("\n")) {
    const m = FLOWCHART_EDGE_RE.exec(line);
    if (!m) continue;
    if (!subgraphIds.has(m[2]!)) referenced.add(m[2]!);
    if (!subgraphIds.has(m[3]!)) referenced.add(m[3]!);
  }

  const classified = new Set<string>();
  for (const line of source.split("\n")) {
    const m = CLASS_LINE_RE.exec(line);
    if (!m) continue;
    for (const id of m[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      classified.add(id);
    }
  }

  const missing = [...referenced].filter((id) => !classified.has(id));
  if (missing.length === 0) {
    return source; // every referenced node already has a category — don't touch the source at all
  }

  return `${source.trimEnd()}\nclass ${missing.join(",")} logicContext\n`;
}

// Matches a labeled flowchart edge line, capturing the arrow token
// separately from stripSelfLoopEdges's FLOWCHART_EDGE_RE above (which only
// needs source/target, not the arrow style or label text). Same arrow
// alternation (solid/dotted/thick, each optionally with an o/x/> head), same
// optional `[...]` inline node-shape support on either endpoint.
const EVENT_EDGE_RE =
  /^(\s*)(\w+)((?:\[[^\]]*\])?)\s*(--[ox>]|-\.-[ox>]?|==[ox>])\s*(?:\|([^|]*)\|\s*)?(\w+)((?:\[[^\]]*\])?)\s*$/;

// Matches a label the model gave a pub/sub-style edge. Deliberately broad on
// the subscribe side (covers the prompt's own required phrasing --
// "subscribes to"/"listens for" -- plus the raw method-call shape a model
// might fall back to, `.subscribe(`/`.on(`) and correspondingly broad on the
// publish side, so this still catches edges from before the SYSTEM_PROMPT
// change above, not only new generations.
const SUBSCRIBE_LABEL_RE = /\b(?:subscribes?(?:\s+to)?|listens?(?:\s+(?:for|on))?|\.subscribe\(|\.on\()/i;
const PUBLISH_LABEL_RE = /\b(?:publish(?:es)?|emits?|\.publish\(|\.emit\()/i;

const NO_PUBLISHER_SUFFIX = " ⚠ not shown as published anywhere in this diagram";
const TOPIC_MISMATCH_SUFFIX = " ⚠ no publish edge for this event shown in this diagram";

// Best-effort extraction of the actual event/topic name out of a pub/sub
// edge label, so the no-publisher check below can compare WHICH event is
// published vs. subscribed, not just whether the bus node appears in any
// publish edge at all. Found necessary the moment this was verified against
// a real live Anthropic call (not assumed): the live-scale diff diagram
// published "order.created" and separately subscribed to "refund.issued" on
// the SAME EventBus node -- exactly the shape of the real bug this backstop
// exists to catch -- but a node-level-only check (does EventBus appear in
// ANY publish edge?) would have missed it, since EventBus does publish
// something, just not the thing being subscribed to. Tries the raw
// method-call shape first (`.subscribe('x')`/`.on("x")`/`.publish('x')`/
// `.emit("x")`), then the phrase shape the SYSTEM_PROMPT actually asks for
// ("subscribes to x" / "publishes x"). Returns null (not "no topic") when
// neither shape yields anything -- callers must treat null as "unknown,"
// not "no event," and fall back to the weaker node-level check rather than
// either warn or stay silent on a guess.
function extractEventTopic(label: string, kind: "subscribe" | "publish"): string | null {
  const callMatch = /\.(?:subscribe|on|publish|emit)\(\s*['"]([^'"]+)['"]/.exec(label);
  if (callMatch?.[1]) return callMatch[1].trim().toLowerCase();

  const phraseRe =
    kind === "subscribe"
      ? /\b(?:subscribes?(?:\s+to)?|listens?(?:\s+(?:for|on))?)\s+(.+)$/i
      : /\b(?:publish(?:es)?|emits?)\s+(.+)$/i;
  const phraseMatch = phraseRe.exec(label.trim());
  const raw = phraseMatch?.[1]?.trim();
  return raw ? raw.replace(/^['"]|['"]$/g, "").toLowerCase() : null;
}

/**
 * Round-13 finding, from the head-to-head diff-only vs. diff+diagram
 * validation (2026-09-06, CLAUDE.md item 25): on the harder, product-
 * representative 10-file scale diff, the diagram drew `Worker -->
 * |calls| EventBus` for what the diff actually shows as an
 * `EventBus.subscribe(...)` registration -- the opposite semantic
 * relationship from a direct call, rendered with the exact same generic
 * arrow. A subagent given ONLY the diagram (no code) said outright: "I'd
 * have shipped a wrong mental model of the EventBus relationship if I'd
 * stopped at the picture" -- the diagram visually implied a working,
 * unconditional Services<->Worker pipeline through the shared EventBus
 * node, when the diff never actually publishes the one event
 * (`refund.issued`) that worker subscribes to. A no-diagram reviewer of
 * the exact same diff caught that missing wiring on their own, purely by
 * reading the code -- the diagram made the SAME diff look safer than it
 * is, which is close to the worst thing a "catch integration issues
 * faster" product can do.
 *
 * This is a two-part fix, same "prompt rule alone isn't reliable enough,
 * so code enforces it after generation" pattern as every other function
 * in this file: llm.ts's SYSTEM_PROMPT now requires "subscribes to"/
 * "publishes" phrasing (and the correct bus-to-subscriber edge direction)
 * for event-driven relationships, but a smaller production model won't
 * always comply, so this backstop (a) re-styles any edge whose label
 * reads as a subscribe relationship (regardless of whether the model used
 * the exact required phrasing) as a DOTTED arrow rather than a solid one
 * -- Mermaid's own visual language for "not a direct/unconditional
 * connection" -- so it can never again look identical to a real function
 * call, and (b) appends a short, honestly-scoped warning when this diagram
 * doesn't itself show a matching publish. Verified live against a real
 * Anthropic call before settling on this shape: the first live run
 * produced a diagram that DID publish something on the same EventBus node
 * (`publishes order.created`) while separately subscribing to a different,
 * unpublished event (`subscribes to refund.issued`) -- a naive "does this
 * node appear in ANY publish edge" check would have missed exactly the
 * bug this exists to catch, so extractEventTopic() below compares the
 * actual event/topic NAME on each side when both are extractable, and only
 * falls back to the weaker node-level check when a name can't be pulled
 * out of one side or the other. Either way this deliberately claims
 * nothing about the real codebase (this tool only ever sees a diff, never
 * the whole repo, so it cannot know whether the event is published
 * somewhere untouched by this PR) -- it states only what's true of the
 * diagram itself: this picture doesn't show a matching publish, which is
 * exactly the situation a reviewer should independently verify rather than
 * take on faith from the arrow. Deliberately does NOT
 * attempt to fix a backwards subscribe-edge's DIRECTION (subscriber-to-bus
 * vs. the correct bus-to-subscriber) -- inferring "which endpoint is the
 * bus" reliably from a bare edge line, without the SYSTEM_PROMPT's own
 * correct-direction instruction actually landing, isn't something a
 * regex over the rendered source can safely guess at; that half of the
 * fix relies on the prompt change alone; the dotted-style and no-publisher
 * warning below are unaffected by which way the arrow happens to point,
 * since both only key off which endpoints participate in ANY subscribe/
 * publish-labeled edge, not the direction of any one edge. A no-op for
 * sequenceDiagram, where this arrow-styling syntax doesn't apply and the
 * EventBus defect above was never observed (only the flowchart side of
 * this project's own live-scale stress test showed it).
 */
export function annotatePublishSubscribeEdges(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const lines = source.split("\n");

  interface ParsedEdge {
    lineIdx: number;
    source: string;
    target: string;
    label: string | null;
    isSubscribe: boolean;
    isPublish: boolean;
  }

  const edges: ParsedEdge[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = EVENT_EDGE_RE.exec(lines[i]!);
    if (!m) continue;
    const [, , src, , , label, tgt] = m;
    const labelText = label ?? null;
    edges.push({
      lineIdx: i,
      source: src!,
      target: tgt!,
      label: labelText,
      isSubscribe: !!labelText && SUBSCRIBE_LABEL_RE.test(labelText),
      isPublish: !!labelText && PUBLISH_LABEL_RE.test(labelText),
    });
  }

  const subscribeEdges = edges.filter((e) => e.isSubscribe);
  if (subscribeEdges.length === 0) {
    return source; // nothing to restyle or check -- don't touch the source at all
  }

  // Every node that participates (as either endpoint) in ANY publish-
  // labeled edge, anywhere in this diagram -- the fallback signal used only
  // when a specific event/topic name can't be confidently extracted from
  // either side (see extractEventTopic's own docstring for why topic
  // comparison is preferred when available).
  const publishParticipants = new Set<string>();
  // Every event/topic name this diagram shows being published, anywhere --
  // extracted only from edges whose label yields one; publish edges whose
  // topic couldn't be extracted don't contribute here (they still count
  // toward publishParticipants above).
  const publishedTopics = new Set<string>();
  for (const e of edges) {
    if (e.isPublish && e.label) {
      publishParticipants.add(e.source);
      publishParticipants.add(e.target);
      const topic = extractEventTopic(e.label, "publish");
      if (topic) publishedTopics.add(topic);
    }
  }

  let anyChange = false;
  const outLines = [...lines];

  for (const edge of subscribeEdges) {
    const m = EVENT_EDGE_RE.exec(lines[edge.lineIdx]!)!;
    const [, indent, srcId, srcShape, arrow, label, tgtId, tgtShape] = m;

    // Re-style: force a dotted arrow so a subscribe relationship can never
    // render visually identical to a direct call. Already-dotted (`-.-`)
    // arrows are left as-is; thick (`==`) arrows are left alone too --
    // rare enough in real output that guessing a dotted-thick hybrid isn't
    // worth the risk of producing invalid Mermaid syntax.
    const newArrow = arrow!.startsWith("--") ? `-.-${arrow!.slice(2)}` : arrow!;

    // Prefer an exact topic comparison (this edge's own subscribed event
    // vs. every event this diagram shows being published) when both sides
    // yield an extractable name -- this is what actually catches the real
    // bug (subscribes to "refund.issued" while the bus only ever publishes
    // "order.created" elsewhere), which a node-level-only check would
    // miss. Fall back to the weaker "does this edge's own endpoint show up
    // in ANY publish edge at all" check when this edge's topic can't be
    // extracted, or when NO publish edge in the diagram yielded an
    // extractable topic either (nothing to compare against) -- in either
    // case there isn't enough signal to make a specific claim, so this
    // falls back to the broader, still-honestly-scoped question instead of
    // guessing a mismatch that might not be real.
    const subscribedTopic = label ? extractEventTopic(label, "subscribe") : null;
    const canCompareTopics = subscribedTopic !== null && publishedTopics.size > 0;
    const missingWarning = canCompareTopics
      ? !publishedTopics.has(subscribedTopic!)
        ? TOPIC_MISMATCH_SUFFIX
        : null
      : !(publishParticipants.has(edge.source) || publishParticipants.has(edge.target))
        ? NO_PUBLISHER_SUFFIX
        : null;

    const alreadyWarned =
      (label?.includes(NO_PUBLISHER_SUFFIX) || label?.includes(TOPIC_MISMATCH_SUFFIX)) ?? false;
    const newLabel = missingWarning && !alreadyWarned ? `${label ?? ""}${missingWarning}` : label;

    if (newArrow === arrow && newLabel === label) continue; // nothing to change on this edge

    anyChange = true;
    const labelPart = newLabel !== null && newLabel !== undefined && newLabel !== "" ? `|${newLabel}| ` : "";
    outLines[edge.lineIdx] =
      `${indent}${srcId}${srcShape ?? ""} ${newArrow} ${labelPart}${tgtId}${tgtShape ?? ""}`;
  }

  if (!anyChange) {
    return source;
  }
  return outLines.join("\n");
}

// Verbs a "this node writes to this table" edge label uses. Deliberately
// broader than just "writes" -- the model has used "creates"/"updates" for
// the same relationship on different diffs, and all of them carry the same
// "this is a real write into this datastore" signal this backstop needs.
// "decrements" was added after a live call labeled InventoryService's own
// stock-adjustment edge that way instead of "writes" -- a reminder this
// list can't be assumed exhaustive from reasoning alone, only from what
// real model output actually says.
const DATASTORE_WRITE_LABEL_RE =
  /\b(?:writes?|creates?|updates?|deletes?|inserts?|persists?|stores?|saves?|modifies|decrements?|increments?|mutates?)\b/i;

/**
 * Round-14 finding (2026-09-07), from the head-to-head validation's
 * disclosed-but-unfixed "missing datastore node" gap: on the real 10-file
 * scale diff, `InventoryService`'s own genuine write
 * (`db.inventory.decrement(...)`) never showed up anywhere in the
 * diagram -- the model correctly drew `InventoryService -->|writes|
 * Tables`, but the shared `Tables` node's own label only ever said
 * "orders / refunds tables," silently omitting the one table this specific
 * PR's new code actually touches. A reviewer scanning the diagram would
 * reasonably conclude this PR never touches inventory data at all -- a
 * real, misleading omission, not a cosmetic one.
 *
 * A SYSTEM_PROMPT fix (llm.ts's COARSE MODE instruction, which now
 * explicitly requires folding every touched table into an existing
 * datastore node's label rather than dropping any) got this right on the
 * very first live call after the fix landed -- but a SECOND live call with
 * the identical fixed prompt reproduced the exact same omission again (the
 * merged label reverted to "orders / refunds tables," missing "inventory,"
 * even though the `InventoryService -->|writes| Tables` edge was still
 * correctly drawn). n=2, but 1-for-2 is exactly the "prompt alone isn't
 * reliable enough" pattern this project has hit on every other behavior it
 * ever tried to enforce by instruction only -- so, same established
 * pattern as every other fix in this file, here is the deterministic
 * backstop.
 *
 * Deliberately conservative about what it does: it never invents a new
 * node or a new edge (unlike every other backstop in this file, which only
 * ever restyles/reclassifies/annotates structure the model ALREADY drew,
 * this would be the first to fabricate new graph structure, which is a
 * meaningfully higher-risk kind of guess -- wrong invented structure is
 * worse than an omission). Instead it only ever RECONCILES an existing
 * datastore node's own label text against write-relationships the model
 * already drew: for every edge from a non-datastore node to a
 * datastore/datastoreContext node whose label reads as a write (writes/
 * creates/updates/deletes/inserts/persists/stores/saves/modifies), it
 * derives a keyword from the WRITING node's own name (reusing this same
 * file's tokenize()/ARCHITECTURAL_SUFFIX_WORDS logic --
 * "InventoryService" -> "inventory" -- picking the shortest surviving
 * token, since a compound whole-word blob like "orderscontroller" is
 * always the least specific candidate) and appends it to the datastore
 * node's own label if no form of it is already present there. Inserts
 * before a trailing "table"/"tables" word when the label has one (matching
 * this product's own "X / Y tables" convention, so "orders / refunds
 * tables" + "inventory" becomes "orders / refunds / inventory tables," not
 * "orders / refunds tables / inventory"); otherwise appends plainly. A
 * no-op for sequenceDiagram (no datastore-category concept there) and for
 * any diagram where every write-edge's target label already mentions its
 * writer's derived keyword -- the common case once the prompt fix lands
 * correctly on its own.
 */
export function reconcileDatastoreNodeLabels(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const lines = source.split("\n");
  const nodeLabelRe = /^(\s*)(\w+)\[(\(?)"([^"]*)"(\)?)\]\s*$/;

  const categoryOf = new Map<string, string>();
  for (const line of lines) {
    const m = CLASS_LINE_RE.exec(line);
    if (!m) continue;
    const base = baseCategoryOf(m[3]!);
    if (!base) continue;
    for (const id of m[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      categoryOf.set(id, base);
    }
  }

  const labelOf = new Map<string, string>();
  for (const line of lines) {
    const m = nodeLabelRe.exec(line);
    if (m) labelOf.set(m[2]!, m[4]!);
  }

  const missingByTarget = new Map<string, Set<string>>();
  for (const line of lines) {
    const m = EVENT_EDGE_RE.exec(line);
    if (!m) continue;
    const sourceId = m[2]!;
    const label = m[5];
    const targetId = m[6]!;
    if (!label || !DATASTORE_WRITE_LABEL_RE.test(label)) continue;
    if (categoryOf.get(targetId) !== "datastore") continue;
    if (categoryOf.get(sourceId) === "datastore") continue;

    const keywords = deriveTableKeywords(sourceId, labelOf.get(sourceId));
    if (keywords.length === 0) continue;
    const targetLabel = labelOf.get(targetId);
    if (targetLabel === undefined) continue;

    for (const keyword of keywords) {
      if (labelAlreadyMentions(targetLabel, keyword)) continue;
      if (!missingByTarget.has(targetId)) missingByTarget.set(targetId, new Set());
      missingByTarget.get(targetId)!.add(keyword);
    }
  }

  if (missingByTarget.size === 0) {
    return source;
  }

  return lines
    .map((line) => {
      const m = nodeLabelRe.exec(line);
      if (!m) return line;
      const id = m[2]!;
      const missing = missingByTarget.get(id);
      if (!missing || missing.size === 0) return line;
      const [, indent, , openParen, label, closeParen] = m;
      const newLabel = insertKeywordsIntoLabel(label!, [...missing]);
      return `${indent}${id}[${openParen}"${newLabel}"${closeParen}]`;
    })
    .join("\n");
}

// Round-15 finding, live-verified: a node whose label reads
// "OrderService + InventoryService" -- the model's own way of writing
// down a merge of two originally-separate services into one node under
// node-cap pressure -- used to derive a keyword from ONLY the first "+"
// -separated part, silently dropping every other one. A merged node's
// write edge could therefore never surface the SECOND service's own table
// even when the datastore label was otherwise missing it -- the exact
// bug this whole function exists to prevent, just reachable through a
// node-merging path rather than a missing-edge path. Now derives one
// keyword per "+"-separated part and returns all of them, so a merged
// node contributes every constituent service's own keyword, not just the
// first one alphabetically/positionally written.
function deriveTableKeywords(nodeId: string, label: string | undefined): string[] {
  const parts = (label ?? nodeId).split(/\s*\+\s*/).filter(Boolean);
  const keywords: string[] = [];
  for (const part of parts) {
    const candidates = tokenize(part).filter((t) => t.length >= 3);
    if (candidates.length === 0) continue;
    const shortest = candidates.reduce((s, t) => (t.length < s.length ? t : s));
    if (!keywords.includes(shortest)) keywords.push(shortest);
  }
  return keywords;
}

function labelAlreadyMentions(label: string, keyword: string): boolean {
  const labelTokens = tokenize(label);
  return labelTokens.some((t) => t.includes(keyword) || keyword.includes(t));
}

function insertKeywordsIntoLabel(label: string, keywords: string[]): string {
  const additions = keywords.join(" / ");
  const trailingTableWord = /^(.*?)(\s+tables?)$/i.exec(label);
  if (trailingTableWord) {
    return `${trailingTableWord[1]} / ${additions}${trailingTableWord[2]}`;
  }
  return `${label} / ${additions}`;
}

/**
 * Round-13 finding, found running the actual live Anthropic API against the
 * real 10-file scale diff to verify the SYSTEM_PROMPT change above (llm.ts):
 * the model DID adopt the requested "publishes"/"subscribes to" phrasing on
 * its very first live call — real confirmation the prompt change works, not
 * assumed — but it quoted the event name inside the edge label exactly as
 * shown in the pre-fix version of that prompt instruction
 * (\`|publishes "order.created"|\`), and Mermaid's flowchart parser rejects
 * a quote character inside a pipe-delimited edge label outright ("Parser
 * error... Expecting ... got 'STR'"). That's a real, confirmed render
 * failure (a 502, wasting a live API call with no repair-retry chance,
 * since validateMermaidSyntax's cheap regex check doesn't catch this and
 * only the real mermaid parser does, much later). The SYSTEM_PROMPT
 * instruction was corrected to ask for the event name unquoted — but per
 * this project's own established pattern, a prompt instruction alone isn't
 * reliable enough on the smaller production model to trust unconditionally,
 * so this strips any quote character found inside a flowchart edge's own
 * pipe-delimited label before it ever reaches the renderer, regardless of
 * why it's there (this specific pub/sub case, or any other reason a future
 * model version might quote part of an edge label). Node labels
 * (\`Id["..."]\`) are untouched — quotes are valid and expected there;
 * this only ever touches the text between a \`|...|\` pair on an edge line.
 */
export function sanitizeEdgeLabelQuotes(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  let changed = false;
  const result = source.replace(/\|([^|]*)\|/g, (full, label: string) => {
    if (!/['"]/.test(label)) return full;
    changed = true;
    return `|${label.replace(/['"]/g, "")}|`;
  });

  return changed ? result : source;
}

const SUBGRAPH_OPEN_RE = /^\s*subgraph\s+(\w+)(?:\[[^\]]*\])?\s*$/;
const SUBGRAPH_END_RE = /^\s*end\s*$/;
const NODE_DECL_RE = /^(\w+)\s*\[[^\]]*\]\s*$/;

/**
 * Round-11 finding, from a fresh adversarial review of the tiered-model
 * output: the real 10-file scale test wraps a SINGLE node
 * (`Tables["orders + refunds tables"]`) in its own `subgraph
 * Data["Database"] ... end` block. The reviewer flagged this as
 * unnecessary visual overhead — a colored border around a box that
 * already has its own colored border, purely because the model reached
 * for a subgraph out of habit rather than because grouping added any
 * information. A subgraph exists to show "these N things belong
 * together"; with N=1 there's nothing to group, and the member node's own
 * category color already conveys everything the subgraph's *Region
 * classDef would have. This strips any subgraph containing exactly one
 * member node (and the dangling `class <subgraphId> ...Region` line that
 * targets it, which would otherwise reference an id that no longer
 * exists once the subgraph wrapper is gone), leaving the member node
 * exactly where it was, at the top level. Deliberately conservative:
 * only touches a subgraph whose ENTIRE body is exactly one bare node
 * declaration line — a subgraph with a single node plus any edge, note,
 * or nested subgraph is left alone, since that's no longer the "grouping
 * added nothing" case this targets.
 */
export function collapseSingleNodeSubgraphs(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const lines = source.split("\n");
  const toRemoveLineIdx = new Set<number>();
  const collapsedSubgraphIds = new Set<string>();

  // Single pass, tracking the innermost open subgraph's start line and the
  // node-declaration lines seen directly inside it (nested subgraphs reset
  // tracking for their own scope so a nested single-node subgraph can still
  // be collapsed independently, but a subgraph containing a nested
  // subgraph itself is never collapsed -- its body isn't "one node").
  interface Frame {
    startIdx: number;
    id: string;
    memberLines: number[];
    hasNonNodeContent: boolean;
  }
  const stack: Frame[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const openMatch = SUBGRAPH_OPEN_RE.exec(line);
    if (openMatch) {
      stack.push({ startIdx: i, id: openMatch[1]!, memberLines: [], hasNonNodeContent: false });
      continue;
    }
    if (SUBGRAPH_END_RE.test(line) && stack.length > 0) {
      const frame = stack.pop()!;
      if (!frame.hasNonNodeContent && frame.memberLines.length === 1) {
        toRemoveLineIdx.add(frame.startIdx);
        toRemoveLineIdx.add(i);
        collapsedSubgraphIds.add(frame.id);
      } else if (stack.length > 0) {
        // A collapsed-ineligible subgraph nested inside another still
        // counts as "non-node content" for its parent -- the parent's
        // body is a subgraph, not a single bare node, so the parent must
        // not collapse either.
        stack[stack.length - 1]!.hasNonNodeContent = true;
      }
      continue;
    }
    if (stack.length === 0) continue; // outside any subgraph -- nothing to track

    const top = stack[stack.length - 1]!;
    if (NODE_DECL_RE.test(line.trim())) {
      top.memberLines.push(i);
    } else if (line.trim() !== "") {
      top.hasNonNodeContent = true; // an edge, note, or anything else inside this subgraph
    }
  }

  if (collapsedSubgraphIds.size === 0) {
    return source; // nothing to collapse — don't touch the source at all
  }

  const kept = lines.filter((line, idx) => {
    if (toRemoveLineIdx.has(idx)) return false;
    // Drop the now-dangling `class <collapsedSubgraphId> ...Region` line,
    // if the model emitted one for this subgraph — the id it refers to no
    // longer exists as anything (not a node, not a subgraph) once the
    // wrapper is gone.
    const classMatch = CLASS_LINE_RE.exec(line);
    if (classMatch) {
      const ids = classMatch[2]!.split(",").map((s) => s.trim());
      if (ids.length === 1 && collapsedSubgraphIds.has(ids[0]!) && /Region$/.test(classMatch[3]!)) {
        return false;
      }
    }
    return true;
  });

  return kept.join("\n");
}

const SUBGRAPH_TITLE_LINE_RE = /^(\s*subgraph\s+)(\w+)\["([^"]*)"\]\s*$/;

// Fixed 1:1 mapping from a subgraph's region (endpoint/logic/datastore/
// external) to a single canonical title string. These are literally the
// SYSTEM_PROMPT's own example titles (`subgraph API["API Layer"]` etc.) --
// not a new vocabulary, just the one the model already reaches for most
// often, now made mandatory rather than a suggestion it's free to
// paraphrase.
const CANONICAL_SUBGRAPH_TITLES: Record<string, string> = {
  endpointRegion: "API Layer",
  logicRegion: "Business Logic",
  datastoreRegion: "Data Layer",
  externalRegion: "External Services",
};

const CATEGORY_TO_REGION: Record<string, string> = {
  endpoint: "endpointRegion",
  logic: "logicRegion",
  datastore: "datastoreRegion",
  external: "externalRegion",
};

/**
 * Round-14 review (2026-09-07) finding, reproduced live: running the
 * IDENTICAL diff through two separate live Anthropic calls produced
 * different subgraph titles each time for the same region -- "Business
 * Logic" vs. "Service Layer," "External Services" vs. "External Systems."
 * A team's shared architecture language can't be shared if it relabels
 * itself on every regeneration. `claude-sonnet-5` (the tier this exact
 * scale scenario escalates to) was confirmed, via a direct live API probe,
 * to reject both `temperature` and `top_p` outright -- there is no
 * sampling-parameter lever available to reduce this variance, so the fix
 * has to remove the model's freedom to choose the wording at all, for the
 * one piece of text where that's actually safe to do: a subgraph's own
 * title conveys nothing beyond "this is the endpoint/logic/datastore/
 * external region," which is fully recoverable from the diagram's own
 * per-node category classes.
 *
 * First version of this fix (still visible in git history) rewrote a
 * subgraph's title based on its own `class SubgraphId <region>Region`
 * line, exactly as the SYSTEM_PROMPT instructs the model to emit
 * separately from its per-node classes. Live-verifying it immediately
 * caught that version shipping completely inert: two fresh live calls in
 * a row, the model classed every individual node correctly but never once
 * emitted the separate subgraph-level `*Region` class line at all -- the
 * exact "prompt alone isn't reliable enough" pattern behind every other
 * backstop in this file, just discovered for a DIFFERENT instruction than
 * the one this fix originally targeted. Rather than lean harder on a
 * second prompt instruction the model has already shown it can silently
 * skip, this INFERS each subgraph's region from its own member nodes'
 * ordinary per-node categories instead (`class Routes,Controllers
 * endpoint` etc.) -- the one signal the model reliably does emit on every
 * single node, in every diagram, because assignMissingCategories() and
 * reconcileDiffClassification() already depend on it being there. An
 * explicit `class SubgraphId <region>Region` line, when the model does
 * happen to emit one, is still honored and takes priority over inference.
 *
 * Deliberately conservative in two places:
 * 1. A subgraph whose member nodes span MORE THAN ONE base category (no
 *    single category accounts for every classed member) has no inferrable
 *    region at all -- left completely untouched rather than guessing which
 *    category is "dominant."
 * 2. If TWO OR MORE subgraphs in the same diagram resolve to the SAME
 *    region (the SYSTEM_PROMPT's "at most 3-4 subgraphs" guidance suggests
 *    one per category is the norm, but doesn't forbid splitting one
 *    category into two groups), forcing both onto the identical canonical
 *    title would make two genuinely distinct groups look like duplicates
 *    of each other -- worse than the instability this fixes. Both are left
 *    completely untouched, canonical title or not.
 *
 * A no-op for sequenceDiagram, and for any subgraph whose title isn't in
 * the `Id["..."]`-with-double-quotes shape the SYSTEM_PROMPT's own example
 * always uses.
 */
export function canonicalizeSubgraphTitles(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const lines = source.split("\n");

  const subgraphIds = new Set<string>();
  for (const m of source.matchAll(/subgraph\s+(\w+)/g)) subgraphIds.add(m[1]!);

  // Two things come out of the same class-line scan: an explicit subgraph
  // region (`class SubgraphId <region>Region`, when the model does emit
  // it) and each ordinary node's own base category (`class NodeId
  // <category>`/`<category>Context`) -- distinguished by whether the id is
  // a known subgraph id or not, same disambiguation this file already
  // relies on elsewhere (e.g. reconcileDiffClassification).
  const explicitRegionOfSubgraph = new Map<string, string>();
  const categoryOfNode = new Map<string, string>();
  for (const line of lines) {
    const classMatch = CLASS_LINE_RE.exec(line);
    if (!classMatch) continue;
    const category = classMatch[3]!;
    for (const id of classMatch[2]!.split(",").map((s) => s.trim())) {
      if (!id) continue;
      if (subgraphIds.has(id)) {
        if (category in CANONICAL_SUBGRAPH_TITLES) explicitRegionOfSubgraph.set(id, category);
      } else {
        const base = baseCategoryOf(category);
        if (base) categoryOfNode.set(id, base);
      }
    }
  }

  // Walk the source tracking subgraph nesting (mirrors
  // collapseSingleNodeSubgraphs's own Frame-stack approach) to collect
  // each subgraph's direct-child node ids, so a region can be INFERRED
  // from those members' own categories when no explicit region line
  // exists for that subgraph.
  interface Frame {
    id: string;
    memberIds: string[];
  }
  const stack: Frame[] = [];
  const memberIdsBySubgraph = new Map<string, string[]>();
  for (const line of lines) {
    const openMatch = SUBGRAPH_OPEN_RE.exec(line);
    if (openMatch) {
      stack.push({ id: openMatch[1]!, memberIds: [] });
      continue;
    }
    if (SUBGRAPH_END_RE.test(line) && stack.length > 0) {
      const frame = stack.pop()!;
      memberIdsBySubgraph.set(frame.id, frame.memberIds);
      continue;
    }
    if (stack.length === 0) continue;
    const nodeMatch = NODE_DECL_RE.exec(line.trim());
    if (nodeMatch) stack[stack.length - 1]!.memberIds.push(nodeMatch[1]!);
  }

  const regionBySubgraphId = new Map<string, string>();
  for (const id of subgraphIds) {
    const explicit = explicitRegionOfSubgraph.get(id);
    if (explicit) {
      regionBySubgraphId.set(id, explicit);
      continue;
    }
    const memberCategories = new Set(
      (memberIdsBySubgraph.get(id) ?? [])
        .map((memberId) => categoryOfNode.get(memberId))
        .filter((c): c is string => Boolean(c))
    );
    if (memberCategories.size === 1) {
      const [onlyCategory] = memberCategories;
      regionBySubgraphId.set(id, CATEGORY_TO_REGION[onlyCategory!]!);
    }
    // size 0 (no classed members found) or > 1 (mixed categories) -- no
    // inferrable region, left out of the map entirely.
  }

  // Count how many DISTINCT subgraph ids resolve to each region -- only a
  // region with exactly one owning subgraph is safe to canonicalize (see
  // this function's own docstring for why 2+ is left alone).
  const idsByRegion = new Map<string, Set<string>>();
  for (const [id, region] of regionBySubgraphId) {
    if (!idsByRegion.has(region)) idsByRegion.set(region, new Set());
    idsByRegion.get(region)!.add(id);
  }

  let changed = false;
  const rewritten = lines.map((line) => {
    const titleMatch = SUBGRAPH_TITLE_LINE_RE.exec(line);
    if (!titleMatch) return line;
    const id = titleMatch[2]!;
    const region = regionBySubgraphId.get(id);
    if (!region) return line;
    if ((idsByRegion.get(region)?.size ?? 0) !== 1) return line; // 2+ subgraphs share this region
    const canonicalTitle = CANONICAL_SUBGRAPH_TITLES[region]!;
    if (titleMatch[3] === canonicalTitle) return line; // already correct -- no-op
    changed = true;
    return `${titleMatch[1]}${id}["${canonicalTitle}"]`;
  });

  return changed ? rewritten.join("\n") : source;
}

const SEQUENCE_BLOCK_OPEN_RE = /^\s*(alt|opt|loop|par|critical|rect|break)\b/;
const SEQUENCE_BLOCK_END_RE = /^\s*end\s*$/;
const SEQUENCE_MESSAGE_RE = /^\s*[\w]+\s*-{1,2}[x>)]{1,2}\s*[\w]+\s*:/;
const SEQUENCE_PARTICIPANT_RE = /^\s*(?:actor|participant)\s+(\w+)/;
const SEQUENCE_NOTE_RE = /^\s*Note\s+(?:over|left of|right of)\b/i;

/**
 * Round-14 investigation, prompted by a round-12 review complaint that a PR
 * adding new calls at two DISJOINT points in an existing sequence flow
 * "can't be highlighted accurately" -- before assuming that meant a deeper
 * architectural rework, this was tested empirically rather than assumed:
 * (1) scripts/rect-edge-cases.ts confirmed live that Mermaid itself renders
 * multiple separate, even directly-adjacent, `rect rgba(...)...end` blocks
 * correctly -- there is no real Mermaid ceiling here; and (2) three live
 * calls against the actual production model (claude-haiku-4-5, the tier
 * every single-file diff actually runs on) via
 * scripts/dry-run-live-sequence-disjoint(3).ts showed the EXISTING prompt
 * already produces one separate rect block per disjoint new run, unprompted
 * by any special multi-block instruction. So the round-12 complaint did not
 * reproduce, and this is NOT the fix for that -- llm.ts's SYSTEM_PROMPT was
 * still tightened to state the multi-block case explicitly rather than
 * leave it to the model to keep inferring correctly by luck.
 *
 * What live testing surfaced INSTEAD, as a genuinely real risk in this same
 * area: asking the model to emit MORE separate rect blocks per diagram
 * means more open/close pairs it has to keep track of, and
 * scripts/rect-edge-cases.ts also proved that a single unclosed block of
 * ANY kind (`rect`/`loop`/`alt`/`opt`/`par`/`critical`/`break`) -- not just
 * `rect` -- breaks the ENTIRE render with a hard Mermaid parse error, which
 * validateMermaidSyntax's cheap regex check does not catch (same shape of
 * gap as the round-13 quote-in-edge-label bug). This is the deterministic
 * backstop for that real, reproduced failure mode: walks every line
 * tracking block-open/close depth (reusing the same SEQUENCE_BLOCK_OPEN_RE/
 * SEQUENCE_BLOCK_END_RE grammar as annotateFullyNewSequence below) and, if
 * the diagram ends with anything still open, appends the missing `end`
 * line(s) rather than letting a well-intentioned but incomplete diagram
 * fail to render at all. A no-op for flowchart and for any already-balanced
 * sequence diagram (the overwhelmingly common case).
 *
 * Deliberately conservative about WHERE it closes things: it only acts at
 * end-of-source, appending whatever `end`s are still owed. It does not try
 * to guess where in the middle of the diagram a missing `end` was meant to
 * go -- a genuinely misplaced (rather than simply omitted) `end` is a
 * different, rarer failure this doesn't attempt to fix.
 */
export function closeUnclosedSequenceBlocks(source: string): string {
  const isSequence = /^sequenceDiagram\b/i.test(source.trim());
  if (!isSequence) {
    return source;
  }

  const lines = source.split("\n");
  let openDepth = 0;
  for (const line of lines) {
    if (SEQUENCE_BLOCK_END_RE.test(line)) {
      if (openDepth > 0) openDepth--;
    } else if (SEQUENCE_BLOCK_OPEN_RE.test(line)) {
      openDepth++;
    }
  }

  if (openDepth <= 0) {
    return source; // already balanced -- the overwhelmingly common case
  }

  const closes = Array.from({ length: openDepth }, () => "end").join("\n");
  return `${source.trimEnd()}\n${closes}\n`;
}

/**
 * Round-11 finding, from a fresh adversarial review: when an ENTIRE
 * sequenceDiagram is new (the whole flow is one PR-introduced exchange,
 * not an existing flow gaining one step), the SYSTEM_PROMPT's own
 * diff-awareness instruction (llm.ts) says to wrap the whole thing in
 * `rect rgba(88, 166, 255, 0.3)`. That's correct, but a reviewer scanning
 * quickly has nothing to CONTRAST it against — the highlight covers every
 * message, so it doesn't visually read as "a signal" the way it does when
 * it sits next to un-highlighted pre-existing calls. The reviewer that
 * caught this scored the diagram down for looking diff-unaware even
 * though it technically was. This deterministically adds an explicit
 * `Note over <first>,<last>: New flow added by this PR` as the first line
 * inside a rect block that spans the diagram's ENTIRE set of message
 * exchanges (no message arrow appears outside it) and doesn't already
 * open with its own Note — unambiguous even to someone not looking
 * closely at background tint, and left alone for the common case where
 * only PART of a sequence is new (the contrast against un-highlighted
 * pre-existing calls already does this job there).
 */
export function annotateFullyNewSequence(source: string): string {
  const isSequence = /^sequenceDiagram\b/i.test(source.trim());
  if (!isSequence) {
    return source;
  }

  const lines = source.split("\n");

  // Find the first `rect rgba(88, 166, 255, ...)` block and its matching
  // `end`, respecting nesting of alt/opt/loop/par/critical/rect/break.
  let rectOpenIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*rect\s+rgba\(\s*88\s*,\s*166\s*,\s*255\s*,/.test(lines[i]!)) {
      rectOpenIdx = i;
      break;
    }
  }
  if (rectOpenIdx === -1) {
    return source; // no diff-highlight rect at all -- nothing to annotate
  }

  let depth = 1;
  let rectEndIdx = -1;
  for (let i = rectOpenIdx + 1; i < lines.length; i++) {
    if (SEQUENCE_BLOCK_OPEN_RE.test(lines[i]!)) depth++;
    else if (SEQUENCE_BLOCK_END_RE.test(lines[i]!)) {
      depth--;
      if (depth === 0) {
        rectEndIdx = i;
        break;
      }
    }
  }
  if (rectEndIdx === -1) {
    return source; // unbalanced rect/end -- don't guess, leave it alone
  }

  // Does every message exchange in the whole diagram fall inside this one
  // rect block? If any message sits outside it, this is a PARTIAL
  // highlight (some pre-existing flow left un-highlighted for contrast),
  // which already does the "this is new" signaling job on its own.
  for (let i = 0; i < lines.length; i++) {
    if (i > rectOpenIdx && i < rectEndIdx) continue;
    if (SEQUENCE_MESSAGE_RE.test(lines[i]!)) {
      return source; // a message exists outside the rect -- partial highlight, leave alone
    }
  }

  // Already has its own Note as the first substantive line inside the
  // rect? Respect it rather than adding a second, redundant one.
  const firstInnerLine = lines.slice(rectOpenIdx + 1, rectEndIdx).find((l) => l.trim() !== "");
  if (firstInnerLine && SEQUENCE_NOTE_RE.test(firstInnerLine)) {
    return source;
  }

  const participants: string[] = [];
  for (const line of lines) {
    const m = SEQUENCE_PARTICIPANT_RE.exec(line);
    if (m && !participants.includes(m[1]!)) participants.push(m[1]!);
  }
  if (participants.length === 0) {
    return source; // no declared participants/actors to anchor a Note over -- can't safely add one
  }

  const span =
    participants.length === 1 ? participants[0]! : `${participants[0]!},${participants[participants.length - 1]!}`;
  const indent = /^(\s*)/.exec(lines[rectOpenIdx + 1] ?? "    ")?.[1] ?? "    ";
  const noteLine = `${indent}Note over ${span}: New flow added by this PR`;

  const out = [...lines];
  out.splice(rectOpenIdx + 1, 0, noteLine);
  return out.join("\n");
}

/**
 * Round-12 finding, from a fresh adversarial review: a real generated
 * diagram (10-file scale test, live API call) left `EventBus`,
 * `PaymentGateway`, and `NotificationService` as bare top-level nodes with
 * no subgraph at all, each reached by a long connector snaking across the
 * canvas. The SYSTEM_PROMPT (llm.ts) explicitly permits leaving a lone
 * external dependency ungrouped -- but the model over-applied that
 * permission to three nodes at once, and the reviewer's complaint was
 * concrete and real: a reviewer's eye has to hunt for what an orphaned
 * node belongs to and trace a line across the canvas to find out, which is
 * exactly the "reconstruct the graph yourself" cost this product exists
 * to remove. Prompt-only instructions have proven unreliable throughout
 * this project's history (see CLAUDE.md items 19-20), so this is a
 * deterministic backstop, same pattern as collapseSingleNodeSubgraphs and
 * assignMissingCategories: 2+ top-level nodes (not already inside ANY
 * subgraph) classed external/externalContext get wrapped in a
 * `subgraph External["External Services"] ... end`.
 *
 * Deliberately conservative: only wraps when every qualifying node's
 * declaration line is CONTIGUOUS (allowing blank lines between them) --
 * if an edge or an unrelated node's declaration sits between two external
 * nodes, this leaves the source untouched rather than guessing how to
 * safely relocate lines out of order. A single ungrouped external node is
 * left alone too (matching the prompt's own explicit permission, and
 * because wrapping just one would immediately be undone by
 * collapseSingleNodeSubgraphs anyway).
 */
export function groupUngroupedExternalNodes(source: string): string {
  const isFlowchart = /^flowchart\s+(TD|LR|BT|RL)\b/i.test(source.trim());
  if (!isFlowchart) {
    return source;
  }

  const lines = source.split("\n");

  // Track subgraph nesting depth per line so we only ever consider
  // genuinely top-level (depth 0) node declarations.
  let depth = 0;
  const lineDepth: number[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (SUBGRAPH_OPEN_RE.test(line)) {
      lineDepth[i] = depth;
      depth++;
      continue;
    }
    if (SUBGRAPH_END_RE.test(line) && depth > 0) {
      depth--;
      lineDepth[i] = depth;
      continue;
    }
    lineDepth[i] = depth;
  }

  // Build id -> base category from every `class` line in the source
  // (mirrors reconcileDiffClassification's own parsing of the same
  // syntax), so this only ever acts on nodes the model itself already
  // classed external/externalContext -- never a guess of our own.
  const categoryOf = new Map<string, string>();
  for (const line of lines) {
    const m = CLASS_LINE_RE.exec(line);
    if (!m) continue;
    const base = baseCategoryOf(m[3]!);
    if (!base) continue;
    for (const id of m[2]!.split(",").map((s) => s.trim())) {
      if (id) categoryOf.set(id, base);
    }
  }

  // Find every top-level bare node declaration (`Id["label"]`) whose
  // class is external, in source order.
  const qualifying: { idx: number; id: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineDepth[i] !== 0) continue;
    const nodeMatch = NODE_DECL_RE.exec(lines[i]!.trim());
    if (nodeMatch && categoryOf.get(nodeMatch[1]!) === "external") {
      qualifying.push({ idx: i, id: nodeMatch[1]! });
    }
  }

  if (qualifying.length < 2) {
    return source; // nothing to group, or only one -- leave the prompt's own rule alone
  }

  // Verify contiguity: every top-level, non-blank line strictly between
  // the first and last qualifying declaration must itself be one of the
  // qualifying declarations -- if an edge or an unrelated node's own
  // declaration sits in between, this isn't safely relocatable, so leave
  // the source untouched rather than guess.
  const qualifyingIdxSet = new Set(qualifying.map((q) => q.idx));
  const firstIdx = qualifying[0]!.idx;
  const lastIdx = qualifying[qualifying.length - 1]!.idx;
  let contiguous = true;
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (lineDepth[i] !== 0) {
      contiguous = false;
      break;
    }
    if (lines[i]!.trim() === "" || qualifyingIdxSet.has(i)) continue;
    contiguous = false;
    break;
  }
  if (!contiguous) {
    return source; // not safely relocatable -- leave it alone rather than guess
  }

  const indent = /^(\s*)/.exec(lines[firstIdx] ?? "")?.[1] ?? "  ";
  const out = [...lines];
  // Insert `end` right after the last qualifying line, then the subgraph
  // opener right before the first -- inserting from the back first keeps
  // firstIdx/lastIdx valid for the second splice.
  out.splice(lastIdx + 1, 0, `${indent}end`, `${indent}class External externalRegion`);
  out.splice(firstIdx, 0, `${indent}subgraph External["External Services"]`);

  return out.join("\n");
}

// Only `participant Name` (optionally `participant Name as "Display Name"`)
// -- deliberately NOT `actor Name`. Per llm.ts's own SYSTEM_PROMPT, `actor`
// is reserved for anything OUTSIDE this codebase's control (a human user,
// an external third-party system) -- the sequence-diagram equivalent of
// flowchart's `external` category -- so it was never a candidate for "did
// this diff touch this" in the first place; `participant` is reserved for
// "everything this codebase actually implements," which is exactly the set
// this diff's own files can confirm or fail to confirm.
const SEQUENCE_PARTICIPANT_DECL_RE = /^\s*participant\s+(\w+)(?:\s+as\s+.+)?\s*$/;

export const CONTEXT_PARTICIPANTS_MARKER = "%% archlens:context-participants";

/**
 * Round-16 finding (CLAUDE.md item 29, finding #10), deliberately deferred
 * at the time as "a real, separate, bigger-scope ask" rather than folded
 * into that round's fixes: a sequenceDiagram's diff-awareness is currently
 * MESSAGE-level only (the `rect rgba(88, 166, 255, 0.3)` highlight around
 * new exchanges) -- every PARTICIPANT box renders identically regardless of
 * whether it's the actual file this diff modifies or a pre-existing service
 * merely being called into. A reviewer glancing at the diagram's header row
 * has no way to tell, from the participant boxes alone, which one is the
 * changed code -- exactly the flowchart-side distinction
 * `endpoint`/`logic`/etc. vs. their `*Context` variants already draws
 * (solid = changed by this PR, dashed = existing context), just never
 * extended to sequence diagrams' own participant boxes.
 *
 * Same "recompute from the diff itself, don't trust the model's guess"
 * philosophy as reconcileDiffClassification above, applied to
 * participants instead of flowchart nodes: reuses the exact same
 * computeDiffTouchState()/tokenize() machinery (a `participant
 * checkoutController` declaration matches this diff's own
 * `checkoutController.ts`/`checkout.ts` basenames, so it has real
 * changed-evidence; `participant CartService`/`PaymentGateway`/etc. do not,
 * since this diff never touches a file with those basenames) rather than
 * asking the model to self-report which participants it just wrote vs.
 * merely referenced -- the same category of instruction this project has
 * repeatedly found a smaller production model won't reliably self-report
 * (see e.g. round-14's subgraph-title finding above).
 *
 * Doesn't touch the mermaid source's own diagram syntax at all (sequence
 * diagrams have no per-participant `class` mechanism the way flowcharts
 * do) -- instead appends a single machine-readable `%%` comment line,
 * which mermaid's own parser silently ignores (confirmed: comments never
 * reach the rendered SVG in any diagram type), listing which participants
 * have NO changed-evidence. mermaid.ts's renderMermaidToSvg reads this
 * same marker back out of the raw source (before it's ever handed to
 * mermaid.render()) and uses it to dim/dash those specific participants'
 * rendered boxes -- see styleContextParticipants() there for the render
 * side of this same fix, and CONTEXT_PARTICIPANTS_MARKER's own definition
 * for the exact text both sides agree on.
 *
 * Deliberately conservative in one place: if EVERY declared participant
 * comes back with no changed-evidence (most likely because this diff's
 * changed files don't textually overlap ANY declared participant name --
 * a real possibility, not just a classifier miss), marking 100% of them
 * as "pre-existing" would erase the one signal this is meant to add
 * (which one is new) rather than sharpen it -- worse than doing nothing.
 * Only emits the marker when there's a genuine mix: at least one
 * participant WITH changed-evidence and at least one WITHOUT.
 */
export function annotatePreexistingParticipants(source: string, files: DiffPatchFile[]): string {
  const isSequence = /^sequenceDiagram\b/i.test(source.trim());
  if (!isSequence) {
    return source;
  }

  const { changed } = computeDiffTouchState(files);

  let totalParticipants = 0;
  const contextParticipants: string[] = [];
  for (const line of source.split("\n")) {
    const m = SEQUENCE_PARTICIPANT_DECL_RE.exec(line);
    if (!m) continue;
    totalParticipants++;
    const tokens = tokenize(m[1]!);
    const hasChanged = tokens.some((t) => changed.has(t));
    if (!hasChanged) contextParticipants.push(m[1]!);
  }

  if (contextParticipants.length === 0 || contextParticipants.length >= totalParticipants) {
    return source; // no mix to show -- either everyone matches, or no one does
  }

  return `${source.trimEnd()}\n${CONTEXT_PARTICIPANTS_MARKER} ${contextParticipants.join(",")}\n`;
}
