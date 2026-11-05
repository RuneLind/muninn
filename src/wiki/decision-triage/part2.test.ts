/** Part (2)'s assembly, pure: what it replays, what it counts, and that a headline
 *  known before the model is known before the model. */

import { describe, expect, test } from "bun:test";
import { sha256 } from "../../gardener/util.ts";
import type { LabelledAnswer } from "./history.ts";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { amendWithHand, cardDoneToday, currentLog, finalRefusal, handSample, parseScoringRecords, part2Day, part2Plan, runPart2, scoringGate, sinceAfterWindow, type ScoringRecord, type ScoringRecords } from "./part2.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, replayKey, type CardLine, type RunLine, type VerdictKind } from "./schema.ts";
import { verdictFlips } from "./score.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-06T04:00:00Z");

const row = (n: number, over: Partial<LabelledAnswer> = {}, page = `p${n % 2}.mdx`): LabelledAnswer => ({
  settled: { relPath: page, id: `O${n}`, answerId: `a${n}`, author: "Eier", firstAt: T0 + n * 1000, at: T0 + n * 1000, choice: "A", body: "", questionHash: "h" },
  status: "ok",
  commit: "abcdef1",
  recommendation: "A",
  added: false,
  ...over,
});
/** A floor met exactly: 20 labelled, 10 added, on 2 pages. */
const floorMet = () => Array.from({ length: 20 }, (_, n) => row(n, { added: n < 10 }));
const run = (at: number): RunLine => ({ type: "run", runId: "r", at, wiki: "w", model: "m", promptVersion: DECISION_TRIAGE_PROMPT_VERSION, usage: { calls: 1 }, repoRoots: null, repos: [], cards: 0, floor: null, outcome: "ok" });
const night = (over: Partial<CardLine>): CardLine => ({ type: "card", runId: "r", at: T0, wiki: "w", promptVersion: DECISION_TRIAGE_PROMPT_VERSION, relPath: "p0.mdx", id: "O0", questionHash: "h", recommendation: "A", verdict: "DEFAULT", ...over });

function replaying() {
  const calls: { n: number } = { n: 0 };
  return {
    calls,
    replay: async (cards: Parameters<Parameters<typeof runPart2>[0]["replay"]>[0]) => {
      calls.n++;
      return new Map(cards.map((c, i) => [replayKey(c), night({ relPath: c.relPath, id: c.id, verdict: i < 10 ? "ASK_OWNER" : "DEFAULT" })]));
    },
  };
}
const day = (n: number) => T0 + n * DAY + 1000;
const NO_RECORDS: ScoringRecords = { records: [], broken: 0 };
const common = { todayCounts: true, records: NO_RECORDS, record: async () => {} };

describe("the plan", () => {
  test("only a commit holding the answered wording is replayed; the floor counts what has a label", () => {
    const plan = part2Plan(
      [{ wiki: "w", labelled: [row(1, { added: true }), row(2, { status: "hash-mismatch", added: true }), row(3, { status: "after-answer", commit: null }), row(4, { status: "no-history", commit: null }), row(5, { status: "unreadable", commit: null }), row(6, { added: null })] }],
      { runs: [], cards: [] },
      T0,
      true,
    );
    expect(plan.cards.map((c) => c.id)).toEqual(["O1", "O6"]);
    expect(plan.cards[0]).toEqual({ wiki: "w", relPath: "p1.mdx", id: "O1", answeredAt: new Date(T0 + 1000).toISOString(), commit: "abcdef1", hashMatches: true, replayable: true });
    expect(plan.floor).toMatchObject({ labelled: 1, added: 1 });
    expect(plan.dropped).toEqual({ noHistory: 1, unreadable: 1, afterAnswer: 1, hashMismatch: 1 });
  });

  test("the day counts from the earliest ok or partial line, floors, and has no run line to read as null", () => {
    const labelled = [{ wiki: "w", labelled: [] }];
    const dayAt = (runs: RunLine[], nowMs: number) => part2Plan(labelled, { runs, cards: [] }, nowMs, true).day;
    expect(dayAt([], T0)).toBeNull();
    expect(dayAt([{ ...run(T0 - DAY), outcome: "refused" }], T0)).toBeNull();
    expect(dayAt([run(T0), { ...run(T0 - 3 * DAY), outcome: "partial" }, { ...run(T0 - 9 * DAY), outcome: "failed" }], T0 + DAY - 1)).toBe(3);
  });

  test("the floor is per wiki and page: one path in two wikis is two pages", () => {
    const one = (wiki: string, n: number) => ({ wiki, labelled: [row(n, { added: true }, "same.mdx")] });
    expect(part2Plan([one("a", 1), one("b", 2)], { runs: [], cards: [] }, T0, true).floor.addedPages).toBe(2);
  });
});

