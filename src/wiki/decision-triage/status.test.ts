import { describe, expect, test } from "bun:test";
import { parseLog, type ParsedLog } from "./log.ts";
import type { CardLine, RunLine } from "./schema.ts";
import { nextTriageDue, triageWikiStatus } from "./status.ts";
import type { WorkMapState } from "../work-map/state.ts";

const H = 3_600_000;
/** 2026-11-07 04:00 UTC = 05:00 Oslo (UTC+1 in November). */
const FIVE_OSLO = Date.UTC(2026, 10, 7, 4);

const run = (at: number, over: Partial<RunLine> = {}): RunLine => ({
  type: "run", runId: `r${at}`, at, wiki: "w", model: "none", promptVersion: "off", usage: { calls: 0 },
  repoRoots: "/r", repos: [], cards: 0, floor: null, outcome: "ok", ...over,
});
const card = (runId: string, at: number, id: string, over: Partial<CardLine> = {}): CardLine => ({
  type: "card", runId, at, wiki: "w", promptVersion: "off", relPath: "plans/p.mdx", id, questionHash: "h",
  recommendation: null, verdict: "NO_VERDICT", ...over,
});
const logOf = (runs: RunLine[], cards: CardLine[], broken = 0): ParsedLog => ({ runs, cards, broken });

describe("triageWikiStatus", () => {
  test("an empty log: no run, no nights, still a next due time", () => {
    const s = triageWikiStatus("w", logOf([], []), null, FIVE_OSLO + H, 5);
    expect(s).toMatchObject({ wiki: "w", lastRun: null, nights: [], reposNotFound: [], broken: 0 });
    expect(s.nextDueAt).toBe(FIVE_OSLO + H);
  });

  test("counts code facts, ANSWERED and repos not found per night, newest night first", () => {
    const r1 = run(FIVE_OSLO - 24 * H, { cards: 2, repos: [{ repo: "a", found: true }] });
    const r2 = run(FIVE_OSLO + 10 * 60_000, {
      cards: 3, outcome: "partial", reason: "1 card(s) with no facts",
      repos: [{ repo: "a", found: true }, { repo: "gone", found: false, reason: "no such folder under the roots" }],
    });
    const cards = [
      card(r1.runId, r1.at, "O1", { codeFacts: true }),
      card(r1.runId, r1.at, "O2", { verdict: "ANSWERED" }),
      card(r2.runId, r2.at, "O1", { codeFacts: true }),
      card(r2.runId, r2.at, "O2", { verdict: "ANSWERED" }),
      card(r2.runId, r2.at, "O3", { codeFacts: false }),
    ];
    const s = triageWikiStatus("w", logOf([r2, r1], cards, 1), null, FIVE_OSLO + H, 5);
    expect(s.lastRun).toEqual({ at: r2.at, outcome: "partial", reason: "1 card(s) with no facts", cards: 3, model: "none", codeFacts: 1 });
    expect(s.nights).toEqual([
      { night: "2026-11-07", outcome: "partial", cards: 3, codeFacts: 1, answered: 1, reposNotFound: ["gone"] },
      { night: "2026-11-06", outcome: "ok", cards: 2, codeFacts: 1, answered: 1, reposNotFound: [] },
    ]);
    expect(s.reposNotFound).toEqual([{ repo: "gone", reason: "no such folder under the roots" }]);
    expect(s.broken).toBe(1);
  });

  test("a partial run: card lines with no run line count on their own night; a re-logged card counts once, its latest line", () => {
    const r = run(FIVE_OSLO, { cards: 1 });
    const cards = [
      card(r.runId, r.at, "O1", { codeFacts: false }),
      card("killed", r.at + 60_000, "O1", { codeFacts: true }),
      card("killed", r.at + 60_000, "O2", { verdict: "ANSWERED" }),
    ];
    const [night] = triageWikiStatus("w", logOf([r], cards), null, FIVE_OSLO + H, 5).nights;
    expect(night).toMatchObject({ night: "2026-11-07", cards: 2, codeFacts: 1, answered: 1, outcome: "ok" });
  });

  test("bounds the nights", () => {
    const runs = Array.from({ length: 20 }, (_, i) => run(FIVE_OSLO - i * 24 * H));
    const s = triageWikiStatus("w", logOf(runs, []), null, FIVE_OSLO + H, 5, 14);
    expect(s.nights).toHaveLength(14);
    expect(s.nights[0]!.night).toBe("2026-11-07");
  });

  test("reads a real log's text, skipping a torn line", () => {
    const text = `${JSON.stringify(run(FIVE_OSLO, { cards: 1 }))}\n${JSON.stringify(card(`r${FIVE_OSLO}`, FIVE_OSLO, "O1", { codeFacts: true }))}\n{"type":"ca`;
    const s = triageWikiStatus("w", parseLog(text), null, FIVE_OSLO + H, 5);
    expect(s.nights[0]).toMatchObject({ cards: 1, codeFacts: 1 });
    expect(s.broken).toBe(1);
  });
});

describe("nextTriageDue", () => {
  const ok = (at: number): WorkMapState => ({ wiki: "w", lastSuccessAt: at, attempts: [{ at, outcome: "ok" }] });

  test("before the day's hour: the hour", () => {
    expect(nextTriageDue(null, FIVE_OSLO - 3 * H - 7 * 60_000, 5)).toBe(FIVE_OSLO);
  });

  test("past the hour with no success: now", () => {
    expect(nextTriageDue(null, FIVE_OSLO + 7 * 60_000, 5)).toBe(FIVE_OSLO + 7 * 60_000);
  });

  test("a success this morning: tomorrow's hour, since its 20 h end falls before it", () => {
    const at = FIVE_OSLO + 12 * 60_000;
    expect(nextTriageDue(ok(at), FIVE_OSLO + 2 * H, 5)).toBe(FIVE_OSLO + 24 * H);
  });

  test("a success late yesterday: 20 h after it, though today's hour came first", () => {
    const at = FIVE_OSLO - 2 * H;
    expect(nextTriageDue(ok(at), FIVE_OSLO + 30 * 60_000, 5)).toBe(at + 20 * H);
  });

  test("two failures after the model call today: tomorrow's hour", () => {
    const state: WorkMapState = { wiki: "w", attempts: [{ at: FIVE_OSLO + 2 * H, outcome: "failed" }, { at: FIVE_OSLO + H, outcome: "failed" }] };
    expect(nextTriageDue(state, FIVE_OSLO + 3 * H, 5)).toBe(FIVE_OSLO + 24 * H);
  });
});
