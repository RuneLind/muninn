import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { sha256 } from "../../gardener/util.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { realGit } from "./git.ts";
import { cardAsAnswered, labelAnswers } from "./history.ts";
import { missedNights } from "./loop-deps.ts";
import type { CardLine, RunLine } from "./schema.ts";
import {
  floorOf,
  labelOf,
  nightlyCatches,
  nightlyShares,
  nightsOf,
  part1Headline,
  part2Headline,
  projectedShare,
  replayReport,
  settledAnswers,
  verdictFlips,
  type ScoredItem,
} from "./score.ts";
import { commitAt, git, write } from "./test-repo.ts";

const MIN = 60_000;
const v = (over: Partial<WikiAnswerVersion>): WikiAnswerVersion => ({
  answerId: "a",
  version: 1,
  wiki: "w",
  relPath: "p.mdx",
  questionId: "O1",
  author: { userId: null, oid: null, navIdent: null, name: "Eier" },
  choice: "A",
  body: "",
  questionHash: "h",
  createdAt: 1_000_000,
  exportedAt: null,
  redactedAt: null,
  ...over,
});

describe("the label", () => {
  test("added: not sure, no choice, a dissent or a body; a plain match is not; a plain choice with no recommendation has none", () => {
    expect(labelOf({ choice: "not-sure", body: "" }, "A")).toBe(true);
    expect(labelOf({ choice: null, body: "tekst" }, "A")).toBe(true);
    expect(labelOf({ choice: "B", body: "" }, "A")).toBe(true);
    expect(labelOf({ choice: "A", body: "en merknad" }, "A")).toBe(true);
    expect(labelOf({ choice: "A", body: "  " }, "A")).toBe(false);
    expect(labelOf({ choice: "A", body: "" }, null)).toBeNull();
    expect(labelOf({ choice: "A", body: "merknad" }, null)).toBe(true);
    expect(labelOf({ choice: "not-sure", body: "" }, null)).toBe(true);
  });

  test("a not-sure corrected 7 minutes later is the correction; at 11 minutes the first stands", () => {
    const start = 1_000_000;
    const corrected = [v({ choice: "not-sure" }), v({ version: 2, choice: "A", createdAt: start + 7 * MIN })];
    expect(settledAnswers(corrected)[0]).toMatchObject({ choice: "A", firstAt: start, at: start + 7 * MIN });
    expect(settledAnswers(corrected, { windowMs: 0 })[0]).toMatchObject({ choice: "not-sure" });
    const late = [v({ choice: "not-sure" }), v({ version: 2, choice: "A", createdAt: start + 11 * MIN })];
    expect(settledAnswers(late)[0]!.choice).toBe("not-sure");
  });

  test("first by time across authors; another author's edit is not a correction; redacted rows are skipped", () => {
    const fag = { userId: "u2", oid: null, navIdent: null, name: "Fag" };
    const rows = [
      v({ answerId: "b", author: fag, choice: "B", createdAt: 1_000_000 + MIN }),
      v({ answerId: "a", choice: "A" }),
      v({ answerId: "gone", questionId: "O2", choice: null, body: "", redactedAt: 5 }),
    ];
    const out = settledAnswers(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "O1", answerId: "a", choice: "A", author: "Eier" });
  });
});

