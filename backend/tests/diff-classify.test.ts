import { describe, expect, it } from "vitest";
import { computeDiffTouchState, reconcileDiffClassification, type DiffPatchFile } from "../lib/diff-classify.js";

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

  it("never touches a line the model already marked 'removed'", () => {
    const source = [
      'flowchart TD',
      '  A["issueRefund()"]', // this WOULD match changed tokens if reconciled
      '  class A removed',
    ].join("\n");
    const result = reconcileDiffClassification(source, files);
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
