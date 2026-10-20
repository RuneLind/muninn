import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { findGlanceLedger, findLedgers, isLedgerLabel, pageLedgers, parseLedgerTable, prStateMap, LEDGER_PARSED_MIN } from "./pr-ledger.ts";

// Synthetic ledgers shaped like the plan pages' (slate number first, state
// column, a Landed column that carries the PR link once the state cell turns
// into result prose). No text is copied from a real page.

const table = (header: string[], rows: string[][]): string =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const ledgerPage = (label: string, header: string[], rows: string[][]): string => [label, "", table(header, rows), ""].join("\n");

describe("isLedgerLabel", () => {
  test.each([
    ["**PR ledger.**", true],
    ["**PR-oversikt.**", true],
    ["**PR ledger:**", true],
    ["## PR ledger", true],
    ["**PR ledger (oppdatert).**", true],
    ["PR-oversikt", true],
    ["## Hvorfor PR-oversikt mangler:", false],
    ["**Status:**", false],
  ])("%s → %s", (line, want) => {
    expect(isLedgerLabel(line)).toBe(want);
  });
});

describe("row state, in the rule order", () => {
  const H = ["PR", "State", "Landed"];
  const one = (row: string[], header = H) => parseLedgerTable(header, [row]).rows[0]!;

  test("rule 1: a state word followed by a PR link or a sha, anywhere in the row", () => {
    expect(one(["1 — a", "merged [#12](https://example.test/pull/12)", ""])).toMatchObject({ state: "merged", rule: 1 });
    expect(one(["2 — b", "merget `e44793fb1e`", ""])).toMatchObject({ state: "merged", rule: 1 });
    // State-cell result prose, `merged [#n]` in the next cell.
    expect(one(["3 — c", "planned last, then retuned", "merged [#40](https://example.test/pull/40)"])).toMatchObject({ state: "merged", rule: 1 });
    expect(one(["4 — d", "Retune dropped after the run", "dropped in [#41](https://example.test/pull/41)"])).toMatchObject({ state: "dropped", rule: 1 });
  });

  test("rule 2: a state word at the start of the state cell", () => {
    expect(one(["5 — e", "closed, no code: the run settled it", ""])).toMatchObject({ state: "closed", rule: 2 });
    expect(one(["6 — f", "dropped as measured: no gain", ""])).toMatchObject({ state: "dropped", rule: 2 });
    expect(one(["7 — g", "**ikke startet**", ""])).toMatchObject({ state: "not-started", rule: 2 });
    expect(one(["8 — h", "_åpen_", ""])).toMatchObject({ state: "open", rule: 2 });
    expect(one(["9 — k", "[merget](https://example.test/pull/9) `abc1234`", ""])).toMatchObject({ state: "merged", rule: 2 });
    expect(one(["10 — l", "landet 29.09", ""])).toMatchObject({ state: "merged", rule: 2 });
  });

  test("every state word, both languages", () => {
    const words: [string, string][] = [
      ["merged", "merged"], ["dropped", "dropped"], ["closed", "closed"], ["open", "open"], ["measurement", "measurement"],
      ["not started", "not-started"], ["blocked", "blocked"], ["optional", "optional"], ["planned", "planned"],
      ["merget", "merged"], ["landet", "merged"], ["landed", "merged"], ["forkastet", "dropped"], ["lukket", "closed"], ["åpen", "open"], ["måling", "measurement"],
      ["ikke startet", "not-started"], ["blokkert", "blocked"], ["valgfri", "optional"], ["planlagt", "planned"],
    ];
    for (const [w, s] of words) expect(`${w} → ${one(["1", w, ""]).state}`).toBe(`${w} → ${s}`);
  });

  test("rule 3: a merged-PR link alone in a Landed / Landet cell", () => {
    expect(one(["9 — i", "see notes", "[#55](https://example.test/pull/55)"])).toMatchObject({ state: "merged", rule: 3 });
    expect(one(["9 — i", "se notat", "[#55](https://example.test/pull/55)"], ["PR", "Status", "Landet"])).toMatchObject({ state: "merged", rule: 3 });
  });

  test("a state word inside prose never counts", () => {
    expect(one(["10 — j", "the branch was merged into the spike", ""])).toMatchObject({ state: "unknown", rule: 0 });
  });
});

describe("PR identity and the decisions a row cites", () => {
  test("the slate number first, bold and dashes stripped; a phase id is no PR", () => {
    const l = parseLedgerTable(["PR", "State"], [["**12** — harness", "merged [#640](https://example.test/pull/640)"], ["A1 — phase", "open"], ["[#77](https://example.test/pull/77) fix", "open"]]);
    expect(l.rows.map((r) => [r.pr, r.slate, r.link])).toEqual([
      [12, 12, 640],
      [77, null, 77],
    ]);
    expect(l.rows[0]!.label).toBe("harness");
  });

  test("a Decisions column: every Dn there, a bare number is no id", () => {
    const r = parseLedgerTable(["PR", "What it gives", "Decisions", "State"], [["3 — x", "per D9", "6, D7, D8", "open"]]).rows[0]!;
    expect(r.decisions).toEqual(["D7", "D8"]);
  });

  test("no Decisions column: every distinct Dn in the row, one in «What it gives», one in State", () => {
    const r = parseLedgerTable(["PR", "What it gives", "State"], [["4 — y", "the cache, per D15", "open — D16 ruled it in, D15 again"]]).rows[0]!;
    expect(r.decisions).toEqual(["D15", "D16"]);
  });
});

