/**
 * The GitHub check against real temp wikis read through the real index, with a
 * stubbed `gh`. Repo names are made up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { getWikiIndex, readWikiPage } from "../store.ts";
import { needGhMarks } from "../../dashboard/views/components/wiki-work-card.ts";
import {
  __resetGhCheckForTest,
  checkWorkMapPrs,
  GH_PRS_PER_HOUR,
  GH_PRS_PER_QUERY,
  GH_QUERIES_AT_ONCE,
  GH_STATE_TTL_MS,
  ghCheckDisabled,
  ghQueryArgs,
  isLiveCheckPage,
  readGhAnswer,
  spawnGhRunner,
  type GhCheckDeps,
  type GhResult,
  type GhRunner,
} from "./gh-check.ts";
import type { WorkMap } from "./schema.ts";

afterEach(() => __resetGhCheckForTest());

const url = (repo: string, n: number) => `[#${n}](https://github.com/${repo}/pull/${n})`;
const WIDGETS = "acme/widgets";
const GEARS = "acme/gears";
const AT = 1_800_000_000_000;

function wiki(pages: Record<string, string>): string {
  const root = testTempDirSync(path.join(tmpdir(), "gh-check-"));
  mkdirSync(path.join(root, "plans"), { recursive: true });
  for (const [rel, text] of Object.entries(pages)) writeFileSync(path.join(root, rel), text);
  return root;
}

const page = (status: string, rows: string[][], extra = "", header = ["PR", "What", "State", "Depends on"]) =>
  `---\ntitle: A plan\nplan_status: ${status}\n${extra}---\n\n**PR ledger.**\n\n| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;

function map(needsYou: { title: string; action?: string; pages: string[]; kind?: string }[] = []): WorkMap {
  return {
    version: 1,
    wiki: "w",
    runAtMs: AT,
    model: "m",
    coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, logEntriesInWindow: 0, digestChars: 0, warnings: [] },
    summary: "",
    needsYou: needsYou.map((n) => ({ kind: "followup", why: "", action: "", ...n })),
    themes: [],
    efforts: [],
    loose: [],
  } as unknown as WorkMap;
}

type Pr = { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt?: string };

/** A `gh` that answers from a table, keyed `owner/repo#n`; a miss is NOT_FOUND with exit 1, as the real one. */
function stubGh(table: Record<string, Pr>, calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args);
    const owner = args.find((a) => a.startsWith("owner="))!.slice(6);
    const repo = args.find((a) => a.startsWith("repo="))!.slice(5);
    const q = args.find((a) => a.startsWith("query="))!;
    const fields: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const m of q.matchAll(/pullRequest\(number:(\d+)\)/g)) {
      const pr = table[`${owner}/${repo}#${m[1]}`];
      fields[`p${m[1]}`] = pr ? { state: pr.state, mergedAt: pr.mergedAt ?? null } : null;
      if (!pr) errors.push({ type: "NOT_FOUND", path: ["repository", `p${m[1]}`], message: "Could not resolve" });
    }
    return { exitCode: errors.length ? 1 : 0, stdout: JSON.stringify({ data: { repository: fields }, ...(errors.length ? { errors } : {}) }), stderr: errors.length ? "gh: Could not resolve" : "" };
  };
}

function deps(runGh: GhRunner, over: Partial<GhCheckDeps> = {}): GhCheckDeps {
  return { index: (root) => getWikiIndex({ root, refresh: true }), readBody: readWikiPage, runGh, disabled: () => false, ...over };
}

const run = (root: string, d: GhCheckDeps, m: WorkMap = map(), now: () => number = () => AT) => checkWorkMapPrs({ wiki: "w", root, map: m }, d, now);

const MERGED_AT = "2026-10-29T08:44:22Z";