describe("no model call when the headline is already known", () => {
  test.each([
    ["day 3", [run(T0)], day(3), floorMet(), "too early"],
    ["no run line", [], day(30), floorMet(), "too early"],
    ["day 14 under the floor", [run(T0)], day(14), floorMet().slice(0, 19), "too few to score"],
    ["the cap under the floor", [run(T0)], day(28), floorMet().slice(0, 19), "too few to score"],
  ] as const)("%s", async (_name, runs, nowMs, rows, result) => {
    const { calls, replay } = replaying();
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: [...rows] }], log: { runs: [...runs], cards: [] }, nowMs, hand: null, replay, ...common });
    expect(calls.n).toBe(0);
    expect(out.headline.result).toBe(result);
    expect(out.scored).toBeNull();
  });

  test("day 14 over the floor calls the model once, and scores what comes back", async () => {
    const { calls, replay } = replaying();
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards: [] }, nowMs: day(14), hand: { read: 5, wrong: 0 }, replay, ...common });
    expect(calls.n).toBe(1);
    expect(out.scored!.report.verdict).toMatchObject({ caught: 10, of: 10, cards: 20 });
    expect(out.headline.result).toBe("miss"); // the nightly medians have no verdicts to read
  });
});

describe("the assembly reaches the headline", () => {
  const nights = (extra: CardLine[] = []): CardLine[] => [night({ id: "n1", at: T0, verdict: "DEFAULT" }), ...extra];
  const passing = async (cards: CardLine[], hand: { read: number; wrong: number } | null) => {
    const { replay } = replaying();
    return runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards }, nowMs: day(14), hand, replay, ...common });
  };

  test("nothing against it, a full sample: pass", async () => {
    expect((await passing(nights(), { read: 5, wrong: 0 })).headline.result).toBe("pass");
  });

  test("one nightly SETTLED before its answer blocks the pass with no hand sample at all", async () => {
    const h = (await passing(nights([night({ id: "O3", relPath: "p1.mdx", at: T0, verdict: "SETTLED" })]), null)).headline;
    expect(h.result).toBe("miss");
    expect(h.line).toContain("1 SETTLED or VOID later answered");
  });

  test("a VOID after the answer does not count", async () => {
    const h = (await passing(nights([night({ id: "O3", relPath: "p1.mdx", at: T0 + 2 * DAY, verdict: "VOID" })]), { read: 5, wrong: 0 })).headline;
    expect(h.result).toBe("pass");
  });

  test("no sample and nothing later answered reads not judged in the headline", async () => {
    const h = (await passing(nights(), null)).headline;
    expect(h.result).toBe("pass");
    expect(h.line).toContain("not judged");
  });

  test("a wrong read in a full sample is a miss", async () => {
    expect((await passing(nights(), { read: 5, wrong: 1 })).headline.result).toBe("miss");
  });

  test("a card the replay did not return is not scored", async () => {
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards: nights() }, nowMs: day(14), hand: { read: 5, wrong: 0 }, replay: async () => new Map(), ...common });
    expect(out.headline.result).toBe("not scored");
  });
});

