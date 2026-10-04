/**
 * The palette's Everywhere section as markup: which fused rows it shows, how
 * a row is numbered after the local rows, what its reason chips say, and that
 * every server-supplied string is escaped. The DOM half (debounce, abort,
 * focus) is pinned by `e2e/wiki-find-everywhere.spec.ts`.
 */

import { describe, expect, test } from "bun:test";
import { freeText, hasFindFilters } from "./wiki-find.ts";
import {
  FIND_EVERY_FILTERED_NOTE,
  everywhereHref,
  everywherePlan,
  everywhereRows,
  everywhereView,
  findDegradeNote,
  findEverywhereHtml,
  findReasonChipsHtml,
  localReasons,
  markedSnippetHtml,
} from "./wiki-find-view.ts";
import type { FindEverywhereResponse, FindEverywhereResult } from "../../../wiki/find-everywhere.ts";

const SID = "abcdef12-3456-4789-8abc-def012345678";

function row(over: Partial<FindEverywhereResult> = {}): FindEverywhereResult {
  return { wiki: "mimir", relPath: "plans/a.mdx", title: "A", type: "plan", score: 0.03, head: false, legs: {}, ...over };
}

function response(results: FindEverywhereResult[], over: Partial<FindEverywhereResponse["sources"]> = {}): FindEverywhereResponse {
  return {
    q: "q",
    results,
    sources: {
      query: { truncated: false },
      indexes: { ms: 1, skipped: [] },
      text: { status: "ok", ms: 1 },
      huginn: { status: "ok", ms: 1 },
      sessions: { status: "ok", ms: 1 },
      ...over,
    },
  };
}

describe("freeText — what the remote legs are sent", () => {
  test("drops every filter token and keeps the typed spelling", () => {
    expect(freeText('Felles type:plan in:"two words" #tag age:<14 is:retired Kjøring')).toBe("Felles Kjøring");
    expect(freeText('"quoted" #500 foo:bar')).toBe("quoted 500 foo:bar");
    expect(freeText("type:")).toBe("");
  });

  test("a `#<digits>` token keeps its digits; `#` alone and a `#tag` do not reach the legs", () => {
    expect(freeText("#12 review")).toBe("12 review");
    expect(freeText("# review #tag")).toBe("review");
  });
});

describe("everywherePlan — when the section fetches, and on what key", () => {
  test("the key is the free text, so an edit that keeps it keeps the fetch", () => {
    const key = (q: string) => {
      const p = everywherePlan(q, true);
      return p.kind === "fetch" ? p.key : p.kind;
    };
    expect(key("felles wiki")).toBe("felles wiki");
    expect(key("felles wiki ")).toBe("felles wiki");
    expect(key("  felles   wiki")).toBe("felles wiki");
    expect(key('felles "wiki"')).toBe("felles wiki");
  });

  test("any filter token suppresses the section, an unfinished one included", () => {
    for (const q of ["felles type:plan", "felles in:x", "felles series:a", "felles age:<14", "felles #tag", "felles is:retired", "felles type:"]) {
      expect(hasFindFilters(q)).toBe(true);
      expect(everywherePlan(q, true)).toEqual({ kind: "filtered" });
    }
    // A number word and an unknown key are not filters.
    expect(everywherePlan("#12 review", true)).toEqual({ kind: "fetch", key: "12 review" });
    expect(everywherePlan("foo:bar baz", true)).toEqual({ kind: "fetch", key: "foo:bar baz" });
  });

  test("short free text, counted in code points, and an unserved route are off", () => {
    expect(everywherePlan("fe", true)).toEqual({ kind: "off" });
    expect(everywherePlan("😀😀", true)).toEqual({ kind: "off" });
    expect(everywherePlan("😀😀😀", true)).toEqual({ kind: "fetch", key: "😀😀😀" });
    expect(everywherePlan("felles wiki", false)).toEqual({ kind: "off" });
  });

  test("everywhereView joins the plan with the fetch state for ITS key only", () => {
    const done = { key: "felles", status: "done" as const, data: response([]) };
    expect(everywhereView({ kind: "off" }, done)).toBeNull();
    expect(everywhereView({ kind: "filtered" }, done)).toEqual({ kind: "filtered" });
    expect(everywhereView({ kind: "fetch", key: "felles" }, done)).toEqual({ kind: "done", data: done.data });
    expect(everywhereView({ kind: "fetch", key: "other" }, done)).toEqual({ kind: "pending" });
    expect(everywhereView({ kind: "fetch", key: "felles" }, { key: "felles", status: "failed" })).toEqual({ kind: "failed" });
    expect(everywhereView({ kind: "fetch", key: "felles" }, null)).toBeNull();
  });
});

describe("everywhereRows and localReasons", () => {
  const data = response([
    row({ relPath: "plans/local.mdx" }),
    row({ relPath: "plans/far.mdx" }),
    row({ wiki: "kode", relPath: "plans/local.mdx" }),
  ]);

  test("a fused row already shown locally is not repeated; the same path in another wiki is", () => {
    const shown = everywhereRows(data, "mimir", new Set(["plans/local.mdx"]));
    expect(shown.map((r) => `${r.wiki}:${r.relPath}`)).toEqual(["mimir:plans/far.mdx", "kode:plans/local.mdx"]);
  });

  test("local rows get the reasons of the current wiki's fused rows only", () => {
    expect([...localReasons(data, "kode").keys()]).toEqual(["plans/local.mdx"]);
    expect(localReasons(data, "kode").get("plans/local.mdx")!.wiki).toBe("kode");
  });
});