describe("the rows", () => {
  const root = () =>
    wiki({
      "plans/alpha.mdx": page("in-flight", [
        [url(WIDGETS, 1), "merged on GitHub", "open", ""],
        [url(WIDGETS, 2), "closed on GitHub", "planned", ""],
        [url(WIDGETS, 3), "still open", "open", ""],
        [url(WIDGETS, 4), "GitHub does not know it", "not started", ""],
        [url(WIDGETS, 5), "merged both ways", "merged", ""],
        ["7", "depends on a merged PR", "open", url(WIDGETS, 1)],
        ["PR #8", "a bare number", "open", ""],
        [url(WIDGETS, 9), "MEL-1 owned elsewhere", "[[owner]]", ""],
      ]),
      "plans/owner.mdx": "---\ntitle: Owner\nowns: [MEL-1]\n---\n\nBody.\n",
    });
  const table = { [`${WIDGETS}#1`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${WIDGETS}#2`]: { state: "CLOSED" }, [`${WIDGETS}#3`]: { state: "OPEN" }, [`${WIDGETS}#5`]: { state: "MERGED", mergedAt: MERGED_AT } } as Record<string, Pr>;

  test("each row lands in exactly one count, and only an open row GitHub has settled contradicts", async () => {
    const body = await run(root(), deps(stubGh(table)));
    expect({ checked: body.checked, unchecked: body.unchecked, unlinked: body.unlinked, skipped: body.skipped }).toEqual({ checked: 4, unchecked: 1, unlinked: 2, skipped: 1 });
    expect(body.contradictions).toEqual([
      { page: "plans/alpha.mdx", pr: 1, repo: WIDGETS, rowState: "open", ghState: "MERGED", mergedAt: MERGED_AT },
      { page: "plans/alpha.mdx", pr: 2, repo: WIDGETS, rowState: "planned", ghState: "CLOSED", mergedAt: null },
    ]);
    expect(body.prs[`${WIDGETS}#1`]).toEqual({ state: "MERGED", mergedAt: MERGED_AT });
    expect(body.prs[`${WIDGETS}#4`]).toBeUndefined();
    expect(body.uncheckedRows).toEqual([{ page: "plans/alpha.mdx", pr: 4, repo: WIDGETS }]);
    expect(body.unlinkedRows.map((r) => r.label)).toEqual(["7", "PR #8"]);
  });

  test("a merged PR in a Depends on cell does not flag its row, and is not asked for on its behalf", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [["7", "x", "open", url(WIDGETS, 1)]]) });
    const calls: string[][] = [];
    const body = await run(r, deps(stubGh({ [`${WIDGETS}#1`]: { state: "MERGED" } }, calls)));
    expect(body.contradictions).toEqual([]);
    expect(body.unlinked).toBe(1);
    expect(calls).toEqual([]);
  });

  test("a row whose state links the page owning its Jira key is skipped, and asks GitHub nothing", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 9), "MEL-1 here", "[[owner]]", ""]]), "plans/owner.mdx": "---\ntitle: Owner\nowns: [MEL-1]\n---\n\nBody.\n" });
    const calls: string[][] = [];
    const body = await run(r, deps(stubGh({}, calls)));
    expect(body.skipped).toBe(1);
    expect(calls).toEqual([]);
  });

  test("a state link to a page owning another key is an ordinary row", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 9), "MEL-2 here", "open [[owner]]", ""]]), "plans/owner.mdx": "---\ntitle: Owner\nowns: [MEL-1]\n---\n\nBody.\n" });
    const body = await run(r, deps(stubGh({ [`${WIDGETS}#9`]: { state: "OPEN" } })));
    expect([body.skipped, body.checked]).toEqual([0, 1]);
  });

  test("a not-started row GitHub has merged is flagged", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 4), "x", "not started", ""]]) });
    const body = await run(r, deps(stubGh({ [`${WIDGETS}#4`]: { state: "MERGED", mergedAt: MERGED_AT } })));
    expect(body.contradictions).toEqual([{ page: "plans/a.mdx", pr: 4, repo: WIDGETS, rowState: "not-started", ghState: "MERGED", mergedAt: MERGED_AT }]);
  });

  test.each(["MEL-10 here", "XMEL-1 here"])("a state link to the owner of MEL-1 does not skip a row naming %s", async (what) => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 9), what, "open [[owner]]", ""]]), "plans/owner.mdx": "---\ntitle: Owner\nowns: [MEL-1]\n---\n\nBody.\n" });
    const body = await run(r, deps(stubGh({ [`${WIDGETS}#9`]: { state: "OPEN" } })));
    expect([body.skipped, body.checked]).toEqual([0, 1]);
  });

  describe("a row with no number", () => {
    const owner = "---\ntitle: Owner\nowns: [MEL-1]\n---\n\nBody.\n";

    test("is seen: no full link is unlinked, a state owned elsewhere is skipped, and the rows sum", async () => {
      const r = wiki({
        "plans/a.mdx": page("in-flight", [
          ["**P3 — unprompted TUI**", "x", "not started", ""],
          ["L — local acceptance", "x", "open", ""],
          ["[MEL-1](https://jira.test/MEL-1)", "A1", "se [[owner]]", ""],
          ["PR A", "MEL-1, the second", "se [[plans/owner]]", ""],
          ["PR B", "MEL-2", "se [[owner]]", ""],
          ["1 — numbered", "x", "open", ""],
          [url(WIDGETS, 3), "linked", "open", ""],
        ]),
        "plans/owner.mdx": owner,
      });
      const body = await run(r, deps(stubGh({ [`${WIDGETS}#3`]: { state: "OPEN" } })));
      expect({ checked: body.checked, unchecked: body.unchecked, unlinked: body.unlinked, skipped: body.skipped }).toEqual({ checked: 1, unchecked: 0, unlinked: 4, skipped: 2 });
      expect(body.unlinkedRows.map((x) => x.label)).toEqual(["P3 — unprompted TUI", "L — local acceptance", "PR B", "numbered"]);
    });

    test("a table with no state column counts its rows and skips none", async () => {
      const r = wiki({
        "plans/a.mdx": page("in-flight", [["P0 — shared", "[[owner]] MEL-1"], ["1 — x", "y"], [url(WIDGETS, 3), "z"]], "", ["PR", "What"]),
        "plans/owner.mdx": owner,
      });
      const body = await run(r, deps(stubGh({ [`${WIDGETS}#3`]: { state: "MERGED", mergedAt: MERGED_AT } })));
      expect({ checked: body.checked, unlinked: body.unlinked, skipped: body.skipped }).toEqual({ checked: 1, unlinked: 2, skipped: 0 });
      expect(body.contradictions).toEqual([]);
    });

    test("a glance table's row with no number stays out, as it is for every other reader", async () => {
      const glance = `---\ntitle: G\nplan_status: proposed\n---\n\n### At a glance\n\n| PR | What |\n|---|---|\n| 1 — a | x |\n| Later | y |\n`;
      const body = await run(wiki({ "plans/g.mdx": glance }), deps(stubGh({})));
      expect(body.unlinkedRows.map((x) => x.label)).toEqual(["a"]);
    });
  });

  describe("the drill label", () => {
    const labelOf = async (first: string): Promise<string> => {
      const body = await run(wiki({ "plans/a.mdx": page("ready", [[first, "x", "open", ""]]) }), deps(stubGh({})));
      return body.unlinkedRows[0]!.label;
    };

    test.each([
      ["**7**", "7"],
      ["~~7~~", "7"],
      ["7 — the *real* `name`", "the real name"],
      ["3 — see [[plans/other]]", "see plans/other"],
      // A table row splits on every `|`, so a piped wikilink reaches its cell cut.
      ["3 — see [[plans/other\\|Other page]]", "see plans/other"],
      ["3 — see [[plans/other|Other page]]", "see plans/other"],
      ["3 — see [[plans/other#part]]", "see plans/other"],
      ["3 — see [the doc](https://example.test/d)", "see the doc"],
      ["3 — ~~old~~ name", "old name"],
      ["3 — __bold__ _lead_ snake_case", "bold lead snake_case"],
    ])("%s reads %s", async (first, want) => {
      expect(await labelOf(first)).toBe(want);
    });

    test("a blank first cell says so", async () => {
      expect(await labelOf(" ")).toBe("(no label)");
    });

    test("a clip never halves a character outside the BMP, and stays in bounds", async () => {
      const label = await labelOf(`3 — ${"a".repeat(78)}😀😀`);
      expect(label).toBe(`${"a".repeat(78)}…`);
      expect(await labelOf(`3 — ${"a".repeat(80)}`)).toBe("a".repeat(80));
      expect(await labelOf(`3 — ${"a".repeat(81)}`)).toBe(`${"a".repeat(79)}…`);
    });
  });

  describe("no false contradiction", () => {
    const flagged = async (rows: string[][], table: Record<string, Pr>) => {
      const body = await run(wiki({ "plans/a.mdx": page("ready", rows) }), deps(stubGh(table)));
      return { pairs: body.contradictions.map((c) => `${c.pr} ${c.rowState} ${c.ghState}`), checked: body.checked, unchecked: body.unchecked, unlinked: body.unlinked };
    };
    const merged = (...ns: number[]) => Object.fromEntries(ns.map((n) => [`${WIDGETS}#${n}`, { state: "MERGED", mergedAt: MERGED_AT } as Pr]));

    test.each([
      ["open, waits on"],
      ["open (blocked by"],
    ])("a dependency in the state cell (%s) is no own PR", async (lead) => {
      const close = lead.includes("(") ? ")" : "";
      expect(await flagged([["3 — x", "y", `${lead} ${url(WIDGETS, 9)}${close}`, ""]], merged(9))).toEqual({ pairs: [], checked: 0, unchecked: 0, unlinked: 1 });
    });

    test("a merged own PR whose state word goes on about follow-up work is not flagged", async () => {
      expect((await flagged([[url(WIDGETS, 1), "y", "open follow-up: rail polish", ""], [url(WIDGETS, 2), "y", "planned next: more", ""]], merged(1, 2))).pairs).toEqual([]);
    });

    test.each([
      ["open follow-up #9"],
      ["planned next #9"],
      [`open ${url(WIDGETS, 9)}`],
      [`open: ${url(WIDGETS, 9)}`],
      ["open 3 follow-ups"],
      ['open "later"'],
      ["open/blocked"],
    ])("%s on a merged own #1 is no contradiction", async (state) => {
      const table = { ...merged(1), [`${WIDGETS}#9`]: { state: "OPEN" } as Pr };
      expect((await flagged([[url(WIDGETS, 1), "y", state, ""]], table)).pairs).toEqual([]);
    });

    test.each([
      ["åpen, klar for review", 369],
      [`åpen: [e2e #400](https://github.com/${WIDGETS}/pull/400) venter`, 400],
    ])("%s still flags its own merged PR", async (state, n) => {
      expect((await flagged([[url(WIDGETS, n), "y", state, ""]], merged(n))).pairs).toEqual([`${n} open MERGED`]);
    });

    test("a state word with a separator still flags", async () => {
      expect((await flagged([[url(WIDGETS, 1), "y", "open — awaiting review", ""]], merged(1))).pairs).toEqual(["1 open MERGED"]);
    });

    test("state cell: the PR right after the state word still flags", async () => {
      expect((await flagged([["3 — x", "y", `open ${url(WIDGETS, 4)}`, ""]], merged(4))).pairs).toEqual(["4 open MERGED"]);
    });

    test("a PR in the state cell's prose is no reason to flag the row's own", async () => {
      expect((await flagged([[url(WIDGETS, 1), "y", `blocked by ${url(WIDGETS, 8)}; open ${url(WIDGETS, 9)}`, ""]], merged(1, 8, 9))).pairs).toEqual([]);
    });

    describe("several PRs in the own cell", () => {
      const row = [[`${url(WIDGETS, 3)}, ${url(WIDGETS, 4)}`, "y", "open", ""]];

      test("one still open: no flag, and the row is one checked row", async () => {
        expect(await flagged(row, { ...merged(3), [`${WIDGETS}#4`]: { state: "OPEN" } })).toEqual({ pairs: [], checked: 1, unchecked: 0, unlinked: 0 });
      });

      test("the first open and the second merged: no flag either", async () => {
        expect((await flagged(row, { [`${WIDGETS}#3`]: { state: "OPEN" }, ...merged(4) })).pairs).toEqual([]);
      });

      test("all settled: one flag for the row, whichever way each one settled", async () => {
        expect(await flagged(row, merged(3, 4))).toEqual({ pairs: ["3 open MERGED"], checked: 1, unchecked: 0, unlinked: 0 });
        expect((await flagged(row, { ...merged(3), [`${WIDGETS}#4`]: { state: "CLOSED" } })).pairs).toEqual(["3 open MERGED"]);
      });

      test("one GitHub does not know: unchecked, naming that PR, never a flag", async () => {
        const body = await run(wiki({ "plans/a.mdx": page("ready", row) }), deps(stubGh(merged(3))));
        expect(body.contradictions).toEqual([]);
        expect([body.checked, body.unchecked]).toEqual([0, 1]);
        expect(body.uncheckedRows).toEqual([{ page: "plans/a.mdx", pr: 4, repo: WIDGETS }]);
      });

      test("every one is asked for, across repos", async () => {
        const calls: string[][] = [];
        await run(wiki({ "plans/a.mdx": page("ready", [[`${url(WIDGETS, 3)} ${url(GEARS, 4)}`, "y", "open", ""]]) }), deps(stubGh({}, calls)));
        expect(calls.map((c) => [c.find((a) => a.startsWith("repo=")), /number:(\d+)/.exec(c.find((a) => a.startsWith("query="))!)![1]])).toEqual([["repo=widgets", "3"], ["repo=gears", "4"]]);
      });

      test("two rows sharing a first PR are two flags, and the PR is asked for once", async () => {
        const calls: string[][] = [];
        const body = await run(wiki({ "plans/a.mdx": page("ready", [...row, [url(WIDGETS, 3), "z", "open", ""]]) }), deps(stubGh(merged(3, 4), calls)));
        expect(body.contradictions.map((c) => c.pr)).toEqual([3, 3]);
        expect(calls.length).toBe(1);
        expect([...calls[0]!.join(" ").matchAll(/number:3\b/g)].length).toBe(1);
      });

      test("one row naming a PR twice asks for it once", async () => {
        const calls: string[][] = [];
        await run(wiki({ "plans/a.mdx": page("ready", [[`${url(WIDGETS, 3)}, ${url(WIDGETS, 3)}`, "y", "open", ""]]) }), deps(stubGh(merged(3), calls)));
        expect([...calls.flat().join(" ").matchAll(/number:3\b/g)].length).toBe(1);
      });

      test("the same row twice on a page is one flag and two checked rows; on two pages it is two flags", async () => {
        const same = [url(WIDGETS, 3), "y", "open", ""];
        const once = await run(wiki({ "plans/a.mdx": page("ready", [same, same]) }), deps(stubGh(merged(3))));
        expect(once.contradictions.map((c) => c.pr)).toEqual([3]);
        expect(once.checked).toBe(2);
        __resetGhCheckForTest();
        const twice = await run(wiki({ "plans/a.mdx": page("ready", [same]), "plans/b.mdx": page("ready", [same]) }), deps(stubGh(merged(3))));
        expect(twice.contradictions.map((c) => c.page)).toEqual(["plans/a.mdx", "plans/b.mdx"]);
      });
    });
  });

  test("only a live page is read: its status decides, a retired page is out", () => {
    const live = (p: Parameters<typeof isLiveCheckPage>[0]) => isLiveCheckPage(p);
    for (const s of ["proposed", "ready", "in-flight", "blocked"] as const) expect(live({ plan_status: s })).toBe(true);
    expect(live({ plan_status: "shipped", followups: "open" })).toBe(true);
    expect(live({ plan_status: "shipped" })).toBe(false);
    expect(live({ plan_status: "abandoned" })).toBe(false);
    expect(live({})).toBe(false);
    expect(live({ plan_status: "ready", culled: true })).toBe(false);
  });

  test("an owner or repo with a leading dash is never passed to gh and the row is unlinked", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[`[#1](https://github.com/-x/widgets/pull/1)`, "x", "open", ""]]) });
    const calls: string[][] = [];
    const body = await run(r, deps(stubGh({}, calls)));
    expect(body.unlinked).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("the lookups", () => {
  test("one query per repo per 50 PRs, four at a time, arguments as an array", async () => {
    const rows = Array.from({ length: GH_PRS_PER_QUERY + 1 }, (_, i) => [url(WIDGETS, i + 1), "x", "open", ""]);
    const r = wiki({ "plans/a.mdx": page("ready", [...rows, [url(GEARS, 1), "x", "open", ""]]) });
    const calls: string[][] = [];
    await run(r, deps(stubGh({}, calls)));
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c[0] === "api" && c[1] === "graphql")).toBe(true);
    expect(calls.map((c) => [...c.join(" ").matchAll(/number:/g)].length).sort((a, b) => a - b)).toEqual([1, 1, GH_PRS_PER_QUERY]);

    let running = 0;
    let peak = 0;
    const slow: GhRunner = async (args) => {
      peak = Math.max(peak, ++running);
      await Bun.sleep(5);
      running--;
      return stubGh({})(args);
    };
    const many = Array.from({ length: GH_PRS_PER_QUERY * (GH_QUERIES_AT_ONCE + 3) }, (_, i) => [url(WIDGETS, i + 1), "x", "open", ""]);
    __resetGhCheckForTest();
    await run(wiki({ "plans/a.mdx": page("ready", many) }), deps(slow));
    expect(peak).toBe(GH_QUERIES_AT_ONCE);
  });

  test("the slug travels in variables, so it can break out of nothing", () => {
    expect(ghQueryArgs("acme/widgets", [1, 2])).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){p1:pullRequest(number:1){state mergedAt} p2:pullRequest(number:2){state mergedAt}}}",
      "-f",
      "owner=acme",
      "-f",
      "repo=widgets",
    ]);
  });

  test("past the hourly cap the rest count as unchecked, and a second request asks nothing more", async () => {
    const rows = Array.from({ length: GH_PRS_PER_HOUR + 1 }, (_, i) => [url(WIDGETS, i + 1), "x", "open", ""]);
    const table = Object.fromEntries(rows.map((_, i) => [`${WIDGETS}#${i + 1}`, { state: "OPEN" } as Pr]));
    const r = wiki({ "plans/a.mdx": page("ready", rows) });
    const calls: string[][] = [];
    const first = await run(r, deps(stubGh(table, calls)));
    expect([first.checked, first.unchecked]).toEqual([GH_PRS_PER_HOUR, 1]);
    const n = calls.length;
    const second = await run(r, deps(stubGh(table, calls)));
    expect(calls.length).toBe(n);
    expect(second.unchecked).toBe(1);
    // An hour on the budget is back, and the states are due again.
    const later = await run(r, deps(stubGh(table, calls)), map(), () => AT + GH_STATE_TTL_MS);
    expect(calls.length).toBeGreaterThan(n);
    expect(later.checked).toBe(GH_PRS_PER_HOUR);
  });

  test("a failed alias beside partial data on exit 1 leaves the others checked", () => {
    const answer = readGhAnswer(
      {
        exitCode: 1,
        stdout: JSON.stringify({ data: { repository: { p1: { state: "MERGED", mergedAt: MERGED_AT }, p2: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "p2"] }] }),
        stderr: "gh: Could not resolve to a PullRequest with the number of 2.",
      },
      [1, 2],
    );
    expect(answer.unanswered).toBe(false);
    expect(answer.states.get(1)).toEqual({ state: "MERGED", mergedAt: MERGED_AT });
    expect(answer.states.get(2)).toBeNull();
  });

  test("any other exit, a timeout or unreadable stdout leaves the whole query unchecked, never a contradiction", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""]]) });
    const results: GhResult[] = [
      { exitCode: 2, stdout: JSON.stringify({ data: { repository: { p1: { state: "MERGED" } } } }), stderr: "" },
      { exitCode: -1, stdout: "", stderr: "", timedOut: true },
      { exitCode: 1, stdout: "<html>", stderr: "HTTP 502" },
    ];
    for (const result of results) {
      __resetGhCheckForTest();
      const body = await run(r, deps(async () => result));
      expect([body.checked, body.unchecked, body.contradictions.length]).toEqual([0, 1, 0]);
      expect(body.notChecked).toBeUndefined();
    }
  });

  test("a runner that throws is a failed call", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""]]) });
    const body = await run(r, deps(async () => { throw new Error("boom"); }));
    expect(body.unchecked).toBe(1);
  });
});

