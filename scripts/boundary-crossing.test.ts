import { describe, expect, test } from "bun:test";
import { classifyCommit, classifyFile, graphFromEdges, parseGitLog, summarize } from "./boundary-crossing.ts";

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
  test("name terms are anchored: a folder called components/, shared-*, planner or -article- does not make a file knowledge", () => {
    for (const f of [
      "src/chat/views/components/authed-fetch.ts",
      "src/dashboard/views/components/theme.ts",
      "src/dashboard/views/shared-styles.ts",
      "src/dashboard/views/benchmark/shared.ts",
      "src/chat/planner.ts",
      "src/watchers/__fixtures__/x-feed-article-trq212.md",
    ]) expect([f, classifyFile(f)]).toEqual([f, "other"]);
  });
  test("the anchored terms still match their own files", () => {
    for (const f of [
      "src/dashboard/views/components/share-dialog.ts",
      "src/dashboard/routes/share-sse.ts",
      "scripts/component-reference.ts",
      "src/dashboard/routes/article-routes.ts",
      "src/dashboard/views/plans-page.ts",
      "src/dashboard/views/components/plan-board.ts",
    ]) expect([f, classifyFile(f)]).toEqual([f, "knowledge"]);
  });
  test("live tree: doc-panel (imports summaries) and doc-panel-menu (only sum-article-library imports it) are knowledge", () => {
    for (const f of ["src/dashboard/views/components/doc-panel.ts", "src/dashboard/views/components/doc-panel-menu.ts"])
      expect([f, classifyFile(f)]).toEqual([f, "knowledge"]);
  });
  test("live tree: a component test file is judged by its imports (client-markdown-links.test.ts imports doc-panel)", () => {
    expect(classifyFile("src/dashboard/views/components/client-markdown-links.test.ts")).toBe("knowledge");
  });
  test("live tree: code-tabs, code-block-chrome and copy-path stay other, since chat's web-format-browser uses them", () => {
    for (const f of ["src/dashboard/views/components/code-tabs.ts", "src/dashboard/views/components/code-block-chrome.ts", "src/dashboard/views/components/copy-path.ts"])
      expect([f, classifyFile(f)]).toEqual([f, "other"]);
  });
  describe("component evidence on a synthetic graph", () => {
    const C = "src/dashboard/views/components/";
    const graph = graphFromEdges([
      { from: `${C}a.ts`, to: "src/summaries/x.ts" },
      { from: `${C}b.ts`, to: "src/format/markdown-ast.ts" },
      { from: `${C}wiki-browser.ts`, to: `${C}c.ts` },
      { from: `${C}sum-reader.ts`, to: `${C}c.ts` },
      { from: `${C}wiki-browser.ts`, to: `${C}d.ts` },
      { from: "src/chat/views/components/web-format-browser.ts", to: `${C}d.ts` },
      { from: "src/wiki/store.ts", to: "src/ai/e.ts" },
      { from: `${C}f.ts`, to: "src/watchers/anthropic.ts" },
      { from: `${C}g.ts`, to: `${C}wiki-filter.ts` },
      { from: `${C}h.ts`, to: "src/wiki/store.ts" },
      { from: `${C}wiki-browser.ts`, to: `${C}i.ts` },
      { from: `${C}i.test.ts`, to: `${C}i.ts` },
    ]);
    test("a test file importing it does not count as an importer", () => expect(classifyFile(`${C}i.ts`, graph)).toBe("knowledge"));
    test("a name-only knowledge file outside the components is no evidence", () => expect(classifyFile(`${C}f.ts`, graph)).toBe("other"));
    test("imports a knowledge component or wiki-core: knowledge", () => {
      expect(classifyFile(`${C}g.ts`, graph)).toBe("knowledge");
      expect(classifyFile(`${C}h.ts`, graph)).toBe("knowledge");
    });
    test("imports a knowledge module: knowledge", () => expect(classifyFile(`${C}a.ts`, graph)).toBe("knowledge"));
    test("imports only render: other", () => expect(classifyFile(`${C}b.ts`, graph)).toBe("other"));
    test("every importer is knowledge: knowledge", () => expect(classifyFile(`${C}c.ts`, graph)).toBe("knowledge"));
    test("one importer is not: other", () => expect(classifyFile(`${C}d.ts`, graph)).toBe("other"));
    test("no edges: other", () => expect(classifyFile(`${C}zz.ts`, graph)).toBe("other"));
    test("outside the component folders the rules alone decide", () => expect(classifyFile("src/ai/e.ts", graph)).toBe("other"));
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
    // #800 (e8628a4f), its full file set.
    expect(
      classifyCommit([
        "e2e/session-expiry.spec.ts",
        "src/auth/CLAUDE.md",
        "src/chat/CLAUDE.md",
        "src/chat/views/components/authed-fetch.test.ts",
        "src/chat/views/components/authed-fetch.ts",
      ]),
    ).toBe("other");
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
