/**
 * The palette's Everywhere section as markup: which fused rows it shows, how
 * a row is numbered after the local rows, what its reason chips say, and that
 * every server-supplied string is escaped. The DOM half (debounce, abort,
 * focus) is pinned by `e2e/wiki-find-everywhere.spec.ts`.
 */

import { describe, expect, test } from "bun:test";
import { freeText } from "./wiki-find.ts";
import {
  everywhereHref,
  everywhereRows,
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
    sources: { text: { status: "ok", ms: 1 }, huginn: { status: "ok", ms: 1 }, sessions: { status: "ok", ms: 1 }, ...over },
  };
}

describe("freeText — what the remote legs are sent", () => {
  test("drops every filter token and keeps the typed spelling", () => {
    expect(freeText('Felles type:plan in:"two words" #tag age:<14 is:retired Kjøring')).toBe("Felles Kjøring");
    expect(freeText('"quoted" #500 foo:bar')).toBe("quoted 500 foo:bar");
    expect(freeText("type:")).toBe("");
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
    expect(findEverywhereHtml({ q: "q", status: "pending" }, [], 0, 0)).toContain("Searching everywhere…");
    expect(findEverywhereHtml({ q: "q", status: "failed" }, [], 0, 0)).toContain("Couldn't search everywhere.");
    expect(findEverywhereHtml({ q: "q", status: "done", data: response([]) }, [], 0, 0)).toContain("Nothing more");
  });

  test("rows continue the local numbering, link to their wiki, and mark the active one", () => {
    const rows = [row({ wiki: "kode", relPath: "plans/x y.mdx", title: "<T>" }), row({ relPath: "b.md" })];
    const html = findEverywhereHtml({ q: "q", status: "done", data: response(rows) }, rows, 4, 5);
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
    const html = findEverywhereHtml({ q: "q", status: "done", data: response([s, h]) }, [s, h], 0, 0);
    expect(html).toContain('<span class="wiki-find-snippet"><mark>felles</mark> wiki</span>');
    expect(html).toContain('<span class="wiki-find-snippet">huginn text</span>');
  });

  test("a failed or unconfigured leg is named in one line", () => {
    const data = response([], { huginn: { status: "error", ms: 3000, error: "x" }, sessions: { status: "unconfigured", ms: 0 } });
    expect(findDegradeNote(data)).toBe("Partial results — huginn unavailable · session search not configured.");
    expect(findEverywhereHtml({ q: "q", status: "done", data }, [], 0, 0)).toContain("data-find-degrade");
    expect(findDegradeNote(response([]))).toBe("");
  });
});
