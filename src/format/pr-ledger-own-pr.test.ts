import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { findGlanceLedger, findLedgers, firstRowPerPr, pageLedgers, parseLedgerTable, prStateMap } from "./pr-ledger.ts";

// A row's own PR, the one the GitHub check compares its state with. Made-up repos.
describe("LedgerRow.ownPr", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const B = "[#2](https://github.com/acme/b/pull/2)";
  const own = (header: string[], cells: string[]) => parseLedgerTable(header, [cells]).rows[0]!;
  const OWN_A = { repo: "acme/a", n: 1 };

  test("first cell, then the PR column, then Landed", () => {
    expect(own(["Slate", "PR", "Landed", "State"], [A, B, B, "open"]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "PR", "Landed", "State"], ["3 x", A, B, "open"]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "Landed", "State"], ["3 x", A, "merged"]).ownPr).toEqual(OWN_A);
  });

  test("the state cell counts when the word opening it set the state", () => {
    expect(own(["Slate", "State"], ["3 x", `merged in ${A}`]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "State"], ["3 x", `open ${A}`]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "State"], ["3 x", "[merget](https://github.com/acme/a/pull/1)"]).ownPr).toEqual(OWN_A);
  });

  test("not when the state word comes later, or another word set the state", () => {
    expect(own(["Slate", "State"], ["3 x", `see ${A}, then merged ${B}`]).ownPr).toBeUndefined();
    expect(own(["Slate", "State"], ["3 x", `blocked by ${A}; open ${B}`]).ownPr).toBeUndefined();
  });

  test("a PR in another cell is not the row's, though `link` reads it", () => {
    const row = own(["Slate", "What", "State", "Depends on", "Touches"], ["3 x", "y", "open", A, B]);
    expect(row.link).toBe(1);
    expect(row.ownPr).toBeUndefined();
  });

  test("a bare number, a non-GitHub URL and a struck link are none", () => {
    expect(own(["PR", "State"], ["PR #7", "open"]).ownPr).toBeUndefined();
    expect(own(["PR", "State"], ["[#7](https://example.test/acme/a/pull/7)", "open"]).ownPr).toBeUndefined();
    expect(own(["PR", "State"], [`3 ~~${A}~~`, "open"]).ownPr).toBeUndefined();
  });

  test("the field is absent, not null, on a row with none", () => {
    expect("ownPr" in own(["PR", "State"], ["PR #7", "open"])).toBe(false);
  });
});