describe("notChecked", () => {
  const SSO = JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }] });
  // The real answer for a repo that does not exist, and for a private one the token cannot read.
  const NO_ACCESS: GhResult = {
    exitCode: 1,
    stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'acme/widgets'." }] }),
    stderr: "gh: Could not resolve to a Repository with the name 'acme/widgets'.",
  };
  const cases: [string, GhResult, string][] = [
    ["no gh on PATH", { exitCode: -1, stdout: "", stderr: "ENOENT", noBinary: true }, "no-gh"],
    ["not logged in: exit 4", { exitCode: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }, "auth"],
    ["a 401 answer", { exitCode: 1, stdout: JSON.stringify({ message: "Bad credentials", status: "401" }), stderr: "gh: Bad credentials (HTTP 401)" }, "auth"],
    ["FORBIDDEN", { exitCode: 1, stdout: SSO, stderr: "gh: Resource protected" }, "sso"],
    ["a SAML 403", { exitCode: 1, stdout: JSON.stringify({ message: "Resource protected by organization SAML enforcement." }), stderr: "HTTP 403" }, "sso"],
    ["a repo the login cannot see", NO_ACCESS, "no-access"],
  ];
  for (const [name, result, reason] of cases) {
    test(`${name} reads as ${reason}, and the other repo's counts still show`, async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""], [url(GEARS, 2), "x", "open", ""]]) });
      const ok = stubGh({ [`${GEARS}#2`]: { state: "MERGED", mergedAt: MERGED_AT } });
      const body = await run(r, deps(async (args) => (args.includes("repo=widgets") ? result : ok(args))));
      expect(body.notChecked).toEqual({ reason: reason as "auth", repos: [WIDGETS] });
      expect([body.checked, body.unchecked, body.contradictions.length]).toEqual([1, 1, 1]);
      // The login comes back: the next request asks again and the note goes.
      const after = await run(r, deps(stubGh({ [`${WIDGETS}#1`]: { state: "OPEN" }, [`${GEARS}#2`]: { state: "MERGED" } })));
      expect(after.notChecked).toBeUndefined();
      expect(after.checked).toBe(2);
    });
  }

  test("a repo the login cannot see caches nothing: its PRs are unchecked and the next request asks again", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""]]) });
    const calls: string[][] = [];
    const counting: GhRunner = async (args) => {
      calls.push(args);
      return NO_ACCESS;
    };
    const first = await run(r, deps(counting));
    expect([first.checked, first.unchecked]).toEqual([0, 1]);
    expect(first.uncheckedRows).toEqual([{ page: "plans/a.mdx", pr: 1, repo: WIDGETS }]);
    expect(first.prs).toEqual({});
    await run(r, deps(counting));
    expect(calls.length).toBe(2);
  });

  test("a repo the login cannot see spends none of the hour's budget", async () => {
    const rows = Array.from({ length: GH_PRS_PER_HOUR }, (_, i) => [url(WIDGETS, i + 1), "x", "open", ""]);
    const table = Object.fromEntries(rows.map((_, i) => [`${WIDGETS}#${i + 1}`, { state: "OPEN" } as Pr]));
    const r = wiki({ "plans/a.mdx": page("ready", rows) });
    await run(r, deps(async () => NO_ACCESS));
    // Switched back to the account that can see it: the whole set is read at once.
    const after = await run(r, deps(stubGh(table)));
    expect([after.checked, after.unchecked]).toEqual([GH_PRS_PER_HOUR, 0]);
    expect(after.notChecked).toBeUndefined();
  });

  test("no-access ranks below no-gh, auth and sso, and names only its own repos", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""], [url(GEARS, 2), "x", "open", ""], [url("acme/third", 3), "x", "open", ""]]) });
    for (const [result, reason] of [
      [{ exitCode: -1, stdout: "", stderr: "ENOENT", noBinary: true }, "no-gh"],
      [{ exitCode: 4, stdout: "", stderr: "gh auth login" }, "auth"],
      [{ exitCode: 1, stdout: SSO, stderr: "" }, "sso"],
    ] as [GhResult, string][]) {
      __resetGhCheckForTest();
      const body = await run(r, deps(async (args) => (args.includes("repo=gears") ? result : NO_ACCESS)));
      expect(body.notChecked).toEqual({ reason: reason as "auth", repos: [GEARS] });
    }
    __resetGhCheckForTest();
    const only = await run(r, deps(async (args) => (args.includes("repo=gears") ? stubGh({ [`${GEARS}#2`]: { state: "OPEN" } })(args) : NO_ACCESS)));
    expect(only.notChecked?.reason).toBe("no-access");
    expect([...only.notChecked!.repos].sort()).toEqual(["acme/third", WIDGETS].sort());
    expect(only.checked).toBe(1);
  });

  // One signal per case: `readGhAnswer` must reach the reason from that alone.
  const reasonOf = (result: Partial<GhResult>) => readGhAnswer({ exitCode: 1, stdout: "", stderr: "", ...result }, [1]).failure;
  const repoErrors = (errors: unknown[]) => JSON.stringify({ data: { repository: null }, errors });

  test.each<[string, string, Partial<GhResult>]>([
    ["exit 4 alone", "auth", { exitCode: 4 }],
    ["HTTP 401 in stderr alone", "auth", { stderr: "gh: HTTP 401" }],
    ["Bad credentials in stderr alone", "auth", { stderr: "gh: Bad credentials" }],
    ["Bad credentials in the body's message alone", "auth", { stdout: JSON.stringify({ message: "Bad credentials" }) }],
    ["a FORBIDDEN error type alone", "sso", { stdout: repoErrors([{ type: "FORBIDDEN" }]) }],
    ["FORBIDDEN in stderr alone", "sso", { stderr: "gh: FORBIDDEN" }],
    ["SAML in stderr alone", "sso", { stderr: "gh: protected by SAML" }],
    ["SAML in the body's message alone", "sso", { stdout: JSON.stringify({ message: "protected by SAML" }) }],
    ["SAML in an error's message alone", "sso", { stdout: repoErrors([{ type: "OTHER", message: "protected by SAML" }]) }],
  ])("%s reads as %s", (_name, reason, result) => {
    expect(reasonOf(result)).toBe(reason as "auth");
  });

  test.each<[string, Partial<GhResult>]>([
    ["an ordinary failure", { stderr: "gh: connection reset" }],
    ["an exit 2", { exitCode: 2, stderr: "gh: usage" }],
    ["another HTTP status", { stderr: "gh: HTTP 502" }],
  ])("%s names no reason", (_name, result) => {
    expect(reasonOf(result)).toBeUndefined();
  });

  describe("a repo's name decides nothing", () => {
    const notFound = (repo: string, echoed = repo): GhResult => ({
      exitCode: 1,
      stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: `Could not resolve to a Repository with the name '${echoed}'.` }] }),
      stderr: `gh: Could not resolve to a Repository with the name '${echoed}'.`,
    });
    const onRepo = async (repo: string, result: GhResult) => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url(repo, 1), "x", "open", ""]]) });
      return (await run(r, deps(async () => result))).notChecked;
    };

    test.each(["acme/SAML-tools", "acme/FORBIDDEN", "acme/saml-tools", "SAML/tools", "FORBIDDEN/x.y"])("a NOT_FOUND on %s reads as no-access", async (repo) => {
      expect(await onRepo(repo, notFound(repo))).toEqual({ reason: "no-access", repos: [repo] });
    });

    test("GitHub echoing the name in another case is the same name", async () => {
      expect(await onRepo("acme/saml-tools", notFound("acme/saml-tools", "ACME/SAML-TOOLS"))).toEqual({ reason: "no-access", repos: ["acme/saml-tools"] });
      expect(readGhAnswer({ exitCode: 1, stdout: "", stderr: "gh: Could not resolve 'ACME/SAML-TOOLS'" }, [1], "acme/saml-tools").failure).toBeUndefined();
    });

    test("the flight hands the query's repo to the reader, so only its name is cut", async () => {
      expect(await onRepo("acme/SAML-tools", { exitCode: 1, stdout: "", stderr: "gh: connection reset for acme/SAML-tools" })).toBeUndefined();
    });

    test.each<[string, string, GhResult]>([
      ["a real SAML block on a repo named SAML", "acme/SAML", { exitCode: 1, stdout: JSON.stringify({ message: "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization." }), stderr: "gh: Resource protected by organization SAML enforcement. (HTTP 403)" }],
      ["a real SAML error on a repo named after it", "acme/SAML-tools", { exitCode: 1, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }] }), stderr: "gh: Resource protected" }],
      ["a real FORBIDDEN that names the repo", "acme/plain", { exitCode: 1, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, for 'acme/plain'." }] }), stderr: "gh: x" }],
      ["the word in a message of another type", "acme/FORBIDDEN", { exitCode: 1, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "OTHER", message: "FORBIDDEN on 'acme/FORBIDDEN'" }] }), stderr: "" }],
    ])("%s still reads as sso", async (_name, repo, result) => {
      expect(await onRepo(repo, result)).toEqual({ reason: "sso", repos: [repo] });
    });

    const read = (repo: string, result: Partial<GhResult>) => readGhAnswer({ exitCode: 1, stdout: "", stderr: "", ...result }, [1], repo).failure;

    test("a NOT_FOUND's type outranks its message", () => {
      expect(read("acme/x", { stdout: repoErrors([{ type: "NOT_FOUND", message: "protected by SAML" }]) })).toBe("no-access");
    });

    test("a NOT_FOUND beside another error does not silence that error's message", () => {
      expect(read("acme/x", { stdout: repoErrors([{ type: "NOT_FOUND" }, { type: "OTHER", message: "protected by SAML" }]) })).toBe("sso");
    });

    test("stderr is read only when no text was parsed", () => {
      expect(read("acme/x", { stdout: JSON.stringify({ message: "Not Found" }), stderr: "gh: protected by SAML" })).toBeUndefined();
      expect(read("acme/x", { stdout: JSON.stringify({ data: { repository: null } }), stderr: "gh: protected by SAML" })).toBe("sso");
    });

    test("stderr with nothing parsed loses the name too, and keeps the rest", () => {
      expect(read("acme/SAML-tools", { stderr: "gh: Could not resolve 'acme/SAML-tools'" })).toBeUndefined();
      expect(read("acme/FORBIDDEN", { exitCode: 2, stderr: "gh: Could not resolve 'acme/FORBIDDEN'" })).toBeUndefined();
      expect(read("acme/SAML-tools", { stderr: "gh: acme/SAML-tools is protected by SAML" })).toBe("sso");
      expect(read("acme/SAML-tools", { stderr: "gh: Bad credentials for acme/SAML-tools" })).toBe("auth");
    });

    test("a name with a dot is matched as written, not as a pattern", () => {
      expect(read("acme/a.SAML", { stderr: "acme/axSAML is protected" })).toBe("sso");
      expect(read("acme/a.SAML", { stderr: "gh: acme/a.SAML is gone" })).toBeUndefined();
    });
  });

  test("a null repository with a more specific error keeps that reason", () => {
    const answer = readGhAnswer({ exitCode: 1, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND" }, { type: "FORBIDDEN" }] }), stderr: "" }, [1]);
    expect(answer.failure).toBe("sso");
  });

  test("a null repository with no NOT_FOUND is a failed query, with no remedy it cannot back", () => {
    const answer = readGhAnswer({ exitCode: 1, stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "SERVICE_UNAVAILABLE", message: "try later" }] }), stderr: "" }, [1]);
    expect(answer.unanswered).toBe(true);
    expect(answer.failure).toBeUndefined();
    expect(answer.states.size).toBe(0);
  });

  test("an alias NOT_FOUND beside a live repository stays cached, with no reason", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""], [url(WIDGETS, 2), "x", "open", ""]]) });
    const calls: string[][] = [];
    const body = await run(r, deps(stubGh({ [`${WIDGETS}#1`]: { state: "OPEN" } }, calls)));
    expect(body.notChecked).toBeUndefined();
    expect([body.checked, body.unchecked]).toEqual([1, 1]);
    await run(r, deps(stubGh({}, calls)));
    expect(calls.length).toBe(1);
  });

  describe("a malformed answer is an unanswered query", () => {
    const shapes: [string, unknown][] = [
      ["a null error", { errors: [null] }],
      ["no repository key", { data: {} }],
      ["a string repository", { data: { repository: "x" } }],
      ["an array repository", { data: { repository: [1] } }],
      ["a repository with none of the aliases", { data: { repository: {} } }],
      ["a bare number", 5],
      ["null", null],
    ];
    const answerOf = (json: unknown) => readGhAnswer({ exitCode: 1, stdout: JSON.stringify(json), stderr: "" }, [1]);

    for (const [name, json] of shapes) {
      test(`${name}: no throw, nothing read`, () => {
        const answer = answerOf(json);
        expect(answer.unanswered).toBe(true);
        expect(answer.states.size).toBe(0);
      });
    }

    test("junk in errors does not cost the data beside it", () => {
      const answer = answerOf({ data: { repository: { p1: { state: "OPEN", mergedAt: null } } }, errors: [null, 5, "x"] });
      expect(answer.unanswered).toBe(false);
      expect(answer.states.get(1)).toEqual({ state: "OPEN", mergedAt: null });
    });

    test("through a request: it resolves, the other repo counts, and no budget goes", async () => {
      const rows = Array.from({ length: GH_PRS_PER_HOUR }, (_, i) => [url(WIDGETS, i + 1), "x", "open", ""]);
      const table = Object.fromEntries(rows.map((_, i) => [`${WIDGETS}#${i + 1}`, { state: "OPEN" } as Pr]));
      const r = wiki({ "plans/a.mdx": page("ready", rows) });
      const empty = await run(r, deps(async () => ({ exitCode: 1, stdout: JSON.stringify({ data: { repository: {} } }), stderr: "" })));
      expect(empty.unchecked).toBe(GH_PRS_PER_HOUR);
      expect((await run(r, deps(stubGh(table)))).checked).toBe(GH_PRS_PER_HOUR);

      __resetGhCheckForTest();
      const two = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""], [url(GEARS, 2), "x", "open", ""]]) });
      const ok = stubGh({ [`${GEARS}#2`]: { state: "OPEN" } });
      const body = await run(two, deps(async (args) => (args.includes("repo=widgets") ? { exitCode: 1, stdout: JSON.stringify({ errors: [null] }), stderr: "" } : ok(args))));
      expect([body.checked, body.unchecked]).toEqual([1, 1]);
    });
  });

  test("the env switch: no spawn, reason disabled", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""]]) });
    const calls: string[][] = [];
    const body = await run(r, deps(stubGh({}, calls), { disabled: () => true }));
    expect(body.notChecked).toEqual({ reason: "disabled", repos: [] });
    expect(calls).toEqual([]);
  });

  test("WORK_MAP_GH_CHECK: off, 0 and false turn it off; unset and blank leave it on", () => {
    for (const v of ["off", "OFF", " 0 ", "false"]) expect(ghCheckDisabled({ WORK_MAP_GH_CHECK: v })).toBe(true);
    for (const v of [undefined, "", "on", "1"]) expect(ghCheckDisabled({ WORK_MAP_GH_CHECK: v })).toBe(false);
  });
});