describe("a new prompt version restarts part (2)", () => {
  const OLD = "an-older-version";
  const old = (at: number): RunLine => ({ ...run(at), promptVersion: OLD });
  const NOW = day(30);

  test("an old prompt's run 14 days back and a new one's 1 day back read day 1 and TOO EARLY, with no model call", async () => {
    const { calls, replay } = replaying();
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [old(NOW - 14 * DAY), run(NOW - DAY)], cards: [] }, nowMs: NOW, hand: { read: 5, wrong: 0 }, replay, ...common });
    expect(out.plan.day).toBe(1);
    expect(out.headline.result).toBe("too early");
    expect(out.headline.line).toContain("TOO EARLY (day 1)");
    expect(out.headline.line).toContain("1 log line(s) of older prompt versions left out");
    expect(calls.n).toBe(0);
  });

  test("an old prompt's lines alone: no clock", () => {
    expect(part2Plan([], { runs: [old(NOW - 40 * DAY)], cards: [] }, NOW, true).day).toBeNull();
    expect(part2Day([old(NOW - 40 * DAY)], NOW)).toBeNull();
    expect(part2Day([old(NOW - 40 * DAY), run(NOW - 2 * DAY)], NOW)).toBe(2);
  });

  test("the medians and SETTLED later answered read the current version's lines only", async () => {
    const start = NOW - 14 * DAY;
    const current = night({ id: "n1", at: start, verdict: "DEFAULT" });
    const stale = { promptVersion: OLD };
    const lines = [current, night({ id: "O3", relPath: "p1.mdx", at: T0, verdict: "SETTLED", ...stale }), night({ id: "x1", at: start, verdict: "ASK_OWNER", ...stale }), night({ id: "x2", at: start, verdict: "ASK_OWNER", ...stale })];
    const { replay } = replaying();
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(start), old(start - 20 * DAY)], cards: lines }, nowMs: NOW, hand: { read: 5, wrong: 0 }, replay, ...common });
    expect(out.headline.result).toBe("pass");
    expect(out.headline.line).toContain("nightly median ASK_OWNER 0%");
    expect(out.headline.line).toContain("4 log line(s) of older prompt versions left out");
  });

  test("the kept log is the current version's; a line with no version counts as older; flips read it", () => {
    const { promptVersion: _gone, ...noVersion } = night({ id: "O9", at: 5, verdict: "ASK_OWNER" });
    const cards = [night({ id: "O9", at: 1, verdict: "DEFAULT", promptVersion: OLD }), night({ id: "O9", at: 2, verdict: "ASK_OWNER" }), noVersion as CardLine];
    const current = currentLog({ runs: [old(1), run(2)], cards });
    expect(current.olderLines).toBe(3);
    expect(current.runs).toHaveLength(1);
    expect(verdictFlips(cards).flips).toBe(1);
    expect(verdictFlips(current.cards).flips).toBe(0);
  });

  test("a scoring on the old prompt holds no decision for the new one", () => {
    const records = { records: [{ type: "scoring", at: 1, day: 14, promptVersion: OLD, result: "pass", hand: null, input: null } as ScoringRecord], broken: 0 };
    expect(scoringGate(records, 14)).toEqual({ allowed: true, kind: "decision" });
  });
});