describe("the card as answered", () => {
  const page = (text: string, id = "O1") => `---\ntitle: T\n---\n\n<Question id="${id}" choices="A|B">\n${text}\n</Question>\n`;
  const hash = (text: string) => sha256(`${text}\n\nchoices: A|B`);
  const REC = "Skal vi? **Recommendation: A.**";
  const NO_REC = "Skal vi?";
  function repo() {
    const root = testTempDirSync(path.join(tmpdir(), "triage-answered-"));
    git(root, "init", "-q");
    return root;
  }
  const at = (iso: string) => Date.parse(iso);

  test("the commit before the answer holds it: ok, and its text decides the recommendation", async () => {
    const root = repo();
    write(root, "p.mdx", page(NO_REC));
    const sha = commitAt(root, "2026-10-01T10:00:00Z", "one");
    // The recommendation arrives later, on changed wording.
    write(root, "p.mdx", page(REC));
    commitAt(root, "2026-10-03T10:00:00Z", "two");
    const card = await cardAsAnswered(root, "p.mdx", "O1", hash(NO_REC), at("2026-10-02T10:00:00Z"), realGit);
    expect(card).toMatchObject({ status: "ok", commit: sha, body: NO_REC });
    const [row] = await labelAnswers(root, [v({ relPath: "p.mdx", questionHash: hash(NO_REC), createdAt: at("2026-10-02T10:00:00Z") })], realGit);
    // Read as answered it has no recommendation, so a plain choice has no label.
    expect(row).toMatchObject({ status: "ok", recommendation: null, added: null });
  });

  test("first committed after the answer: after-answer, no replay commit, the answered wording still read", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    commitAt(root, "2026-10-05T10:00:00Z", "late");
    const card = await cardAsAnswered(root, "p.mdx", "O1", hash(REC), at("2026-10-02T10:00:00Z"), realGit);
    expect(card).toMatchObject({ status: "after-answer", commit: null, body: REC });
  });

  test("other wording at that commit: hash-mismatch, and the commit holding the wording supplies the text", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    commitAt(root, "2026-10-01T10:00:00Z", "one");
    write(root, "p.mdx", page(NO_REC));
    const before = commitAt(root, "2026-10-02T10:00:00Z", "two");
    const card = await cardAsAnswered(root, "p.mdx", "O1", hash(REC), at("2026-10-03T10:00:00Z"), realGit);
    expect(card).toMatchObject({ status: "hash-mismatch", commit: before, body: REC });
  });

  test("nothing in git: no-history, no label for a plain choice", async () => {
    const root = repo();
    write(root, "other.md", "x\n");
    commitAt(root, "2026-10-01T10:00:00Z", "one");
    const [row] = await labelAnswers(root, [v({ relPath: "p.mdx" })], realGit);
    expect(row).toMatchObject({ status: "no-history", added: null });
  });
});

const item = (over: Partial<ScoredItem>): ScoredItem => ({ wiki: "mimir", relPath: "p", id: "O1", added: false, verdict: "DEFAULT", ...over });

/** A set of `n` items with `flagged` flagged and `caught` of the added ones among them. */
function build(added: number, others: number, caught: number, flaggedOthers: number): ScoredItem[] {
  return [
    ...Array.from({ length: added }, (_, i) => item({ id: `a${i}`, added: true, verdict: i < caught ? "ASK_OWNER" : "DEFAULT" })),
    ...Array.from({ length: others }, (_, i) => item({ id: `o${i}`, verdict: i < flaggedOthers ? "ASK_OTHER" : "DEFAULT" })),
  ];
}

describe("the replay's figures", () => {
  const population = { added: 15, other: 94 };

  test("the two controls project to the contract's shares", () => {
    expect(projectedShare({ caught: 10, of: 14, flagged: 22, cards: 49 }, population)).toBe(39);
    expect(projectedShare({ caught: 11, of: 14, flagged: 21, cards: 49 }, population)).toBe(35);
  });

  test("better, worse and tie by the contract's numbers, tie saying where it fell against the rule", () => {
    const head = (caught: number, flaggedOthers: number) => part1Headline(replayReport(build(14, 35, caught, flaggedOthers), population));
    expect(head(12, 8).result).toBe("better");
    expect(head(9, 3).result).toBe("worse");
    expect(head(14, 25).result).toBe("worse");
    const tie = head(10, 8);
    expect(tie.result).toBe("tie");
    expect(tie.line).toContain("at or above");
    const rule = build(14, 35, 10, 8).map((i) => i);
    for (let n = 0; n < 11; n++) rule[n]!.wiki = "melosys-kode-wiki";
    expect(part1Headline(replayReport(rule, population)).line).toContain("below");
  });

  test("a card with no verdict reads not scored, never worse", () => {
    const items = build(14, 35, 0, 0);
    items[0]!.verdict = "NO_VERDICT";
    const h = part1Headline(replayReport(items, population));
    expect(h.result).toBe("not scored");
    expect(h.line).toContain("not a worse result");
  });

  test("per wiki, the late cards and catches split by verdict", () => {
    const report = replayReport([
      item({ wiki: "melosys-kode-wiki", added: true, verdict: "ASK_OTHER", gapHours: 20, textAlone: true }),
      item({ wiki: "mimir", added: true, verdict: "ASK_OWNER", gapHours: 1 }),
      item({ wiki: "mimir", verdict: "SETTLED", gapHours: 13 }),
    ]);
    expect(report.perWiki["melosys-kode-wiki"]).toEqual({ caught: 1, of: 1, flagged: 1, cards: 1 });
    expect(report.late).toEqual({ caught: 1, of: 1, flagged: 1, cards: 2 });
    expect(report.lateTextAlone).toEqual({ caught: 1, of: 1, flagged: 1, cards: 2 });
    expect(report.catchesBy).toEqual({ ASK_OWNER: 1, ASK_OTHER: 1 });
    expect(report.rule).toMatchObject({ caught: 1, flagged: 1 });
  });
});