// The GitHub check reads every row of a ledger; every other reader keeps the numbered rows.
describe("the everyRow read", () => {
  const H = ["PR", "State"];
  const ROWS = [["**P3 — no number**", "not started"], ["7 — numbered", "open"], ["[KEY-1](https://example.test/KEY-1)", "see [[owner]]"]];
  const MD = `**PR ledger.**\n\n| PR | State |\n|---|---|\n${ROWS.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;

  test("keeps a row with no number, its pr null", () => {
    const rows = parseLedgerTable(H, ROWS, "ledger", { everyRow: true }).rows;
    expect(rows.map((r) => r.pr)).toEqual([null, 7, null]);
    expect(rows[0]).toMatchObject({ slate: null, link: null, state: "not-started", label: "P3 — no number" });
  });

  test("findLedgers and pageLedgers pass it on", () => {
    const blocks = parseBlocks(MD);
    expect(findLedgers(blocks, { everyRow: true })[0]!.rows).toHaveLength(3);
    expect(pageLedgers(blocks, false, { everyRow: true })[0]!.rows).toHaveLength(3);
  });

  test("every other reader keeps today's parse: the numbered rows, and the share over them", () => {
    const blocks = parseBlocks(MD);
    for (const l of [parseLedgerTable(H, ROWS), findLedgers(blocks)[0]!, pageLedgers(blocks)[0]!, pageLedgers(blocks, true)[0]!]) {
      expect(l.rows.map((r) => r.pr)).toEqual([7]);
      expect([l.parsedShare, l.draws]).toEqual([1, true]);
    }
    expect(firstRowPerPr([parseLedgerTable(H, ROWS)]).map((r) => r.pr)).toEqual([7]);
    expect(prStateMap([parseLedgerTable(H, ROWS)])).toEqual(new Map([[7, "open"]]));
  });

  describe("a glance table", () => {
    const GLANCE = "### At a glance\n\n| PR | What |\n|---|---|\n| 1 — a | x |\n| Later | y |\n";

    test("keeps a row with no number for the check, planned by source", () => {
      const rows = pageLedgers(parseBlocks(GLANCE), true, { everyRow: true })[0]!.rows;
      expect(rows.map((r) => [r.pr, r.state, r.claimedState])).toEqual([[1, "planned", "planned"], [null, "planned", "planned"]]);
      expect(findGlanceLedger(parseBlocks(GLANCE), { everyRow: true })!.rows).toHaveLength(2);
    });

    test("every other reader's rows stay the numbered ones", () => {
      expect(pageLedgers(parseBlocks(GLANCE), true)[0]!.rows.map((r) => r.pr)).toEqual([1]);
      expect(findGlanceLedger(parseBlocks(GLANCE))!.rows.map((r) => r.pr)).toEqual([1]);
    });
  });
});

// A header such as `Status og PR-er` says its cell holds the state, among other things.
describe("a header that opens with a state word", () => {
  const LINKED = "[[owner]]";
  const ledger = (headers: string[], opts = { everyRow: true }) => parseLedgerTable(headers, [headers.map(() => LINKED)], "ledger", opts);

  test.each([
    ["Status og PR-er", 1],
    ["status: PR", 1],
    ["Tilstand og PR", 1],
    ["State and PRs", 1],
    ["**Status** og PR-er", 1],
  ])("%s is the state column for the check", (header, column) => {
    expect(ledger(["Sak", header]).stateColumn).toBe(column);
  });

  test.each(["Statuses", "Statusbar", "Status-log", "Stateful", "Prior status", "Tilstander"])("%s is not", (header) => {
    expect(ledger(["Sak", header]).stateColumn).toBe(-1);
  });

  test("a header that is the state alone wins over one that opens with it", () => {
    expect(ledger(["Sak", "Status og PR-er", "State"]).stateColumn).toBe(2);
  });

  test("its cell sets the state for the check, and only for the check", () => {
    const cells = [["1 a", "merged"]];
    const check = parseLedgerTable(["Sak", "Status og PR-er"], cells, "ledger", { everyRow: true });
    expect(check.rows[0]!.state).toBe("merged");
    const other = parseLedgerTable(["Sak", "Status og PR-er"], cells);
    expect(other.stateColumn).toBe(-1);
    expect(other.rows[0]!.state).toBe("unknown");
    expect(other.draws).toBe(false);
  });
});

describe("a link in the state cell", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const B = "[#2](https://github.com/acme/b/pull/2)";
  const own = (state: string) => parseLedgerTable(["Slate", "State"], [["3 x", state]]).rows[0]!;
  const OWN_A = { repo: "acme/a", n: 1 };
  const OWN_B = { repo: "acme/b", n: 2 };

  test.each([
    [`merged ${A}`],
    [`merged  ${A}`],
    [`merged (${A})`],
    [`merged: ${A}`],
    [`merged — ${A}`],
    [`merged, ${A}`],
    [`Merged In ${A}`],
    ['merged [#1](https://github.com/acme/a/pull/1 "the title")'],
    [`merged 2026-10-30, ${A}`],
    [`merged 24.10 (${A})`],
    [`merged 02.11, ${A}`],
    [`**merged** ${A}`],
    [`_merged_ ${A}`],
    [`merged in ${A}`],
    [`merget i ${A}`],
    ["merged https://github.com/acme/a/pull/1"],
    ["[merget](https://github.com/acme/a/pull/1)"],
  ])("%s is the row's own", (state) => {
    expect(own(state).ownPr).toEqual(OWN_A);
  });

  test.each([
    [`open, waits on ${A}`],
    [`open (blocked by ${A})`],
    [`open, see ${A}`],
    [`open — after ${A}`],
    [`open follow-up ${A}`],
    [`merged into ${A}`],
    [`merged 3 days ago ${A}`],
    [`merged 3 ${A}`],
    [`open, merged ${A}`],
    [`open, ${A}; merged ${B}`],
    [`merged 2026-10-30x ${A}`],
    [`merged [notes](https://example.test/n) ${A}`],
  ])("%s is not", (state) => {
    expect(own(state).ownPr).toBeUndefined();
  });

  test("the URL is read raw: `__` in a slug is part of the slug", () => {
    const OWN = { repo: "acme/my__repo", n: 1 };
    expect(own("open [#1](https://github.com/acme/my__repo/pull/1)").ownPr).toEqual(OWN);
    expect(own("merged https://github.com/acme/my__repo/pull/1").ownPr).toEqual(OWN);
    expect(own("[merget](https://github.com/acme/my__repo/pull/1)").ownPr).toEqual(OWN);
    expect(own("**merged** [#1](https://github.com/acme/my__repo/pull/1)").ownPr).toEqual(OWN);
    expect(own("__merged__ [#1](https://github.com/acme/my__repo/pull/1)").ownPr).toEqual(OWN);
    expect(own("merged **[#1](https://github.com/acme/my__repo/pull/1)**").ownPr).toEqual(OWN);
  });

  test("links run on only with nothing but punctuation between", () => {
    expect(own(`merged ${A}, ${B}`).ownPrs).toEqual([OWN_A, OWN_B]);
    expect(own(`merged ${A}, waits on ${B}`).ownPrs).toEqual([OWN_A]);
    expect(own(`merged in ${A} in ${B}`).ownPrs).toEqual([OWN_A]);
    expect(own(`merged ${A}, ${A}`).ownPrs).toEqual([OWN_A]);
    expect(own("[merget](https://github.com/acme/a/pull/1), [#2](https://github.com/acme/b/pull/2)").ownPrs).toEqual([OWN_A, OWN_B]);
  });
});

