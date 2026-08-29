import { describe, expect, it } from "vitest";
import { buildCompressedDiff, compressPatch, matchesIncludePatterns } from "../src/diff.js";

describe("compressPatch", () => {
  it("strips comment lines, blank lines, and log calls, keeps hunk headers and real changes", () => {
    const patch = [
      "@@ -1,5 +1,8 @@",
      " function existing() {}",
      "+// a comment explaining the new route",
      "+router.post('/users', createUser)",
      "+",
      "+console.log('debug')",
      "-router.post('/legacy-users', createUser)",
    ].join("\n");

    const result = compressPatch(patch);

    expect(result).toContain("@@ -1,5 +1,8 @@");
    expect(result).toContain("+router.post('/users', createUser)");
    expect(result).toContain("-router.post('/legacy-users', createUser)");
    expect(result).not.toContain("comment explaining");
    expect(result).not.toContain("console.log");
    expect(result.split("\n").every((l) => l.length > 0)).toBe(true);
  });
});

describe("matchesIncludePatterns", () => {
  it("matches against glob patterns", () => {
    const patterns = ["**/*.sql", "**/routes/**", "**/*.prisma"];
    expect(matchesIncludePatterns("db/migrations/001.sql", patterns)).toBe(true);
    expect(matchesIncludePatterns("src/routes/users.ts", patterns)).toBe(true);
    expect(matchesIncludePatterns("schema.prisma", patterns)).toBe(true);
    expect(matchesIncludePatterns("README.md", patterns)).toBe(false);
  });

  it("matches everything when no patterns are configured", () => {
    expect(matchesIncludePatterns("anything.txt", [])).toBe(true);
  });
});

describe("buildCompressedDiff", () => {
  it("reports matched=false when nothing matches the include patterns", () => {
    const result = buildCompressedDiff(
      [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, patch: "+hi" }],
      ["**/*.sql"],
      60_000
    );
    expect(result.matched).toBe(false);
    expect(result.files).toHaveLength(0);
  });

  it("keeps matching files, compresses patches, and returns a stable filename order", () => {
    const result = buildCompressedDiff(
      [
        {
          filename: "b.sql",
          status: "modified",
          additions: 2,
          deletions: 0,
          patch: "@@ -0,0 +1,2 @@\n+CREATE TABLE b (id INT);\n+-- comment",
        },
        {
          filename: "a.sql",
          status: "added",
          additions: 3,
          deletions: 0,
          patch: "@@ -0,0 +1,3 @@\n+CREATE TABLE a (id INT);",
        },
        { filename: "notes.txt", status: "modified", additions: 1, deletions: 0, patch: "+hi" },
      ],
      ["**/*.sql"],
      60_000
    );

    expect(result.matched).toBe(true);
    expect(result.files.map((f) => f.filename)).toEqual(["a.sql", "b.sql"]);
    expect(result.files[1]!.patch).not.toContain("comment");
    expect(result.truncated).toBe(false);
  });

  it("drops the smallest-signal files first when the byte cap is exceeded", () => {
    const bigPatch = "@@ -0,0 +1,1 @@\n+" + "X".repeat(500);
    const smallPatch = "@@ -0,0 +1,1 @@\n+Y";

    const result = buildCompressedDiff(
      [
        { filename: "big.sql", status: "added", additions: 500, deletions: 0, patch: bigPatch },
        { filename: "small.sql", status: "added", additions: 1, deletions: 0, patch: smallPatch },
      ],
      ["**/*.sql"],
      100 // small cap forces a drop
    );

    expect(result.truncated).toBe(true);
    // the larger, more informative change should be the one kept
    expect(result.files.map((f) => f.filename)).toContain("small.sql");
  });
});