describe("the floor and part (2)", () => {
  test("the floor needs 20 labelled, 10 added, on 2 pages; a no-label row does not count", () => {
    const rows = (added: number, other: number, pages: number) => [
      ...Array.from({ length: added }, (_, i) => ({ wiki: "w", relPath: `p${i % pages}`, added: true as boolean | null })),
      ...Array.from({ length: other }, () => ({ wiki: "w", relPath: "q", added: false as boolean | null })),
    ];
    expect(floorOf(rows(10, 10, 2)).met).toBe(true);
    expect(floorOf(rows(9, 11, 2)).met).toBe(false);
    expect(floorOf(rows(10, 9, 2)).met).toBe(false);
    expect(floorOf(rows(10, 10, 1)).met).toBe(false);
    expect(floorOf([...rows(10, 9, 2), { wiki: "w", relPath: "q", added: null }]).met).toBe(false);
  });

  const input = (over: Partial<Parameters<typeof part2Headline>[0]> = {}) => ({
    report: replayReport(build(10, 10, 9, 0)),
    floor: { labelled: 20, added: 10, addedPages: 2, met: true },
    day: 14,
    shares: { askOwnerMedian: 0.2, askAnyMedian: 0.4, nights: 10 },
    handRead: 5,
    handWrong: 0,
    ...over,
  });

  test("below the floor reads too few to score, never a pass", () => {
    const h = part2Headline(input({ floor: { labelled: 5, added: 1, addedPages: 1, met: false } }));
    expect(h.result).toBe("too few to score");
    expect(h.line).toContain("TOO FEW TO SCORE");
  });

  test("before day 14 nothing is scored", () => {
    expect(part2Headline(input({ day: 13 })).result).toBe("too early");
    expect(part2Headline(input({ day: null })).result).toBe("too early");
  });

  test("a pass needs 90%, both medians, and no wrong hand read", () => {
    expect(part2Headline(input()).result).toBe("pass");
    expect(part2Headline(input({ report: replayReport(build(10, 10, 8, 0)) })).result).toBe("miss");
    expect(part2Headline(input({ shares: { askOwnerMedian: 0.31, askAnyMedian: 0.4, nights: 10 } })).result).toBe("miss");
    expect(part2Headline(input({ shares: { askOwnerMedian: 0.2, askAnyMedian: 0.51, nights: 10 } })).result).toBe("miss");
    expect(part2Headline(input({ handWrong: 1 })).result).toBe("miss");
  });

  test("fewer than 5 hand reads say not judged; the rule and ASK_OTHER get their notes", () => {
    expect(part2Headline(input({ handRead: 4 })).notes.join(" ")).toContain("not judged");
    const items = build(10, 10, 9, 3).map((i, n) => ({ ...i, verdict: n < 9 ? ("ASK_OTHER" as const) : i.verdict, wiki: n < 10 ? "melosys-kode-wiki" : "mimir" }));
    const notes = part2Headline(input({ report: replayReport(items) })).notes.join(" ");
    expect(notes).toContain("rule matches");
    expect(notes).toContain("Most catches are ASK_OTHER");
  });
});

const run = (over: Partial<RunLine>): RunLine => ({ type: "run", runId: "r", at: 0, wiki: "w", model: "m", promptVersion: "1", usage: { calls: 1 }, repoRoots: null, repos: [], cards: 0, floor: null, outcome: "ok", ...over });
const line = (over: Partial<CardLine>): CardLine => ({ type: "card", runId: "r", at: 0, wiki: "w", relPath: "p", id: "O1", questionHash: "h", recommendation: null, verdict: "DEFAULT", ...over });
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-10T06:00:00Z");