describe("which ledgers draw", () => {
  const rows = (n: number, known: number) =>
    Array.from({ length: n }, (_, i) => [`${i + 1} — p`, i < known ? "merged [#1](https://example.test/pull/1)" : "see the run notes"]);

  test(`the ${LEDGER_PARSED_MIN * 100} % floor`, () => {
    expect(parseLedgerTable(["PR", "State"], rows(4, 3)).draws).toBe(true);
    expect(parseLedgerTable(["PR", "State"], rows(5, 3)).draws).toBe(false);
  });

  test("no state column ⇒ never draws", () => {
    const l = parseLedgerTable(["PR", "Landed"], [["1", "[#5](https://example.test/pull/5)"], ["2", "[#6](https://example.test/pull/6)"]]);
    expect(l.stateColumn).toBe(-1);
    expect(l.draws).toBe(false);
  });

  test("a ledger inside a Lane is found; a table under another label is not", () => {
    const md = [
      "<NextMoves>",
      "",
      '<Lane kind="you">',
      "",
      ledgerPage("**PR-oversikt.**", ["PR", "Status"], [["1 — a", "merget [#3](https://example.test/pull/3)"]]),
      "</Lane>",
      "",
      "</NextMoves>",
      "",
      ledgerPage("**Other table.**", ["PR", "Status"], [["9", "open"]]),
    ].join("\n");
    const found = findLedgers(parseBlocks(md));
    expect(found).toHaveLength(1);
    expect(found[0]!.rows[0]).toMatchObject({ pr: 1, state: "merged" });
  });

  test("a label with prose after it, and a Meter between label and table, still find the table", () => {
    const md = [
      "**PR ledger.** Merged rows first, then the rest.",
      "",
      '<Meter value="1" max="2" tone="good">1 of 2 merged</Meter>',
      "",
      "| PR | State |",
      "|---|---|",
      "| 1 — a | merged |",
      "| 2 — b | open |",
      "",
    ].join("\n");
    expect(findLedgers(parseBlocks(md)).map((l) => l.rows.map((r) => r.state))).toEqual([["merged", "open"]]);
    expect(isLedgerLabel("**PR ledger.** Merged rows first, then the rest.")).toBe(false);
    expect(findLedgers(parseBlocks(md.replace("**PR ledger.**", "**Plan.**")))).toEqual([]);
  });

  test("no ledger on a proposed plan ⇒ the At a glance table, every PR planned; a ledger beats it", () => {
    const glance = ["### At a glance", "", table(["PR", "What"], [["1", "a"], ["2", "b"]]), ""].join("\n");
    const g = findGlanceLedger(parseBlocks(glance))!;
    expect(g.rows.map((r) => r.state)).toEqual(["planned", "planned"]);
    expect(pageLedgers(parseBlocks(glance), true)[0]!.source).toBe("glance");
    // Not proposed (shipped, in flight): no slate of planned PRs.
    expect(pageLedgers(parseBlocks(glance))).toEqual([]);
    const both = [glance, ledgerPage("**PR ledger.**", ["PR", "State"], [["1", "open"]])].join("\n");
    expect(pageLedgers(parseBlocks(both), true).map((l) => l.source)).toEqual(["ledger"]);
  });

  test("prStateMap: the first row naming a PR wins", () => {
    const a = parseLedgerTable(["PR", "State"], [["1", "open"]]);
    const b = parseLedgerTable(["PR", "State"], [["1", "merged [#2](https://example.test/pull/2)"]]);
    expect(prStateMap([a, b]).get(1)).toBe("open");
  });
});

// Fix round 1, batch 1. Synthetic rows only.
const U = "https://example.test/pull";