describe("the cache", () => {
  const one = () => wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""]]) });
  const merged = { [`${WIDGETS}#1`]: { state: "MERGED", mergedAt: MERGED_AT } } as Record<string, Pr>;

  test("two concurrent cold calls share one lookup", async () => {
    const r = one();
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const d = deps(async (args) => {
      await gate;
      return stubGh(merged, calls)(args);
    });
    const both = Promise.all([run(r, d), run(r, d)]);
    // Held, so a second lookup could only come from a missing single-flight.
    await Bun.sleep(100);
    release();
    const [a, b] = await both;
    expect(calls.length).toBe(1);
    expect(a.checked).toBe(1);
    expect(b.checked).toBe(1);
  });

  test("a failed flight is not asked again by the call that joined it", async () => {
    const r = one();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const d = deps(async () => {
      calls++;
      await gate;
      return { exitCode: 2, stdout: "", stderr: "" };
    });
    const both = Promise.all([run(r, d), run(r, d)]);
    // Long enough for both calls to read the pages and meet at the flight.
    await Bun.sleep(100);
    release();
    const [a, b] = await both;
    expect(calls).toBe(1);
    expect([a.unchecked, b.unchecked]).toEqual([1, 1]);
  });

  test("a state under an hour is served without a spawn", async () => {
    const r = one();
    const calls: string[][] = [];
    await run(r, deps(stubGh(merged, calls)));
    const body = await run(r, deps(stubGh(merged, calls)), map(), () => AT + GH_STATE_TTL_MS - 1);
    expect(calls.length).toBe(1);
    expect(body.checked).toBe(1);
  });

  test("past the hour a request waits for the refresh and gets the new state", async () => {
    const r = one();
    await run(r, deps(stubGh({ [`${WIDGETS}#1`]: { state: "OPEN" } })));
    const body = await run(r, deps(stubGh(merged)), map(), () => AT + GH_STATE_TTL_MS);
    expect(body.refreshing).toBeUndefined();
    expect(body.contradictions.length).toBe(1);
  });

  test("past the hour a refresh that outlasts the wait returns the old state with refreshing", async () => {
    const r = one();
    await run(r, deps(stubGh({ [`${WIDGETS}#1`]: { state: "OPEN" } })));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const later = () => AT + GH_STATE_TTL_MS;
    const slow = deps(
      async (args) => {
        await gate;
        return stubGh(merged)(args);
      },
      { refreshWaitMs: 10 },
    );
    const waited = await run(r, slow, map(), later);
    expect(waited.refreshing).toBe(true);
    expect(waited.prs[`${WIDGETS}#1`]!.state).toBe("OPEN");
    expect(waited.contradictions).toEqual([]);
    release();
    await Bun.sleep(5);
    const after = await run(r, slow, map(), later);
    expect(after.refreshing).toBeUndefined();
    expect(after.contradictions.length).toBe(1);
  });

  test("on a cold process a refresh that outlasts the wait returns every PR unchecked with refreshing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const body = await run(
      one(),
      deps(
        async (args) => {
          await gate;
          return stubGh(merged)(args);
        },
        { refreshWaitMs: 10 },
      ),
    );
    expect(body.refreshing).toBe(true);
    expect([body.checked, body.unchecked]).toEqual([0, 1]);
    release();
  });

  test("a refresh that fails past the hour leaves the row unchecked, not checked on an old state", async () => {
    const r = one();
    await run(r, deps(stubGh(merged)));
    const body = await run(r, deps(async () => ({ exitCode: 2, stdout: "", stderr: "" })), map(), () => AT + GH_STATE_TTL_MS);
    expect([body.checked, body.unchecked, body.contradictions.length]).toEqual([0, 1, 0]);
  });

  test("a new map gets its marks without waiting for the cache", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""], [url(WIDGETS, 2), "x", "open", ""]]) });
    const calls: string[][] = [];
    const table = { ...merged, [`${WIDGETS}#2`]: { state: "CLOSED" } } as Record<string, Pr>;
    await run(r, deps(stubGh(table, calls)), map([{ title: "Old", action: "Merge #1", pages: ["plans/a.mdx"] }]));
    const n = calls.length;
    const body = await run(r, deps(stubGh(table, calls)), map([{ title: "New", action: "Close #2", pages: ["plans/a.mdx"] }]), () => AT + 1);
    expect(calls.length).toBe(n);
    expect(body.needs).toEqual([{ kind: "followup", title: "New", pr: 2, state: "CLOSED", mergedAt: null, asksForIt: true }]);
  });

  test("a PR only a new map names is looked up in that request", async () => {
    const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "open", ""]]), "plans/b.mdx": `---\ntitle: B\n---\n\nSee https://github.com/${GEARS}/pull/7 here.\n` });
    const calls: string[][] = [];
    const table = { ...merged, [`${GEARS}#7`]: { state: "MERGED", mergedAt: MERGED_AT } } as Record<string, Pr>;
    await run(r, deps(stubGh(table, calls)));
    expect(calls.length).toBe(1);
    const body = await run(r, deps(stubGh(table, calls)), map([{ title: "T", action: "Merge #7", pages: ["plans/b.mdx"] }]), () => AT + 1);
    expect(calls.length).toBe(2);
    expect(body.needs[0]!.state).toBe("MERGED");
  });
});