describe("the nights", () => {
  test("ok, partial, refused, failed and absent, from the first ok or partial line", () => {
    const runs = [
      run({ at: T0 - DAY, outcome: "refused" }),
      run({ at: T0, outcome: "ok" }),
      run({ at: T0 + DAY, outcome: "partial" }),
      run({ at: T0 + 3 * DAY, outcome: "refused" }),
      run({ at: T0 + 3 * DAY + 3_600_000, outcome: "failed" }),
    ];
    const nights = nightsOf(runs, [], T0 + 4 * DAY);
    expect(nights.map((n) => n.outcome)).toEqual(["ok", "partial", "absent", "failed", "absent"]);
  });

  test("a wiki that only ever refused shows those nights and starts no clock", () => {
    expect(nightsOf([run({ at: T0, outcome: "refused" })], [], T0 + 5 * DAY)).toHaveLength(1);
  });

  test("a card line with no run line still counts its verdict; the shares read model verdicts only", () => {
    const nights = nightsOf(
      [run({ at: T0 })],
      [line({ at: T0, verdict: "ASK_OWNER" }), line({ at: T0, verdict: "DEFAULT" }), line({ at: T0, verdict: "ANSWERED" }), line({ at: T0, verdict: "NO_VERDICT" }), line({ at: T0, verdict: "ASK_OTHER" }), line({ at: T0, verdict: "SETTLED" }), line({ at: T0 + DAY, verdict: "ASK_OTHER" })],
      T0 + DAY,
    );
    expect(nights[0]!.kinds).toEqual({ ASK_OWNER: 1, DEFAULT: 1, ASK_OTHER: 1, SETTLED: 1 });
    expect(nights[1]).toMatchObject({ outcome: "absent", kinds: { ASK_OTHER: 1 } });
    const shares = nightlyShares(nights);
    expect(shares.nights).toBe(2);
    expect(shares.askOwnerMedian).toBeCloseTo(0.125);
    expect(shares.askAnyMedian).toBeCloseTo(0.75);
  });

  test("flips count changes between nights, per card with two or more", () => {
    const flips = verdictFlips([
      line({ at: 1, verdict: "DEFAULT" }),
      line({ at: 2, verdict: "ASK_OWNER" }),
      line({ at: 3, verdict: "ASK_OWNER" }),
      line({ at: 4, verdict: "ANSWERED" }),
      line({ id: "O2", at: 1 }),
      line({ id: "O2", at: 2 }),
      line({ id: "O3", at: 1 }),
    ]);
    expect(flips).toEqual({ flips: 1, cardsFlipped: 1, cards: 2 });
  });

  test("a night's catches read the last verdict before the answer; a later SETTLED counts against itself", () => {
    const answers = [
      { wiki: "w", relPath: "p", id: "O1", firstAt: 100, added: true },
      { wiki: "w", relPath: "p", id: "O2", firstAt: 100, added: false },
      { wiki: "w", relPath: "p", id: "O3", firstAt: 100, added: true },
      { wiki: "w", relPath: "p", id: "O4", firstAt: 100, added: true },
    ];
    const out = nightlyCatches(answers, [
      line({ id: "O1", at: 50, verdict: "ASK_OTHER" }),
      line({ id: "O2", at: 50, verdict: "SETTLED" }),
      line({ id: "O3", at: 50, verdict: "VOID" }),
      line({ id: "O4", at: 150, verdict: "ASK_OWNER" }),
    ]);
    expect(out).toEqual({ waited: 3, addedWaited: 2, caught: 1, settledThenAnswered: 2 });
  });

  test("two whole nights with no run line count; none before the first run", () => {
    expect(missedNights([], T0)).toBe(0);
    expect(missedNights([{ at: T0 }], T0)).toBe(0);
    expect(missedNights([{ at: T0 }], T0 + DAY)).toBe(0);
    expect(missedNights([{ at: T0 }], T0 + 2 * DAY)).toBe(1);
    expect(missedNights([{ at: T0 - DAY }, { at: T0 }], T0 + 3 * DAY)).toBe(2);
  });
});
