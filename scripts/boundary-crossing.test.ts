import { describe, expect, test } from "bun:test";
import { classifyCommit, classifyFile, parseGitLog, summarize } from "./boundary-crossing.ts";

describe("classifyFile", () => {
  test("knowledge: wiki-core and render layers, capture verticals, wiki files in mixed folders", () => {
    for (const f of [
      "src/wiki/store.ts",
      "src/format/question.ts",
      "src/web/web-format.ts",
      "src/gardener/runner.ts",
      "src/youtube/probe.ts",
      "src/dashboard/views/wiki-browser.ts",
      "src/dashboard/views/components/sum-reader.ts",
      "src/watchers/wiki-linter.ts",
      "e2e/wiki-find.spec.ts",
      "scripts/wiki-check.ts",
      "db/migrations/090-wiki-proposals.sql",
    ]) expect([f, classifyFile(f)]).toEqual([f, "knowledge"]);
  });
  test("other: chat, ai, auth, non-wiki dashboard and watcher files", () => {
    for (const f of ["src/ai/executor.ts", "src/chat/routes.ts", "src/auth/origin.ts", "src/dashboard/views/agents-page.ts", "src/watchers/email.ts", "e2e/chat.spec.ts", "db/init.sql"])
      expect([f, classifyFile(f)]).toEqual([f, "other"]);
  });
  test("neutral: shared registries, instructions, root config", () => {
    for (const f of [
      "package.json",
      "bun.lock",
      "CLAUDE.md",
      "src/wiki/CLAUDE.md",
      "src/wiki/reference/notes.md",
      ".github/workflows/ci.yml",
      "e2e/ports.ts",
      "scripts/unit-shards.json",
      "src/test/ambient-env.ts",
      "src/auth/chat-page-zone-inventory.txt",
      "src/dashboard/route-groups.ts",
    ]) expect([f, classifyFile(f)]).toEqual([f, "neutral"]);
  });
});

describe("classifyCommit", () => {
  test("both sides is a crossing; neutral files never decide", () => {
    expect(classifyCommit(["src/wiki/store.ts", "src/ai/executor.ts"])).toBe("crossing");
    expect(classifyCommit(["src/wiki/store.ts", "package.json", "CLAUDE.md"])).toBe("knowledge");
    expect(classifyCommit(["src/ai/executor.ts", "e2e/ports.ts"])).toBe("other");
    expect(classifyCommit(["package.json"])).toBe("neutral");
    expect(classifyCommit([])).toBe("neutral");
  });
});

describe("parseGitLog and summarize", () => {
  const log = [
    "\u0001aaaa1111 Add a wiki thing (#1)",
    "",
    "src/wiki/store.ts",
    "src/ai/executor.ts",
    "",
    "\u0001bbbb2222 Wiki only (#2)",
    "",
    "src/wiki/lint.ts",
    "\u0001cccc3333 Bump deps",
    "",
    "package.json",
    "\u0001dddd4444 Chat only",
    "",
    "src/chat/routes.ts",
    "",
  ].join("\n");

  test("one commit per marker, with its subject and files", () => {
    const commits = parseGitLog(log);
    expect(commits.map((c) => c.sha)).toEqual(["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"]);
    expect(commits[0]).toEqual({ sha: "aaaa1111", subject: "Add a wiki thing (#1)", files: ["src/wiki/store.ts", "src/ai/executor.ts"] });
  });

  test("the share leaves neutral-only commits out of the denominator", () => {
    expect(summarize(parseGitLog(log))).toEqual({ commits: 4, knowledge: 1, other: 1, crossing: 1, neutral: 1, crossingShare: 1 / 3 });
  });

  test("an empty range has share 0", () => {
    expect(summarize([]).crossingShare).toBe(0);
  });
});