describe("Needs you", () => {
  const twoRepos = () =>
    wiki({
      "plans/a.mdx": page("ready", [[url(WIDGETS, 5), "x", "merged", ""], [url(WIDGETS, 6), "x", "open", ""]]),
      "plans/b.mdx": page("ready", [[url(GEARS, 5), "x", "merged", ""]]),
    });
  const table = { [`${WIDGETS}#5`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${WIDGETS}#6`]: { state: "OPEN" }, [`${GEARS}#5`]: { state: "CLOSED" } } as Record<string, Pr>;

  test("a #n that matches two repos resolves to neither", async () => {
    const m = map([{ title: "Merge #5", action: "Merge #5", pages: ["plans/a.mdx", "plans/b.mdx"] }]);
    const body = await run(twoRepos(), deps(stubGh(table)), m);
    expect(body.needs).toEqual([{ kind: "followup", title: "Merge #5", pr: 5, state: null, mergedAt: null, asksForIt: false }]);
  });

  test("a #n resolves through the item's own pages only", async () => {
    const m = map([{ title: "Merge #5", action: "Merge #5", pages: ["plans/a.mdx"] }]);
    const body = await run(twoRepos(), deps(stubGh(table)), m);
    expect(body.needs[0]).toMatchObject({ pr: 5, state: "MERGED", mergedAt: MERGED_AT, asksForIt: true });
  });

  test("an item asking for two PRs gets an entry for each, with its own state", async () => {
    const m = map([{ title: "Both", action: "Merge #5 and #6", pages: ["plans/a.mdx"] }]);
    const body = await run(twoRepos(), deps(stubGh(table)), m);
    expect(body.needs.map((n) => [n.pr, n.state, n.asksForIt])).toEqual([[5, "MERGED", true], [6, "OPEN", true]]);
  });

  test("an item that only mentions a PR does not ask for it, and a #n said twice is one entry", async () => {
    const m = map([{ title: "e2e #5 is open", action: "See what #5 changed.", pages: ["plans/a.mdx"] }]);
    const body = await run(twoRepos(), deps(stubGh(table)), m);
    expect(body.needs.map((n) => [n.pr, n.asksForIt])).toEqual([[5, false]]);
  });

  test("a page marker's anchor is no PR number, and an item with no #n has no entry", async () => {
    const m = map([{ title: "See ⟦plans/a#5.mdx⟧", action: "Merge it", pages: ["plans/a.mdx"] }]);
    expect((await run(twoRepos(), deps(stubGh(table)), m)).needs).toEqual([]);
  });

  describe("an action asks for a PR only when the whole of it is the ask", () => {
    const NUMBERS = [1, 2, 5, 369, 378, 786, 3556];
    const allMerged = Object.fromEntries(NUMBERS.map((n) => [`${WIDGETS}#${n}`, { state: "MERGED", mergedAt: MERGED_AT } as Pr]));
    const needsOf = (action: string, title = "T") =>
      run(wiki({ "plans/a.mdx": page("ready", NUMBERS.map((n) => [url(WIDGETS, n), "x", "merged", ""])) }), deps(stubGh(allMerged)), map([{ title, action, pages: ["plans/a.mdx"] }]));
    /** The page knows gears as well, so a slug-shaped word can name it. */
    const needsWithGears = (action: string) =>
      run(wiki({ "plans/a.mdx": page("ready", [[url(GEARS, 5), "x", "merged", ""], [url(WIDGETS, 6), "x", "merged", ""]]) }), deps(stubGh({ [`${GEARS}#5`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${WIDGETS}#6`]: { state: "MERGED", mergedAt: MERGED_AT } })), map([{ title: "T", action, pages: ["plans/a.mdx"] }]));

    test.each([
      // A word before the number that is no part of the PR's repo.
      "Merge gears #5",
      "Merge api #5",
      "Merge gears (#5)",
      "Close issue #5",
      "Lukk sak #5",
      "Review comment #5",
      "Merge step #786",
      "Merge unless #5",
      "Merge hvis #5",
      "Merge aldri #5",
      "Merge after #5",
      "Merge før #5",
      "Lukk når #5",
      "Merge wid #5",
      "Merge idgets #5",
      "Merge the widgets #5",
      // Not opening the action.
      "Don't then merge #5",
      "Not yet: merge #5",
      "Ikke merge #1, merge #2",
      "ikke merg #5",
      "don't merge #5",
      "do not merge #5",
      "not merge #5",
      "Please merge #5",
      "Set up the cron, merge #5",
      "Set up the cron and merge #5",
      "Release #1, merge #2",
      "Deploy it, then merge #5",
      "Run the tests, then merge #5",
      "Jeg så review #5",
      "Question: merge #5",
      "Hvis testene feiler, lukk #5",
      "Verify that the merged #786 works in prod",
      "After merging #786, set up the cron on the mini",
      "Revert merged #786",
      "Vent på reviewer for #5",
      "Se review-kommentar på #5",
      // Something after the list.
      "Merge e2e #369 og sett siden til shipped",
      "Merge #5 now",
      "Merge #5 first",
      "Merge #5 and deploy it",
      "Merge #5 så deploy",
      "Merge #5; deploy",
      "Merge #5: then deploy",
      "Merge #5. Then deploy.",
      "Merge #1, then #2",
      "Merge #1 og deploy #2",
      "Merge #1, release #2",
      "Merge #1 og lukk #2",
      "Review #786, then deploy it to prod and run the backfill",
      "Merge step #786 of the sweep",
      "Closes in release, #5 lands",
      // Punctuation the rule does not allow.
      "Merge #5?",
      "Merge #5..",
      "Merge #5.!",
      "Merge #1,",
      "Merge #1,, #2",
      "Merge #1 og",
      "**Merge #5**",
      "Merge `#5`",
      "Merge (#5)",
      "Merge #5,#x",
      // Not the verb.
      "Merged #5 needs prod",
      "merges #5",
      "merget #5",
      "merging #5",
      "reviewer #5",
      "closes #5",
      "Re-review #5",
      "preview #5",
      "Merge eller #5",
      "Merge deploy #5",
      "Merge but close #5",
      "Merge og lukk og review #5",
    ])("%s: not asked for", async (action) => {
      const { needs } = await needsOf(action);
      expect(needs.length).toBeGreaterThan(0);
      expect(needs.map((n) => n.asksForIt)).toEqual(needs.map(() => false));
    });

    test.each(["Merge a/b/gears#5", "Merge ./gears#5", "Merge gears#5", "Merge x/gears#5"])("%s is no REF, though its repo is on the page: not asked for", async (action) => {
      const { needs } = await needsWithGears(action);
      expect(needs.map((n) => n.asksForIt)).toEqual(needs.map(() => false));
      expect(needGhMarks(needs).struck).toBe(false);
    });

    test.each([
      ["Merge #5", [5]],
      ["merg #5", [5]],
      ["Lukk #5", [5]],
      ["Close #5", [5]],
      ["Godkjenn #5", [5]],
      ["Approve #5", [5]],
      ["Review #5", [5]],
      ["MERGE #5", [5]],
      ["Merge #5.", [5]],
      ["Merge #5!", [5]],
      ["  Merge #5  ", [5]],
      ["Merge PR #369", [369]],
      ["merge pr #369", [369]],
      ["Merge widgets #369", [369]],
      ["Merge WIDGETS #369", [369]],
      ["merge eller lukk #378", [378]],
      ["merge or close #378", [378]],
      ["merge og lukk #378", [378]],
      ["review and approve #378", [378]],
      ["merge eller lukk PR #378", [378]],
      ["Merge #1 og #2", [1, 2]],
      ["Merge #1 and #2", [1, 2]],
      ["Merge #1, #2", [1, 2]],
      ["Merge #1 & #2", [1, 2]],
      ["Merge #1, #2 and #5", [1, 2, 5]],
      ["Merge #1 og #2 & #5", [1, 2, 5]],
      ["Merge PR #1 og #2", [1, 2]],
      ["Merge widgets #1, #2", [1, 2]],
      ["Merge acme/widgets#5", [5]],
      ["Merge https://github.com/acme/widgets/pull/5", [5]],
      ["Merge PR https://github.com/acme/widgets/pull/5", [5]],
      ["Merge #1 og https://github.com/acme/widgets/pull/2", [1, 2]],
      ["Merge acme/widgets#1 og #2", [1, 2]],
    ] as const)("%s: asked for", async (action, prs) => {
      const { needs } = await needsOf(action);
      expect(needs.map((n) => [n.pr, n.asksForIt])).toEqual(prs.map((n) => [n, true]));
    });

    test("every word of the rule applies to a repo with dashes: one token, or the whole name", async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url("navikt/melosys-e2e-tests", 369), "x", "merged", ""], [url("navikt/melosys-api", 3556), "x", "merged", ""]]) });
      const gh = stubGh({ "navikt/melosys-e2e-tests#369": { state: "MERGED", mergedAt: MERGED_AT }, "navikt/melosys-api#3556": { state: "MERGED", mergedAt: MERGED_AT } });
      const asks = async (action: string) => {
        __resetGhCheckForTest();
        return (await run(r, deps(gh), map([{ title: "T", action, pages: ["plans/a.mdx"] }]))).needs.map((n) => n.asksForIt);
      };
      for (const action of ["Merge e2e #369", "Merge tests #369", "Merge melosys-e2e-tests #369", "Merge api #3556", "Merge navikt/melosys-api#3556"]) expect(await asks(action)).toEqual([true]);
      for (const action of ["Merge e2 #369", "Merge melosys-e2e #369", "Merge e2e-tests #369", "Merge api #369", "Merge e2e #3556", "Merge navikt #369"]) expect(await asks(action)).toEqual([false]);
    });

    test("a qualifier is read against the PR it stands before, not the others in the list", async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "merged", ""], [url(GEARS, 2), "x", "merged", ""]]) });
      const gh = stubGh({ [`${WIDGETS}#1`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${GEARS}#2`]: { state: "MERGED", mergedAt: MERGED_AT } });
      const asks = async (action: string) => {
        __resetGhCheckForTest();
        return (await run(r, deps(gh), map([{ title: "T", action, pages: ["plans/a.mdx"] }]))).needs.map((n) => n.asksForIt);
      };
      expect(await asks("Merge widgets #1 og #2")).toEqual([true, true]);
      expect(await asks("Merge gears #1 og #2")).toEqual([false]);
    });

    test.each(["merge", "close", "review", "lukk"])("a repo named %s does not swallow the plain verb", async (repo) => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 5), "x", "merged", ""], [url(`acme/${repo}`, 7), "x", "merged", ""]]) });
      const gh = stubGh({ [`${WIDGETS}#5`]: { state: "MERGED", mergedAt: MERGED_AT }, [`acme/${repo}#7`]: { state: "OPEN" } });
      const verb = repo[0]!.toUpperCase() + repo.slice(1);
      const body = await run(r, deps(gh), map([{ title: `${verb} #5`, action: `${verb} #5`, pages: ["plans/a.mdx"] }]));
      expect(body.needs.map((n) => [n.pr, n.state, n.asksForIt])).toEqual([[5, "MERGED", true]]);
    });

    test("that repo's own PR can still be asked for by its name", async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url("acme/merge", 7), "x", "merged", ""]]) });
      const body = await run(r, deps(stubGh({ "acme/merge#7": { state: "MERGED", mergedAt: MERGED_AT } })), map([{ title: "T", action: "Merge merge #7", pages: ["plans/a.mdx"] }]));
      expect(body.needs.map((n) => [n.pr, n.asksForIt])).toEqual([[7, true]]);
    });

    test.each(["Merge #9", "Merge #5 og #9", "Merge #9 og #5"])("%s: a #n the page does not know resolves to no PR, so nothing is asked", async (action) => {
      const { needs } = await needsOf(action);
      expect(needs.map((n) => n.asksForIt)).toEqual(needs.map(() => false));
    });

    test("a page marker after the PR adds no step; one between verb and PR keeps it unasked", async () => {
      const on = (action: string) => run(wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 5), "x", "merged", ""]]) }), deps(stubGh(allMerged)), map([{ title: "T", action, pages: ["plans/a.mdx"] }]));
      for (const [action, want] of [["Merge #5 ⟦plans/a.mdx⟧", true], ["Merge #5 ⟦plans/a.mdx⟧.", true], ["Merge #5. ⟦plans/a.mdx⟧", true], ["Merge #5 ⟦plans/a.mdx⟧ ⟦plans/b.mdx⟧", true], ["Merge ⟦plans/a.mdx⟧ #5", false], ["Merge #5 ⟦plans/a.mdx⟧!!", false], ["Merge #5. ⟦plans/a.mdx⟧.", false]] as const) {
        __resetGhCheckForTest();
        expect([action, (await on(action)).needs[0]!.asksForIt]).toEqual([action, want]);
      }
    });

    test.each([
      ["Merge e2e #369 og sett siden til shipped", "GitHub: #369 merged"],
      ["Release #3556 to prod", "GitHub: #3556 merged"],
      ["Vent på release av #3556", "GitHub: #3556 merged"],
      ["Merge #5 now", "GitHub: #5 merged"],
    ])("%s: a neutral note, not struck", async (action, text) => {
      const m = needGhMarks((await needsOf(action)).needs);
      expect(m.struck).toBe(false);
      expect(m.notes.map((n) => [n.tone, n.text.replace(/ \d+\.\d+$/, "")])).toEqual([["info", text]]);
    });

    test("two PRs asked for are done only when both are merged", async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 1), "x", "merged", ""], [url(WIDGETS, 2), "x", "open", ""]]) });
      const m = map([{ title: "T", action: "Merge #1 og #2", pages: ["plans/a.mdx"] }]);
      const open = await run(r, deps(stubGh({ [`${WIDGETS}#1`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${WIDGETS}#2`]: { state: "OPEN" } })), m);
      expect(needGhMarks(open.needs).struck).toBe(false);
      __resetGhCheckForTest();
      const both = await run(r, deps(stubGh({ [`${WIDGETS}#1`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${WIDGETS}#2`]: { state: "MERGED", mergedAt: MERGED_AT } })), m);
      expect(needGhMarks(both.needs).struck).toBe(true);
    });

    describe("the length cap", () => {
      const fill = (action: string, at: number) => action.replace(" ", " ".repeat(at - action.length + 1));

      test("200 characters may ask, 201 may not", async () => {
        const fits = fill("Merge #5", 200);
        expect(fits.length).toBe(200);
        expect((await needsOf(fits)).needs.map((n) => n.asksForIt)).toEqual([true]);
        __resetGhCheckForTest();
        const over = fill("Merge #5", 201);
        expect(over.length).toBe(201);
        expect((await needsOf(over, "#5")).needs.map((n) => n.asksForIt)).toEqual([false]);
      });

      test("the cap reads the trimmed action", async () => {
        expect((await needsOf(`${" ".repeat(300)}Merge #5`)).needs.map((n) => n.asksForIt)).toEqual([true]);
      });

      test("an over-long action names nothing, and the title still does", async () => {
        const action = `Merge #5 ${"x".repeat(300)}`;
        expect((await needsOf(action)).needs).toEqual([]);
        __resetGhCheckForTest();
        expect((await needsOf(action, "Land #5")).needs.map((n) => [n.pr, n.asksForIt])).toEqual([[5, false]]);
      });

      test("an over-long title names nothing either", async () => {
        expect((await needsOf("Se på saken", `#5 ${"x".repeat(300)}`)).needs).toEqual([]);
      });

      const HUGE = 100_000;
      test.each<[string, { title?: string; action?: string; why?: string }]>([
        ["an alphanumeric run in the action", { action: "a".repeat(HUGE) }],
        ["an alphanumeric run in the title", { title: "a".repeat(HUGE) }],
        ["a whitespace run in the action", { action: `Merge #5${" ".repeat(HUGE)}x` }],
        ["a whitespace run before a marker", { action: `Merge #5${" ".repeat(HUGE)}⟦a⟧` }],
        ["a dash run in the action", { action: "-".repeat(HUGE) }],
        ["a run of open markers in the action", { action: "⟦".repeat(HUGE) }],
        ["a run of open markers in the title", { title: "⟦".repeat(HUGE) }],
        ["a run of open markers in the why", { action: "Merge #5", why: "⟦".repeat(HUGE) }],
      ])("%s of 100k characters is fast", async (_name, item) => {
        const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 5), "x", "merged", ""]]) });
        const m = map([{ title: "T", action: "", pages: ["plans/a.mdx"], ...item }]);
        const started = performance.now();
        await run(r, deps(stubGh(allMerged)), m);
        expect(performance.now() - started).toBeLessThan(1000);
      });
    });
  });

  describe("an item's PR is the one it names", () => {
    const widgetsOnly = () => wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 5), "x", "merged", ""], [url(WIDGETS, 6), "x", "merged", ""]]) });
    const gearsElsewhere = () => wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 5), "x", "merged", ""], [url(GEARS, 9), "x", "merged", ""]]) });
    const merged = { [`${WIDGETS}#5`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${WIDGETS}#6`]: { state: "MERGED", mergedAt: MERGED_AT }, [`${GEARS}#5`]: { state: "CLOSED" }, [`${GEARS}#9`]: { state: "MERGED", mergedAt: MERGED_AT } } as Record<string, Pr>;
    const item = (action: string, pages = ["plans/a.mdx"]) => map([{ title: "T", action, pages }]);
    const brief = (needs: { pr: number; state: unknown; asksForIt: boolean }[]) => needs.map((n) => [n.pr, n.state, n.asksForIt]);

    test.each(["Merge acme/gears#5", "Merge ACME/gears#5"])("%s on a page knowing only another repo's #5: no entry", async (action) => {
      expect((await run(widgetsOnly(), deps(stubGh(merged)), item(action))).needs).toEqual([]);
    });

    test.each(["Merge gears #5", "Merge gears#5"])("%s where the page knows gears but not its #5: no entry", async (action) => {
      expect((await run(gearsElsewhere(), deps(stubGh(merged)), item(action))).needs).toEqual([]);
    });

    test.each(["Merge acme/gears#5", "Merge ACME/Gears#5", "Merge gears #5", "Merge GEARS #5"])("%s on a page knowing both repos: the named one", async (action) => {
      expect(brief((await run(twoRepos(), deps(stubGh(table)), item(action, ["plans/a.mdx", "plans/b.mdx"]))).needs)).toEqual([[5, "CLOSED", true]]);
    });

    test("a glued short name is the named repo's entry, and is no REF, so it asks nothing", async () => {
      expect(brief((await run(twoRepos(), deps(stubGh(table)), item("Merge gears#5", ["plans/a.mdx", "plans/b.mdx"]))).needs)).toEqual([[5, "CLOSED", false]]);
    });

    test("a known short name with no such PR keeps another PR in the item from being struck", async () => {
      const body = await run(gearsElsewhere(), deps(stubGh(merged)), item("Merge gears #7 og #5"));
      expect(brief(body.needs)).toEqual([[5, "MERGED", false]]);
    });

    test("a short name two owners share resolves to neither", async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url("acme/gears", 5), "x", "merged", ""], [url("other/gears", 5), "x", "merged", ""]]) });
      expect(brief((await run(r, deps(stubGh({ "acme/gears#5": { state: "MERGED" }, "other/gears#5": { state: "MERGED" } })), item("Merge gears #5"))).needs)).toEqual([[5, null, false]]);
    });

    test("a word that is no repo on the page leaves the bare form's rule", async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url("navikt/melosys-e2e-tests", 369), "x", "merged", ""]]) });
      expect(brief((await run(r, deps(stubGh({ "navikt/melosys-e2e-tests#369": { state: "MERGED", mergedAt: MERGED_AT } })), item("Merge e2e #369"))).needs)).toEqual([[369, "MERGED", true]]);
    });

    test.each(["see foo.md#5", "https://example.test/x#5", "https://example.test/?a=#5", "#5.2 merge", "x#5", "/#5", "docs/foo.md#5", "#5x", "#5_x", "&#5;", "a.#5"])("%s is no PR", async (action) => {
      expect((await run(widgetsOnly(), deps(stubGh(merged)), item(action))).needs).toEqual([]);
    });

    test("a number after an ordinary word stays a bare #n and is never struck", async () => {
      const r = wiki({ "plans/a.mdx": page("ready", [[url(WIDGETS, 12), "x", "merged", ""]]) });
      const body = await run(r, deps(stubGh({ [`${WIDGETS}#12`]: { state: "MERGED", mergedAt: MERGED_AT } })), item("color #12 merge"));
      expect(brief(body.needs)).toEqual([[12, "MERGED", false]]);
      expect(needGhMarks(body.needs).struck).toBe(false);
    });

    test.each([
      ["Merge https://github.com/acme/other/pull/44", true],
      ["Merge http://www.github.com/acme/other/pull/44", true],
      ["Merge [#44](https://github.com/acme/other/pull/44)", false],
      ["Merge https://github.com/acme/other/pull/44/files", false],
    ] as const)("%s is that PR, known to the page or not, one entry; only the plain URL is a REF", async (action, asks) => {
      const calls: string[][] = [];
      const body = await run(widgetsOnly(), deps(stubGh({ ...merged, "acme/other#44": { state: "MERGED", mergedAt: MERGED_AT } }, calls)), item(action));
      expect(brief(body.needs)).toEqual([[44, "MERGED", asks]]);
      expect(calls.some((c) => c.includes("repo=other"))).toBe(true);
    });

    test("a URL to a PR that does not exist on GitHub is not struck", async () => {
      const body = await run(widgetsOnly(), deps(stubGh(merged)), item("Merge https://github.com/acme/other/pull/44"));
      expect(brief(body.needs)).toEqual([[44, null, true]]);
      expect(needGhMarks(body.needs).struck).toBe(false);
    });

    test.each(["Merge acme/gears#7 og #5", "Merge #5 og x#6"])("%s: a named PR with no entry keeps the other from being struck", async (action) => {
      const body = await run(widgetsOnly(), deps(stubGh(merged)), item(action));
      expect(brief(body.needs)).toEqual([[5, "MERGED", false]]);
      expect(needGhMarks(body.needs).struck).toBe(false);
    });

    test("the title's bare #5 is the action's named PR, not a second one", async () => {
      const m = map([{ title: "Land #5", action: "Merge gears #5", pages: ["plans/a.mdx", "plans/b.mdx"] }]);
      expect(brief((await run(twoRepos(), deps(stubGh(table)), m)).needs)).toEqual([[5, "CLOSED", true]]);
    });
  });

  const merge12 = map([{ title: "T", action: "Merge #12", pages: ["plans/p.mdx"] }]);
  const gh12 = stubGh({ [`${GEARS}#12`]: { state: "MERGED", mergedAt: MERGED_AT } });

  test("the page ref index alone resolves a number", async () => {
    const r = wiki({ "plans/p.mdx": `---\ntitle: Plain\nprs: [acme/gears#12]\n---\n\nBody.\n` });
    expect((await run(r, deps(gh12), merge12)).needs[0]!.state).toBe("MERGED");
  });

  test("a ledger link alone resolves a number", async () => {
    const r = wiki({ "plans/p.mdx": page("ready", [[url(GEARS, 12), "x", "open", ""]]) });
    // The index also reads that link from the body, so it is taken away here.
    const noIndexRefs: GhCheckDeps["index"] = async (root) => {
      const index = await getWikiIndex({ root, refresh: true });
      for (const p of index?.pages ?? []) delete p.prRefs;
      return index;
    };
    const body = await run(r, deps(gh12, { index: noIndexRefs }), merge12);
    expect(body.needs[0]).toMatchObject({ pr: 12, state: "MERGED" });
  });
});