describe("F1: a state word counts only where the rules say", () => {
  const one = (row: string[], header = ["PR", "State", "Landed"]) => parseLedgerTable(header, [row]).rows[0]!;

  test("a sha needs backticks, or both a digit and a letter a–f", () => {
    expect(one(["1", "see notes", "merged defaced"])).toMatchObject({ state: "unknown", rule: 0 });
    expect(one(["1", "see notes", "open 20261019"])).toMatchObject({ state: "unknown", rule: 0 });
    expect(one(["1", "see notes", "merged e44793fb1e"])).toMatchObject({ state: "merged", rule: 1 });
    expect(one(["1", "see notes", "merget `deadbeef`"])).toMatchObject({ state: "merged", rule: 1 });
  });

  test("the state cell wins over a state word mid-prose in another cell", () => {
    const H = ["PR", "Notes", "State"];
    expect(one(["1", `was open [#3](${U}/3) before`, `merged [#4](${U}/4)`], H)).toMatchObject({ state: "merged", rule: 1 });
    expect(one(["1", `was open [#3](${U}/3) before`, "merged"], H)).toMatchObject({ state: "merged", rule: 2 });
  });

  test("struck text is gone before matching", () => {
    expect(one(["1", "~~merged~~ dropped", ""])).toMatchObject({ state: "dropped", rule: 2 });
    expect(one(["1", `~~merged [#3](${U}/3)~~ dropped`, ""])).toMatchObject({ state: "dropped", rule: 2 });
  });

  test("a hyphen ends no state word", () => {
    expect(one(["1", "open-ended question", ""])).toMatchObject({ state: "unknown", rule: 0 });
  });
});

describe("F2: one PR-link reader", () => {
  const one = (row: string[], header = ["PR", "State", "Landed"]) => parseLedgerTable(header, [row]).rows[0]!;

  test.each([
    ["merged muninn #5"],
    [`merged [muninn#5](${U}/5)`],
    [`merged [PR #5](${U}/5)`],
    ["merged PR #5"],
    ["merged pr #5"],
  ])("rule 1 reads %s", (landed) => {
    expect(one(["1", "see notes", landed])).toMatchObject({ state: "merged", rule: 1 });
  });

  test("rule 3: a repo link alone reads merged; a link with prose after it does not", () => {
    expect(one(["1", "see notes", `[muninn#5](${U}/5)`])).toMatchObject({ state: "merged", rule: 3 });
    expect(one(["1", "see notes", `[#5](${U}/5) reverted`])).toMatchObject({ state: "unknown", rule: 0 });
    expect(one(["1", "see notes", `[#5](${U}/5), open`])).toMatchObject({ state: "unknown", rule: 0 });
  });

  test("rule 3: a date, a sha in backticks or a parenthetical after the link is no prose", () => {
    for (const landed of [`[#5](${U}/5), 2026-09-13`, `[#5](${U}/5) 09-24`, `[muninn #5](${U}/5) \`c59ce4f\` (v2)`]) {
      expect(`${landed}: ${one(["1", "see notes", landed]).state}`).toBe(`${landed}: merged`);
    }
  });

  test("link text in backticks, with an owner", () => {
    expect(parseLedgerTable(["PR", "State"], [["2a — [`acme/tool#4`](https://example.test/pull/4)", "open"]]).rows[0]).toMatchObject({ slate: null, link: 4, pr: 4 });
    expect(parseLedgerTable(["PR", "State"], [["x — acme/tool#4", "open"]]).rows[0]).toMatchObject({ link: 4 });
    const one = (landed: string) => parseLedgerTable(["PR", "State", "Landed"], [["1", "see notes", landed]]).rows[0]!;
    expect(one("[`acme/tool#4`](https://example.test/pull/4)")).toMatchObject({ state: "merged", rule: 3 });
    expect(one("merged [`acme/tool#4`](https://example.test/pull/4)")).toMatchObject({ state: "merged", rule: 1 });
  });

  test("`step #3` is no PR; `PR #7` is", () => {
    const l = parseLedgerTable(["PR", "State"], [["step #3 — x", "open"], ["fix, see PR #7", "open"]]);
    expect(l.rows.map((r) => r.link)).toEqual([7]);
  });

  test("identity prefers the PR, state and Landed cells over a Review cell", () => {
    const r = parseLedgerTable(["PR", "Review", "State", "Landed"], [["fix x", "alpha-api#901", "merged", `[#12](${U}/12)`]]).rows[0]!;
    expect(r).toMatchObject({ link: 12, pr: 12 });
  });
});

describe("F3: the slate is read from a slate column only", () => {
  test("a leading `PR` or link before the number", () => {
    const l = parseLedgerTable(["PR", "State"], [["PR 12 — x", "open"], [`[#351](${U}/351) 1 — y`, "open"]]);
    expect(l.rows.map((r) => [r.slate, r.link, r.pr, r.label])).toEqual([
      [12, null, 12, "x"],
      [1, 351, 1, "y"],
    ]);
  });

  test("a date or a decimal is no slate", () => {
    const l = parseLedgerTable(["PR", "State"], [["2026-10-19", `merged [#5](${U}/5)`], ["1.5 — x", `merged [#6](${U}/6)`]]);
    expect(l.rows.map((r) => [r.slate, r.pr])).toEqual([
      [null, 5],
      [null, 6],
    ]);
  });

  test("a Fase / Phase / Date column holds no slate", () => {
    for (const h of ["Fase", "Phase", "Date", "Dato", "When", "Når", "Uke", "Week", "Sprint", "Runde", "Round", "Versjon", "Version", "**Fase (uke)**"]) {
      const l = parseLedgerTable([h, "State"], [["1", `merged [#40](${U}/40)`], ["2", "open"]]);
      expect(`${h}: ${JSON.stringify(l.rows.map((r) => [r.slate, r.pr]))}`).toBe(`${h}: [[null,40]]`);
    }
  });

  test("a slate column by another name still holds the slate", () => {
    for (const h of ["#", "Oppgave", "Task", "Steg", "Step", "Planned PR", "Slice"]) {
      expect(`${h}: ${parseLedgerTable([h, "State"], [["3 — x", "open"]]).rows[0]?.slate}`).toBe(`${h}: 3`);
    }
  });

  test("any first header but a phase, date or period one holds the slate", () => {
    for (const h of ["Slate", "PR #", "No.", "Item", "", "Endring"]) {
      expect(`${h}: ${parseLedgerTable([h, "State"], [["3 — x", "open"]]).rows[0]?.slate}`).toBe(`${h}: 3`);
    }
  });
});

