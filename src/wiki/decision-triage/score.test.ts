import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { sha256 } from "../../gardener/util.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { answerWindowMs, computeFloor, frozenAfterMs, labelsSince } from "./floor.ts";
import { realGit, type GitRun } from "./git.ts";
import { cardAsAnswered, labelAnswers } from "./history.ts";
import { missedNights } from "./loop-deps.ts";
import { nightlyLogPath } from "./log.ts";
import { DECISION_TRIAGE_PROMPT_FROZEN_ON, DECISION_TRIAGE_PROMPT_VERSION, type CardLine, type RunLine } from "./schema.ts";
import {
  floorOf,
  labelOf,
  nightContext,
  nightlyCatches,
  nightlyShares,
  nightsOf,
  part1Headline,
  part2Headline,
  shownPct,
  projectedShare,
  replayReport,
  settledAnswers,
  verdictFlips,
  type NightRecord,
  type ScoredItem,
} from "./score.ts";
import { todayNightDue } from "./script-roots.ts";
import { osloDay } from "../work-map/ids.ts";
import { commitAt, git, write } from "./test-repo.ts";

const MIN = 60_000;
const DAY_MS = 86_400_000;
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

  test("a page busier than any count still finds the commit before the answer", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    const sha = commitAt(root, "2026-10-01T10:00:00Z", "the card");
    for (let i = 0; i < 85; i++) {
      write(root, "p.mdx", `${page(REC)}\nline ${i}\n`);
      commitAt(root, `2026-10-03T10:${String(i % 60).padStart(2, "0")}:00Z`, `busy ${i}`);
    }
    const card = await cardAsAnswered(root, "p.mdx", "O1", hash(REC), at("2026-10-02T10:00:00Z"), realGit);
    expect(card).toMatchObject({ status: "ok", commit: sha, body: REC });
  }, 30_000);

  test("the log read takes no count", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    commitAt(root, "2026-10-01T10:00:00Z", "one");
    const seen: (number | undefined)[] = [];
    const spy: GitRun = (cwd, args, opts) => {
      if (args[0] === "log") seen.push(opts?.maxLines);
      return realGit(cwd, args, opts);
    };
    await cardAsAnswered(root, "p.mdx", "O1", hash(REC), at("2026-10-02T10:00:00Z"), spy);
    expect(seen).toEqual([undefined]);
  });

  test("a root that is no repo reads unreadable, never no-history", async () => {
    const root = testTempDirSync(path.join(tmpdir(), "triage-norepo-"));
    const card = await cardAsAnswered(root, "p.mdx", "O1", "h", at("2026-10-02T10:00:00Z"), realGit);
    expect(card).toMatchObject({ status: "unreadable", commit: null, body: null });
  });

  test("a log cut off by the byte bound or a timeout reads unreadable", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    commitAt(root, "2026-10-01T10:00:00Z", "one");
    const when = at("2026-10-02T10:00:00Z");
    const capped: GitRun = () => Promise.resolve({ ok: true, stdout: "", capped: true });
    const timedOut: GitRun = () => Promise.resolve({ ok: false, stdout: "", timedOut: true });
    expect((await cardAsAnswered(root, "p.mdx", "O1", hash(REC), when, capped)).status).toBe("unreadable");
    expect((await cardAsAnswered(root, "p.mdx", "O1", hash(REC), when, timedOut)).status).toBe("unreadable");
  });

  test("a commit that cannot be read reads unreadable, wherever it fell in the walk", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    commitAt(root, "2026-10-01T10:00:00Z", "one");
    write(root, "p.mdx", page(NO_REC));
    const newest = commitAt(root, "2026-10-01T12:00:00Z", "two");
    const bad: GitRun = (cwd, args, opts) => (args[0] === "show" && args[1]!.startsWith(newest) ? Promise.resolve({ ok: false, stdout: "", stderr: "fatal: bad object" }) : realGit(cwd, args, opts));
    expect((await cardAsAnswered(root, "p.mdx", "O1", hash(REC), at("2026-10-02T10:00:00Z"), bad)).status).toBe("unreadable");
  });

  test("a read failing in the later walks reads unreadable too", async () => {
    const root = repo();
    write(root, "p.mdx", page(NO_REC));
    const older = commitAt(root, "2026-10-01T10:00:00Z", "older");
    write(root, "p.mdx", page(REC));
    const newer = commitAt(root, "2026-10-01T12:00:00Z", "newer");
    write(root, "p.mdx", page(NO_REC));
    const later = commitAt(root, "2026-10-05T10:00:00Z", "later");
    const failsOn = (sha: string): GitRun => (cwd, args, opts) => (args[0] === "show" && args[1]!.startsWith(sha) ? Promise.resolve({ ok: false, stdout: "", timedOut: true }) : realGit(cwd, args, opts));
    // The newest before the answer holds other wording, so the walk for the answered wording goes on.
    expect((await cardAsAnswered(root, "p.mdx", "O1", "another-hash", at("2026-10-02T10:00:00Z"), failsOn(older))).status).toBe("unreadable");
    // Nothing before the answer: the search runs through the commits after it.
    expect((await cardAsAnswered(root, "p.mdx", "O1", "another-hash", at("2026-09-02T10:00:00Z"), failsOn(later))).status).toBe("unreadable");
    expect((await cardAsAnswered(root, "p.mdx", "O1", hash(REC), at("2026-09-02T10:00:00Z"), failsOn(newer))).status).toBe("unreadable");
  });

  test("a commit that deleted the page is no read failure: the walk goes on", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    const sha = commitAt(root, "2026-10-01T10:00:00Z", "one");
    git(root, "rm", "-q", "p.mdx");
    commitAt(root, "2026-10-01T12:00:00Z", "gone");
    const card = await cardAsAnswered(root, "p.mdx", "O1", hash(REC), at("2026-10-02T10:00:00Z"), realGit);
    expect(card).toMatchObject({ status: "ok", commit: sha });
  });

  test("a whole wiki's history failing is a fault, not an empty result, and the floor throws", async () => {
    const root = testTempDirSync(path.join(tmpdir(), "triage-norepo-"));
    let asked = 0;
    const history = async () => {
      asked++;
      return [v({})];
    };
    const [row] = await labelsSince([{ wiki: "w", root }], 0, history, realGit);
    expect(row!.labelled).toEqual([]);
    expect(row!.fault).toContain("not a git repository");
    expect(asked).toBe(0);
    await expect(computeFloor([{ wiki: "w", root }], history, realGit)).rejects.toThrow("not a git repository");
  });

  describe("the answer window, one for the run line and the score", () => {
    const after = frozenAfterMs(DECISION_TRIAGE_PROMPT_FROZEN_ON);
    const current = DECISION_TRIAGE_PROMPT_VERSION;

    test("the later of the frozen date and the current prompt's first run line, of any outcome", () => {
      expect(answerWindowMs([])).toBe(after);
      expect(answerWindowMs([{ at: after - DAY_MS, promptVersion: current }])).toBe(after);
      expect(answerWindowMs([{ at: after + 3 * DAY_MS, promptVersion: current }, { at: after + DAY_MS, promptVersion: current }])).toBe(after + DAY_MS);
      expect(answerWindowMs([{ at: after + DAY_MS, promptVersion: "older" }])).toBe(after);
      expect(answerWindowMs([{ at: after + DAY_MS, promptVersion: "older" }, { at: after + 5 * DAY_MS, promptVersion: current }])).toBe(after + 5 * DAY_MS);
    });

    test("the floor counts from the prompt's first run line, as the score does, and a run's own line counts", async () => {
      const root = repo();
      write(root, "p.mdx", `${page(REC)}${page(REC, "O2")}`);
      commitAt(root, new Date(after).toISOString(), "cards");
      const q = (id: string, ms: number) => v({ answerId: id, questionId: id, questionHash: hash(REC), choice: "B", createdAt: ms });
      const history = async () => [q("O1", after + DAY_MS), q("O2", after + 3 * DAY_MS)];
      const dir = testTempDirSync(path.join(tmpdir(), "triage-floor-"));
      const counted = async (opts: { dir: string; ownLineAt?: number }) => (await computeFloor([{ wiki: "w", root }], history, realGit, opts)).labelled;
      expect(await counted({ dir })).toBe(2);
      expect(await counted({ dir, ownLineAt: after + 2 * DAY_MS })).toBe(1);
      const older = { type: "run", at: after + 2 * DAY_MS, wiki: "w", promptVersion: "older", outcome: "ok" };
      writeFileSync(nightlyLogPath("w", dir), `${JSON.stringify(older)}\n`);
      expect(await counted({ dir })).toBe(2);
      writeFileSync(nightlyLogPath("w", dir), `${JSON.stringify({ ...older, promptVersion: current, outcome: "refused" })}\n`);
      expect(await counted({ dir })).toBe(1);
    });
  });

  test("every answer's read failing is a fault; one of several is a count, not a fault", async () => {
    const root = repo();
    write(root, "p.mdx", page(REC));
    commitAt(root, "2026-10-01T10:00:00Z", "one");
    const logFails = (rel: string | null): GitRun => (cwd, args, opts) => (args[0] === "log" && (rel === null || args.includes(rel)) ? Promise.resolve({ ok: false, stdout: "", stderr: "fatal: bad" }) : realGit(cwd, args, opts));
    const two = async () => [v({ questionHash: hash(REC), createdAt: at("2026-10-02T10:00:00Z") }), v({ answerId: "b", relPath: "q.mdx", createdAt: at("2026-10-02T10:00:00Z") })];
    const [all] = await labelsSince([{ wiki: "w", root }], 0, two, logFails(null));
    expect(all!.fault).toContain("none of w's 2 answers");
    const [some] = await labelsSince([{ wiki: "w", root }], 0, two, logFails("q.mdx"));
    expect(some!.fault).toBeUndefined();
    expect(some!.labelled.map((l) => l.status).sort()).toEqual(["ok", "unreadable"]);
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
  const head = (caught: number, flaggedOthers: number) => part1Headline(replayReport(build(14, 35, caught, flaggedOthers), population));

  test("the two controls project to the contract's shares", () => {
    expect(projectedShare({ caught: 10, of: 14, flagged: 22, cards: 49 }, population)).toBe(39);
    expect(projectedShare({ caught: 11, of: 14, flagged: 21, cards: 49 }, population)).toBe(35);
  });

  test("better, worse and tie by the contract's numbers, tie saying where it fell against the rule", () => {
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

  test("the bars read the raw share: 11 of 14 with 16 of 35 is 50.24%, over 50% though it prints 50%", () => {
    const h = head(11, 16);
    expect(h.result).toBe("worse");
    expect(h.line).toContain("50.2% flagged");
    const report = replayReport(build(14, 35, 12, 8), population);
    expect(part1Headline({ ...report, sharePct: 39, shareRaw: 39.3 }).result).toBe("tie");
    expect(part1Headline({ ...report, sharePct: 39, shareRaw: 39 }).result).toBe("better");
    expect(part1Headline({ ...report, sharePct: 50, shareRaw: 50 }).result).toBe("tie");
  });

  describe("the headline prints what the bars read", () => {
    const BARS = "Bars, read raw: worse at 9 or fewer caught or over 50% flagged; better at 12 or more caught and at most 39% flagged.";
    /** The contract's two controls beside the verdict: text alone 10 of 14 with 12 of 35, the rule 11 of 14 with 10 of 35. */
    const withControls = (caught: number, flaggedOthers: number) =>
      build(14, 35, caught, flaggedOthers).map((it, i) => ({
        ...it,
        textAlone: i < 14 ? i < 10 : i - 14 < 12,
        wiki: (i < 14 ? i < 11 : i - 14 < 10) ? "melosys-kode-wiki" : "mimir",
      }));
    const line = (caught: number, flaggedOthers: number) => part1Headline(replayReport(withControls(caught, flaggedOthers), population));

    test.each([
      ["worse", 11, 16, "WORSE: 11 of 14 caught, 50.2% flagged"],
      ["worse", 9, 3, "WORSE: 9 of 14 caught, 16.2% flagged"],
      ["better", 12, 8, "BETTER: 12 of 14 caught, 31.5% flagged"],
      ["tie", 10, 8, "TIE: 10 of 14 caught, 29.5% flagged"],
      ["tie", 12, 12, "TIE: 12 of 14 caught, 41.4% flagged"],
    ] as const)("%s at %i and %i prints one decimal, both controls and the bars", (result, caught, others, opening) => {
      const h = line(caught, others);
      expect(h.result).toBe(result);
      expect(h.line).toStartWith(opening);
      expect(h.line).toContain("(text alone 10 of 14, 39.4%; rule 11 of 14, 35.5%)");
      expect(h.line).toEndWith(BARS);
    });

    test("not scored gives no share and no bars: nothing was read against them", () => {
      const items = withControls(12, 8);
      items[0]!.verdict = "NO_VERDICT";
      const h = part1Headline(replayReport(items, population));
      expect(h.result).toBe("not scored");
      expect(h.line).not.toContain("%");
      expect(h.line).not.toContain("Bars");
    });

    test("a base with no bars prints one decimal and no bars line", () => {
      const h = part1Headline(replayReport(build(13, 35, 12, 8), population));
      expect(h.result).toBe("no bars");
      expect(h.line).toMatch(/caught, \d+\.\d% flagged/);
      expect(h.line).not.toContain("Bars, read raw");
    });

    test("a share one decimal would print on its bar, or on the rule, prints as many as it takes", () => {
      const report = replayReport(withControls(12, 8), population);
      const over = part1Headline({ ...report, shareRaw: 50.04 });
      expect(over.result).toBe("worse");
      expect(over.line).toContain("50.04% flagged");
      expect(part1Headline({ ...report, shareRaw: 39.04 }).line).toContain("39.04% flagged");
      expect(part1Headline({ ...report, shareRaw: 39 }).line).toContain("39.0% flagged");
      expect(part1Headline({ ...report, shareRaw: 50 }).line).toContain("50.0% flagged");
      const close = part1Headline({ ...report, verdict: { ...report.verdict, caught: 11 }, shareRaw: 30.91, rule: { ...report.rule, caught: 11, shareRaw: 30.94 } });
      expect(close.line).toContain("30.91% flagged");
      expect(close.line).toContain("rule 11 of 14, 30.94%");
      expect(close.line).toContain("at or above");
      expect(part1Headline({ ...report, verdict: { ...report.verdict, caught: 11 }, shareRaw: 30.94, rule: { ...report.rule, caught: 11, shareRaw: 30.91 } }).line).toContain("below");
    });

    test("shownPct: one decimal, more only against a bar it differs from", () => {
      expect(shownPct(39.4)).toBe("39.4%");
      expect(shownPct(39.44, 39)).toBe("39.4%");
      expect(shownPct(39.04, 39)).toBe("39.04%");
      expect(shownPct(38.96, 39)).toBe("38.96%");
      expect(shownPct(39, 39)).toBe("39.0%");
      expect(shownPct(39 + 1e-12, 39)).toBe("39.0%");
      expect(shownPct(39.04, 50, 39)).toBe("39.04%");
      expect(shownPct(39 + 1e-8, 39)).toBe("39.00000001%");
    });
  });

  test("below the rule reads the raw shares too", () => {
    const rep = replayReport(build(14, 35, 10, 8), population);
    const at = (own: number, rule: number) => part1Headline({ ...rep, sharePct: 30, shareRaw: own, rule: { ...rep.rule, caught: 10, sharePct: 30, shareRaw: rule } }).line;
    expect(at(30.4, 30.2)).toContain("below");
    expect(at(30.2, 30.4)).toContain("at or above");
  });

  test("a base other than 14 positives gets its figures and no bars", () => {
    for (const items of [build(13, 35, 12, 0), build(15, 35, 15, 0)]) {
      const h = part1Headline(replayReport(items, population));
      expect(h.result).toBe("no bars");
      expect(h.line).toContain(`${items.filter((i) => i.verdict === "ASK_OWNER").length} of ${items.filter((i) => i.added).length} caught`);
      expect(h.line).toContain("bars apply only to the file's base");
    }
    expect(part1Headline(replayReport(build(14, 35, 14, 0), population)).result).toBe("better");
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

  const input = (over: Partial<Parameters<typeof part2Headline>[0]> = {}): Parameters<typeof part2Headline>[0] => ({
    report: replayReport(build(10, 10, 9, 0)),
    floor: { labelled: 20, added: 10, addedPages: 2, met: true },
    day: 14,
    shares: { askOwnerMedian: 0.2, askAnyMedian: 0.4, nights: 10 },
    handRead: 5,
    handWrong: 0,
    settledThenAnswered: 0,
    context: { refused: 0, failed: 0, absent: 0, wikiNights: 10, olderLines: 0 },
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

  test("a SETTLED or VOID later answered blocks a pass, whatever the hand sample", () => {
    for (const hand of [{ handRead: null, handWrong: null }, { handRead: 4, handWrong: 0 }, { handRead: 5, handWrong: 0 }]) {
      const h = part2Headline(input({ ...hand, settledThenAnswered: 3 }));
      expect(h.result).toBe("miss");
      expect(h.line).toContain("3 SETTLED or VOID later answered");
      expect(h.line).not.toContain("not judged");
    }
  });

  test("fewer than 5 read and none later answered: the headline says not judged, and a wrong read below 5 does not decide", () => {
    for (const hand of [{ handRead: null, handWrong: null }, { handRead: 4, handWrong: 0 }]) {
      const h = part2Headline(input(hand));
      expect(h.result).toBe("pass");
      expect(h.line).toContain("«SETTLED or VOID» not judged");
    }
    expect(part2Headline(input({ handRead: 5 })).line).not.toContain("not judged");
  });

  test("every headline counts the nights in its own line, and any older lines it left out", () => {
    const context = { refused: 2, failed: 1, absent: 3, wikiNights: 20, olderLines: 0 };
    const said = "Nights: 2 refused, 1 failed, 3 absent, of 20 wiki-night(s).";
    for (const over of [{}, { report: replayReport(build(10, 10, 8, 0)) }, { day: 3 }, { day: null }, { floor: { labelled: 5, added: 1, addedPages: 1, met: false } }, { report: replayReport([{ ...item({}), verdict: "NO_VERDICT" }]) }]) {
      expect(part2Headline(input({ context, ...over })).line).toContain(said);
    }
    expect(part2Headline(input({ context })).line).not.toContain("older");
    expect(part2Headline(input({ context: { ...context, olderLines: 7 } })).line).toContain("7 log line(s) of older prompt versions left out.");
  });

  test("part (2) prints what its bars read, with the bars, in pass and in miss", () => {
    const pass = part2Headline(input({ shares: { askOwnerMedian: 0.3, askAnyMedian: 0.5, nights: 10 } }));
    expect(pass.result).toBe("pass");
    expect(pass.line).toStartWith("PASS (day 14): 9 of 10 caught (90.0%, bar at least 90%), nightly median ASK_OWNER 30.0% (bar at most 30%), both 50.0% (bar at most 50%). Bars read raw.");
    const miss = part2Headline(input({ shares: { askOwnerMedian: 0.3004, askAnyMedian: 0.5004, nights: 10 } }));
    expect(miss.result).toBe("miss");
    expect(miss.line).toStartWith("MISS (day 14): 9 of 10 caught (90.0%, bar at least 90%), nightly median ASK_OWNER 30.04% (bar at most 30%), both 50.04% (bar at most 50%). Bars read raw.");
    expect(part2Headline(input({ shares: { askOwnerMedian: null, askAnyMedian: null, nights: 0 } })).line).toContain("ASK_OWNER n/a (bar at most 30%), both n/a (bar at most 50%)");
    const below = part2Headline(input({ report: { ...replayReport(build(10, 10, 9, 0)), verdict: { caught: 8996, of: 10000, flagged: 8996, cards: 10000 } } }));
    expect(below.result).toBe("miss");
    expect(below.line).toContain("(89.96%, bar at least 90%)");
  });

  test("most catches means more ASK_OTHER than ASK_OWNER: a tie says nothing", () => {
    const report = replayReport(build(10, 10, 9, 0));
    const said = (ASK_OWNER: number, ASK_OTHER: number) => part2Headline(input({ report: { ...report, catchesBy: { ASK_OWNER, ASK_OTHER } } })).line;
    expect(said(4, 5)).toContain("Most catches are ASK_OTHER");
    expect(said(5, 5)).not.toContain("Most catches");
    expect(said(0, 0)).not.toContain("Most catches");
  });

  test("the bars read raw shares: 30.4% misses though it prints 30%, and exactly 30% and 50% pass through float noise", () => {
    const miss = part2Headline(input({ shares: { askOwnerMedian: 0.304, askAnyMedian: 0.4, nights: 10 } }));
    expect(miss.result).toBe("miss");
    expect(miss.line).toContain("ASK_OWNER 30.4% (bar at most 30%)");
    expect(part2Headline(input({ shares: { askOwnerMedian: 0.2, askAnyMedian: 0.504, nights: 10 } })).result).toBe("miss");
    // (0.2 + 0.4) / 2 is 0.30000000000000004, read off two real nights.
    const fifths = (owner: number): NightRecord => ({ day: `d${owner}`, wiki: "w", outcome: "ok", kinds: { ASK_OWNER: owner, DEFAULT: 5 - owner } });
    const shares = nightlyShares([fifths(1), fifths(2)]);
    expect(shares.askOwnerMedian! > 0.3).toBe(true);
    expect(part2Headline(input({ shares })).result).toBe("pass");
    const caught = (c: number, of: number) => part2Headline(input({ report: replayReport(build(of, 10, c, 0)) }));
    expect(caught(9, 10).result).toBe("pass");
    const justUnder = caught(26, 29);
    expect(justUnder.result).toBe("miss");
    expect(justUnder.line).toContain("(89.7%, bar at least 90%)");
  });

  test("the rule's match reads raw shares: 50.4% does not match a result at 50.2%, though both print 50%", () => {
    const r = replayReport(build(10, 10, 9, 0));
    const close = { ...r, sharePct: 50, shareRaw: 50.2, rule: { ...r.rule, caught: 9, sharePct: 50, shareRaw: 50.4 } };
    expect(part2Headline(input({ report: close })).line).not.toContain("rule matches");
    expect(part2Headline(input({ report: { ...close, rule: { ...close.rule, shareRaw: 50.2 } } })).line).toContain("rule matches");
  });

  test("fewer than 5 hand reads say not judged; the rule and ASK_OTHER get their notes", () => {
    expect(part2Headline(input({ handRead: 4 })).line).toContain("not judged");
    const items = build(10, 10, 9, 3).map((i, n) => ({ ...i, verdict: n < 9 ? ("ASK_OTHER" as const) : i.verdict, wiki: n < 10 ? "melosys-kode-wiki" : "mimir" }));
    const { line: said } = part2Headline(input({ report: replayReport(items) }));
    expect(said).toContain("rule matches");
    expect(said).toContain("Most catches are ASK_OTHER");
  });
});

const run = (over: Partial<RunLine>): RunLine => ({ type: "run", runId: "r", at: 0, wiki: "w", model: "m", promptVersion: "1", usage: { calls: 1 }, repoRoots: null, repos: [], cards: 0, floor: null, outcome: "ok", ...over });
const line = (over: Partial<CardLine>): CardLine => ({ type: "card", runId: "r", at: 0, wiki: "w", promptVersion: "1", relPath: "p", id: "O1", questionHash: "h", recommendation: null, verdict: "DEFAULT", ...over });
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
    const nights = nightsOf(runs, [], T0 + 4 * DAY, true);
    expect(nights.map((n) => n.outcome)).toEqual(["ok", "partial", "absent", "failed", "absent"]);
  });

  test("a wiki that only ever refused shows those nights and starts no clock", () => {
    expect(nightsOf([run({ at: T0, outcome: "refused" })], [], T0 + 5 * DAY, true)).toHaveLength(1);
  });

  test("a card line with no run line still counts its verdict; the shares read model verdicts only", () => {
    const nights = nightsOf(
      [run({ at: T0 })],
      [line({ at: T0, verdict: "ASK_OWNER" }), line({ at: T0, verdict: "DEFAULT" }), line({ at: T0, verdict: "ANSWERED" }), line({ at: T0, verdict: "NO_VERDICT" }), line({ at: T0, verdict: "ASK_OTHER" }), line({ at: T0, verdict: "SETTLED" }), line({ at: T0 + DAY, verdict: "ASK_OTHER" })],
      T0 + DAY,
      true,
    );
    expect(nights[0]!.kinds).toEqual({ ASK_OWNER: 1, DEFAULT: 1, ASK_OTHER: 1, SETTLED: 1 });
    expect(nights[1]).toMatchObject({ outcome: "absent", kinds: { ASK_OTHER: 1 } });
    const shares = nightlyShares(nights);
    expect(shares.nights).toBe(2);
    expect(shares.askOwnerMedian).toBeCloseTo(0.125);
    expect(shares.askAnyMedian).toBeCloseTo(0.75);
  });

  test("the headline's counts are wiki-nights by outcome", () => {
    const n = (outcome: NightRecord["outcome"]): NightRecord => ({ day: "d", wiki: "w", outcome, kinds: {} });
    expect(nightContext([n("ok"), n("partial"), n("refused"), n("refused"), n("refused"), n("failed"), n("absent"), n("absent")], 4)).toEqual({ refused: 3, failed: 1, absent: 2, wikiNights: 8, olderLines: 4 });
  });

  test("one night pools its wikis: a small wiki at 0% and a big one at 60% read 50%, not 30%", () => {
    const nights: NightRecord[] = [
      { day: "2026-11-10", wiki: "small", outcome: "ok", kinds: { DEFAULT: 2 } },
      { day: "2026-11-10", wiki: "big", outcome: "ok", kinds: { ASK_OWNER: 6, DEFAULT: 4 } },
    ];
    expect(nightlyShares(nights)).toEqual({ askOwnerMedian: 0.5, askAnyMedian: 0.5, nights: 1 });
    const other: NightRecord = { day: "2026-11-11", wiki: "small", outcome: "ok", kinds: { ASK_OTHER: 1, DEFAULT: 1 } };
    expect(nightlyShares([...nights, other])).toEqual({ askOwnerMedian: 0.25, askAnyMedian: 0.5, nights: 2 });
    expect(nightlyShares([{ day: "2026-11-12", wiki: "w", outcome: "ok", kinds: {} }]).nights).toBe(0);
  });

  test("today reads absent only once its hour has passed; a line today always counts", () => {
    const lateNight = run({ at: T0 - DAY });
    expect(nightsOf([lateNight], [], T0, false).map((n) => n.outcome)).toEqual(["ok"]);
    expect(nightsOf([lateNight], [], T0, true).map((n) => n.outcome)).toEqual(["ok", "absent"]);
    expect(nightsOf([lateNight, run({ at: T0, outcome: "refused" })], [], T0, false).map((n) => n.outcome)).toEqual(["ok", "refused"]);
    expect(nightsOf([lateNight], [line({ at: T0, verdict: "ASK_OWNER" })], T0, false).map((n) => n.outcome)).toEqual(["ok", "absent"]);
    // An earlier day with no line is a missed night at any hour.
    expect(nightsOf([run({ at: T0 - 2 * DAY })], [], T0, false).map((n) => n.outcome)).toEqual(["ok", "absent"]);
  });

  test("today's hour plus one decides whether today counts", () => {
    const at = (iso: string) => todayNightDue(Date.parse(iso), 5);
    expect(at("2026-11-10T03:59:00Z")).toBe(false); // 04:59 in Oslo
    expect(at("2026-11-10T04:30:00Z")).toBe(false); // the hour itself: a run may be going
    expect(at("2026-11-10T05:00:00Z")).toBe(true);
    expect(at("2026-11-10T22:59:00Z")).toBe(true); // 23:59 in Oslo
    expect(at("2026-11-10T23:30:00Z")).toBe(false); // 00:30 on the next day in Oslo
  });

  test("a killed night keeps its verdicts: a wiki with no ok line, and a night before the first ok line", () => {
    const killedOnly = nightsOf([], [line({ at: T0, verdict: "ASK_OWNER" }), line({ at: T0 + DAY, verdict: "DEFAULT" })], T0 + 5 * DAY, true);
    expect(killedOnly).toEqual([
      { day: osloDay(T0), wiki: "w", outcome: "absent", kinds: { ASK_OWNER: 1 } },
      { day: osloDay(T0 + DAY), wiki: "w", outcome: "absent", kinds: { DEFAULT: 1 } },
    ]);
    const refusedThenKilled = nightsOf([run({ at: T0, outcome: "refused" })], [line({ at: T0 + DAY, verdict: "ASK_OTHER" })], T0 + 2 * DAY, true);
    expect(refusedThenKilled.map((n) => [n.outcome, n.kinds])).toEqual([["refused", {}], ["absent", { ASK_OTHER: 1 }]]);
    const killedFirst = nightsOf([run({ at: T0 + DAY })], [line({ at: T0, verdict: "ASK_OWNER" }), line({ at: T0, verdict: "NO_VERDICT" })], T0 + DAY, true);
    expect(killedFirst.map((n) => [n.outcome, n.kinds])).toEqual([["absent", { ASK_OWNER: 1 }], ["ok", {}]]);
    expect(nightlyShares(killedFirst).nights).toBe(1);
    // A NO_VERDICT line alone is no night of model verdicts and moves no start.
    expect(nightsOf([run({ at: T0 + DAY })], [line({ at: T0, verdict: "NO_VERDICT" })], T0 + DAY, true).map((n) => n.outcome)).toEqual(["ok"]);
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