describe("the one decision point", () => {
  /** A run's life: each scoring reads the record the last one wrote. */
  function life(opts: { rows?: () => LabelledAnswer[]; cards?: CardLine[]; flagged?: number } = {}) {
    const written: ScoringRecord[] = [];
    const calls = { n: 0 };
    const score = (n: number, extra: { hand?: { read: number; wrong: number }; final?: boolean; rows?: LabelledAnswer[] } = {}) =>
      runPart2({
        wikis: [{ wiki: "w", labelled: extra.rows ?? opts.rows?.() ?? floorMet() }],
        log: { runs: [run(T0)], cards: opts.cards ?? [night({ id: "n1", at: T0, verdict: "DEFAULT" })] },
        nowMs: day(n),
        todayCounts: true,
        hand: extra.hand ?? { read: 5, wrong: 0 },
        ...(extra.final ? { final: true } : {}),
        records: parseScoringRecords(written.map((r) => JSON.stringify(r)).join("\n")),
        record: async (r) => void written.push(r),
        replay: async (cards) => {
          calls.n++;
          return new Map(cards.map((c, i) => [replayKey(c), night({ relPath: c.relPath, id: c.id, verdict: i < (opts.flagged ?? 10) ? "ASK_OWNER" : "DEFAULT" })]));
        },
      });
    return { written, calls, score };
  }
  /** 8 of 10 caught: a miss on the bar, whatever the day. */
  const missing = { flagged: 8 };

  test("day 14 miss: refused on every day to 27, the same day included, allowed once at 28, then refused", async () => {
    const { written, calls, score } = life(missing);
    expect((await score(14)).headline.result).toBe("miss");
    expect(written.map((r) => [r.day, r.result])).toEqual([[14, "miss"]]);
    for (const n of [14, 15, 16, 20, 27]) {
      const later = await score(n);
      expect(later.headline.result).toBe("refused");
      expect(later.headline.line).toContain(`REFUSED (day ${n})`);
      expect(later.headline.line).toContain("no scoring between");
      expect(later.scored).toBeNull();
    }
    expect(calls.n).toBe(1);
    expect(written).toHaveLength(1);
    expect((await score(28)).headline.result).toBe("miss");
    expect(written.map((r) => r.day)).toEqual([14, 28]);
    expect(calls.n).toBe(2);
    for (const n of [28, 29, 60]) {
      const h = (await score(n)).headline;
      expect(h.result).toBe("refused");
      expect(h.line).toContain("final");
    }
    expect(calls.n).toBe(2);
  });

  test("the day 16 re-run that would now read PASS never gets to", async () => {
    const m = life(missing);
    await m.score(14);
    const later = await m.score(16, { rows: floorMet() });
    expect(later.headline.result).toBe("refused");
  });

  test("a pass is not scored again on any later day", async () => {
    const { written, calls, score } = life();
    expect((await score(14)).headline.result).toBe("pass");
    for (const n of [14, 20, 28, 40]) {
      const h = (await score(n)).headline;
      expect(h.result).toBe("refused");
      expect(h.line).toContain("passed");
    }
    expect(calls.n).toBe(1);
    expect(written).toHaveLength(1);
  });

  test("no floor on day 14 leaves the decision to day 28 too, even once the floor is met", async () => {
    const { written, calls, score } = life();
    const few = floorMet().slice(0, 19);
    expect((await score(14, { rows: few })).headline.result).toBe("too few to score");
    expect(written.map((r) => [r.day, r.result, r.input])).toEqual([[14, "too few to score", null]]);
    expect((await score(16)).headline.result).toBe("refused");
    expect(calls.n).toBe(0);
    expect((await score(28)).headline.result).toBe("pass");
    expect(calls.n).toBe(1);
  });

  test("a late session: the first scoring past day 28 runs, once", async () => {
    const { written, score } = life();
    expect((await score(40)).headline.result).toBe("pass");
    expect(written.map((r) => r.day)).toEqual([40]);
    expect((await score(41)).headline.result).toBe("refused");
  });

  test("a first scoring on day 17 is the decision point, and a miss there still waits for 28", async () => {
    const { score } = life(missing);
    expect((await score(17)).headline.result).toBe("miss");
    expect((await score(18)).headline.result).toBe("refused");
    expect((await score(28)).headline.result).toBe("miss");
  });

  test("TOO EARLY is no scoring: nothing recorded, and day 14 is still the first", async () => {
    const { written, score } = life();
    for (const n of [0, 3, 13]) expect((await score(n)).headline.result).toBe("too early");
    expect(written).toEqual([]);
    expect((await score(14)).headline.result).toBe("pass");
  });

  test("not scored takes the decision point as any reading does", async () => {
    const written: ScoringRecord[] = [];
    const go = (n: number) => runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards: [] }, nowMs: day(n), todayCounts: true, hand: null, records: { records: [...written], broken: 0 }, record: async (r) => void written.push(r), replay: async () => new Map() });
    expect((await go(14)).headline.result).toBe("not scored");
    expect((await go(15)).headline.result).toBe("refused");
  });

  test("the record is written before a result can print: a failed write gives no headline", async () => {
    const { replay } = replaying();
    const attempt = runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards: [] }, nowMs: day(14), todayCounts: true, hand: null, records: NO_RECORDS, record: async () => { throw new Error("disk full"); }, replay });
    await expect(attempt).rejects.toThrow("disk full");
  });

  test("the record holds aggregates, never a card or its verdict's words", async () => {
    const { written, score } = life();
    await score(14);
    const text = JSON.stringify(written[0]);
    expect(text).not.toContain("O3");
    expect(text).not.toContain("p1.mdx");
    expect(written[0]).toMatchObject({ type: "scoring", day: 14, promptVersion: DECISION_TRIAGE_PROMPT_VERSION, hand: { read: 5, wrong: 0 } });
    expect(written[0]!.at).toBe(day(14));
  });

  test("a broken record line refuses from day 14, and before it nothing depends on the record", () => {
    const broken = parseScoringRecords('{"type":"scoring","day":14\n{"type":"other"}\n\n{"type":"scoring","day":"x","result":"miss","promptVersion":"v"}\n{"day":14,"result":"miss","promptVersion":"v"}');
    expect(broken).toEqual({ records: [], broken: 4 });
    const gate = scoringGate(broken, 20);
    expect(gate).toMatchObject({ allowed: false });
    expect(scoringGate(broken, 3)).toMatchObject({ allowed: false });
    expect(scoringGate(parseScoringRecords(""), 3)).toEqual({ allowed: true, kind: "before" });
    expect(scoringGate(NO_RECORDS, null)).toEqual({ allowed: true, kind: "before" });
    expect(scoringGate(NO_RECORDS, 14)).toEqual({ allowed: true, kind: "decision" });
    expect(scoringGate(NO_RECORDS, 27)).toEqual({ allowed: true, kind: "decision" });
    expect(scoringGate(NO_RECORDS, 28)).toEqual({ allowed: true, kind: "final" });
  });

  describe("a hand sample read after the scoring", () => {
    test("adds to the same figures once: a pass turned miss still waits for day 28, and no second hand", async () => {
      const m = life();
      await m.score(14, { hand: undefined });
      const scored = m.written[0]!;
      const unread: ScoringRecord = { ...scored, hand: null, input: { ...scored.input!, handRead: null, handWrong: null } };
      const gate = scoringGate({ records: [unread], broken: 0 }, 20);
      expect(gate).toMatchObject({ allowed: false, amend: unread });
      const wrong = amendWithHand(unread, { read: 5, wrong: 1 }, day(20));
      expect(wrong.headline.result).toBe("miss");
      expect(wrong.record).toMatchObject({ day: 14, at: day(20), result: "miss", hand: { read: 5, wrong: 1 } });
      expect(wrong.headline.line).toContain("(day 14)");
      const after = { records: [unread, wrong.record], broken: 0 };
      expect(scoringGate(after, 20)).toMatchObject({ allowed: false, amend: null });
      expect(scoringGate(after, 28)).toEqual({ allowed: true, kind: "final" });
    });

    test("cannot lift a miss: its figures do not move", () => {
      const m = { type: "scoring", at: 1, day: 14, promptVersion: DECISION_TRIAGE_PROMPT_VERSION, result: "miss", hand: null, input: null } as ScoringRecord;
      expect(scoringGate({ records: [m], broken: 0 }, 16)).toMatchObject({ allowed: false, amend: null });
    });

    test("a clean read on a pass stays a pass and says judged", async () => {
      const m = life();
      await m.score(14);
      const unread: ScoringRecord = { ...m.written[0]!, hand: null, input: { ...m.written[0]!.input!, handRead: 2, handWrong: 0 } };
      expect(amendWithHand(unread, { read: 2, wrong: 1 }, day(15)).headline.line).toContain("not judged");
      const clean = amendWithHand(unread, { read: 5, wrong: 0 }, day(15));
      expect(clean.headline.result).toBe("pass");
      expect(clean.headline.line).not.toContain("not judged");
      expect(scoringGate({ records: [clean.record], broken: 0 }, 16)).toMatchObject({ allowed: false, amend: null });
    });

    test("a not-scored record has nothing to add to, though it holds figures", () => {
      const notScored = { type: "scoring", at: 1, day: 14, promptVersion: DECISION_TRIAGE_PROMPT_VERSION, result: "not scored", hand: null, input: {} } as ScoringRecord;
      expect(scoringGate({ records: [notScored], broken: 0 }, 16)).toMatchObject({ allowed: false, amend: null });
    });

    test("a too-few record has nothing to add to", () => {
      const few = { type: "scoring", at: 1, day: 14, promptVersion: DECISION_TRIAGE_PROMPT_VERSION, result: "too few to score", hand: null, input: null } as ScoringRecord;
      expect(scoringGate({ records: [few], broken: 0 }, 16)).toMatchObject({ allowed: false, amend: null });
    });
  });

  describe("--final", () => {
    test("refused before the final scoring is reached", () => {
      expect(finalRefusal(null)).toContain("--final");
      expect(finalRefusal(3)).toContain("day 3");
      expect(finalRefusal(13)).toContain("day 13");
      expect(finalRefusal(14, false)).toContain("under the floor");
      expect(finalRefusal(27, false)).toContain("under the floor");
      expect(finalRefusal(14)).toBeNull();
      expect(finalRefusal(14, true)).toBeNull();
      expect(finalRefusal(28, false)).toBeNull();
    });

    test("through the run: day 3 and an unfloored day 14 refuse, record nothing and call no model", async () => {
      const { written, calls, score } = life();
      expect((await score(3, { final: true })).headline.result).toBe("refused");
      expect((await score(14, { final: true, rows: floorMet().slice(0, 19) })).headline.result).toBe("refused");
      expect(written).toEqual([]);
      expect(calls.n).toBe(0);
      expect((await score(14, { final: true })).headline.result).toBe("pass");
    });
  });

  test("a --since past the window's day is out: one window for the floor and the score", () => {
    const start = Date.parse("2026-11-07T23:30:00Z"); // already the 8th in Oslo
    expect(sinceAfterWindow("2026-11-08", start)).toBe(false);
    expect(sinceAfterWindow("2026-11-01", start)).toBe(false);
    expect(sinceAfterWindow("2026-11-09", start)).toBe(true);
  });
});

