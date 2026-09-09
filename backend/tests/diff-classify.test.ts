import { describe, expect, it } from "vitest";
import {
  computeDiffTouchState,
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
  type DiffPatchFile,
} from "../lib/diff-classify.js";

describe("computeDiffTouchState", () => {
  it("collects tokens from added (+) lines as changed", () => {
    const files: DiffPatchFile[] = [
      { filename: "a.ts", status: "added", patch: "+export function issueRefund(orderId) {}" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("issuerefund")).toBe(true);
    // Only the definition's own name is captured, not its parameters or
    // body — that's deliberate: a param name isn't identifying evidence,
    // and pulling in every word would reintroduce the false-positive
    // problem this module exists to avoid (see the call-site test below).
    expect(changed.has("orderid")).toBe(false);
  });

  it("collects tokens seen only on removed (-) lines, never on any + line, as removed", () => {
    const files: DiffPatchFile[] = [
      { filename: "a.ts", status: "modified", patch: "-export function cancelSubscription() {}\n+export function pauseSubscription() {}" },
    ];
    const { changed, removed } = computeDiffTouchState(files);
    expect(removed.has("cancelsubscription")).toBe(true);
    expect(changed.has("pausesubscription")).toBe(true);
    // "subscription" appears on both a - line and a + line, so it's not
    // purely removed -- it stays out of the removed set.
    expect(removed.has("subscription")).toBe(false);
  });

  it("ties a MODIFIED file's basename to 'changed', not just added/removed files", () => {
    // Real bug found on the live 10-file stress test: in COARSE MODE the
    // model collapses ordersController.ts (status "modified") into one
    // node labeled "OrdersController" -- a label that shares no literal
    // token with the "create"/"cancel" functions actually changed inside
    // it, so without this the node was wrongly downgraded to Context
    // despite the file genuinely changing.
    const files: DiffPatchFile[] = [
      { filename: "src/controllers/ordersController.ts", status: "modified", patch: "+export async function create(req, res) {}" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("orderscontroller")).toBe(true);
  });

  it("excludes generic stopwords that would cause false-positive overlap", () => {
    const files: DiffPatchFile[] = [
      { filename: "a.sql", status: "added", patch: "+CREATE TABLE refunds (\n+  id uuid PRIMARY KEY\n+);" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("refunds")).toBe(true);
    expect(changed.has("table")).toBe(false);
    expect(changed.has("create")).toBe(false);
  });

  it("ties a dot-separated file basename to a PascalCase node label sharing no single-token match (real bug: NestJS-style auth.controller.ts vs 'AuthController')", () => {
    // Found running a REAL external repo (nestjs-boilerplate) through the
    // full pipeline: the old tokenizer reduced "AuthController" to one
    // blob "authcontroller" and "auth.controller" (the file's basename)
    // to two pieces "auth"/"controller" -- never equal, so a genuinely
    // modified controller file always fell back to Context.
    const files: DiffPatchFile[] = [
      { filename: "src/auth/auth.controller.ts", status: "modified", patch: "+  @Get('me')" },
    ];
    const { changed } = computeDiffTouchState(files);
    // "controller" itself is deliberately excluded as a generic
    // architectural-layer suffix (see the STOPWORDS comment) -- "auth" is
    // the part that actually identifies this file, and it's what a
    // PascalCase "AuthController" label needs to overlap on.
    expect(changed.has("auth")).toBe(true);
  });

  it("matches a Python 'def' definition against its diagram label (real bug: FastAPI 'def read_item' never recognized as a definition at all)", () => {
    const files: DiffPatchFile[] = [
      { filename: "app/api/routes/items.py", status: "modified", patch: "+def read_item(session: SessionDep, id: uuid.UUID) -> Any:" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("read_item")).toBe(true);
    expect(changed.has("read")).toBe(true);
    expect(changed.has("item")).toBe(true);
  });

  it("matches a Go 'func' definition, including one with a method receiver", () => {
    const files: DiffPatchFile[] = [
      { filename: "orders.go", status: "modified", patch: "+func (s *OrderService) CancelOrder(id string) error {" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("cancelorder")).toBe(true);
  });

  it("does not treat a generic architectural suffix ('Service'/'Controller'/...) as identifying evidence on its own (real false-positive found on nestjs-boilerplate: 'GoogleService', never touched by the diff, matched only because 'auth.service.ts' also changed)", () => {
    const files: DiffPatchFile[] = [
      { filename: "src/auth/auth.service.ts", status: "modified", patch: "+  private readonly foo = 1;" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("service")).toBe(false);
    expect(changed.has("auth")).toBe(true);
  });

  it("matches a singular diagram label against a plural file basename (real bug: 'UpdateUser' vs users.py, where the def line itself wasn't touched by the diff)", () => {
    // Reproduces the exact FastAPI shape: `def update_user(...)` is
    // unchanged context in the diff -- only an inner parameter's type
    // changed -- so there's no definition-pattern evidence at all, only
    // the basename fallback, which used to fail purely on items/item.
    const files: DiffPatchFile[] = [
      { filename: "app/api/routes/users.py", status: "modified", patch: "+    user_id: uuid.UUID," },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("user")).toBe(true);
  });

  it("de-pluralizes an -ies / -es ending too, not just a plain trailing s", () => {
    const files: DiffPatchFile[] = [
      { filename: "app/categories.py", status: "modified", patch: "+x = 1" },
      { filename: "app/boxes.py", status: "added", patch: "+y = 2" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("category")).toBe(true);
    expect(changed.has("box")).toBe(true);
  });

  it("keeps a generic architectural word as fallback evidence when it's the ENTIRE basename, rather than dropping it to zero signal", () => {
    // A file literally named models.py (common in Django/FastAPI/Flask
    // apps) has no other identifying word in its basename at all -- unlike
    // "auth.service.ts", there's no more-specific token to prefer instead,
    // so dropping "models" here would leave the file with zero fallback
    // evidence, which is worse than the rare coincidental collision this
    // stopword list exists to prevent.
    const files: DiffPatchFile[] = [
      { filename: "backend/app/models.py", status: "modified", patch: "+    hashed_password: str" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("models")).toBe(true);
  });

  // Round-7 addition: a real, confirmed false negative found on the
  // product's own FastAPI real-repo test. tokenize() used to require 3+
  // total characters, so a 2-character basename like "db" (from "db.py")
  // produced NO tokens at all -- a modified db.py could never register as
  // "changed" no matter what, which is also what silently defeated the
  // round-7 "wrongly removed" rescue logic on this exact file (see
  // reconcileDiffClassification's removed-handling below).
  it("recognizes a 2-character basename like 'db' (from db.py) as changed evidence, not silently dropped for being too short", () => {
    const files: DiffPatchFile[] = [
      { filename: "backend/app/core/db.py", status: "modified", patch: "+engine = create_engine(str(settings.DATABASE_URL), pool_pre_ping=True)" },
    ];
    const { changed } = computeDiffTouchState(files);
    expect(changed.has("db")).toBe(true);
  });
});

describe("reconcileDiffClassification", () => {
  const files: DiffPatchFile[] = [
    {
      filename: "src/services/refundService.ts",
      status: "added",
      patch: "+export async function issueRefund(orderId) {\n+  await PaymentGateway.refund(orderId)\n+}",
    },
  ];

  it("downgrades a node the model marked 'changed' to Context when the diff never actually touches it", () => {
    // PaymentGateway is only *referenced* in the added code (called, not
    // defined/modified) -- its label shares no real identifying token with
    // an added line, so it should be forced to Context even though the
    // model marked it a plain (changed) category. This is the exact
    // failure mode the review caught: an unrelated pre-existing system
    // marked as if the PR created it.
    const source = [
      'flowchart TD',
      '  A["PaymentGateway"]',
      '  B["issueRefund()"]',
      '  A --> B',
      '  class A datastore',
      '  class B logic',
    ].join("\n");

    const result = reconcileDiffClassification(source, files);
    expect(result).toContain("class A datastoreContext");
    // B's label DOES share a token ("issuerefund") with an added line, so
    // it correctly stays classified as changed.
    expect(result).toContain("class B logic");
    expect(result).not.toContain("class B logicContext");
  });

  // Round-7 addition: `external` (a third-party dependency, e.g. a payment
  // gateway) is a fourth base category alongside endpoint/logic/datastore
  // (see mermaid.ts's CATEGORY_CLASS_DEFS and llm.ts's SYSTEM_PROMPT for
  // why it needed to exist) -- it must get the exact same diff-aware
  // changed/Context reconciliation, not be silently left out because it's
  // new.
  it("reconciles 'external' the same way as the other base categories", () => {
    const source = [
      'flowchart TD',
      '  A["PaymentGateway"]',
      '  B["issueRefund()"]',
      '  A --> B',
      '  class A external',
      '  class B logic',
    ].join("\n");

    const result = reconcileDiffClassification(source, files);
    // PaymentGateway is only referenced (called), never defined/modified by
    // the diff -- external's plain (changed) variant must be downgraded to
    // externalContext exactly like datastore/endpoint/logic are.
    expect(result).toContain("class A externalContext");
    expect(result).not.toContain("class A external\n");
  });

  it("promotes a node to 'removed' when its only diff evidence is on a removed line", () => {
    const removalFiles: DiffPatchFile[] = [
      { filename: "src/routes/legacy.ts", status: "removed", patch: "-router.post('/legacy-checkout', handler)" },
    ];
    const source = [
      'flowchart TD',
      '  A["POST /legacy-checkout"]',
      '  class A endpoint',
    ].join("\n");

    const result = reconcileDiffClassification(source, removalFiles);
    expect(result).toContain("class A removed");
    expect(result).not.toContain("class A endpoint\n");
  });

  it("leaves a node's classification untouched when no node declaration can be found for it (can't reconcile blind)", () => {
    const source = 'flowchart TD\n  class GhostNode logic';
    const result = reconcileDiffClassification(source, files);
    expect(result).toBe(source);
  });

  it("never touches Region-category lines (subgraph coloring has no diff-state concept)", () => {
    const source = [
      'flowchart TD',
      '  subgraph Logic["Business Logic"]',
      '    A["unrelatedThing"]',
      '  end',
      '  class A logic',
      '  class Logic logicRegion',
    ].join("\n");
    const result = reconcileDiffClassification(source, files);
    expect(result).toContain("class Logic logicRegion");
  });

  // Round-7 addition, replacing the old "never touches 'removed'" test:
  // a real Anthropic-generated diagram (FastAPI real-repo test, round 8)
  // re-marked db.py `removed` even though the diff only modified it --
  // recurring despite the SYSTEM_PROMPT already warning against exactly
  // this cascade (see llm.ts). `removed` is no longer a free pass: a node
  // whose label has real evidence of being CHANGED by this diff cannot
  // have been deleted BY THIS SAME DIFF, so it's rescued to `logicContext`
  // rather than left rendered as torn out of the codebase.
  it("rescues a node the model wrongly marked 'removed' when the diff shows it was actually changed, not deleted", () => {
    const source = [
      'flowchart TD',
      '  A["issueRefund()"]', // matches a changed token -- proof this file/identifier is still present
      '  class A removed',
    ].join("\n");
    const result = reconcileDiffClassification(source, files);
    expect(result).toContain("class A logicContext");
    expect(result).not.toContain("class A removed");
  });

  // Round-7 addition: the exact real bug, reproduced end to end -- a real
  // Anthropic-generated FastAPI diagram wrongly marked db.py `removed`
  // even though the diff only added `pool_pre_ping=True` to its existing
  // engine call. Depends on both the tokenize() short-basename fix above
  // AND the removed-rescue logic -- neither alone was sufficient.
  it("rescues a real modified file (db.py) wrongly marked 'removed', end to end", () => {
    const dbFiles: DiffPatchFile[] = [
      { filename: "backend/app/core/db.py", status: "modified", patch: "+engine = create_engine(str(settings.DATABASE_URL), pool_pre_ping=True)" },
    ];
    const source = [
      'flowchart TD',
      '  A["db.py<br/>pool_pre_ping"]',
      '  class A removed',
    ].join("\n");
    const result = reconcileDiffClassification(source, dbFiles);
    expect(result).toContain("class A logicContext");
    expect(result).not.toContain("class A removed");
  });

  it("still leaves a genuinely removed node alone -- no changed-token evidence it survived the diff", () => {
    const removalFiles: DiffPatchFile[] = [
      { filename: "src/routes/legacy.ts", status: "removed", patch: "-router.post('/legacy-checkout', handler)" },
    ];
    const source = [
      'flowchart TD',
      '  A["POST /legacy-checkout"]',
      '  class A removed',
    ].join("\n");
    const result = reconcileDiffClassification(source, removalFiles);
    expect(result).toBe(source);
  });

  // Round-10 fix: a real live run (fastapi real-repo, right after switching
  // in a tiered/larger model, unrelated to the model choice itself) caught
  // this exact false rescue. `backend_pre_start.py` was genuinely deleted
  // by the diff and correctly marked `removed` by the model -- but its
  // label tokenizes to {"backend","pre","start",...}, and "start" is ALSO
  // a token of `tests-start.sh`, an unrelated file merely MODIFIED
  // elsewhere in the same diff. That coincidental one-word overlap alone
  // used to satisfy `hasChanged` and wrongly rescue a real deletion into
  // "still present, just unclassifiable." A node with its OWN unique
  // removed-evidence ("backend", not shared with anything else in the
  // diff) must not be rescued just because it also shares one generic
  // word-piece with something unrelated that changed.
  it("does not rescue a genuinely removed node just because it shares one generic token with an unrelated file that changed", () => {
    const mixedFiles: DiffPatchFile[] = [
      { filename: "backend/app/backend_pre_start.py", status: "removed", patch: "-def init():\n-    pass" },
      { filename: "scripts/tests-start.sh", status: "modified", patch: "+echo start" },
    ];
    const source = [
      'flowchart TD',
      '  A["backend_pre_start.py"]',
      '  class A removed',
    ].join("\n");
    const result = reconcileDiffClassification(source, mixedFiles);
    expect(result).toBe(source);
  });

  // Round-7 addition: a real Anthropic-generated diagram (same FastAPI
  // round-8 run) contained the literal line `class removed removed` --
  // referencing a node ID that was never declared anywhere, spelled
  // identically to the category keyword. Almost certainly a hallucinated
  // self-reference, not a real node; dropped rather than rendered as a
  // dangling, meaningless class assignment.
  it("drops a hallucinated 'removed' class line whose id is a reserved keyword with no matching node declaration", () => {
    const source = [
      'flowchart TD',
      '  A["real node"]',
      '  class removed removed',
      '  class A endpoint',
    ].join("\n");
    const result = reconcileDiffClassification(source, files);
    expect(result).not.toContain("class removed removed");
    expect(result).toContain("class A endpoint");
  });

  it("keeps a genuinely declared node even if its id happens to collide with a reserved keyword", () => {
    const source = [
      'flowchart TD',
      '  removed["a node someone chose to name removed"]',
      '  class removed removed',
    ].join("\n");
    const result = reconcileDiffClassification(source, files);
    // Has a real node declaration, and no changed-token evidence it
    // survived the diff -- genuine removal, left untouched.
    expect(result).toBe(source);
  });

  it("is a no-op for sequenceDiagram, where this category system doesn't exist", () => {
    const source = "sequenceDiagram\n  A->>B: issueRefund";
    expect(reconcileDiffClassification(source, files)).toBe(source);
  });

  it("returns the source completely unchanged when every classification already matches the diff", () => {
    const source = [
      'flowchart TD',
      '  B["issueRefund()"]',
      '  class B logic',
    ].join("\n");
    expect(reconcileDiffClassification(source, files)).toBe(source);
  });
});

describe("stripSelfLoopEdges", () => {
  // Round-7 addition: a real Anthropic-generated NestJS diagram had 6 of
  // its 14 edges be meaningless self-loops (`RoleSeedService -->|accesses|
  // RoleSeedService`) despite the SYSTEM_PROMPT explicitly forbidding
  // them — this is the deterministic backstop.
  it("drops an edge whose source and target are the same node", () => {
    const source = [
      'flowchart TD',
      '  A["RoleSeedService"]',
      '  B["RoleRepository"]',
      '  A -->|accesses| A',
      '  A -->|seeds| B',
    ].join("\n");
    const result = stripSelfLoopEdges(source);
    expect(result).not.toContain("-->|accesses| A");
    expect(result).toContain("A -->|seeds| B");
  });

  it("leaves a real edge between two different nodes untouched", () => {
    const source = 'flowchart TD\n  A["x"]\n  B["y"]\n  A --> B';
    expect(stripSelfLoopEdges(source)).toBe(source);
  });

  it("strips an unlabeled self-loop too, not just a labeled one", () => {
    const source = 'flowchart TD\n  A["x"]\n  A --> A';
    const result = stripSelfLoopEdges(source);
    expect(result).not.toContain("A --> A");
  });

  it("is a no-op for sequenceDiagram, where a self-message (A->>A: ...) is legitimate", () => {
    const source = "sequenceDiagram\n  A->>A: validate internally";
    expect(stripSelfLoopEdges(source)).toBe(source);
  });

  it("returns the source completely unchanged when there are no self-loops", () => {
    const source = 'flowchart TD\n  A["x"]\n  B["y"]\n  A --> B';
    expect(stripSelfLoopEdges(source)).toBe(source);
  });
});

describe("assignMissingCategories", () => {
  // Round-8 addition: a real Anthropic-generated diagram (live-scale
  // stress test) declared and wired up `RefundWorker` into two real edges
  // but never gave it a `class` line at all. mermaid doesn't error on an
  // unclassed node -- it silently falls back to the theme's
  // primaryBorderColor, which is the exact same blue as `endpoint`, so a
  // background worker rendered as if it were a real API route.
  it("assigns logicContext to a node that's declared and wired into edges but never appears in any class line", () => {
    const source = [
      'flowchart TD',
      '  subgraph Data["Data & Events"]',
      '    EventBus["EventBus"]',
      '  end',
      '  EventBus -->|triggers| RefundWorker["refundWorker"]',
      '  RefundWorker -->|calls| NotifSvc["NotificationService"]',
      '  class EventBus,NotifSvc externalContext',
    ].join("\n");
    const result = assignMissingCategories(source);
    expect(result).toContain("class RefundWorker logicContext");
  });

  it("leaves a diagram alone when every referenced node already has a category", () => {
    const source = [
      'flowchart TD',
      '  A["x"]',
      '  B["y"]',
      '  A --> B',
      '  class A endpoint',
      '  class B logic',
    ].join("\n");
    expect(assignMissingCategories(source)).toBe(source);
  });

  it("never treats a subgraph id as a node needing a category", () => {
    const source = [
      'flowchart TD',
      '  subgraph API["API Layer"]',
      '    A["x"]',
      '  end',
      '  class A endpoint',
      '  class API endpointRegion',
    ].join("\n");
    expect(assignMissingCategories(source)).toBe(source);
  });

  it("is a no-op for sequenceDiagram, where class doesn't apply", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    expect(assignMissingCategories(source)).toBe(source);
  });
});

// Round-11 finding: a fresh adversarial review of the real 10-file scale
// test flagged a subgraph wrapping a single node
// (subgraph Data["Database"] ... Tables["orders + refunds tables"] ... end)
// as unnecessary visual clutter -- a colored border around a node that
// already has its own colored border.
describe("collapseSingleNodeSubgraphs", () => {
  it("unwraps a subgraph whose entire body is exactly one node declaration", () => {
    const source = [
      'flowchart TD',
      '  subgraph Data["Database"]',
      '    Tables["orders + refunds tables"]',
      '  end',
      '  class Tables datastore',
      '  class Data datastoreRegion',
      '  A --> Tables',
    ].join("\n");
    const result = collapseSingleNodeSubgraphs(source);
    expect(result).toContain('Tables["orders + refunds tables"]');
    expect(result).not.toContain("subgraph Data");
    expect(result).not.toContain("end");
    expect(result).not.toContain("datastoreRegion");
    expect(result).toContain("class Tables datastore"); // the node's own category line is untouched
    expect(result).toContain("A --> Tables");
  });

  it("leaves a subgraph with two or more member nodes alone", () => {
    const source = [
      'flowchart TD',
      '  subgraph Logic["Business Logic"]',
      '    A["a.ts"]',
      '    B["b.ts"]',
      '  end',
      '  class A,B logic',
      '  class Logic logicRegion',
    ].join("\n");
    expect(collapseSingleNodeSubgraphs(source)).toBe(source);
  });

  it("leaves a single-node subgraph alone if it also contains an edge (not purely a bare node)", () => {
    const source = [
      'flowchart TD',
      '  subgraph Data["Database"]',
      '    Tables["orders table"]',
      '    Tables -->|self-check| Tables',
      '  end',
      '  class Tables datastore',
      '  class Data datastoreRegion',
    ].join("\n");
    expect(collapseSingleNodeSubgraphs(source)).toBe(source);
  });

  it("collapses more than one qualifying subgraph in the same diagram", () => {
    const source = [
      'flowchart TD',
      '  subgraph Data["Database"]',
      '    Tables["orders table"]',
      '  end',
      '  subgraph Ext["External"]',
      '    Gw["PaymentGateway"]',
      '  end',
      '  class Tables datastore',
      '  class Data datastoreRegion',
      '  class Gw external',
      '  class Ext externalRegion',
    ].join("\n");
    const result = collapseSingleNodeSubgraphs(source);
    expect(result).not.toContain("subgraph Data");
    expect(result).not.toContain("subgraph Ext");
    expect(result).toContain('Tables["orders table"]');
    expect(result).toContain('Gw["PaymentGateway"]');
  });

  it("does not collapse a subgraph containing a nested subgraph", () => {
    const source = [
      'flowchart TD',
      '  subgraph Outer["Outer"]',
      '    subgraph Inner["Inner"]',
      '      A["a.ts"]',
      '    end',
      '  end',
      '  class A logic',
      '  class Inner logicRegion',
    ].join("\n");
    // The inner single-node subgraph collapses; the outer one, whose body
    // is now "a subgraph" rather than a single bare node, must not.
    const result = collapseSingleNodeSubgraphs(source);
    expect(result).toContain("subgraph Outer");
    expect(result).not.toContain("subgraph Inner");
    expect(result).toContain('A["a.ts"]');
  });

  it("returns the source unchanged when there is nothing to collapse", () => {
    const source = ['flowchart TD', '  A["a.ts"] --> B["b.ts"]'].join("\n");
    expect(collapseSingleNodeSubgraphs(source)).toBe(source);
  });

  it("is a no-op for sequenceDiagram", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    expect(collapseSingleNodeSubgraphs(source)).toBe(source);
  });
});

describe("annotateFullyNewSequence", () => {
  it("injects a Note as the first line inside a rect that spans every message exchange", () => {
    const source = [
      "sequenceDiagram",
      "  participant Client",
      "  participant API",
      "  rect rgba(88, 166, 255, 0.3)",
      "  Client->>API: newEndpoint()",
      "  API-->>Client: 200 OK",
      "  end",
    ].join("\n");
    const result = annotateFullyNewSequence(source);
    const lines = result.split("\n");
    const rectIdx = lines.findIndex((l) => l.includes("rect rgba(88, 166, 255"));
    expect(lines[rectIdx + 1]).toMatch(/Note over Client,API: New flow added by this PR/);
  });

  it("leaves a partial highlight alone (a message exists outside the rect)", () => {
    const source = [
      "sequenceDiagram",
      "  participant Client",
      "  participant API",
      "  Client->>API: existingCall()",
      "  rect rgba(88, 166, 255, 0.3)",
      "  Client->>API: newEndpoint()",
      "  end",
    ].join("\n");
    expect(annotateFullyNewSequence(source)).toBe(source);
  });

  it("does not double-annotate a rect that already opens with its own Note", () => {
    const source = [
      "sequenceDiagram",
      "  participant Client",
      "  participant API",
      "  rect rgba(88, 166, 255, 0.3)",
      "  Note over Client,API: Already annotated",
      "  Client->>API: newEndpoint()",
      "  end",
    ].join("\n");
    expect(annotateFullyNewSequence(source)).toBe(source);
  });

  it("is a no-op when there is no diff-highlight rect at all", () => {
    const source = ["sequenceDiagram", "  participant Client", "  Client->>API: hi"].join("\n");
    expect(annotateFullyNewSequence(source)).toBe(source);
  });

  it("leaves an unbalanced rect/end alone rather than guessing", () => {
    const source = [
      "sequenceDiagram",
      "  participant Client",
      "  participant API",
      "  rect rgba(88, 166, 255, 0.3)",
      "  Client->>API: newEndpoint()",
    ].join("\n");
    expect(annotateFullyNewSequence(source)).toBe(source);
  });

  it("uses the single participant twice when only one is declared", () => {
    const source = [
      "sequenceDiagram",
      "  participant Worker",
      "  rect rgba(88, 166, 255, 0.3)",
      "  Worker->>Worker: selfCheck()",
      "  end",
    ].join("\n");
    const result = annotateFullyNewSequence(source);
    expect(result).toContain("Note over Worker: New flow added by this PR");
  });

  it("is a no-op when no participants/actors are declared at all", () => {
    const source = ["sequenceDiagram", "  rect rgba(88, 166, 255, 0.3)", "  Client->>API: hi", "  end"].join("\n");
    expect(annotateFullyNewSequence(source)).toBe(source);
  });

  it("is a no-op for flowchart", () => {
    const source = ['flowchart TD', '  A["a.ts"] --> B["b.ts"]'].join("\n");
    expect(annotateFullyNewSequence(source)).toBe(source);
  });

  it("respects nested alt/opt/loop blocks when finding the matching end for the rect", () => {
    const source = [
      "sequenceDiagram",
      "  participant Client",
      "  participant API",
      "  rect rgba(88, 166, 255, 0.3)",
      "  alt success",
      "  Client->>API: newEndpoint()",
      "  else failure",
      "  API-->>Client: error",
      "  end",
      "  end",
    ].join("\n");
    const result = annotateFullyNewSequence(source);
    const lines = result.split("\n");
    const rectIdx = lines.findIndex((l) => l.includes("rect rgba(88, 166, 255"));
    expect(lines[rectIdx + 1]).toMatch(/Note over Client,API: New flow added by this PR/);
  });

  it("recognizes actor declarations, not just participant", () => {
    const source = [
      "sequenceDiagram",
      "  actor User",
      "  participant API",
      "  rect rgba(88, 166, 255, 0.3)",
      "  User->>API: newEndpoint()",
      "  end",
    ].join("\n");
    const result = annotateFullyNewSequence(source);
    expect(result).toContain("Note over User,API: New flow added by this PR");
  });
});

describe("groupUngroupedExternalNodes", () => {
  it("wraps 2+ contiguous ungrouped external nodes into their own subgraph (the real captured bug)", () => {
    // The exact real shape from the live-scale stress test that a fresh
    // adversarial review flagged: EventBus/PaymentGateway/
    // NotificationService left as bare top-level nodes.
    const source = [
      "flowchart TD",
      '  subgraph Logic["Service Layer"]',
      '    OrderService["orderService.ts"]',
      "  end",
      "  class OrderService logic",
      "",
      '  EventBus["EventBus"]',
      '  PaymentGateway["PaymentGateway"]',
      '  NotificationService["NotificationService"]',
      "  class EventBus,PaymentGateway,NotificationService externalContext",
      "",
      "  OrderService --> EventBus",
    ].join("\n");
    const result = groupUngroupedExternalNodes(source);
    expect(result).toContain('subgraph External["External Services"]');
    expect(result).toContain("class External externalRegion");
    expect(result).toContain('EventBus["EventBus"]');
    expect(result).toContain('PaymentGateway["PaymentGateway"]');
    expect(result).toContain('NotificationService["NotificationService"]');
    expect(result).toContain("OrderService --> EventBus"); // edges untouched
    // The subgraph must actually wrap all three (open before, end after).
    const lines = result.split("\n");
    const openIdx = lines.findIndex((l) => l.includes('subgraph External["External Services"]'));
    const eventBusIdx = lines.findIndex((l) => l.includes('EventBus["EventBus"]'));
    const notifIdx = lines.findIndex((l) => l.includes('NotificationService["NotificationService"]'));
    const endIdx = lines.findIndex((l, i) => i > notifIdx && l.trim() === "end");
    expect(openIdx).toBeLessThan(eventBusIdx);
    expect(notifIdx).toBeLessThan(endIdx);
  });

  it("leaves a single ungrouped external node alone", () => {
    const source = [
      "flowchart TD",
      '  A["a.ts"]',
      '  PaymentGateway["PaymentGateway"]',
      "  class A logic",
      "  class PaymentGateway externalContext",
    ].join("\n");
    expect(groupUngroupedExternalNodes(source)).toBe(source);
  });

  it("leaves ungrouped external nodes alone when they aren't contiguous", () => {
    const source = [
      "flowchart TD",
      '  EventBus["EventBus"]',
      '  A["a.ts"]',
      '  PaymentGateway["PaymentGateway"]',
      "  class EventBus,PaymentGateway externalContext",
      "  class A logic",
    ].join("\n");
    expect(groupUngroupedExternalNodes(source)).toBe(source);
  });

  it("does not re-wrap external nodes that are already inside a subgraph", () => {
    const source = [
      "flowchart TD",
      '  subgraph Ext["External Services"]',
      '    EventBus["EventBus"]',
      '    PaymentGateway["PaymentGateway"]',
      "  end",
      "  class EventBus,PaymentGateway externalContext",
      "  class Ext externalRegion",
    ].join("\n");
    expect(groupUngroupedExternalNodes(source)).toBe(source);
  });

  it("returns the source unchanged when there are no external nodes at all", () => {
    const source = ['flowchart TD', '  A["a.ts"] --> B["b.ts"]', "  class A,B logic"].join("\n");
    expect(groupUngroupedExternalNodes(source)).toBe(source);
  });

  it("is a no-op for sequenceDiagram", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    expect(groupUngroupedExternalNodes(source)).toBe(source);
  });
});

describe("canonicalizeSubgraphTitles", () => {
  // Round-14 finding, reproduced live: the identical diff produced
  // different subgraph titles across two separate live calls ("Business
  // Logic" vs. "Service Layer"). Each subgraph's own *Region class already
  // states its category unambiguously, so the title gets forced to the
  // fixed canonical string for that region regardless of what the model
  // wrote.
  it("rewrites a non-canonical title to the canonical one for its region", () => {
    const source = [
      "flowchart TD",
      '  subgraph Logic["Service Layer"]',
      '    OrderService["orderService.ts"]',
      "  end",
      "  class Logic logicRegion",
      "  class OrderService logic",
    ].join("\n");
    const result = canonicalizeSubgraphTitles(source);
    expect(result).toContain('subgraph Logic["Business Logic"]');
    expect(result).not.toContain("Service Layer");
  });

  it("rewrites all four canonical regions correctly in the same diagram", () => {
    const source = [
      "flowchart TD",
      '  subgraph API["Routes"]',
      '    A["a.ts"]',
      "  end",
      "  class API endpointRegion",
      '  subgraph Logic["Services"]',
      '    B["b.ts"]',
      "  end",
      "  class Logic logicRegion",
      '  subgraph Data["DB"]',
      '    C["c.ts"]',
      "  end",
      "  class Data datastoreRegion",
      '  subgraph Ext["Third Parties"]',
      '    D["d.ts"]',
      "  end",
      "  class Ext externalRegion",
      "  class A endpoint",
      "  class B logic",
      "  class C datastore",
      "  class D external",
    ].join("\n");
    const result = canonicalizeSubgraphTitles(source);
    expect(result).toContain('subgraph API["API Layer"]');
    expect(result).toContain('subgraph Logic["Business Logic"]');
    expect(result).toContain('subgraph Data["Data Layer"]');
    expect(result).toContain('subgraph Ext["External Services"]');
  });

  it("is a no-op when the title is already the canonical one", () => {
    const source = [
      "flowchart TD",
      '  subgraph Logic["Business Logic"]',
      '    A["a.ts"]',
      "  end",
      "  class Logic logicRegion",
      "  class A logic",
    ].join("\n");
    expect(canonicalizeSubgraphTitles(source)).toBe(source);
  });

  // The one deliberate exception: forcing two DIFFERENT subgraphs that
  // happen to share a region onto the identical canonical title would make
  // two genuinely distinct groups look like duplicates of each other —
  // worse than the instability this function exists to fix. Both must be
  // left completely untouched rather than picking one arbitrarily.
  it("leaves both titles alone when two subgraphs share the same region", () => {
    const source = [
      "flowchart TD",
      '  subgraph Ext1["Payment Providers"]',
      '    A["a.ts"]',
      "  end",
      "  class Ext1 externalRegion",
      '  subgraph Ext2["Notification Providers"]',
      '    B["b.ts"]',
      "  end",
      "  class Ext2 externalRegion",
      "  class A,B external",
    ].join("\n");
    expect(canonicalizeSubgraphTitles(source)).toBe(source);
  });

  // The realistic case, found by live-verifying the first version of this
  // fix: the model classes every individual node correctly but never
  // actually emits the separate subgraph-level `class SubgraphId
  // <region>Region` line the SYSTEM_PROMPT asks for. Two fresh live calls
  // in a row produced zero such lines between them. The fix has to work
  // from ordinary per-node categories alone, or it ships completely inert.
  it("infers the region from member nodes' own categories when no explicit *Region class line exists at all — the real shape live output actually takes", () => {
    const source = [
      "flowchart TD",
      'subgraph API["API Routes"]',
      '  Routes["orders.ts / refunds.ts routes"]',
      '  Controllers["ordersController / refundsController"]',
      "end",
      "class Routes,Controllers endpoint",
      "",
      'subgraph Logic["Service Layer"]',
      '  OrderService["orderService.ts"]',
      '  RefundService["refundService.ts"]',
      "end",
      "class OrderService,RefundService logic",
      "",
      'subgraph ThirdParty["External Systems"]',
      '  EventBus["EventBus"]',
      '  PaymentGateway["PaymentGateway"]',
      "end",
      // Note: no `class API endpointRegion` / `class Logic logicRegion` /
      // `class ThirdParty externalRegion` lines anywhere in this source --
      // exactly what live output actually looked like.
      "class EventBus,PaymentGateway externalContext",
    ].join("\n");
    const result = canonicalizeSubgraphTitles(source);
    expect(result).toContain('subgraph API["API Layer"]');
    expect(result).toContain('subgraph Logic["Business Logic"]');
    expect(result).toContain('subgraph ThirdParty["External Services"]');
    expect(result).not.toContain("Service Layer");
    expect(result).not.toContain("External Systems");
  });

  it("prefers an explicit *Region class line over inference when both are present", () => {
    // A contrived case where the member's own category would infer
    // "logic" but the subgraph's own explicit region line says otherwise
    // -- the explicit line is the more direct signal and wins.
    const source = [
      "flowchart TD",
      '  subgraph Weird["Odd Grouping"]',
      '    A["a.ts"]',
      "  end",
      "  class Weird endpointRegion",
      "  class A logic",
    ].join("\n");
    const result = canonicalizeSubgraphTitles(source);
    expect(result).toContain('subgraph Weird["API Layer"]');
  });

  it("leaves a subgraph untouched when its members span more than one category", () => {
    const source = [
      "flowchart TD",
      '  subgraph Mixed["Grab Bag"]',
      '    A["a.ts"]',
      '    B["b.ts"]',
      "  end",
      "  class A logic",
      "  class B datastore",
    ].join("\n");
    expect(canonicalizeSubgraphTitles(source)).toBe(source);
  });

  it("leaves a subgraph untouched when none of its members have a known category", () => {
    const source = [
      "flowchart TD",
      '  subgraph Weird["Some Title"]',
      '    A["a.ts"]',
      "  end",
      "  class A removed",
    ].join("\n");
    expect(canonicalizeSubgraphTitles(source)).toBe(source);
  });

  it("is a no-op for sequenceDiagram", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    expect(canonicalizeSubgraphTitles(source)).toBe(source);
  });

  it("returns the source unchanged when there are no subgraphs at all", () => {
    const source = ['flowchart TD', '  A["a.ts"] --> B["b.ts"]', "  class A,B logic"].join("\n");
    expect(canonicalizeSubgraphTitles(source)).toBe(source);
  });
});

describe("annotatePublishSubscribeEdges", () => {
  it("restyles a subscribe-labeled solid edge to a dotted arrow", () => {
    const source = [
      "flowchart TD",
      '  Worker["RefundWorker"]',
      '  Bus["EventBus"]',
      '  Worker -->|subscribes to "refund.issued"| Bus',
    ].join("\n");
    const result = annotatePublishSubscribeEdges(source);
    expect(result).toContain('Worker -.-> |subscribes to "refund.issued"');
    expect(result).not.toMatch(/Worker\s+-->/);
  });

  it("appends the no-publisher warning when neither endpoint has a shown publish", () => {
    const source = [
      "flowchart TD",
      '  Worker["RefundWorker"]',
      '  Bus["EventBus"]',
      '  Worker -->|subscribes to "refund.issued"| Bus',
    ].join("\n");
    const result = annotatePublishSubscribeEdges(source);
    expect(result).toContain("not shown as published anywhere in this diagram");
  });

  it("does NOT append the warning when the bus has a publish edge shown elsewhere in the diagram", () => {
    const source = [
      "flowchart TD",
      '  Refunds["RefundService"]',
      '  Worker["RefundWorker"]',
      '  Bus["EventBus"]',
      '  Refunds -->|publishes "refund.issued"| Bus',
      '  Worker -->|subscribes to "refund.issued"| Bus',
    ].join("\n");
    const result = annotatePublishSubscribeEdges(source);
    expect(result).not.toContain("not shown as published anywhere in this diagram");
    // The subscribe edge is still restyled dotted even though it's not warned.
    expect(result).toContain('Worker -.-> |subscribes to "refund.issued"');
    // The publish edge itself is left as a normal solid arrow.
    expect(result).toContain('Refunds -->|publishes "refund.issued"| Bus');
  });

  it("warns on a topic mismatch even when the bus DOES publish something -- just not the event being subscribed to (real bug: found running a live Anthropic call, publishes order.created and separately subscribes to refund.issued on the same EventBus node)", () => {
    const source = [
      "flowchart TD",
      '  OrderService["OrderService"]',
      '  Bus["EventBus"]',
      '  Worker["RefundWorker"]',
      "  OrderService -->|publishes order.created| Bus",
      "  Bus -->|subscribes to refund.issued| Worker",
    ].join("\n");
    const result = annotatePublishSubscribeEdges(source);
    expect(result).toContain("no publish edge for this event shown in this diagram");
    // A node-level-only check would have wrongly stayed silent here, since
    // Bus does appear in a publish edge -- just for a different event.
    expect(result).not.toContain("not shown as published anywhere in this diagram");
    // The publish edge itself is untouched.
    expect(result).toContain("OrderService -->|publishes order.created| Bus");
  });

  it("does not warn when the subscribed and published topic names match", () => {
    const source = [
      "flowchart TD",
      '  OrderService["OrderService"]',
      '  Bus["EventBus"]',
      '  Worker["RefundWorker"]',
      "  OrderService -->|publishes refund.issued| Bus",
      "  Bus -->|subscribes to refund.issued| Worker",
    ].join("\n");
    const result = annotatePublishSubscribeEdges(source);
    expect(result).not.toContain("⚠");
  });

  it("recognizes a raw .subscribe( call-shaped label, not just the exact prompt phrasing", () => {
    const source = [
      "flowchart TD",
      '  Worker["RefundWorker"]',
      '  Bus["EventBus"]',
      "  Worker -->|.subscribe('refund.issued')| Bus",
    ].join("\n");
    const result = annotatePublishSubscribeEdges(source);
    expect(result).toMatch(/Worker\s+-\.->/);
  });

  it("leaves an already-dotted subscribe edge's arrow alone but still evaluates the warning", () => {
    const source = [
      "flowchart TD",
      '  Worker["RefundWorker"]',
      '  Bus["EventBus"]',
      '  Worker -.->|subscribes to "refund.issued"| Bus',
    ].join("\n");
    const result = annotatePublishSubscribeEdges(source);
    expect(result).toContain("not shown as published anywhere in this diagram");
  });

  it("does not restyle or warn on a publish-only edge", () => {
    const source = [
      "flowchart TD",
      '  Refunds["RefundService"]',
      '  Bus["EventBus"]',
      '  Refunds -->|publishes "refund.issued"| Bus',
    ].join("\n");
    expect(annotatePublishSubscribeEdges(source)).toBe(source);
  });

  it("returns the source unchanged when there are no subscribe-labeled edges at all", () => {
    const source = ['flowchart TD', '  A["a.ts"] --> B["b.ts"]', "  class A,B logic"].join("\n");
    expect(annotatePublishSubscribeEdges(source)).toBe(source);
  });

  it("is idempotent -- running it twice never double-appends the warning", () => {
    const source = [
      "flowchart TD",
      '  Worker["RefundWorker"]',
      '  Bus["EventBus"]',
      '  Worker -->|subscribes to "refund.issued"| Bus',
    ].join("\n");
    const once = annotatePublishSubscribeEdges(source);
    const twice = annotatePublishSubscribeEdges(once);
    expect(twice).toBe(once);
    const warningCount = (twice.match(/not shown as published anywhere in this diagram/g) ?? []).length;
    expect(warningCount).toBe(1);
  });

  it("is a no-op for sequenceDiagram", () => {
    const source = "sequenceDiagram\n  A->>B: subscribes to refund.issued";
    expect(annotatePublishSubscribeEdges(source)).toBe(source);
  });
});

describe("sanitizeEdgeLabelQuotes", () => {
  it("strips a double-quoted event name from a pipe-delimited edge label (real bug: a live Anthropic call quoted it exactly like the SYSTEM_PROMPT's own example used to, and Mermaid's parser rejects a quote inside |...|)", () => {
    const source = [
      "flowchart TD",
      '  Refunds["RefundService"]',
      '  Bus["EventBus"]',
      '  Refunds -->|publishes "order.created"| Bus',
    ].join("\n");
    const result = sanitizeEdgeLabelQuotes(source);
    expect(result).toContain("|publishes order.created|");
    // Node labels keep their own quotes -- only the edge's pipe-delimited
    // label is sanitized.
    expect(result).toContain('Refunds["RefundService"]');
  });

  it("strips single quotes too", () => {
    const source = ['flowchart TD', '  A["a"]', '  B["b"]', "  A -->|calls 'x'| B"].join("\n");
    expect(sanitizeEdgeLabelQuotes(source)).toContain("|calls x|");
  });

  it("never touches a node's own quoted label", () => {
    const source = ['flowchart TD', '  A["My Node"] --> B["Other Node"]'].join("\n");
    expect(sanitizeEdgeLabelQuotes(source)).toBe(source);
  });

  it("returns the source unchanged when no edge label contains a quote", () => {
    const source = ['flowchart TD', '  A["a"] -->|calls| B["b"]'].join("\n");
    expect(sanitizeEdgeLabelQuotes(source)).toBe(source);
  });

  it("is a no-op for sequenceDiagram", () => {
    const source = 'sequenceDiagram\n  A->>B: publishes "order.created"';
    expect(sanitizeEdgeLabelQuotes(source)).toBe(source);
  });
});

describe("closeUnclosedSequenceBlocks", () => {
  it("returns an already-balanced diagram unchanged", () => {
    const source = [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  A->>B: call 1",
      "  rect rgba(88, 166, 255, 0.3)",
      "  A->>B: call 2",
      "  end",
      "  A->>B: call 3",
    ].join("\n");
    expect(closeUnclosedSequenceBlocks(source)).toBe(source);
  });

  it("appends a missing end for a single unclosed rect block", () => {
    const source = [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  A->>B: call 1",
      "  rect rgba(88, 166, 255, 0.3)",
      "  A->>B: call 2 (new)",
    ].join("\n");
    const result = closeUnclosedSequenceBlocks(source);
    expect(result).toBe(`${source}\nend\n`);
  });

  it("appends multiple missing ends, one per still-open block, in the real shape that broke rendering (round-14 live finding)", () => {
    // Mirrors scripts/rect-edge-cases.ts's "unclosed rect" reproduction,
    // which produced a real Mermaid parse error when rendered unpatched.
    const source = [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  A->>B: call 1",
      "  rect rgba(88, 166, 255, 0.3)",
      "  A->>B: call 2 (new)",
      "  A->>B: call 3 (should not be highlighted, but rect never closed)",
    ].join("\n");
    const result = closeUnclosedSequenceBlocks(source);
    expect(result).toBe(`${source}\nend\n`);
    expect(result.trim().split("\n").filter((l) => l.trim() === "end").length).toBe(1);
  });

  it("closes multiple distinct unclosed blocks (rect left open, then alt left open) with one end each", () => {
    const source = [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  rect rgba(88, 166, 255, 0.3)",
      "  A->>B: call 1",
      "  alt some condition",
      "  A->>B: call 2",
    ].join("\n");
    const result = closeUnclosedSequenceBlocks(source);
    const trailingEnds = result.slice(source.length);
    expect(trailingEnds.trim().split("\n")).toEqual(["end", "end"]);
  });

  it("does not touch a correctly nested and fully closed alt/rect combination", () => {
    const source = [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  rect rgba(88, 166, 255, 0.3)",
      "  alt success",
      "  A->>B: ok",
      "  else failure",
      "  A->>B: error",
      "  end",
      "  end",
    ].join("\n");
    expect(closeUnclosedSequenceBlocks(source)).toBe(source);
  });

  it("is a no-op for flowchart, where this block syntax doesn't apply", () => {
    const source = ['flowchart TD', '  A["a"] --> B["b"]'].join("\n");
    expect(closeUnclosedSequenceBlocks(source)).toBe(source);
  });

  it("is a no-op when there are no block-opening keywords at all", () => {
    const source = ["sequenceDiagram", "  participant A", "  participant B", "  A->>B: hello"].join("\n");
    expect(closeUnclosedSequenceBlocks(source)).toBe(source);
  });
});

describe("reconcileDatastoreNodeLabels", () => {
  // Mirrors the real round-14 shape: a live-model diagram correctly drew
  // `InventoryService -->|writes| Tables` but the shared Tables node's own
  // label only said "orders / refunds tables," silently omitting inventory.
  function scaleDiagram(tablesLabel: string): string {
    return [
      "flowchart TD",
      '  OrderService["OrderService"]',
      '  InventoryService["InventoryService"]',
      '  RefundService["RefundService"]',
      `  Tables["${tablesLabel}"]`,
      "class OrderService,InventoryService,RefundService logic",
      "class Tables datastore",
      "OrderService -->|writes| Tables",
      "InventoryService -->|writes| Tables",
      "RefundService -->|writes| Tables",
    ].join("\n");
  }

  it("inserts a missing writer's keyword before a trailing 'tables' word", () => {
    const source = scaleDiagram("orders / refunds tables");
    const result = reconcileDatastoreNodeLabels(source);
    expect(result).toContain('Tables["orders / refunds / inventory tables"]');
  });

  it("is idempotent -- does nothing when every writer's keyword is already present", () => {
    const source = scaleDiagram("orders / refunds / inventory tables");
    expect(reconcileDatastoreNodeLabels(source)).toBe(source);
  });

  it("recognizes the keyword even when the label uses the plural and the node name is singular", () => {
    // OrderService -> "order"; label already says "orders" -- substring
    // containment must treat these as the same table, not flag a false gap.
    const source = [
      "flowchart TD",
      '  OrderService["OrderService"]',
      '  Tables["orders tables"]',
      "class OrderService logic",
      "class Tables datastore",
      "OrderService -->|writes| Tables",
    ].join("\n");
    expect(reconcileDatastoreNodeLabels(source)).toBe(source);
  });

  it("falls back to a plain append when the label has no trailing 'table(s)' word", () => {
    const source = [
      "flowchart TD",
      '  InventoryService["InventoryService"]',
      '  DB["OrdersDB"]',
      "class InventoryService logic",
      "class DB datastore",
      "InventoryService -->|writes| DB",
    ].join("\n");
    const result = reconcileDatastoreNodeLabels(source);
    expect(result).toContain('DB["OrdersDB / inventory"]');
  });

  it("recognizes creates/updates/deletes as write verbs too, not only 'writes'", () => {
    const source = [
      "flowchart TD",
      '  InventoryService["InventoryService"]',
      '  Tables["orders tables"]',
      "class InventoryService logic",
      "class Tables datastore",
      "InventoryService -->|creates| Tables",
    ].join("\n");
    expect(reconcileDatastoreNodeLabels(source)).toContain('Tables["orders / inventory tables"]');
  });

  // Real live-model finding (2026-09-07): a genuine call labeled
  // InventoryService's own stock-adjustment edge "decrements" instead of
  // "writes" -- a reminder the verb list can't be assumed exhaustive.
  it("recognizes 'decrements' as a write verb too", () => {
    const source = [
      "flowchart TD",
      '  InventoryService["InventoryService"]',
      '  Tables["orders tables"]',
      "class InventoryService logic",
      "class Tables datastore",
      "InventoryService -->|decrements| Tables",
    ].join("\n");
    expect(reconcileDatastoreNodeLabels(source)).toContain('Tables["orders / inventory tables"]');
  });

  it("does not touch a non-write edge into a datastore node (e.g. a mere reference)", () => {
    const source = [
      "flowchart TD",
      '  InventoryService["InventoryService"]',
      '  Tables["orders tables"]',
      "class InventoryService logic",
      "class Tables datastore",
      "InventoryService -->|reads| Tables",
    ].join("\n");
    expect(reconcileDatastoreNodeLabels(source)).toBe(source);
  });

  it("does not touch an edge between two datastore nodes", () => {
    const source = [
      "flowchart TD",
      '  Archive["ArchiveTable"]',
      '  Tables["orders tables"]',
      "class Archive datastore",
      "class Tables datastore",
      "Archive -->|writes| Tables",
    ].join("\n");
    expect(reconcileDatastoreNodeLabels(source)).toBe(source);
  });

  it("is a no-op for sequenceDiagram", () => {
    const source = "sequenceDiagram\n  A->>B: writes to inventory";
    expect(reconcileDatastoreNodeLabels(source)).toBe(source);
  });

  it("merges multiple missing keywords onto the same target in one pass", () => {
    const source = [
      "flowchart TD",
      '  InventoryService["InventoryService"]',
      '  ShippingService["ShippingService"]',
      '  Tables["orders tables"]',
      "class InventoryService,ShippingService logic",
      "class Tables datastore",
      "InventoryService -->|writes| Tables",
      "ShippingService -->|writes| Tables",
    ].join("\n");
    const result = reconcileDatastoreNodeLabels(source);
    expect(result).toContain('"orders / inventory / shipping tables"');
  });
});
