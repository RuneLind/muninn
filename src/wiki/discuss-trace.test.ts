import { describe, expect, test } from "bun:test";
import { PACK_SECTION_MAX } from "./discuss-pack.ts";
import { renderTraceTurnPrompt, traceContextPack } from "./discuss-trace.ts";
import type { MentionsBody } from "./mentions.ts";

const body = (over: Partial<MentionsBody> = {}): MentionsBody => ({
  key: "MEL-77",
  kind: "case",
  files: [{ relPath: "plans/ferry.mdx", title: "Ferry plan", lines: [{ n: 12, text: "The ferry case MEL-77 is open." }] }],
  commits: [{ sha: "abcdef0123456789", date: "2026-11-20T10:00:00+01:00", subject: "Ferry plan names MEL-77", files: ["plans/ferry.mdx"] }],
  log: [{ date: "2026-11-20", kind: "plan", line: "- MEL-77 was filed.", n: 40 }],
  prs: [
    { repo: "acme/acme-api", number: 3, state: "merged", mergedAt: "2026-11-21T08:00:00Z", url: "https://github.com/acme/acme-api/pull/3", stale: false },
    { repo: "acme/acme-web", number: 4, state: "not-checked", mergedAt: null, url: "https://github.com/acme/acme-web/pull/4", stale: false, reason: "sso" },
  ],
  totalLines: 3,
  totalFiles: 2,
  totalsAtLeast: false,
  truncated: true,
  ...over,
});

describe("traceContextPack", () => {
  test("the key, the totals from the route's counts, each file's lines, commits, log lines and PR states", () => {
    const pack = traceContextPack("kode", body()).join("\n");
    expect(pack).toContain("Key: MEL-77 (kind: case)");
    expect(pack).toContain("Mentioned on 3 lines in 2 files git tracks; not all of them are listed below.");
    expect(pack).toContain("- plans/ferry.mdx «Ferry plan»\n  12: The ferry case MEL-77 is open.");
    expect(pack).toContain("- 2026-11-20 abcdef0123 Ferry plan names MEL-77 (plans/ferry.mdx)");
    expect(pack).toContain("- log.md:40 [2026-11-20 plan] - MEL-77 was filed.");
    expect(pack).toContain("- acme/acme-api#3: merged 2026-11-21");
    expect(pack).toContain("- acme/acme-web#4: not checked (sso)");
  });

  test("a key no file names, with no kind and lower-bound totals", () => {
    const pack = traceContextPack("mimir", body({ kind: null, files: [], commits: [], log: [], prs: [], totalLines: 0, totalFiles: 0, totalsAtLeast: true, truncated: false })).join("\n");
    expect(pack).toContain("Key: MEL-77\n");
    expect(pack).toContain("at least 0 lines in at least 0 files");
    expect(pack).toContain("(no tracked file names it)");
  });

  test("a section is cut at the pack bound with a note of what was left out", () => {
    const lines = Array.from({ length: 400 }, (_, i) => ({ n: i + 1, text: `MEL-77 ${"x".repeat(200)}` }));
    const pack = traceContextPack("kode", body({ files: [{ relPath: "a.md", title: null, lines }] }));
    const files = pack.slice(pack.indexOf("## Where it is mentioned") + 1, pack.indexOf("## Commits that changed how often it occurs (newest first)") - 1);
    expect(files.join("\n").length).toBeLessThanOrEqual(PACK_SECTION_MAX + 40);
    expect(files.at(-1)).toMatch(/^- … \d+ more lines cut$/);
  });
});

test("renderTraceTurnPrompt: pack, reach with citations on the first file, the discussion so far, the question last", () => {
  const prompt = renderTraceTurnPrompt({
    wiki: "kode",
    mentions: body(),
    reach: { kind: "readSearch", wikiSnapshot: "/snap/w1", repos: [], missed: [], own: [] },
    earlier: [{ question: "Summarize", selection: null, answer: "It is a ferry case.", endState: "done" }],
    question: "Where else?",
  });
  expect(prompt.indexOf("## The key")).toBe(0);
  expect(prompt).toContain("e.g. `plans/ferry.mdx:12`");
  expect(prompt).toContain("## The discussion so far\nQuestion: Summarize\nAnswer: It is a ferry case.");
  expect(prompt.endsWith("## Question\nWhere else?")).toBe(true);
  expect(prompt).not.toContain("## The page");
});
