import { describe, expect, test } from "bun:test";
import type { ChecksNeed, WorkMapChecksBody } from "../../../wiki/work-map/gh-check.ts";
import { WORK_MAP_VERSION, type WorkMap } from "../../../wiki/work-map/schema.ts";
import { needGhMarks, STRIP_ROWS_SHOWN, workCardHtml, type ChecksView, type StripView } from "./wiki-work-card.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const PAGES = [
  { relPath: "plans/a.mdx", title: "Plan A" },
  { relPath: "plans/b.mdx", title: "Plan B" },
  { relPath: "plans/c.mdx", title: "Plan C" },
];
const href = (rel: string) => `/wiki?relPath=${encodeURIComponent(rel)}`;

const map = (): WorkMap =>
  ({
    version: WORK_MAP_VERSION,
    wiki: "w",
    runAtMs: NOW - 3_600_000,
    model: "m",
    coverage: { sessionsSinceMs: NOW, sessionsAsOfMs: NOW, touchWindowDays: 28, activePages: 1, threads: 1, logEntries: 0, digestChars: 0, warnings: [] },
    summary: "",
    needsYou: [
      { title: "First", kind: "decision", why: "", action: "Pick one", pages: [] },
      { title: "Second", kind: "followup", why: "", action: "Merge #369", pages: [] },
    ],
    themes: [],
    efforts: [],
    loose: [],
  }) as unknown as WorkMap;

const checksBody = (over: Partial<WorkMapChecksBody> = {}): WorkMapChecksBody => ({ at: NOW, checked: 3, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [], ...over });
/** An answer is for the map on the card unless a test says otherwise. */
const render = (checks?: Omit<ChecksView, "answerRunAt"> & { answerRunAt?: number | null }, strip?: StripView) =>
  workCardHtml({ body: { map: map(), organizable: false }, pages: PAGES, now: NOW, done: new Set(), hrefFor: href, refresh: { phase: "idle" }, waitsCounted: true, ...(checks ? { checks: { answerRunAt: map().runAtMs, ...checks } } : {}), ...(strip ? { strip } : {}) });
const cellHtml = (out: string) => /<button[^>]*data-wm-cell="github"[\s\S]*?<\/button>/.exec(out)?.[0] ?? null;
const flat = (s: string | null) => (s ?? "").replace(/<[^>]+>/g, "");
const contradiction = { page: "plans/a.mdx", pr: 12, repo: "acme/gears", rowState: "open", ghState: "MERGED" as const, mergedAt: "2026-10-29T12:00:00Z" };
const need = (over: Partial<ChecksNeed> = {}): ChecksNeed => ({ kind: "followup", title: "Second", pr: 369, state: "MERGED", mergedAt: "2026-10-29T12:00:00Z", asksForIt: true, ...over });

