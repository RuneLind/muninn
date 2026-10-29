import { describe, expect, test } from "bun:test";
import type { TouchRecord } from "../git-dates.ts";
import type { WorkThread } from "../work-focus.ts";
import { activePages, buildWorkMapDigest, cleanSessionTitle, parseLogEntries, type DigestInput, type DigestPage } from "./digest.ts";
import { WORK_MAP_VERSION, type WorkMap } from "./schema.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

function page(relPath: string, over: Partial<DigestPage> = {}): DigestPage {
  return { relPath, title: relPath.replace(/^.*\//, "").replace(/\..*$/, ""), type: "plan", ...over } as DigestPage;
}

/** A small synthetic wiki: two efforts' worth of plans, a report, a blog, a
 *  bookkeeping page, an attachment child and an old page. */
function fixture(over: Partial<DigestInput> = {}): DigestInput {
  const pages = [
    page("plans/rail-groups.mdx", { workedMs: NOW - 1 * DAY, plan_status: "in-flight", description: "Group the rail by effort.", series: "rail" }),
    page("archive/rail-groups-report.mdx", { type: "report", gitTouchedMs: NOW - 3 * DAY }),
    page("plans/dark-mode.mdx", { workedMs: NOW - 2 * DAY, movesYou: 2, status_note: "waits on the palette" }),
    page("blogs/dark-mode.mdx", { type: "blog", gitTouchedMs: NOW - 40 * DAY }),
    page("plans/old.mdx", { workedMs: NOW - 60 * DAY, gitTouchedMs: NOW - 50 * DAY }),
    page("log.md", { type: "note", gitTouchedMs: NOW - 1 * DAY }),
    page("plans/rail-groups-prototype.html", { type: "explainer", parent: "plans/rail-groups.mdx", gitTouchedMs: NOW - 1 * DAY }),
  ];
  const threads: WorkThread[] = [
    {
      key: "plans/dark-mode.mdx",
      pages: ["plans/dark-mode.mdx", "blogs/dark-mode.mdx"],
      touched: ["plans/rail-groups-prototype.html"],
      sessions: [{ id: "s1", provider: "claude", first: NOW - 3 * DAY, last: NOW - 2 * DAY, title: "Dark mode <pasted_content x> in /Users/someone/src/app.ts" }],
    },
  ];
  const touches: [string, TouchRecord[]][] = [
    ["plans/rail-groups.mdx", [{ ts: NOW - 5 * DAY, commit: "a", path: "plans/rail-groups.mdx" }, { ts: NOW - 1 * DAY, commit: "b", path: "plans/rail-groups.mdx" }]],
  ];
  return {
    wiki: "fixture",
    nowMs: NOW,
    pages,
    outgoing: new Map([
      ["plans/rail-groups.mdx", ["archive/rail-groups-report.mdx", "plans/old.mdx"]],
      ["blogs/dark-mode.mdx", ["plans/dark-mode.mdx"]],
    ]),
    threads,
    sessionsSinceMs: NOW - 8 * DAY,
    sessionsAsOfMs: NOW,
    gitTouches: new Map(touches),
    logText: [
      "# Activity Log",
      "",
      "## [2026-10-19] build | Rail groups PR 1 merged — [[plans/rail-groups]]",
      "Also touched [[archive/rail-groups-report|the report]] and [[plans/old]].",
      "",
      "## [2026-09-01] build | Too old — [[plans/dark-mode]]",
    ].join("\n"),
    resolveLink: (t) => pages.find((p) => p.relPath.replace(/\.[^.]+$/, "") === t)?.relPath,
    previous: null,
    ...over,
  };
}

describe("buildWorkMapDigest", () => {
  test("lists active pages newest first, with short ids mapped back to relPaths", () => {
    const d = buildWorkMapDigest(fixture());
    expect(d.active).toEqual(["plans/rail-groups.mdx", "plans/dark-mode.mdx", "archive/rail-groups-report.mdx", "blogs/dark-mode.mdx"]);
    expect([...d.rel.entries()]).toEqual([
      ["p1", "plans/rail-groups.mdx"],
      ["p2", "plans/dark-mode.mdx"],
      ["p3", "archive/rail-groups-report.mdx"],
      ["p4", "blogs/dark-mode.mdx"],
    ]);
    expect(d.ids.get("plans/dark-mode.mdx")).toBe("p2");
    // Bookkeeping, an attachment child and an old page get no id.
    expect(d.ids.has("log.md")).toBe(false);
    expect(d.ids.has("plans/rail-groups-prototype.html")).toBe(false);
    expect(d.ids.has("plans/old.mdx")).toBe(false);
  });

  test("the digest's shape: coverage line, pages, threads, log, links", () => {
    const d = buildWorkMapDigest(fixture());
    const lines = d.text.split("\n");
    expect(lines[0]).toStartWith("WIKI: fixture. Now = 2026-10-20T12:00Z. Work threads and session events cover the last 8 days;");
    expect(lines[0]).toContain("worked times are all-time; commit times reach back 28 days; log.md entries 15 days.");
    expect(d.text).toContain(
      'p1 "rail-groups" | plan | status=in-flight | worked=1d | commit=1d | commits28d=2 | series=rail | desc: Group the rail by effort. | path=plans/rail-groups.mdx',
    );
    expect(d.text).toContain('p2 "dark-mode" | plan | waits-on-owner=2 | worked=2d | commit=– | note: waits on the palette | path=plans/dark-mode.mdx');
    // A blog in a thread is active although its commit is 40 days old.
    expect(d.text).toContain("path=blogs/dark-mode.mdx");
    // The thread: a child in it counts for its parent; the title is cleaned.
    expect(d.text).toContain("T1 key=p2 pages=[p2,p4] touched=[p1]\n   session 2d ago: Dark mode in app.ts");
    // Log: only the last 15 days, wikilinks to active pages only.
    expect(d.text).toContain("2026-10-19 build: Rail groups PR 1 merged → [p1,p3]");
    expect(d.text).not.toContain("Too old");
    expect(d.logEntries).toBe(1);
    // Links between active pages only.
    expect(d.text).toContain("## Wikilinks between active pages\np1 → p3\np4 → p2");
    expect(d.text).not.toContain("## The previous map");
  });

  test("the log cap keeps the newest entries even when they are appended at the bottom", () => {
    const old = Array.from({ length: 120 }, (_, i) => `## [2026-10-10] build | Old entry ${i}`);
    const appended = Array.from({ length: 10 }, (_, i) => `## [2026-10-19] fix | Appended entry ${i}`);
    const d = buildWorkMapDigest(fixture({ logText: ["# Activity Log", ...old, ...appended].join("\n") }));
    for (let i = 0; i < 10; i++) expect(d.text).toContain(`2026-10-19 fix: Appended entry ${i} →`);
    expect(d.text).not.toContain("Old entry 119 →");
    expect(d.text).toContain("Old entry 0 →");
    expect(d.logEntries).toBe(120);
    expect(d.logEntriesInWindow).toBe(130);
    expect(d.text.split("\n")[0]).toContain("log.md entries 15 days (the newest 120 of 130 shown)");
    // Newest first in the log section.
    const logSection = d.text.slice(d.text.indexOf("## log.md"));
    expect(logSection.indexOf("Appended entry 0")).toBeLessThan(logSection.indexOf("Old entry 0"));
    expect(buildWorkMapDigest(fixture()).logEntriesInWindow).toBe(1);
  });

  test("a degraded metadata filter is stated in the coverage line", () => {
    const d = buildWorkMapDigest(fixture({ metadataFilter: { degraded: true, reason: "budget" } }));
    expect(d.text.split("\n")[0]).toContain("could not filter out every metadata-only commit (it ran out of time)");
    const s = buildWorkMapDigest(fixture({ metadataFilter: { degraded: true, reason: "steps", pages: 3 } }));
    expect(s.text.split("\n")[0]).toContain("3 page(s) hit the step limit");
    expect(buildWorkMapDigest(fixture({ metadataFilter: { degraded: false } })).text.split("\n")[0]).not.toContain("metadata-only");
  });

  test("the previous map goes in with its ids, names and overlapping pages", () => {
    const previous: WorkMap = {
      version: WORK_MAP_VERSION,
      wiki: "fixture",
      runAtMs: NOW - DAY,
      model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 4, threads: 1, logEntries: 1, digestChars: 1, warnings: [] },
      summary: "",
      needsYou: [],
      themes: [],
      efforts: [
        {
          id: "rail",
          name: "Rail grouping",
          aliases: ["groups"],
          oneLine: "",
          state: "active",
          pages: [{ id: "plans/rail-groups.mdx", role: "plan" }, { id: "plans/gone.mdx", role: "plan" }],
          why: "",
          confidence: 1,
          next: "",
          related: [],
          daily: [],
        },
      ],
      loose: [],
    };
    const d = buildWorkMapDigest(fixture({ previous }));
    expect(d.text).toContain("## The previous map (2026-10-19) — keep an id while its pages overlap\nrail: Rail grouping (groups) — pages [p1] +1 not active now");
  });
});

describe("helpers", () => {
  test("activePages keeps the parent of a child that a thread touched", () => {
    const input = fixture();
    // The parent itself has no recent work: only the thread's touch of its child.
    const only = activePages({ ...input, pages: input.pages.map((p) => (p.relPath === "plans/rail-groups.mdx" ? { ...p, workedMs: undefined } : p)) });
    expect(only.map((p) => p.relPath)).toContain("plans/rail-groups.mdx");
  });
  test("cleanSessionTitle drops pasted blocks and home paths", () => {
    expect(cleanSessionTitle("Fix <pasted_content id=1> /Users/x/y/z.ts now")).toBe("Fix z.ts now");
  });
  test("parseLogEntries reads the entry's first lines and resolves links", () => {
    const e = parseLogEntries("## [2026-10-19] fix | Title — [[a]]\n[[b#x]] and [[missing]]\n", NOW - 15 * DAY, (t) => (t === "missing" ? undefined : `${t}.md`));
    expect(e).toEqual([{ day: "2026-10-19", kind: "fix", title: "Title", pages: ["a.md", "b.md"] }]);
  });
});