// Fix round 1, batch 2. Synthetic rows only.
describe("F4: the label anywhere in the paragraph above; a qualified state header", () => {
  const T = table(["PR", "State"], [["1 — a", "merged"], ["2 — b", "open"]]);

  test("label line followed by prose on the next line, no blank between", () => {
    const md = ["Intro paragraph.", "", "**PR ledger.**", "Merged rows first.", "", T, ""].join("\n");
    expect(findLedgers(parseBlocks(md)).map((l) => l.rows.length)).toEqual([2]);
    expect(findLedgers(parseBlocks(["**PR-oversikt.**", "Merget først.", "Resten etter.", "", T, ""].join("\n")))).toHaveLength(1);
  });

  test("a label in an earlier paragraph, or mid-line, is no ledger label", () => {
    expect(findLedgers(parseBlocks(["**PR ledger.**", "", "Another paragraph.", "", T, ""].join("\n")))).toEqual([]);
    expect(findLedgers(parseBlocks(["See the **PR ledger.** below.", "", T, ""].join("\n")))).toEqual([]);
  });

  test("a state header with a parenthetical qualifier is the state column", () => {
    for (const h of ["Status (10-19)", "State (as of 2026-10-19)", "**Tilstand (per i dag)**"]) {
      const l = parseLedgerTable(["PR", h], [["1", "merged"], ["2", "open"]]);
      expect(`${h}: ${l.stateColumn} ${l.draws}`).toBe(`${h}: 1 true`);
    }
    expect(parseLedgerTable(["PR", "Statusnotat"], [["1", "merged"]]).stateColumn).toBe(-1);
  });
});

// Fix round 2, batch 1. Synthetic rows only.
describe("G1: the ledger regexes run in linear time", () => {
  const H = ["PR", "State", "Landed"];
  const timed = (state: string, landed: string): { ms: number; state: string } => {
    const t = performance.now();
    const r = parseLedgerTable(H, [["1", state, landed]]).rows[0]!;
    return { ms: performance.now() - t, state: r.state };
  };
  const KB50 = (unit: string): string => unit.repeat(Math.ceil(50_000 / unit.length));

  test("a short Landed cell of dates or dotted numbers after a link", () => {
    expect(timed("see notes", `[#5](${U}/5)${" 2026-10-19".repeat(14)} x`)).toMatchObject({ state: "unknown" });
    expect(timed("see notes", `[#5](${U}/5)${" 2026-10-19".repeat(14)} x`).ms).toBeLessThan(50);
    expect(timed("see notes", `[#5](${U}/5)${" 1.2.3".repeat(24)} x`).ms).toBeLessThan(50);
  });

  test("a 50 KB State cell finishes in under 50 ms", () => {
    expect(timed(`merged ${KB50("a_")}`, "").ms).toBeLessThan(50);
    expect(timed(`see ${KB50("[#1](u")}`, "").ms).toBeLessThan(50);
  });

  test("a 50 KB Landed cell finishes in under 50 ms", () => {
    expect(timed("see notes", `[#5](${U}/5)${KB50(" 2026-10-19")} x`).ms).toBeLessThan(50);
    expect(timed("see notes", `[#5](${U}/5)${KB50(" 1.2.3")} x`).ms).toBeLessThan(50);
    expect(timed("see notes", `[#5](${U}/5)${KB50(" [#6](u)")} x`).ms).toBeLessThan(50);
  });
});

describe("G2: rule 3 reads a Landed cell of links and landing metadata only", () => {
  const one = (landed: string) => parseLedgerTable(["PR", "State", "Landed"], [["1", "see notes", landed]]).rows[0]!;

  test.each([["reverted #5"], ["draft #5"], ["pending #5"], [`[#5](${U}/5) (reverted)`], [`[#5](${U}/5) (closed unmerged)`]])(
    "%s is prose, not a landed link",
    (landed) => {
      expect(one(landed)).toMatchObject({ state: "unknown", rule: 0 });
    },
  );

  test.each([
    [`[#5](${U}/5 "the title")`],
    [`[#5](${U}/5) and [#6](${U}/6)`],
    [`[#5](${U}/5) og [#6](${U}/6)`],
    [`[#5](${U}/5) (v34)`],
    [`[#5](${U}/5) (2026-10-19)`],
  ])("%s reads merged", (landed) => {
    expect(one(landed)).toMatchObject({ state: "merged", rule: 3 });
  });

  test("a bare ref is no link: rule 3 needs a markdown PR link", () => {
    expect(one("muninn #552 (`b6e693ff`)")).toMatchObject({ link: 552, state: "unknown", rule: 0 });
  });
});