describe("a cell linking several PRs", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const B = "[#2](https://github.com/acme/b/pull/2)";
  const row = (header: string[], cells: string[]) => parseLedgerTable(header, [cells]).rows[0]!;

  test("all are the row's own, in order, the first still ownPr", () => {
    const r = row(["PR", "State"], [`${A}, ${B}`, "open"]);
    expect(r.ownPrs).toEqual([{ repo: "acme/a", n: 1 }, { repo: "acme/b", n: 2 }]);
    expect(r.ownPr).toEqual({ repo: "acme/a", n: 1 });
  });

  test("the first cell holding one decides: a later cell adds nothing", () => {
    expect(row(["Slate", "PR", "State"], [A, B, "open"]).ownPrs).toEqual([{ repo: "acme/a", n: 1 }]);
    expect(row(["Slate", "PR", "Landed", "State"], ["3", `${B} ${A}`, A, "open"]).ownPrs).toEqual([{ repo: "acme/b", n: 2 }, { repo: "acme/a", n: 1 }]);
    expect(row(["Slate", "Landed", "State"], ["3", `${A} ${B}`, "open"]).ownPrs).toHaveLength(2);
  });

  test("the same PR twice, in any case, is one", () => {
    expect(row(["PR", "State"], [`${A} ${A.replace("acme", "ACME")}`, "open"]).ownPrs).toEqual([{ repo: "acme/a", n: 1 }]);
  });

  test("a row with none has neither field", () => {
    const r = row(["PR", "State"], ["PR #7", "open"]);
    expect("ownPrs" in r).toBe(false);
    expect("ownPr" in r).toBe(false);
  });
});

