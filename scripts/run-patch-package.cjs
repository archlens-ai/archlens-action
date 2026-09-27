#!/usr/bin/env node
/**
 * Self-locating, self-diagnosing patch-package runner.
 *
 * Why this exists (see CLAUDE.md items 43-46 for the full saga): a plain
 * "patch-package" postinstall breaks specifically on Vercel's build
 * container for this monorepo, and three straight fixes (43, 44, 45, 46)
 * each looked correct locally and each broke on the real deployment with a
 * DIFFERENT error, because each one assumed a specific value for "where is
 * patch-package's index.js on disk" instead of checking. This script stops
 * guessing: it searches for patch-package/index.js starting from every
 * plausible anchor, logs exactly what it finds (or doesn't) so a future
 * failure is diagnosable from the log alone, and only then runs it with the
 * correct cwd (the directory that actually contains node_modules/, which is
 * also where patch-package expects to find the repo's patches/ folder).
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

function log(msg) {
  console.error("[run-patch-package] " + msg);
}

function findPatchPackageUpward(startDir) {
  let cur = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(cur, "node_modules", "patch-package", "index.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Anchor candidates, in priority order. We try multiple because different
// npm/Vercel configurations have given us different, contradictory values
// for each of these across items 43-46 - so we no longer trust just one.
const anchors = [];
if (process.env.npm_package_json) anchors.push(path.dirname(process.env.npm_package_json));
anchors.push(process.cwd());
anchors.push(__dirname); // this file's own directory (repo/scripts)
anchors.push(path.dirname(__dirname)); // repo root, if this file lives in <root>/scripts

log("process.cwd()        = " + process.cwd());
log("__dirname             = " + __dirname);
log("npm_package_json       = " + process.env.npm_package_json);

let resolved = null;
for (const anchor of anchors) {
  if (!anchor) continue;
  const found = findPatchPackageUpward(anchor);
  if (found) {
    resolved = found;
    log("found patch-package at " + found + " (via anchor " + anchor + ")");
    break;
  }
}

if (!resolved) {
  log("FATAL: could not find node_modules/patch-package/index.js starting from any anchor:");
  for (const a of anchors) log("  anchor tried: " + a);
  // Dump what actually exists so the next failure (if any) is diagnosable
  // from this one log instead of requiring another guess-and-redeploy cycle.
  for (const anchor of anchors) {
    if (!anchor) continue;
    const nm = path.join(path.resolve(anchor), "node_modules");
    try {
      const entries = fs.readdirSync(nm);
      log("contents of " + nm + " (" + entries.length + " entries): " +
        entries.filter((e) => e.toLowerCase().includes("patch")).join(", ") +
        (entries.length ? "" : " <empty>"));
    } catch (e) {
      log("could not read " + nm + ": " + e.message);
    }
  }
  process.exit(1);
}

// resolved = <root>/node_modules/patch-package/index.js
// patch-package resolves its own "patches/" directory relative to its own
// cwd at runtime, so we must spawn it with cwd = <root> (three levels up
// from index.js), not wherever this script happens to be running from.
const root = path.dirname(path.dirname(path.dirname(resolved)));
log("spawning patch-package with cwd=" + root);

const result = cp.spawnSync(process.execPath, [resolved], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  log("FATAL: failed to spawn patch-package: " + result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