describe("G3: a PR link is a PR URL or a PR-shaped text; a bare ref is `PR #n` or a lowercase repo", () => {
  const one = (landed: string) => parseLedgerTable(["PR", "State", "Landed"], [["1", "see notes", landed]]).rows[0]!;

  test("an issue link or an anchor link is no PR link", () => {
    expect(one("[Issue #12](https://example.test/acme/tool/issues/12)")).toMatchObject({ link: null, state: "unknown" });
    expect(one("[step #3](#step-3)")).toMatchObject({ link: null, state: "unknown" });
    expect(one("[#12](https://example.test/acme/tool/issues/12)")).toMatchObject({ link: null, state: "unknown" });
  });

  test("a link whose URL is a pull request is a PR link, whatever its text", () => {
    expect(one("[the fix](https://example.test/acme/tool/pull/77)")).toMatchObject({ link: 77, state: "merged", rule: 3 });
    expect(one("[!12](https://example.test/acme/tool/-/merge_requests/12)")).toMatchObject({ link: 12, state: "merged", rule: 3 });
  });

  test("a capitalised word before `#n` numbers something else", () => {
    const l = parseLedgerTable(["Fase", "State"], [["Sprint #3 — x", "open"], ["Week #3", "open"], ["Bug #12", "open"], ["Attempt #2", "open"], ["y — PR #9", "open"]]);
    expect(l.rows.map((r) => r.pr)).toEqual([9]);
  });

  test("a struck link gives no identity; a struck first cell keeps its slate", () => {
    const l = parseLedgerTable(["PR", "Repo", "State"], [
      [`~~[#3](${U}/3)~~ [#4](${U}/4)`, "", "open"],
      ["fix x", `~~[#5](${U}/5)~~ [#6](${U}/6)`, "open"],
      ["~~7 — x~~", "", "open"],
      ["~~8 — y~~ 9 — y", "", "open"],
    ]);
    expect(l.rows.map((r) => [r.slate, r.link, r.pr])).toEqual([
      [null, 4, 4],
      [null, 6, 6],
      [7, null, 7],
      [8, null, 8],
    ]);
  });

  test("`dropped Sprint #4` is no rule-1 state", () => {
    expect(one("dropped Sprint #4")).toMatchObject({ state: "unknown", rule: 0 });
  });
});