describe("spawnGhRunner", () => {
  const script = (text: string) => {
    const dir = testTempDirSync(path.join(tmpdir(), "gh-runner-"));
    const file = path.join(dir, "gh");
    writeFileSync(file, `#!/bin/sh\n${text}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  test("a missing binary says so", async () => {
    const res = await spawnGhRunner("/no/such/gh-binary")(["x"]);
    expect(res.noBinary).toBe(true);
    expect(readGhAnswer(res, [1]).failure).toBe("no-gh");
  });

  test("arguments arrive as one array, unsplit and unexpanded", async () => {
    const res = await spawnGhRunner(script('printf "%s|" "$@"; echo err >&2; exit 1'))(["a b", "$HOME", "c"]);
    expect(res).toEqual({ exitCode: 1, stdout: "a b|$HOME|c|", stderr: "err\n" });
  });

  describe("the child's environment", () => {
    const ALLOWED = ["PATH", "HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"];
    const EXCLUDED = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "DATABASE_URL", "TELEGRAM_BOT_TOKEN_JARVIS", "SLACK_BOT_TOKEN_JARVIS"];
    const MODULE = path.join(import.meta.dir, "gh-check.ts");

    /** The runner in a muninn-like process that STARTED with this env (a later
     *  `process.env` write does not reach Bun's default spawn env), printing what
     *  its own child printed. */
    async function inProcess(set: Record<string, string | undefined>, bin: string): Promise<{ stdout: string; noBinary?: boolean; failure?: string }> {
      const code = `import { spawnGhRunner, readGhAnswer } from ${JSON.stringify(MODULE)};
        const r = await spawnGhRunner(${bin})([]);
        process.stdout.write(JSON.stringify({ stdout: r.stdout, noBinary: r.noBinary, failure: readGhAnswer(r, [1]).failure }));`;
      const env = Object.fromEntries(Object.entries({ ...process.env, ...set }).filter(([, v]) => v !== undefined)) as Record<string, string>;
      const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      if (!out) throw new Error(`the process printed nothing: ${err}`);
      return JSON.parse(out);
    }

    /** What a real child sees: `/usr/bin/env` through the runner. */
    async function childEnv(set: Record<string, string | undefined>): Promise<Map<string, string>> {
      const { stdout } = await inProcess(set, '"/usr/bin/env"');
      return new Map(stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    }

    for (const name of ALLOWED) {
      test(`${name} arrives, as muninn has it`, async () => {
        expect((await childEnv({ [name]: `/sentinel/${name}` })).get(name)).toBe(`/sentinel/${name}`);
      });
    }

    for (const name of EXCLUDED) {
      test(`${name} does not arrive`, async () => {
        expect((await childEnv({ [name]: "secret" })).has(name)).toBe(false);
      });
    }

    test("nothing else arrives, and a name muninn does not have stays unset", async () => {
      const env = await childEnv({ HOME: "/sentinel/home", GH_CONFIG_DIR: "/sentinel/gh", XDG_CONFIG_HOME: undefined, SOME_OTHER_SECRET: "secret" });
      expect([...env.keys()].sort()).toEqual(["GH_CONFIG_DIR", "HOME", "PATH"]);
    });

    test("the default binary is found on muninn's PATH and gets the same env", async () => {
      const dir = path.dirname(script('echo "token=${GH_TOKEN:-none} home=$HOME"'));
      const res = await inProcess({ PATH: dir, GH_TOKEN: "secret", HOME: "/sentinel/home" }, "");
      expect(res.stdout.trim()).toBe("token=none home=/sentinel/home");
    });

    test("a PATH without gh is still no-gh", async () => {
      const res = await inProcess({ PATH: testTempDirSync(path.join(tmpdir(), "gh-nopath-")) }, "");
      expect(res.noBinary).toBe(true);
      expect(res.failure).toBe("no-gh");
    });
  });

  test("the call's own process is gone after its timeout", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "gh-runner-pid-"));
    const pidFile = path.join(dir, "pid");
    const res = await spawnGhRunner(script(`echo $$ > ${pidFile}\nexec sleep 30`), 500)([]);
    expect(res.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // The kill is sent before the race resolves, and the reap follows it.
      for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(50);
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid, "SIGKILL");
    }
  });

  test("a hung call is killed at its timeout, even with a child holding the pipes", async () => {
    const start = Date.now();
    const res = await spawnGhRunner(script("sleep 30"), 50)([]);
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(readGhAnswer(res, [1]).unanswered).toBe(true);
  });
});
