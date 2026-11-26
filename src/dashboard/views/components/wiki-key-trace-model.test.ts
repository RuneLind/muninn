import { expect, test } from "bun:test";
import { PEEK_FILES_MAX, keyPeekHtml, traceBodyHtml, traceTimelineHtml, traceTurnHtml } from "./wiki-key-trace-model.ts";
import type { MentionsBody } from "../../../wiki/mentions.ts";

const body = (over: Partial<MentionsBody> = {}): MentionsBody => ({
  key: "MEL-77",
  kind: "case",
  files: Array.from({ length: 6 }, (_, i) => ({ relPath: `plans/p${i}.mdx`, title: i === 0 ? "Ferry <plan>" : null, lines: [{ n: i + 1, text: `MEL-77 line ${i}` }] })),
  commits: [
    { sha: "aaaaaaa1111", date: "2026-11-02T10:00:00Z", subject: "Older commit", files: ["plans/p1.mdx"] },
    { sha: "bbbbbbb2222", date: "2026-11-20T10:00:00Z", subject: "Newer commit", files: ["plans/p0.mdx"] },
  ].reverse(),
  log: [{ date: "2026-11-10", kind: "plan", line: "- MEL-77 filed", n: 9 }],
  prs: [
    { repo: "acme/acme-api", number: 3, state: "merged", mergedAt: "2026-11-15T08:00:00Z", url: "https://github.com/acme/acme-api/pull/3", stale: false },
    { repo: "acme/acme-web", number: 4, state: "not-checked", mergedAt: null, url: "https://github.com/acme/acme-web/pull/4", stale: false, reason: "sso" },
  ],
  totalLines: 40,
  totalFiles: 9,
  totalsAtLeast: true,
  truncated: true,
  ...over,
});

test("the peek reads the route's totals (not the listed lines), the last change, a few files, PR states with a reason, and «Trace»", () => {
  const html = keyPeekHtml(body(), { trace: true });
  expect(html).toContain("40+ lines in 9+ files · last changed 2026-11-20 · 1 log.md line");
  expect(html).toContain("Ferry &lt;plan&gt;");
  expect(html.match(/<li>/g)!.length).toBe(PEEK_FILES_MAX);
  expect(html).toContain("and 5+ more");
  expect(html).toContain('<span data-pr-state="merged">acme-api#3 merged</span>');
  expect(html).toContain("acme-web#4 not checked (sso)");
  expect(html).toContain('data-key-trace="MEL-77"');
  expect(keyPeekHtml(body({ files: [], totalFiles: 0, totalLines: 0, totalsAtLeast: false }), { trace: false })).toContain("Named in no tracked file.");
});

test("the timeline: commits, log lines and merged PRs, newest first", () => {
  const html = traceTimelineHtml(body());
  const kinds = [...html.matchAll(/data-trace-ev="(\w+)"><span class="wiki-sel-d">([\d-]+)/g)].map((m) => `${m[2]} ${m[1]}`);
  expect(kinds).toEqual(["2026-11-20 commit", "2026-11-15 pr", "2026-11-10 log", "2026-11-02 commit"]);
  expect(traceTimelineHtml(body({ commits: [], log: [], prs: [] }))).toContain("No commit, log.md line or merged PR");
});

test("the Trace body: mentions and timeline at once; the discussion controls only with an agent", () => {
  const opts = { currentRelPath: "plans/p0.mdx", hrefFor: (r: string) => `/wiki?relPath=${r}` };
  const on = traceBodyHtml(body(), { ...opts, agent: true });
  expect(on).toContain('data-trace-sec="mentions"');
  expect(on).toContain('data-trace-sec="timeline"');
  expect(on).toContain("data-trace-summarize");
  expect(on).toContain("data-trace-continue");
  // PR rows are under the timeline only.
  expect(on.split("wiki-sel-prs").length - 1).toBe(1);
  const off = traceBodyHtml(body(), { ...opts, agent: false });
  expect(off).not.toContain("data-trace-summarize");
});

test("a turn: the question escaped, a status while it runs, an error as an alert", () => {
  expect(traceTurnHtml({ question: "<q>", answerHtml: "", state: "running", status: "Working: mentions", turnId: null })).toContain("&lt;q&gt;");
  expect(traceTurnHtml({ question: "q", answerHtml: "", state: "running", status: "Working: mentions" })).toContain("Working: mentions");
  expect(traceTurnHtml({ question: "q", answerHtml: "nope", state: "error", turnId: "t1" })).toContain('role="alert">nope');
});