// Class check (fix round 3): the ref rules as the spec states them, over the
// state space of token kinds × the cells a token can sit in. Synthetic rows only.
describe("C: PR refs, the token kinds × the cells they sit in", () => {
  const P = "https://example.test/acme/tool";
  /** A token kind: the ref number it gives (null: no ref), whether it is a
   *  markdown PR link (R-a i), and whether prose stands beside the ref. */
  interface Kind {
    name: string;
    tok: string;
    n: number | null;
    link: boolean;
    prose?: boolean;
  }
  const kinds: Kind[] = [
    // R-a (i): a markdown link, by its URL or its exact text.
    { name: "md link, pull URL", tok: `[the fix](${P}/pull/77)`, n: 77, link: true },
    { name: "md link, pulls URL", tok: `[x](${P}/pulls/78)`, n: 78, link: true },
    { name: "md link, merge request URL", tok: `[!12](${P}/-/merge_requests/12)`, n: 12, link: true },
    { name: "md link, URL number wins over text", tok: `[#3](${P}/pull/79)`, n: 79, link: true },
    { name: "md link #n", tok: "[#5](notes.md)", n: 5, link: true },
    { name: "md link #n in backticks", tok: "[`#5`](notes.md)", n: 5, link: true },
    { name: "md link PR #n", tok: "[PR #5](notes.md)", n: 5, link: true },
    { name: "md link repo#n", tok: "[muninn#5](notes.md)", n: 5, link: true },
    { name: "md link repo #n", tok: "[muninn #5](notes.md)", n: 5, link: true },
    { name: "md link owner/repo#n", tok: "[acme/tool#5](notes.md)", n: 5, link: true },
    { name: "md link owner/stopword-repo#n", tok: "[acme/test#5](notes.md)", n: 5, link: true },
    { name: "md link issues URL", tok: `[#5](${P}/issues/5)`, n: null, link: false },
    { name: "md link #anchor", tok: "[#5](#step-5)", n: null, link: false },
    { name: "md link stopword text", tok: "[step #3](notes.md)", n: null, link: false },
    // Any lowercase slug off the stoplist is a repo, in link text as bare.
    { name: "md link word #n text", tok: "[see #3](notes.md)", n: 3, link: true },
    { name: "md link two-word text", tok: "[see muninn #3](notes.md)", n: null, link: false },
    // R-a (ii): owner/repo#n, no space; the stoplist does not apply.
    { name: "owner/repo#n", tok: "acme/tool#5", n: 5, link: false },
    { name: "owner/stopword-repo#n", tok: "acme/test#5", n: 5, link: false },
    { name: "Owner/stopword-repo#n", tok: "RuneLind/check#5", n: 5, link: false },
    { name: "owner/repo #n (space)", tok: "acme/tool #5", n: null, link: false },
    { name: "owner/repo- #n", tok: "acme/tool-#5", n: null, link: false },
    // R-a (iii): repo #n / repo#n, a lowercase slug starting and ending [a-z0-9].
    { name: "repo #n", tok: "muninn #5", n: 5, link: false },
    { name: "repo#n", tok: "muninn#5", n: 5, link: false },
    { name: "dotted repo #n", tok: "melosys-api.v2 #5", n: 5, link: false },
    { name: "digit-led repo #n", tok: "1password #5", n: 5, link: false },
    { name: "date #n (no letter)", tok: "2026-03-12 #4", n: null, link: false },
    { name: "owner/digits#n (no letter)", tok: "acme/2026#4", n: null, link: false },
    { name: "slug starting .", tok: ".muninn #5", n: null, link: false },
    { name: "slug starting _", tok: "_muninn #5", n: null, link: false },
    { name: "slug ending -", tok: "step-#3", n: null, link: false },
    { name: "slug ending - (post)", tok: "post-#252", n: null, link: false },
    { name: "slug ending - (pre)", tok: "pre-#431", n: null, link: false },
    { name: "slug ending .", tok: "nr. #5", n: null, link: false },
    { name: "slug ending . (e.g.)", tok: "e.g. #5", n: null, link: false },
    { name: "slug ending . (incl.)", tok: "incl. #139", n: null, link: false },
    { name: "slug ending _", tok: "issue_#12", n: null, link: false },
    { name: "stopword #n", tok: "step #3", n: null, link: false },
    { name: "stopword #n (no)", tok: "fase #2", n: null, link: false },
    { name: "stopword #n (issue)", tok: "issue #12", n: null, link: false },
    { name: "Word #n", tok: "Sprint #3", n: null, link: false },
    { name: "Word #n (Bug)", tok: "Bug #12", n: null, link: false },
    // R-a (iv): PR #n, any case.
    { name: "PR #n", tok: "PR #5", n: 5, link: false },
    { name: "pr #n", tok: "pr #5", n: 5, link: false },
    { name: "Pr#n", tok: "Pr#5", n: 5, link: false },
    // Prose before a ref: the ref stands, the prose blocks rule 3. A lowercase
    // word right before `#n` is itself the ref's repo (`reversert #5`), so it
    // follows a state word as a ref does.
    { name: "EN prose, md link", tok: "after [#5](notes.md)", n: 5, link: true, prose: true },
    { name: "EN prose, md link (skipped)", tok: `skipped [#5](${P}/pull/5)`, n: 5, link: true, prose: true },
    { name: "NO prose, md link", tok: `reversert [#5](${P}/pull/5)`, n: 5, link: true, prose: true },
    { name: "NO prose, md link (utkast)", tok: "utkast [#5](notes.md)", n: 5, link: true, prose: true },
    { name: "EN prose, bare word #n", tok: "deferred #5", n: 5, link: false },
    { name: "NO prose, bare word #n", tok: "reversert #5", n: 5, link: false },
    { name: "NO prose, bare word #n (venter)", tok: "venter #5", n: 5, link: false },
    { name: "EN prose, repo ref", tok: "after muninn #5", n: 5, link: false, prose: true },
  ];

  type Want = { pr: number | null; link: number | null; state: string; rule: number } | "no row";
  /** The contexts, each with the spec's expected reading of a kind there. */
  const contexts: { name: string; header: string[]; row: (t: string) => string[]; want: (k: Kind) => Want }[] = [
    {
      // Identity from a PR ref in the first cell; no slate, no state word.
      name: "first cell",
      header: ["PR", "State", "Landed"],
      row: (t) => [`a — ${t}`, "see notes", ""],
      want: (k) => (k.n === null ? "no row" : { pr: k.n, link: k.n, state: "unknown", rule: 0 }),
    },
    {
      // Identity from a PR ref in any cell; rule 2 on the state cell.
      name: "PR column",
      header: ["Item", "PR", "State"],
      row: (t) => ["x", t, "open"],
      want: (k) => (k.n === null ? "no row" : { pr: k.n, link: k.n, state: "open", rule: 2 }),
    },
    {
      // Rule 1 when the ref follows the word, else rule 2 (word at the start).
      name: "state cell after a state word",
      header: ["PR", "State", "Landed"],
      row: (t) => ["1", `merged ${t}`, ""],
      want: (k) => ({ pr: 1, link: k.n, state: "merged", rule: k.n !== null && !k.prose ? 1 : 2 }),
    },
    {
      // Rule 3: a PR link alone; a bare ref never fires it.
      name: "Landed alone",
      header: ["PR", "State", "Landed"],
      row: (t) => ["1", "see notes", t],
      want: (k) => (k.link && !k.prose ? { pr: 1, link: k.n, state: "merged", rule: 3 } : { pr: 1, link: k.n, state: "unknown", rule: 0 }),
    },
    ...[", 2026-10-19", " `c59ce4f`", " (v34)"].map((suffix) => ({
      name: `Landed + ${suffix.trim()}`,
      header: ["PR", "State", "Landed"],
      row: (t: string) => ["1", "see notes", `${t}${suffix}`],
      want: (k: Kind): Want =>
        k.link && !k.prose ? { pr: 1, link: k.n, state: "merged", rule: 3 } : { pr: 1, link: k.n, state: "unknown", rule: 0 },
    })),
    {
      // Prose after the ref: never rule 3.
      name: "Landed + prose",
      header: ["PR", "State", "Landed"],
      row: (t) => ["1", "see notes", `${t} reverted`],
      want: (k) => ({ pr: 1, link: k.n, state: "unknown", rule: 0 }),
    },
  ];

  const cells = kinds.flatMap((k) => contexts.map((c) => ({ k, c })));
  test(`${cells.length} cells`, () => {
    const red: string[] = [];
    for (const { k, c } of cells) {
      const r = parseLedgerTable(c.header, [c.row(k.tok)]).rows[0];
      const got: Want = r ? { pr: r.pr, link: r.link, state: r.state, rule: r.rule } : "no row";
      const want = c.want(k);
      if (JSON.stringify(got) !== JSON.stringify(want)) red.push(`${k.name} | ${c.name} | ${k.tok} | want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
    console.log(`class-check table: ${cells.length} cells, ${red.length} red`);
    if (red.length) console.log(red.join("\n"));
    expect(red).toEqual([]);
  });

  // Round-2 branches the table does not reach.
  test("the first ref by position is the row's link", () => {
    expect(parseLedgerTable(["PR", "State"], [["muninn #3 [#5](notes.md)", "open"]]).rows[0]).toMatchObject({ link: 3, pr: 3 });
  });

  test("a leading bare `PR #5` is the slate, not a link to skip", () => {
    expect(parseLedgerTable(["PR", "State"], [["PR #5 1 — y", "open"]]).rows[0]).toMatchObject({ slate: 5, link: 5, pr: 5 });
  });

  // 256 KB, not 1 MB: a CI runner took 1.4 s at 1 MB (linear); a quadratic
  // scan takes minutes at this size, so the bound still separates them.
  test("a 256 KB cell of near-refs finishes in under 1 s", () => {
    const MB = (unit: string): string => unit.repeat(Math.ceil(256_000 / unit.length));
    for (const cell of [
      `merged ${MB("a")} #5`,
      `merged ${MB("a-")}#5`,
      `merged ${MB("a.")} #5`,
      `merged ${MB("a/")}#5`,
      `merged ${MB("A")}/b#5`,
      `merged x/${MB("a-")}#5`,
      MB("muninn #5 "),
      MB("[#5](u) "),
      MB("pr #"),
    ]) {
      const t = performance.now();
      parseLedgerTable(["PR", "State", "Landed"], [[cell, cell, cell]]);
      expect(performance.now() - t).toBeLessThan(1000);
    }
  });
});

// Class check (fix round 3, batch 3): the slate, its label and the row's link
// over first-cell shapes × first headers × other cells. Rules: the slate and
// the label are read from the first cell with `~~` stripped like `**` (struck
// text kept); the link and the state from the unstruck cells; a first header
// of a phase, date or period word, alone or with a parenthetical, holds no
// slate. Synthetic rows only.
describe("CS: slate identity, first-cell shapes × headers × other cells", () => {
  /** A first-cell shape: its text with markers stripped and leading dashes
   *  gone (`plain`), and — in a slate column — the slate and the label after it. */
  const shapes: { cell: string; plain: string; slate: number | null; label: string }[] = [
    { cell: "3 — x", plain: "3 — x", slate: 3, label: "x" },
    { cell: "**3 — x**", plain: "3 — x", slate: 3, label: "x" },
    { cell: "~~3 — x~~", plain: "3 — x", slate: 3, label: "x" },
    { cell: "~~**3 — x**~~", plain: "3 — x", slate: 3, label: "x" },
    { cell: "**~~3~~** — x", plain: "3 — x", slate: 3, label: "x" },
    // The leading integer of the text with `~~` stripped: 3, not 4.
    { cell: "~~3~~ 4 — x", plain: "3 4 — x", slate: 3, label: "4 — x" },
    // The label keeps struck text, markers stripped.
    { cell: "3 — ~~old~~ new", plain: "3 — old new", slate: 3, label: "old new" },
    { cell: "A1 — x", plain: "A1 — x", slate: null, label: "A1 — x" },
    { cell: "2026-10-03 — x", plain: "2026-10-03 — x", slate: null, label: "2026-10-03 — x" },
    { cell: "1.5 — x", plain: "1.5 — x", slate: null, label: "1.5 — x" },
    { cell: "", plain: "", slate: null, label: "" },
  ];
  /** First headers and whether the column holds the slate. The anchors: a
   *  phase/date/period word inside a longer word (`Update`, `Sprintnr`) or
   *  followed by more than a parenthetical (`Phase PR`) is no such header. */
  const headers: [string, boolean][] = [
    ["PR", true], ["#", true], ["", true], ["Slate", true],
    ["Fase", false], ["Fase (uke)", false],
    ["Update", true], ["Workaround", true], ["Background", true],
    ["Sprintnr", true], ["Phase PR", true], ["Versjon bump", true],
  ];
  const others: { name: string; cell: string; link: number | null }[] = [
    { name: "none", cell: "", link: null },
    { name: "live link", cell: `[#7](${U}/7)`, link: 7 },
    { name: "struck link", cell: `~~[#7](${U}/7)~~`, link: null },
  ];

  const cells = shapes.flatMap((s) => headers.flatMap(([h, slateCol]) => others.map((o) => ({ s, h, slateCol, o }))));
  test(`${cells.length} cells`, () => {
    const red: string[] = [];
    for (const { s, h, slateCol, o } of cells) {
      const r = parseLedgerTable([h, "State", "Notes"], [[s.cell, "dropped", o.cell]]).rows[0];
      const slate = slateCol ? s.slate : null;
      const pr = slate ?? o.link;
      const want = pr === null ? "no row" : { slate, link: o.link, pr, label: slateCol ? s.label : s.plain, state: "dropped" };
      const got = r ? { slate: r.slate, link: r.link, pr: r.pr, label: r.label, state: r.state } : "no row";
      if (JSON.stringify(got) !== JSON.stringify(want)) red.push(`${s.cell} | ${h} | ${o.name} | want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
    console.log(`slate class-check table: ${cells.length} cells, ${red.length} red`);
    if (red.length) console.log(red.join("\n"));
    expect(red).toEqual([]);
  });

  test("a struck slate with a live link: the slate wins, the link stays", () => {
    expect(parseLedgerTable(["PR", "State"], [["~~**1**~~", `shipped [#107](${U}/107)`]]).rows[0]).toMatchObject({ slate: 1, link: 107, pr: 1 });
  });
});

// Round-3 verify pins (93dab1fd): ref shapes, rule 3's bare-ref and
// other-link guards, and a linear scan. Expected values are literal.
describe("round-3 pins: ref shapes and rule 3", () => {
  /** A row whose PR column is not the slate column, so a row exists only
   *  when the PR cell holds a ref. */
  const prCell = (cell: string) => parseLedgerTable(["Fase", "PR", "State"], [["a", cell, "open"]]).rows[0];
  const landed = (cell: string) => parseLedgerTable(["PR", "State", "Landed"], [["1", "", cell]]).rows[0]!;

  test("a state cell of 256 KB with no `#` after the run parses in under 1 s", () => {
    const n = 128_000;
    for (const cell of ["merged " + "a-".repeat(n), "merged " + "a.".repeat(n)]) {
      const t = performance.now();
      const r = parseLedgerTable(["PR", "State"], [["1", cell]]).rows[0]!;
      expect(performance.now() - t).toBeLessThan(1000);
      expect(r).toMatchObject({ slate: 1, link: null, state: "merged", rule: 2 });
    }
  });

  test("rule 3: a bare ref beside a PR link is no landed-links-only cell", () => {
    expect(landed("[#5](https://example.test/o/r/pull/5), muninn #6")).toMatchObject({ link: 5, state: "unknown", rule: 0 });
  });

  test("rule 3: another link beside a PR link is not merged", () => {
    expect(landed("[#5](https://example.test/o/r/pull/5) [notes](x.md)")).toMatchObject({ link: 5, state: "unknown", rule: 0 });
  });

  test("a link whose text is a ref and more, to no PR URL, is no link", () => {
    expect(prCell("[muninn #3 notes](notes.md)")).toBeUndefined();
  });

  test("a bare ref runs to a word end: `muninn #5a` is none", () => {
    expect(prCell("muninn #5a")).toBeUndefined();
  });

  test("a repo slug is lower case: `gitHub #5`, `Muninn #5` are none", () => {
    expect(prCell("gitHub #5")).toBeUndefined();
    expect(prCell("Muninn #5")).toBeUndefined();
  });

  test("a bare `#5` alone is no ref", () => {
    expect(prCell("#5")).toBeUndefined();
  });

  test("a pull URL with a trailing path reads its number", () => {
    expect(prCell("[x](https://example.test/o/r/pull/5/files)")).toMatchObject({ slate: null, link: 5, pr: 5, state: "open" });
  });
});
