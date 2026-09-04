import { describe, expect, it } from "vitest";
import { computeDiffTouchState, reconcileDiffClassification, stripSelfLoopEdges, assignMissingCategories, type DiffPatchFile } from "../lib/diff-classify.js";

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