describe("the hand sample takes only cards done today", () => {
  const CARD = { relPath: "p.mdx", id: "O1" };
  const BODY = "Skal vi?";
  const card = `<Question id="O1" choices="A|B">\n${BODY}\n</Question>\n`;
  const PAGE = `# T\n\n${card}`;
  const CLOSED = `# T\n\n${card}\n<DecisionLog>\n- **O1** — Lukket 01.11.2026 (D1).\n- **D1** — Valgt. E, 01.11.2026.\n</DecisionLog>\n`;
  const hash = sha256(`${BODY}\n\nchoices: A|B`);
  const OWNER = "Eier";
  const version = (over: Partial<WikiAnswerVersion> = {}): WikiAnswerVersion => ({
    answerId: "a", version: 1, wiki: "w", relPath: "p.mdx", questionId: "O1", author: { userId: "u1", oid: null, navIdent: null, name: OWNER }, choice: "A", body: "", questionHash: hash, createdAt: 1000, exportedAt: null, redactedAt: null, ...over,
  });
  const done = (text: string | null, versions: WikiAnswerVersion[], owner: string | null = OWNER) => cardDoneToday(CARD, text, versions, owner);

  test("the owner's real choice on today's wording, or a closed card", () => {
    expect(done(PAGE, [version()])).toBe(true);
    expect(done(CLOSED, [])).toBe(true);
    expect(done(CLOSED, [], null)).toBe(true);
  });

  test("still open: no answer, not sure, text only, a colleague, changed wording, a redacted answer, a later not-sure", () => {
    const colleague = { userId: "u2", oid: null, navIdent: null, name: "Kollega" };
    expect(done(PAGE, [])).toBe(false);
    expect(done(PAGE, [version({ choice: "not-sure" })])).toBe(false);
    expect(done(PAGE, [version({ choice: null, body: "tekst" })])).toBe(false);
    expect(done(PAGE, [version({ author: colleague })])).toBe(false);
    expect(done(PAGE, [version({ questionHash: "older-wording" })])).toBe(false);
    expect(done(PAGE, [version({ redactedAt: 5 })])).toBe(false);
    expect(done(PAGE, [version(), version({ version: 2, choice: "not-sure", createdAt: 2000 })])).toBe(false);
    expect(done(PAGE, [version()], null)).toBe(false);
  });

  test("a group as owner: a member's choice leaves the card open; closing still counts", () => {
    const member = { userId: "u3", oid: null, navIdent: "X1", name: "Medlem" };
    expect(cardDoneToday(CARD, PAGE, [version({ author: member })], "fag")).toBe(false);
    expect(cardDoneToday(CARD, CLOSED, [], "fag")).toBe(true);
  });

  test("gone today counts as open: it may have moved", () => {
    expect(done(null, [version()])).toBe(false);
    expect(done("# T\n", [version()])).toBe(false);
  });

  const cardsOf = (kinds: VerdictKind[]) => kinds.map((_, i) => ({ wiki: "w", relPath: "p.mdx", id: `O${i}`, answeredAt: "2026-11-07T00:00:00.000Z", commit: "abc", hashMatches: true, replayable: true as const }));
  const linesOf = (cards: ReturnType<typeof cardsOf>, kinds: VerdictKind[]) => new Map(cards.map((c, i) => [replayKey(c), night({ relPath: c.relPath, id: c.id, answeredAt: c.answeredAt, verdict: kinds[i]!, why: `why ${c.id}` })]));

  test("a verdict on a card not done never reaches the rows", () => {
    const kinds: VerdictKind[] = ["SETTLED", "SETTLED", "VOID", "ASK_OWNER", "ASK_OTHER", "DEFAULT"];
    const cards = cardsOf(kinds);
    const lines = linesOf(cards, kinds);
    const closedOnly = new Set(["O1", "O4"]);
    const out = handSample(cards, lines, (c) => closedOnly.has(c.id), true);
    expect(out.map((k) => [k.kind, k.total, k.rows.map((r) => r.id)])).toEqual([
      ["SETTLED", 1, ["O1"]],
      ["VOID", 0, []],
      ["DEFAULT", 0, []],
      ["ASK_OWNER", 0, []],
      ["ASK_OTHER", 1, ["O4"]],
    ]);
    expect(handSample(cards, lines, () => false, true).flatMap((k) => k.rows)).toEqual([]);
  });

  test("before the final scoring only SETTLED and VOID; at it 5 each of the others, every SETTLED and VOID", () => {
    const kinds: VerdictKind[] = [...Array<VerdictKind>(7).fill("SETTLED"), ...Array<VerdictKind>(7).fill("DEFAULT"), ...Array<VerdictKind>(7).fill("ASK_OWNER"), ...Array<VerdictKind>(7).fill("ASK_OTHER")];
    const cards = cardsOf(kinds);
    const lines = linesOf(cards, kinds);
    expect(handSample(cards, lines, () => true, false).map((k) => k.kind)).toEqual(["SETTLED", "VOID"]);
    const final = handSample(cards, lines, () => true, true);
    expect(final.map((k) => [k.kind, k.total, k.rows.length])).toEqual([["SETTLED", 7, 7], ["VOID", 0, 0], ["DEFAULT", 7, 5], ["ASK_OWNER", 7, 5], ["ASK_OTHER", 7, 5]]);
  });

  test("a card with no line is left out", () => {
    const kinds: VerdictKind[] = ["SETTLED"];
    expect(handSample(cardsOf(kinds), new Map(), () => true, true).flatMap((k) => k.rows)).toEqual([]);
  });
});
