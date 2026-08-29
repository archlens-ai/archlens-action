import * as core from "@actions/core";
import * as github from "@actions/github";

import { loadConfig } from "./config.js";
import { buildCompressedDiff, type ChangedFile } from "./diff.js";
import { generateDiagram, ArchLensApiError } from "./client.js";
import { buildCommentBody, upsertComment } from "./comment.js";

async function run(): Promise<void> {
  const config = loadConfig();
  const { context } = github;

  const pullRequest = context.payload.pull_request;
  if (!pullRequest) {
    core.info("ArchLens only runs on pull_request events — skipping.");
    core.setOutput("skipped", "true");
    return;
  }

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const prNumber = pullRequest.number as number;

  const octokit = github.getOctokit(config.githubToken);

  const rawFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const changedFiles: ChangedFile[] = rawFiles.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));

  const diff = buildCompressedDiff(
    changedFiles,
    config.includePatterns,
    config.maxDiffBytes
  );

  if (!diff.matched) {
    core.info(
      "No changed files matched the configured include-patterns — skipping diagram generation."
    );
    core.setOutput("skipped", "true");
    return;
  }

  core.info(
    `ArchLens: ${diff.files.length} matching file(s), ${diff.totalBytes} bytes` +
      (diff.truncated ? " (truncated to fit max-diff-bytes)" : "")
  );

  try {
    const result = await generateDiagram(config.apiBaseUrl, {
      apiKey: config.archlensApiKey,
      owner,
      repo,
      prNumber,
      diagramType: config.diagramType,
      diff,
    });

    const body = buildCommentBody({
      svgUrl: result.svgUrl,
      mermaidSource: result.mermaidSource,
      diagramType: result.diagramType,
      truncated: diff.truncated,
      repoFullName: `${owner}/${repo}`,
    });

    const commentUrl = await upsertComment(octokit, owner, repo, prNumber, body);

    core.setOutput("diagram-url", result.svgUrl);
    core.setOutput("comment-url", commentUrl);
    core.setOutput("skipped", "false");
    core.info(`ArchLens posted diagram: ${commentUrl}`);
  } catch (err) {
    await handleGenerationError(err, octokit, owner, repo, prNumber, config.failOnError);
  }
}

/**
 * On failure we still try to leave the PR a friendly comment explaining
 * what happened (expired key, quota exceeded, etc.) rather than silently
 * failing the whole CI run — a red X on someone's PR for a diagramming tool
 * is exactly the kind of friction that gets ArchLens uninstalled.
 */
async function handleGenerationError(
  err: unknown,
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  failOnError: boolean
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  core.warning(`ArchLens generation failed: ${message}`);

  if (err instanceof ArchLensApiError && err.code !== "malformed_response") {
    try {
      await upsertComment(
        octokit,
        owner,
        repo,
        prNumber,
        `<!-- archlens-ai-comment -->\n### 🤖 ArchLens AI\n\n⚠️ Couldn't generate a diagram for this PR: ${message}\n`
      );
    } catch (commentErr) {
      core.warning(
        `Also failed to post the error comment: ${
          commentErr instanceof Error ? commentErr.message : String(commentErr)
        }`
      );
    }
  }

  core.setOutput("skipped", "true");
  if (failOnError) {
    core.setFailed(message);
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