describe("claimedState: what the GitHub check compares", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const one = (state: string) => parseLedgerTable(["Slate", "State"], [["3 x", state]]).rows[0]!;

  const NINE = "[#9](https://github.com/acme/a/pull/9)";
  const own1 = (state: string) => parseLedgerTable(["PR", "State"], [[A, state]]).rows[0]!;

  // Anything but the rule: the cell is about something else. `state` stays, the strip reads it.
  test.each([
    ["open follow-up: rail polish", "open"],
    ["planned next: more", "planned"],
    ["not started yet", "not-started"],
    ["ikke startet ennå", "not-started"],
    ["open Ærlig talt", "open"],
    ["**open** follow-up", "open"],
    ["_open_ follow-up", "open"],
    ["*open* follow-up", "open"],
    ["open `follow-up`", "open"],
    ["open [the follow-up](https://example.test/f)", "open"],
    ["open [[plans/follow-up]]", "open"],
    ["[åpen](https://example.test/x) follow-up", "open"],
    ["open 3 follow-ups", "open"],
    ['open "later"', "open"],
    ["open/blocked", "open"],
    ["open.", "open"],
    ["open; waiting", "open"],
    ["open -x", "open"],
    ["open 3", "open"],
    ["open 2026-10-01 later", "open"],
    ["open 2026-10-01x", "open"],
  ])("%s reads unknown", (cell, parsed) => {
    expect(one(cell).claimedState).toBe("unknown");
    expect(one(cell).state).toBe(parsed as never);
  });

  // The ref must be the row's own; another PR means the cell is about that PR.
  test.each([
    ["open follow-up #9"],
    ["planned next #9"],
    ["open #9"],
    ["open PR #9"],
    ["open a #9"],
    ["open acme/a#9"],
    ["open acme/b#1"],
    ["open b #1"],
    ["open follow-up #1"],
    // A row's own PR is a full URL, so only a link can be checked against it.
    ["open #1"],
    ["open PR #1"],
    ["open a #1"],
    ["open acme/a#1"],
    [`open ${NINE}`],
    [`open ${A} ${NINE}`],
    ["open https://github.com/acme/a/pull/9"],
    ["open [#1](https://github.com/acme/b/pull/1)"],
    ["open [#1](https://example.test/1)"],
    [`open: ${NINE}`],
    [`open, ${NINE}`],
    [`open (${NINE})`],
    [`open — ${NINE}`],
    [`open – ${NINE}`],
    [`open - ${NINE}`],
    ["open, #9 is the follow-up"],
    ["open, PR #9 is the follow-up"],
    ["open: acme/a#9"],
    ["open (a #9)"],
    ["open, [#9](https://example.test/9)"],
    ["[åpen](https://github.com/acme/a/pull/9)"],
    ["[åpen](https://example.test/pull/1)"],
  ])("%s on own #1 reads unknown", (cell) => {
    expect(own1(cell).ownPr).toEqual({ repo: "acme/a", n: 1 });
    expect(own1(cell).claimedState).toBe("unknown");
  });

  test.each([
    ["open", "open"],
    ["planned", "planned"],
    ["not started", "not-started"],
    ["ikke startet", "not-started"],
    ["åpen", "open"],
    ["planlagt", "planned"],
    ["open, awaiting review", "open"],
    ["open: awaiting review", "open"],
    ["open — awaiting review", "open"],
    ["open – awaiting review", "open"],
    ["open - awaiting review", "open"],
    ["open (awaiting review)", "open"],
    ["open,awaiting", "open"],
    ["open -", "open"],
    ["**open** — awaiting", "open"],
    ["__open__ — awaiting", "open"],
    ["_open_, awaiting", "open"],
    ["open 2026-10-01", "open"],
    ["open 24.10", "open"],
    ["open 2026-10-01, later", "open"],
    ["[åpen](https://example.test/x)", "open"],
    ["[åpen](https://example.test/x) — venter", "open"],
    ["planned: more", "planned"],
    ["not started, waits", "not-started"],
    [`open ${A}`, "open"],
  ])("%s keeps its state", (cell, want) => {
    expect(one(cell).claimedState).toBe(want as never);
  });

  // A ref to the row's own PR, in each spelling, and whatever follows a separator.
  test.each([
    [`open ${A}`],
    ["open [#1](https://github.com/ACME/A/pull/1)"],
    ["open https://github.com/acme/a/pull/1"],
    [`open ${A} 2026-10-01`],
    [`open ${A} 2026-10-01 - waits`],
    [`open ${A} - waits`],
    [`open ${A} — waits`],
    [`open ${A} – waits`],
    [`open ${A}: waits`],
    [`open ${A}, waits on ${NINE}`],
    [`open ${A} (blocked by ${NINE})`],
    [`open: ${A} waits`],
    [`open (${A})`],
    [`open, waits on ${NINE}`],
    [`open (blocked by ${NINE})`],
    ["open, klar for review #9"],
    ["[åpen](https://github.com/acme/a/pull/1)"],
    ["[åpen](https://github.com/acme/a/pull/1), venter"],
    [`åpen: [a #1](https://github.com/acme/a/pull/1) venter`],
  ])("%s on own #1 keeps open", (cell) => {
    expect(own1(cell).claimedState).toBe("open");
  });

  test("a link text says nothing: the URL decides", () => {
    const row = (state: string) => parseLedgerTable(["PR", "State"], [["[#4](https://github.com/acme/foo-e2e-tests/pull/4)", state]]).rows[0]!.claimedState;
    expect(row("åpen: [e2e #4](https://github.com/acme/foo-e2e-tests/pull/4) venter")).toBe("open");
    expect(row("åpen: [e2e #4](https://github.com/acme/foo-e2e-tests/pull/9) venter")).toBe("unknown");
  });

  test("past a separator a link that is no PR is just words", () => {
    expect(own1("open, [notes](https://example.test/n) soon").claimedState).toBe("open");
    expect(own1("open: https://example.test/n").claimedState).toBe("open");
    expect(own1("open: https://github.com/acme/a/pull/9").claimedState).toBe("unknown");
  });

  test("when the cell itself sets the own PR, its refs are the row's", () => {
    expect(one(`open ${NINE}`).ownPr).toEqual({ repo: "acme/a", n: 9 });
    expect(one(`open ${NINE}`).claimedState).toBe("open");
    expect(one(`open ${A}, ${NINE}`).ownPrs).toHaveLength(2);
    expect(one(`open ${A}, ${NINE}`).claimedState).toBe("open");
  });

  test("any of a row's own PRs may be named", () => {
    const row = parseLedgerTable(["PR", "State"], [[`${A} ${NINE}`, `open ${NINE}`]]).rows[0]!;
    expect(row.claimedState).toBe("open");
  });

  test("a slug with `__` still matches its own URL in the state cell", () => {
    const u = "https://github.com/acme/my__repo/pull/1";
    expect(parseLedgerTable(["PR", "State"], [[`[#1](${u})`, `open [#1](${u})`]]).rows[0]!.claimedState).toBe("open");
    expect(parseLedgerTable(["PR", "State"], [[`[#1](${u})`, "open [#1](https://github.com/acme/myrepo/pull/1)"]]).rows[0]!.claimedState).toBe("unknown");
  });

  test("a merged, dropped or blocked row keeps its state: only what can contradict is read", () => {
    expect(one("merged 2026-10-30, #762").claimedState).toBe("merged");
    expect(one("merged follow-up").claimedState).toBe("merged");
    expect(one("dropped for later").claimedState).toBe("dropped");
    expect(one("blocked by #8").claimedState).toBe("blocked");
  });

  test("a state word reading a link deep in prose is about that link, not the row", () => {
    const r = one(`blocked by ${A}; open [#2](https://github.com/acme/b/pull/2)`);
    expect([r.state, r.rule, r.claimedState]).toEqual(["open", 1, "unknown"]);
  });

  test("so is one in a cell that does not hold the row's state or PR", () => {
    const row = parseLedgerTable(["Slate", "State", "Notes"], [["3 x", "?", `open ${A}`]]).rows[0]!;
    expect([row.state, row.rule, row.claimedState]).toEqual(["open", 1, "unknown"]);
  });

  test("a state word opening the PR, Landed or first cell is the row's", () => {
    expect(parseLedgerTable(["Slate", "PR"], [["3 x", `open ${A}`]]).rows[0]!.claimedState).toBe("open");
    expect(parseLedgerTable(["Slate", "Landed"], [["3 x", `open ${A}`]]).rows[0]!.claimedState).toBe("open");
    expect(parseLedgerTable(["Slate", "What"], [[`open ${A}`, "x"]]).rows[0]!.claimedState).toBe("open");
  });

  test("a state word opening the Landed cell is read past a state cell opening with another word", () => {
    const row = parseLedgerTable(["PR", "State", "Landed"], [["3 x", "blocked by more", `open ${A}`]]).rows[0]!;
    expect([row.state, row.rule, row.claimedState]).toEqual(["open", 1, "open"]);
  });

  test("a row with no state keeps none, and a merged one stays merged", () => {
    expect(one("?").claimedState).toBe("unknown");
    expect(one("merged").claimedState).toBe("merged");
    expect(parseLedgerTable(["PR", "Landed"], [["1", A]]).rows[0]!.claimedState).toBe("merged");
  });
});
