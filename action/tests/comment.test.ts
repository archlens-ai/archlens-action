import { describe, expect, it, vi } from "vitest";
import { ARCHLENS_MARKER, buildCommentBody, upsertComment } from "../src/comment.js";

describe("buildCommentBody", () => {
  it("embeds the marker, image, and mermaid source", () => {
    const body = buildCommentBody({
      svgUrl: "https://cdn.archlens.dev/abc123.svg",
      mermaidSource: "flowchart TD\n  A --> B",
      diagramType: "flowchart",
      truncated: false,
      repoFullName: "acme/widgets",
    });

    expect(body).toContain(ARCHLENS_MARKER);
    expect(body).toContain("https://cdn.archlens.dev/abc123.svg");
    expect(body).toContain("flowchart TD");
    expect(body).not.toContain("⚠️ This diff was larger");
  });

  it("includes a truncation warning when the diff was truncated", () => {
    const body = buildCommentBody({
      svgUrl: "https://cdn.archlens.dev/abc123.svg",
      mermaidSource: "flowchart TD\n  A --> B",
      diagramType: "flowchart",
      truncated: true,
      repoFullName: "acme/widgets",
    });
    expect(body).toContain("⚠️ This diff was larger");
  });

  it("includes the PR number and matched-file count when provided, so the image is self-identifying out of thread context", () => {
    const body = buildCommentBody({
      svgUrl: "https://cdn.archlens.dev/abc123.svg",
      mermaidSource: "flowchart TD\n  A --> B",
      diagramType: "flowchart",
      truncated: false,
      repoFullName: "acme/widgets",
      prNumber: 482,
      filesMatched: 3,
    });
    expect(body).toContain("PR #482");
    expect(body).toContain("3 files matched");
  });

  it("omits the PR context segment when prNumber/filesMatched aren't provided", () => {
    const body = buildCommentBody({
      svgUrl: "https://cdn.archlens.dev/abc123.svg",
      mermaidSource: "flowchart TD\n  A --> B",
      diagramType: "flowchart",
      truncated: false,
      repoFullName: "acme/widgets",
    });
    expect(body).not.toContain("PR #");
  });

  // Disclosed-simplification note, added alongside the coarse-mode prompt
  // switch (llm.ts) and the deterministic diff-classification fix
  // (diff-classify.ts) that came out of the harsh-review loop finding the
  // diagram unreadable past ~10 files — a reviewer should know a big
  // diagram is simplified by design, not silently missing detail.
  it("includes a simplification note once matched files pass the complexity threshold", () => {
    const body = buildCommentBody({
      svgUrl: "https://cdn.archlens.dev/abc123.svg",
      mermaidSource: "flowchart TD\n  A --> B",
      diagramType: "flowchart",
      truncated: false,
      repoFullName: "acme/widgets",
      prNumber: 512,
      filesMatched: 10,
    });
    expect(body).toContain("10 files");
    expect(body).toContain("file/module level");
  });

  it("omits the simplification note for a small diff", () => {
    const body = buildCommentBody({
      svgUrl: "https://cdn.archlens.dev/abc123.svg",
      mermaidSource: "flowchart TD\n  A --> B",
      diagramType: "flowchart",
      truncated: false,
      repoFullName: "acme/widgets",
      prNumber: 512,
      filesMatched: 3,
    });
    expect(body).not.toContain("file/module level");
  });
});

function makeFakeOctokit(existingComments: Array<{ id: number; body: string }>) {
  const createComment = vi.fn().mockResolvedValue({
    data: { html_url: "https://github.com/acme/widgets/pull/1#issuecomment-new" },
  });
  const updateComment = vi.fn().mockResolvedValue({
    data: { html_url: "https://github.com/acme/widgets/pull/1#issuecomment-existing" },
  });

  const octokit = {
    paginate: vi.fn().mockResolvedValue(existingComments),
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment,
        updateComment,
      },
    },
  };

  return { octokit: octokit as any, createComment, updateComment };
}

describe("upsertComment", () => {
  it("creates a new comment when no ArchLens comment exists yet", async () => {
    const { octokit, createComment, updateComment } = makeFakeOctokit([]);
    const url = await upsertComment(octokit, "acme", "widgets", 1, "body with marker");
    expect(createComment).toHaveBeenCalledOnce();
    expect(updateComment).not.toHaveBeenCalled();
    expect(url).toContain("issuecomment-new");
  });

  it("updates the existing ArchLens comment instead of creating a duplicate", async () => {
    const { octokit, createComment, updateComment } = makeFakeOctokit([
      { id: 42, body: `${ARCHLENS_MARKER}\nold diagram` },
      { id: 43, body: "an unrelated human comment" },
    ]);
    const url = await upsertComment(octokit, "acme", "widgets", 1, "new body");
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 42, body: "new body" })
    );
    expect(createComment).not.toHaveBeenCalled();
    expect(url).toContain("issuecomment-existing");
  });
});