describe("findReasonChipsHtml", () => {
  test("one chip per leg, the session chip carrying its short id, rank and title", () => {
    const html = findReasonChipsHtml(
      row({
        head: true,
        legs: {
          text: { rank: 3 },
          huginn: { rank: 1, snippet: 'a "quoted" <b>' },
          sessions: [{ id: SID, rank: 2, title: "Find <the> page", snippet: { text: "", marks: [] } }],
        },
      }),
    );
    expect(html).toContain(">leg #1<");
    expect(html).toContain(">text #3<");
    expect(html).toContain(">huginn #1<");
    expect(html).toContain(">session abcdef12 #2<");
    expect(html).toContain('title="Session: Find &lt;the&gt; page"');
    expect(html).toContain("&quot;quoted&quot; &lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  test("no legs, no chips", () => {
    expect(findReasonChipsHtml(row())).toBe("");
  });
});

describe("markedSnippetHtml", () => {
  test("escapes the text and wraps only the marked spans", () => {
    expect(markedSnippetHtml({ text: "<x> felles & wiki", marks: [[4, 10], [13, 17]] })).toBe(
      "&lt;x&gt; <mark>felles</mark> &amp; <mark>wiki</mark>",
    );
  });

  test("ignores an overlapping or empty span", () => {
    expect(markedSnippetHtml({ text: "abcdef", marks: [[0, 3], [2, 4], [5, 5]] })).toBe("<mark>abc</mark>def");
  });
});

describe("findEverywhereHtml", () => {
  test("pending, failed and empty states each say so", () => {
    expect(findEverywhereHtml(null, [], 0, 0)).toBe("");
    expect(findEverywhereHtml({ kind: "pending" }, [], 0, 0)).toContain("Searching everywhere…");
    expect(findEverywhereHtml({ kind: "failed" }, [], 0, 0)).toContain("Couldn't search everywhere.");
    expect(findEverywhereHtml({ kind: "done", data: response([]) }, [], 0, 0)).toContain("Nothing more");
    expect(findEverywhereHtml({ kind: "filtered" }, [], 0, 0)).toContain(FIND_EVERY_FILTERED_NOTE);
  });

  test("rows continue the local numbering, link to their wiki, and mark the active one", () => {
    const rows = [row({ wiki: "kode", relPath: "plans/x y.mdx", title: "<T>" }), row({ relPath: "b.md" })];
    const html = findEverywhereHtml({ kind: "done", data: response(rows) }, rows, 4, 5);
    expect(html).toContain('id="wikiFindRow-4"');
    expect(html).toContain('data-find-row="4"');
    expect(html).toContain('data-find-row="5"');
    expect(html).toMatch(/class="wiki-find-row wiki-find-every-row active"[^>]*data-find-row="5"/);
    expect(html).toContain('href="/wiki?wiki=kode&amp;relPath=plans%2Fx%20y.mdx"');
    expect(everywhereHref("kode", "plans/x y.mdx")).toBe("/wiki?wiki=kode&relPath=plans%2Fx%20y.mdx");
    expect(html).toContain("&lt;T&gt;");
    expect(html).toContain('<span class="wiki-find-wiki">kode</span>');
  });

  test("a row shows the first session's snippet, else huginn's", () => {
    const s = row({
      legs: {
        huginn: { rank: 1, snippet: "huginn text" },
        sessions: [{ id: SID, rank: 1, snippet: { text: "felles wiki", marks: [[0, 6]] } }],
      },
    });
    const h = row({ relPath: "h.md", legs: { huginn: { rank: 2, snippet: "huginn text" } } });
    const html = findEverywhereHtml({ kind: "done", data: response([s, h]) }, [s, h], 0, 0);
    expect(html).toContain('<span class="wiki-find-snippet"><mark>felles</mark> wiki</span>');
    expect(html).toContain('<span class="wiki-find-snippet">huginn text</span>');
  });

  test("every failed or unconfigured leg, skipped index and cut query is named in one line", () => {
    const data = response([], {
      text: { status: "error", ms: 1, error: "failed" },
      huginn: { status: "error", ms: 3000, error: "timeout" },
      sessions: { status: "error", ms: 9, error: "HTTP 503" },
      indexes: { ms: 2500, skipped: [{ wiki: "mimir", error: "timeout" }, { wiki: "kode", error: "failed" }] },
      query: { truncated: true },
    });
    expect(findDegradeNote(data)).toBe(
      "Partial results — text search: failed · huginn: timeout · session search: HTTP 503 · mimir index: timeout · kode index: failed · query shortened.",
    );
    expect(findEverywhereHtml({ kind: "done", data }, [], 0, 0)).toContain("data-find-degrade");
    const unconf = response([], {
      huginn: { status: "unconfigured", ms: 0, error: "no wiki collections" },
      sessions: { status: "unconfigured", ms: 0, error: "CLAUDE_USAGE_URL unset" },
    });
    expect(findDegradeNote(unconf)).toBe("Partial results — huginn: no wiki collections · session search: CLAUDE_USAGE_URL unset.");
    expect(findDegradeNote(response([]))).toBe("");
  });
});