describe("the GitHub cell", () => {
  test("no view leaves the four cells; a view adds the fifth", () => {
    expect(cellHtml(render())).toBeNull();
    expect(render().match(/data-wm-cell=/g)!.length).toBe(4);
    expect(render({ body: checksBody() }).match(/data-wm-cell=/g)!.length).toBe(5);
  });

  test("before the first answer it reads checking… in the muted tone, disabled", () => {
    const c = cellHtml(render({ body: null }))!;
    expect(c).toContain("<b>checking…</b>");
    expect(c).toMatch(/class="wiki-wm-cell muted unset"/);
    expect(c).toContain(" disabled");
  });

  test("a failed fetch says nothing about any PR", () => {
    expect(flat(cellHtml(render({ body: null, failed: true })))).toContain("not checked");
  });

  test("a count above 0 is the bad tone; 0 with nothing to list is disabled", () => {
    expect(cellHtml(render({ body: checksBody({ contradictions: [contradiction] }) }))).toMatch(/class="wiki-wm-cell bad"[^>]*><b>1<\/b>/);
    const zero = cellHtml(render({ body: checksBody() }))!;
    expect(zero).toContain("<b>0</b>");
    expect(zero).toContain(" disabled");
  });

  test("while refreshing it shows the count with a suffix; after the last fetch the suffix goes and the unchecked show", () => {
    const body = checksBody({ refreshing: true, unchecked: 2 });
    expect(flat(cellHtml(render({ body, retrying: true })))).toContain("refreshing");
    expect(flat(cellHtml(render({ body, retrying: true })))).not.toContain("not checked");
    const after = flat(cellHtml(render({ body, retrying: false })));
    expect(after).not.toContain("refreshing");
    expect(after).toContain("2 not checked");
    expect(flat(cellHtml(render({ body: checksBody({ refreshing: true }), retrying: false })))).not.toContain("not checked");
  });

  test.each([
    ["no-gh", "not checked: install gh"],
    ["auth", "not checked: log in with gh auth login"],
    ["sso", "not checked: authorize the token for the organization (gh auth refresh)"],
  ] as const)("notChecked %s reads as its remedy, and the other repos' counts still show", (reason, text) => {
    const c = cellHtml(render({ body: checksBody({ notChecked: { reason, repos: ["acme/gears"] }, contradictions: [contradiction] }) }));
    expect(flat(c)).toContain(text);
    expect(c).toContain("<b>1</b>");
    expect(c).toMatch(/\bwide\b/);
    // Nothing read: no count to claim.
    expect(cellHtml(render({ body: checksBody({ checked: 0, unchecked: 2, notChecked: { reason, repos: ["acme/gears"] } }) }))).toContain("<b>—</b>");
  });

  test("disabled: the cell is absent", () => {
    expect(cellHtml(render({ body: checksBody({ notChecked: { reason: "disabled", repos: [] } }) }))).toBeNull();
  });

  test("the drill list: contradictions first, then the unchecked and unlinked rows, folded at the row limit", () => {
    const body = checksBody({
      contradictions: [contradiction],
      uncheckedRows: [{ page: "plans/b.mdx", pr: 4, repo: "acme/x" }],
      unlinkedRows: Array.from({ length: 9 }, (_, i) => ({ page: "plans/c.mdx", label: `row <${i}>` })),
    });
    const out = render({ body }, { open: "github", expanded: false });
    const rows = [...out.matchAll(/<li class="wiki-wm-drill-row">([\s\S]*?)<\/li>/g)].map((m) => flat(m[1]!));
    expect(rows.length).toBe(STRIP_ROWS_SHOWN);
    expect(rows[0]).toMatch(/Plan A.*says open.*GitHub: #12 merged \d+\.10/);
    expect(rows[1]).toMatch(/Plan B.*#4 not checked/);
    expect(rows[2]).toContain("no full PR link");
    expect(out).toContain("&lt;0&gt;");
    expect(out).toContain('href="https://github.com/acme/gears/pull/12"');
    expect(out).toContain("+3 more");
    expect(render({ body }, { open: "github", expanded: true })).not.toContain("+3 more");
  });

  test("a cell open while its list empties renders no list", () => {
    const out = render({ body: checksBody() }, { open: "github", expanded: false });
    expect(out).not.toContain("wiki-wm-drill");
    expect(cellHtml(out)).toContain('aria-expanded="false"');
  });
});

describe("needGhMarks", () => {
  test("merged and asked for: struck, this step is done", () => {
    const m = needGhMarks([need()]);
    expect(m.struck).toBe(true);
    expect(m.notes).toEqual([{ tone: "done", text: expect.stringMatching(/^GitHub: #369 merged \d+\.10, this step is done$/) }]);
  });

  test("closed without merge: a warning, not struck, whether asked or mentioned", () => {
    for (const asksForIt of [true, false]) expect(needGhMarks([need({ state: "CLOSED", mergedAt: null, asksForIt })])).toEqual({ struck: false, notes: [{ tone: "warn", text: "GitHub: #369 closed without merge" }] });
  });

  test("only mentioned: a neutral note", () => {
    const m = needGhMarks([need({ asksForIt: false, pr: 3556 })]);
    expect(m.struck).toBe(false);
    expect(m.notes).toEqual([{ tone: "info", text: expect.stringMatching(/^GitHub: #3556 merged \d+\.10$/) }]);
  });

  test("one open PR: nothing to say", () => {
    expect(needGhMarks([need({ state: "OPEN", mergedAt: null })])).toEqual({ struck: false, notes: [] });
  });

  test("two PRs, one merged and one open: each gets its note, not struck", () => {
    const m = needGhMarks([need({ pr: 1 }), need({ pr: 2, state: "OPEN", mergedAt: null })]);
    expect(m.struck).toBe(false);
    expect(m.notes.map((n) => [n.tone, n.text.replace(/ \d+\.10/, "")])).toEqual([["info", "GitHub: #1 merged"], ["info", "GitHub: #2 open"]]);
  });

  test("two PRs both merged: struck", () => {
    expect(needGhMarks([need({ pr: 1 }), need({ pr: 2 })]).struck).toBe(true);
  });

  test("a PR whose state is unknown keeps the item open", () => {
    const m = needGhMarks([need({ pr: 1 }), need({ pr: 2, state: null, mergedAt: null })]);
    expect(m.struck).toBe(false);
    expect(m.notes.map((n) => n.text.replace(/ \d+\.10/, ""))).toEqual(["GitHub: #1 merged", "GitHub: #2 not checked"]);
    expect(needGhMarks([need({ state: null, mergedAt: null })])).toEqual({ struck: false, notes: [] });
  });

  test("no entries: nothing", () => {
    expect(needGhMarks([])).toEqual({ struck: false, notes: [] });
  });
});

describe("an answer for an older map", () => {
  const older = { answerRunAt: map().runAtMs - 1 };
  const out = (over: Partial<ChecksView> = {}) => render({ body: checksBody({ contradictions: [contradiction], needs: [need()] }), ...older, ...over });

  test("marks no item, whatever it says about a title the new map shares", () => {
    for (const html of [out(), out({ retrying: true }), out({ failed: true })]) {
      expect(html).not.toContain("wiki-wm-ghnote");
      expect(html).not.toContain("gh-done");
    }
  });

  test("still gives the cell its count, muted, and says where the new answer stands", () => {
    const pending = cellHtml(out({ retrying: true }))!;
    expect(pending).toContain("<b>1</b>");
    expect(pending).toMatch(/class="wiki-wm-cell muted"/);
    expect(flat(pending)).toContain("checking…");
    expect(flat(cellHtml(out({ failed: true })))).toContain("not checked");
  });

  test("the answer for this map marks as before", () => {
    expect(render({ body: checksBody({ needs: [need()] }), answerRunAt: map().runAtMs })).toContain("gh-done");
  });
});

describe("marks on the items", () => {
  test("they land on the item whose kind and title match, the ✓ kept", () => {
    const out = render({ body: checksBody({ needs: [need()] }) });
    const first = /data-wm-need="0"[\s\S]*?data-wm-need="1"/.exec(out)![0];
    expect(first).not.toContain("wiki-wm-ghnote");
    expect(out).toContain('class="wiki-wm-need gh-done" data-wm-need="1"');
    expect(out).toMatch(/<div class="wiki-wm-ghnote done">GitHub: #369 merged \d+\.10, this step is done<\/div>/);
    expect(out).toContain('data-wm-done="1"');
  });

  test("a mark for a title the map no longer holds lands nowhere", () => {
    expect(render({ body: checksBody({ needs: [need({ title: "Gone" })] }) })).not.toContain("wiki-wm-ghnote");
  });
});
