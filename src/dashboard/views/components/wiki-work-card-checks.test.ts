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

const checksBody = (over: Partial<WorkMapChecksBody> = {}): WorkMapChecksBody => ({ at: NOW, checked: 3, compared: 0, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [], ...over });
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

  test("no-access names the first repo the login cannot see, as text, in the remedy's form", () => {
    const c = cellHtml(render({ body: checksBody({ checked: 2, unchecked: 3, contradictions: [contradiction], notChecked: { reason: "no-access", repos: ["acme/<first>", "acme/second"] } }) }))!;
    expect(flat(c)).toContain("not checked: your gh login cannot see acme/&lt;first&gt; (gh auth status)");
    expect(c).toContain("<code>gh</code>");
    expect(c).toContain("<code>gh auth status</code>");
    expect(flat(c)).not.toContain("second");
    expect(flat(c)).not.toContain("3 not checked");
    expect(c).toContain("<b>1</b>");
    expect(c).toMatch(/\bwide\b/);
    expect(cellHtml(render({ body: checksBody({ checked: 0, unchecked: 3, notChecked: { reason: "no-access", repos: ["acme/x"] } }) }))).toContain("<b>—</b>");
  });

  describe("a fetch that failed after an answer for this map", () => {
    const body = checksBody({ contradictions: [contradiction], needs: [need()] });

    test("keeps the old count, muted, and says not checked", () => {
      const c = cellHtml(render({ body, failed: true }))!;
      expect(c).toContain("<b>1</b>");
      expect(c).toMatch(/class="wiki-wm-cell muted"/);
      expect(c).not.toMatch(/\bbad\b/);
      expect(flat(c)).toContain("not checked");
    });

    test("during «refreshing» says not checked and not refreshing", () => {
      const c = cellHtml(render({ body: { ...body, refreshing: true }, failed: true, retrying: false }))!;
      expect(flat(c)).toContain("not checked");
      expect(flat(c)).not.toContain("refreshing");
      expect(c).toMatch(/\bmuted\b/);
    });

    test("does not repeat itself beside a remedy, or count what it did not ask", () => {
      const c = flat(cellHtml(render({ body: { ...body, unchecked: 4, notChecked: { reason: "auth", repos: ["acme/x"] } }, failed: true })));
      expect(c.match(/not checked/g)!.length).toBe(1);
      expect(c).toContain("log in with");
      expect(flat(cellHtml(render({ body: { ...body, unchecked: 4 }, failed: true })))).not.toContain("4 not checked");
    });

    test("keeps this map's marks, and its list open", () => {
      const out = render({ body, failed: true }, { open: "github", expanded: false });
      expect(out).toContain("gh-done");
      expect(out).toContain("wiki-wm-drill");
    });

    test("a good answer afterwards is not muted", () => {
      expect(cellHtml(render({ body, failed: false }))).toMatch(/class="wiki-wm-cell bad"/);
    });
  });

  describe("the retries spent with «refreshing» still true", () => {
    const stale = { refreshing: true, contradictions: [contradiction] };

    test("keeps the count, muted, and says not refreshed", () => {
      const c = cellHtml(render({ body: checksBody(stale), retrying: false }))!;
      expect(c).toContain("<b>1</b>");
      expect(c).toMatch(/class="wiki-wm-cell muted"/);
      expect(c).not.toMatch(/\bbad\b/);
      expect(flat(c)).toContain("not refreshed");
      expect(flat(c)).not.toContain("refreshing");
    });

    test("a 0 is no plain 0 either", () => {
      const c = cellHtml(render({ body: checksBody({ refreshing: true }), retrying: false }))!;
      expect(c).toContain("<b>0</b>");
      expect(c).toMatch(/class="wiki-wm-cell muted"/);
      expect(flat(c)).toContain("not refreshed");
    });

    test("while the retries run it stays the live count", () => {
      const c = cellHtml(render({ body: checksBody(stale), retrying: true }))!;
      expect(c).toMatch(/class="wiki-wm-cell bad"/);
      expect(flat(c)).toContain("refreshing");
      expect(flat(c)).not.toContain("not refreshed");
    });

    test("rows unchecked beside it are still counted", () => {
      const c = flat(cellHtml(render({ body: checksBody({ ...stale, unchecked: 2 }), retrying: false })));
      expect(c).toContain("not refreshed");
      expect(c).toContain("2 not checked");
    });

    test("nothing read has no count to call stale", () => {
      const c = cellHtml(render({ body: checksBody({ refreshing: true, checked: 0, unchecked: 2 }), retrying: false }))!;
      expect(c).toContain("<b>—</b>");
      expect(flat(c)).not.toContain("not refreshed");
      expect(flat(c)).toContain("2 not checked");
    });

    test("a remedy for one repo leaves the others' count stale", () => {
      const c = cellHtml(render({ body: checksBody({ ...stale, notChecked: { reason: "auth", repos: ["acme/x"] } }), retrying: false }))!;
      expect(c).toMatch(/class="wiki-wm-cell muted wide"/);
      expect(flat(c)).toContain("log in with");
      expect(flat(c)).toContain("not refreshed");
    });

    test("a failed fetch outranks it", () => {
      const c = flat(cellHtml(render({ body: checksBody(stale), failed: true, retrying: false })));
      expect(c).toContain("not checked");
      expect(c).not.toContain("not refreshed");
    });

    test("an answer with no «refreshing» says nothing of it", () => {
      expect(flat(cellHtml(render({ body: checksBody({ contradictions: [contradiction] }), retrying: false })))).not.toContain("not refreshed");
    });
  });

  describe("nothing read", () => {
    test("0 checked with rows unchecked reads —, muted, with no reason", () => {
      const c = cellHtml(render({ body: checksBody({ checked: 0, unchecked: 85 }) }))!;
      expect(c).toContain("<b>—</b>");
      expect(c).not.toContain("<b>0</b>");
      expect(c).toMatch(/class="wiki-wm-cell muted"/);
      expect(flat(c)).toContain("85 not checked");
    });

    test("a remedy with nothing to count reads —, muted", () => {
      const c = cellHtml(render({ body: checksBody({ checked: 0, unchecked: 0, notChecked: { reason: "auth", repos: ["acme/x"] } }) }))!;
      expect(c).toContain("<b>—</b>");
      expect(c).toMatch(/\bmuted\b/);
    });

    test("0 checked and nothing to check is the plain 0", () => {
      const c = cellHtml(render({ body: checksBody({ checked: 0, unchecked: 0 }) }))!;
      expect(c).toContain("<b>0</b>");
      expect(c).not.toMatch(/\bmuted\b/);
    });

    test("one row read is a real count", () => {
      expect(cellHtml(render({ body: checksBody({ checked: 1, unchecked: 85 }) }))).toContain("<b>0</b>");
    });
  });

  test("disabled: the cell is absent", () => {
    expect(cellHtml(render({ body: checksBody({ notChecked: { reason: "disabled", repos: [] } }) }))).toBeNull();
  });

  describe("the drill list", () => {
    const rowsOf = (out: string) => [...out.matchAll(/<li class="wiki-wm-drill-row">([\s\S]*?)<\/li>/g)].map((m) => flat(m[1]!));
    const groupOf = (out: string, g: string) => new RegExp(`data-wm-gh-group="${g}"[\\s\\S]*?(?=data-wm-gh-group=|$)`).exec(out)?.[0] ?? null;
    const unlinkedRows = Array.from({ length: 9 }, (_, i) => ({ page: "plans/c.mdx", label: `row <${i}>` }));
    const uncheckedRows = [{ page: "plans/b.mdx", pr: 4, repo: "acme/x" }];
    const open = (over: Partial<WorkMapChecksBody>, ghGroups?: StripView["ghGroups"], extra: Partial<ChecksView> = {}) => render({ body: checksBody(over), ...extra }, { open: "github", expanded: false, ...(ghGroups ? { ghGroups } : {}) });

    test("three labelled groups in the slice's order, each with its count", () => {
      const out = open({ contradictions: [contradiction], uncheckedRows, unlinkedRows });
      const text = flat(out);
      const at = ["GitHub contradicts · 1", "Not checked · 1", "No PR link read · 9"].map((label) => text.indexOf(label));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(out).toContain('data-wm-gh-group="contradictions"');
      expect(out).toContain('data-wm-gh-group="unchecked"');
      expect(out).toContain('data-wm-gh-group="unlinked"');
    });

    test("a group is present only when it has rows", () => {
      const only = open({ contradictions: [contradiction] });
      expect(only).toContain('data-wm-gh-group="contradictions"');
      expect(only).not.toContain('data-wm-gh-group="unchecked"');
      expect(only).not.toContain('data-wm-gh-group="unlinked"');
      const noContra = open({ unlinkedRows });
      expect(noContra).not.toContain('data-wm-gh-group="contradictions"');
      expect(noContra).not.toContain('data-wm-gh-group="unchecked"');
      expect(noContra).toContain('data-wm-gh-group="unlinked"');
    });

    test("contradictions are always all shown; the other groups start as one line naming the count", () => {
      const many = Array.from({ length: STRIP_ROWS_SHOWN + 3 }, (_, i) => ({ ...contradiction, pr: i + 1 }));
      const out = open({ contradictions: many, uncheckedRows, unlinkedRows });
      const rows = rowsOf(out);
      expect(rows.length).toBe(many.length);
      expect(rows.every((r) => r.includes("says open"))).toBe(true);
      expect(groupOf(out, "unchecked")).toContain("+1 more");
      expect(groupOf(out, "unlinked")).toContain("+9 more");
      expect(groupOf(out, "unlinked")).toContain('aria-label="+9 more with no PR link read"');
      expect(out).toContain('href="https://github.com/acme/gears/pull/1"');
    });

    test("a line opens its group to the row limit, then +N more shows the rest", () => {
      const window = open({ uncheckedRows, unlinkedRows }, { unlinked: "window" });
      expect(rowsOf(window).length).toBe(STRIP_ROWS_SHOWN);
      expect(rowsOf(window)[0]).toContain("row &lt;0&gt;: no PR link in a column the check reads");
      expect(groupOf(window, "unlinked")).toContain("+1 more");
      expect(groupOf(window, "unchecked")).toContain("+1 more");
      const all = open({ uncheckedRows, unlinkedRows }, { unlinked: "all" });
      expect(rowsOf(all).length).toBe(9);
      expect(groupOf(all, "unlinked")).not.toContain("more");
      expect(flat(open({ uncheckedRows }, { unchecked: "window" }))).toContain("#4 not checked");
    });

    test("the list opens with the counts, before any group, with or without a contradiction", () => {
      const out = open({ checked: 3, compared: 3, unlinkedRows });
      expect(out.indexOf("wiki-wm-drill-counts")).toBeGreaterThan(-1);
      expect(out.indexOf("wiki-wm-drill-counts")).toBeLessThan(out.indexOf("data-wm-gh-group="));
      expect(open({ contradictions: [contradiction], unlinkedRows })).toContain("wiki-wm-drill-counts");
    });

    // The body shapes the earlier sentences were false on: a list states counts and no conclusion.
    const SHAPES: [string, Partial<WorkMapChecksBody>, string][] = [
      ["partly read behind a login", { checked: 1, compared: 0, unchecked: 2, uncheckedRows, notChecked: { reason: "auth", repos: ["acme/x"] } }, "1 checked · 0 with a state to compare · 2 not checked · 0 with no PR link read · 0 skipped"],
      ["nothing comparable beside unlinked rows", { checked: 167, compared: 0, unlinked: 199, unlinkedRows }, "167 checked · 0 with a state to compare · 0 not checked · 199 with no PR link read · 0 skipped"],
      ["some compared", { checked: 3, compared: 2, unchecked: 2, uncheckedRows }, "3 checked · 2 with a state to compare · 2 not checked · 0 with no PR link read · 0 skipped"],
      ["a multi-PR row half answered", { checked: 0, compared: 0, unchecked: 1, uncheckedRows }, "0 checked · 0 with a state to compare · 1 not checked · 0 with no PR link read · 0 skipped"],
      ["no PR link read beside a skipped row", { checked: 0, unlinked: 1, skipped: 1, unlinkedRows }, "0 checked · 0 with a state to compare · 0 not checked · 1 with no PR link read · 1 skipped"],
      ["a remedy", { checked: 0, unlinked: 9, unlinkedRows, notChecked: { reason: "auth", repos: ["acme/x"] } }, "0 checked · 0 with a state to compare · 0 not checked · 9 with no PR link read · 0 skipped"],
    ];
    for (const [name, body, line] of SHAPES) {
      test(`${name}: the list states the counts and concludes nothing`, () => {
        const out = open(body);
        const text = flat(out);
        expect(text).toContain(line);
        expect(text).not.toMatch(/agrees|every (ledger )?row|nothing could|none of|does not contradict|answered for|was read from|has a PR link/i);
      });
    }

    test("the tooltip carries the same counts as the list", () => {
      const c = cellHtml(open({ checked: 3, compared: 2, unlinked: 4, skipped: 1, unlinkedRows }))!;
      expect(/title="([^"]*)"/.exec(c)![1]).toBe("3 checked · 2 with a state to compare · 0 not checked · 4 with no PR link read · 1 skipped");
    });

    describe("on an answer that is not current", () => {
      const LINE = "From the last answer, not current";
      const lineOf = (out: string) => [...out.matchAll(/class="wiki-wm-drill-stale">([^<]*)</g)].map((m) => m[1]);
      const states: [string, Partial<ChecksView>, Partial<WorkMapChecksBody>][] = [
        ["a failed fetch", { failed: true }, {}],
        ["an older map's", { answerRunAt: NOW - 90_000_000 }, {}],
        ["not refreshed", { retrying: false }, { refreshing: true }],
      ];
      const forms: [string, Partial<WorkMapChecksBody>][] = [
        ["contradictions", { contradictions: [contradiction], unlinkedRows }],
        ["rows compared", { compared: 3, unlinkedRows }],
        ["nothing comparable", { compared: 0, unlinkedRows }],
        ["none answered", { checked: 0, unchecked: 2, uncheckedRows }],
        ["nothing read", { checked: 0, unlinked: 9, unlinkedRows, notChecked: { reason: "auth", repos: ["acme/x"] } }],
        ["no link read", { checked: 0, unlinked: 9, unlinkedRows }],
      ];
      for (const [state, view, body] of states) {
        test.each(forms)(`${state}, %s: one line opens the list and no sentence has a prefix`, (_form, over) => {
          const out = open({ ...over, ...body }, undefined, view);
          expect(lineOf(out)).toEqual([LINE]);
          const at = out.indexOf("wiki-wm-drill-stale");
          expect(at).toBeGreaterThan(out.indexOf("wiki-wm-drill-title"));
          expect(at).toBeLessThan(out.indexOf("data-wm-gh-group="));
          const clear = out.indexOf("wiki-wm-drill-counts");
          if (clear >= 0) expect(at).toBeLessThan(clear);
          expect(out).not.toMatch(/In the last answer|gitHub/);
        });
        test(`${state}: the tooltip opens with the same words`, () => {
          const c = cellHtml(render({ body: checksBody({ unlinked: 1, skipped: 2, ...body }), ...view }))!;
          expect(/title="([^"]*)"/.exec(c)![1]).toBe(`${LINE} · 3 checked · 0 with a state to compare · 0 not checked · 1 with no PR link read · 2 skipped`);
        });
      }
      test("a current answer has neither, nor has one still refreshing", () => {
        for (const view of [{ body: checksBody({ compared: 3, unlinkedRows }) }, { body: checksBody({ refreshing: true, compared: 3, unlinkedRows }), retrying: true }]) {
          const out = render(view, { open: "github", expanded: false });
          expect(lineOf(out)).toEqual([]);
          expect(/title="([^"]*)"/.exec(cellHtml(out)!)![1]).toMatch(/^3 checked/);
        }
      });
    });

    test("only skipped rows are no plain 0", () => {
      const c = cellHtml(render({ body: checksBody({ checked: 0, skipped: 4 }) }))!;
      expect(c).toContain("<b>—</b>");
      expect(c).toMatch(/class="wiki-wm-cell muted"/);
      expect(flat(c)).toContain("4 skipped");
    });

    test("the cell says what it counts, one row or many", () => {
      const label = (over: Partial<WorkMapChecksBody>) => /data-wm-cell="github"[^>]*><b>[^<]*<\/b><span>([^<]*)</.exec(render({ body: checksBody(over) }))![1];
      expect(label({ contradictions: [contradiction] })).toBe("PR row out of date");
      expect(label({ contradictions: [contradiction, { ...contradiction, pr: 8 }] })).toBe("PR rows out of date");
      expect(label({ contradictions: [] })).toBe("PR rows out of date");
    });

    test("with no count to read, the cell keeps the plural label", () => {
      const labelOf = (checks: Parameters<typeof render>[0]) => /<\/b><span>([^<]*)</.exec(cellHtml(render(checks))!)![1];
      expect(labelOf({ body: null })).toBe("PR rows out of date");
      expect(labelOf({ body: null, failed: true })).toBe("PR rows out of date");
      expect(labelOf({ body: checksBody({ checked: 0, unlinked: 9, unlinkedRows: [] }) })).toBe("PR rows out of date");
    });

    test("the list's title promises no contradiction", () => {
      const out = open({ checked: 0, unlinked: 9, unlinkedRows });
      expect(/wiki-wm-drill-title">([^<]*)</.exec(out)![1]).toBe("What the GitHub check found in the PR rows");
    });

    test("rows with no PR link read and nothing else read are not an all-clear", () => {
      const out = open({ checked: 0, unchecked: 0, unlinked: 197, unlinkedRows });
      const c = cellHtml(out)!;
      expect(c).toContain("<b>—</b>");
      expect(c).not.toContain("<b>0</b>");
      expect(c).toMatch(/class="wiki-wm-cell muted( on)?"/);
      expect(flat(c)).toContain("197 with no PR link read");
      expect(c).not.toContain(" disabled");
      expect(flat(out)).toContain("0 checked · 0 with a state to compare · 0 not checked · 197 with no PR link read · 0 skipped");
    });

    test("rows read beside the unlinked ones stay the plain count", () => {
      const c = cellHtml(open({ checked: 5, unlinked: 197, unlinkedRows }))!;
      expect(c).toContain("<b>0</b>");
      expect(c).not.toMatch(/\bmuted\b/);
      expect(c).not.toContain(" disabled");
    });
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

  describe("on an answer GitHub did not just confirm", () => {
    test("«closed without merge» goes: a closed PR can reopen", () => {
      expect(needGhMarks([need({ state: "CLOSED", mergedAt: null })], true)).toEqual({ struck: false, notes: [] });
    });

    test("«#2 open» goes: an open PR can merge; the merged one's note stays and nothing strikes", () => {
      const m = needGhMarks([need({ pr: 1 }), need({ pr: 2, state: "OPEN", mergedAt: null })], true);
      expect(m.struck).toBe(false);
      expect(m.notes.map((n) => n.text.replace(/ \d+\.10/, ""))).toEqual(["GitHub: #1 merged"]);
    });

    test("a merged strike stays: a merge is final", () => {
      const m = needGhMarks([need()], true);
      expect(m.struck).toBe(true);
      expect(m.notes).toEqual([{ tone: "done", text: expect.stringMatching(/this step is done$/) }]);
    });

    test("a merged note stays", () => {
      expect(needGhMarks([need({ asksForIt: false })], true).notes.map((n) => n.tone)).toEqual(["info"]);
    });

    test("«not checked» stays: it says the answer is missing", () => {
      expect(needGhMarks([need({ pr: 1 }), need({ pr: 2, state: null, mergedAt: null })], true).notes.map((n) => n.text.replace(/ \d+\.10/, ""))).toEqual(["GitHub: #1 merged", "GitHub: #2 not checked"]);
    });
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

  describe("when the last fetch failed or was not refreshed", () => {
    const needs = [need(), need({ title: "First", kind: "decision", pr: 7, state: "CLOSED", mergedAt: null, asksForIt: false })];

    test.each<[string, Partial<ChecksView>, Partial<WorkMapChecksBody>]>([
      ["failed", { failed: true }, {}],
      ["not refreshed", { retrying: false }, { refreshing: true }],
    ])("%s: the closed note goes and the merged strike stays", (_name, view, over) => {
      const out = render({ body: checksBody({ needs, ...over }), ...view });
      expect(out).not.toContain("closed without merge");
      expect(out).toContain("gh-done");
      expect(out).toContain("this step is done");
    });

    test("while the retries run, or on a good answer, it stays", () => {
      expect(render({ body: checksBody({ needs, refreshing: true }), retrying: true })).toContain("closed without merge");
      expect(render({ body: checksBody({ needs }) })).toContain("closed without merge");
    });
  });

  test("a mark for a title the map no longer holds lands nowhere", () => {
    expect(render({ body: checksBody({ needs: [need({ title: "Gone" })] }) })).not.toContain("wiki-wm-ghnote");
  });
});
