import { test, expect, describe } from "bun:test";
import {
  HEALTH_ESCALATE_AFTER,
  HEALTH_RE_ESCALATE_EVERY,
  buildHealthAlerts,
  healthAlertId,
  healthLevel,
  isSourceHealthMap,
  recordOutcome,
  shouldEscalate,
  stalenessMs,
  type SourceHealth,
} from "./source-health.ts";

const H = 3_600_000;
const NOW = 1_800_000_000_000;

describe("recordOutcome", () => {
  test("an ok run resets the streak and stamps lastOkAt", () => {
    const prior: SourceHealth = { outcome: "skipped", at: NOW - H, consecutive: 7, detail: "x" };
    const h = recordOutcome(prior, "ok", NOW);
    expect(h).toEqual({ outcome: "ok", at: NOW, consecutive: 0, lastOkAt: NOW });
  });

  test("consecutive failures accumulate and preserve the last known-good time", () => {
    let h = recordOutcome({ outcome: "ok", at: NOW - 10 * H, consecutive: 0, lastOkAt: NOW - 10 * H }, "skipped", NOW - 9 * H, "shrink");
    expect(h.consecutive).toBe(1);
    h = recordOutcome(h, "skipped", NOW - 8 * H, "shrink");
    h = recordOutcome(h, "error", NOW, "HTTP 503");
    expect(h.consecutive).toBe(3);
    expect(h.outcome).toBe("error");
    expect(h.detail).toBe("HTTP 503");
    // The freshness signal must survive the failures — it is what staleness is measured
    // against, and it is the number `last_run_at` was standing in for (wrongly).
    expect(h.lastOkAt).toBe(NOW - 10 * H);
  });

  test("a source that has never succeeded carries no lastOkAt", () => {
    expect(recordOutcome(undefined, "error", NOW, "boom").lastOkAt).toBeUndefined();
  });
});

describe("escalation", () => {
  const failing = (consecutive: number, over: Partial<SourceHealth> = {}): SourceHealth => ({
    outcome: "skipped",
    at: NOW,
    consecutive,
    lastOkAt: NOW - 100 * H,
    ...over,
  });

  test("stays silent below the threshold, fires on the run that crosses it", () => {
    expect(shouldEscalate(failing(HEALTH_ESCALATE_AFTER - 1))).toBe(false);
    expect(shouldEscalate(failing(HEALTH_ESCALATE_AFTER))).toBe(true);
  });

  test("a healthy source never escalates", () => {
    expect(shouldEscalate({ outcome: "ok", at: NOW, consecutive: 0, lastOkAt: NOW })).toBe(false);
  });

  test("emits on every run past the threshold — the runner's id-dedup does the suppressing", () => {
    // Deliberate: any "already alerted" flag has to be committed when the alert is BUILT,
    // long before the runner delivers it, so a watcher timeout or a transient Telegram
    // error after that write silences the source for a whole re-escalation window.
    expect(shouldEscalate(failing(HEALTH_ESCALATE_AFTER))).toBe(true);
    expect(shouldEscalate(failing(HEALTH_ESCALATE_AFTER + 1))).toBe(true);
    expect(shouldEscalate(failing(HEALTH_ESCALATE_AFTER + 5))).toBe(true);
  });

  test("the id is STABLE within an episode, so repeated emissions collapse to one delivery", () => {
    const id = (c: number) => healthAlertId("W", "tier2:llms", failing(c));
    expect(id(HEALTH_ESCALATE_AFTER + 1)).toBe(id(HEALTH_ESCALATE_AFTER));
    expect(id(HEALTH_ESCALATE_AFTER + HEALTH_RE_ESCALATE_EVERY - 1)).toBe(id(HEALTH_ESCALATE_AFTER));
  });

  test("the id CHANGES at each nag bucket, so a long wedge is heard again", () => {
    const id = (c: number) => healthAlertId("W", "tier2:llms", failing(c));
    expect(id(HEALTH_ESCALATE_AFTER + HEALTH_RE_ESCALATE_EVERY)).not.toBe(id(HEALTH_ESCALATE_AFTER));
  });

  test("a source that RECOVERS and wedges again gets a distinct id (not swallowed by id-dedup)", () => {
    // The bug this pins: `recordOutcome` resets the streak on recovery, so an id keyed on
    // the streak length alone was byte-identical for the second wedge. The runner's
    // 600-id lastNotifiedIds window — already full on the live rows — would drop it, and
    // the next chance to be heard was 24 further failures: 48h on the 2h row, ~24 WEEKS
    // on the weekly one.
    const first = healthAlertId("W", "tier2:llms", failing(3, { lastOkAt: NOW - 100 * H }));
    const second = healthAlertId("W", "tier2:llms", failing(3, { lastOkAt: NOW - 2 * H }));
    expect(second).not.toBe(first);
  });

  test("buildHealthAlerts emits one alert per unhealthy source and MUTATES NOTHING", () => {
    const map = {
      "tier2:llms": failing(3),
      "tier2:blog:news": { outcome: "ok" as const, at: NOW, consecutive: 0, lastOkAt: NOW },
      "tier2:blog:research": failing(1),
    };
    const snapshot = JSON.parse(JSON.stringify(map));
    const alerts = buildHealthAlerts("Anthropic Highlights", map, NOW);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.summary).toContain("tier2:llms");
    expect(alerts[0]!.summary).toContain("3 consecutive");
    // Names the thing that made this invisible for six days.
    expect(alerts[0]!.summary).toContain("watcher itself is running fine");
    expect(alerts[0]!.urgency).toBe("medium");
    // Purity is load-bearing: no bookkeeping can be committed ahead of delivery.
    expect(map).toEqual(snapshot);
    // ...so a re-emission is identical and the runner collapses it.
    expect(buildHealthAlerts("Anthropic Highlights", map, NOW)[0]!.id).toBe(alerts[0]!.id);
  });
});

describe("staleness", () => {
  test("the window is floored at 24h and ceilinged, not a raw 3x interval", () => {
    // 3x on the 2h Highlights row is 6h — far too twitchy.
    expect(stalenessMs(2 * H)).toBe(24 * H);
    // 3x on the 7d weekly row is 21 DAYS — uselessly permissive; the wedge it came from
    // lasted six days and must not be able to hide inside the window. But the ceiling is
    // itself floored at 2 intervals, because a window SHORTER than the poll interval is
    // nonsense: a 7d source's lastOkAt is ~7d old on its very next run, so a flat 4-day
    // ceiling would make one transient 503 render as a red `stale` chip and leave `warn`
    // unreachable on that row entirely.
    expect(stalenessMs(7 * 24 * H)).toBe(14 * 24 * H);
    // The 2h row is unaffected — its 2-interval floor (4h) is far below the ceiling.
    expect(stalenessMs(2 * H)).toBe(24 * H);
    // In between, the multiplier applies.
    expect(stalenessMs(24 * H)).toBe(3 * 24 * H);
  });

  test("a weekly source's first transient failure reads warn, not a red stale chip", () => {
    const weekly = 7 * 24 * H;
    const oneBadRun: SourceHealth = { outcome: "error", at: NOW, consecutive: 1, lastOkAt: NOW - weekly };
    expect(healthLevel(oneBadRun, weekly, NOW)).toBe("warn");
    // Two missed weeks IS stale.
    expect(healthLevel({ ...oneBadRun, consecutive: 2, lastOkAt: NOW - 15 * 24 * H }, weekly, NOW)).toBe("stale");
  });

  test("level: ok when it advanced, warn while inside the window, stale beyond it", () => {
    const ok: SourceHealth = { outcome: "ok", at: NOW, consecutive: 0, lastOkAt: NOW };
    expect(healthLevel(ok, 2 * H, NOW)).toBe("ok");

    const recent: SourceHealth = { outcome: "skipped", at: NOW, consecutive: 1, lastOkAt: NOW - 3 * H };
    expect(healthLevel(recent, 2 * H, NOW)).toBe("warn");

    const long: SourceHealth = { outcome: "skipped", at: NOW, consecutive: 40, lastOkAt: NOW - 100 * H };
    expect(healthLevel(long, 2 * H, NOW)).toBe("stale");
  });

  test("a source that has NEVER succeeded is stale, not merely warn", () => {
    const never: SourceHealth = { outcome: "error", at: NOW, consecutive: 1 };
    expect(healthLevel(never, 2 * H, NOW)).toBe("stale");
  });
});

describe("isSourceHealthMap", () => {
  test("accepts a real map and rejects the shapes a corrupt snapshot can hold", () => {
    expect(isSourceHealthMap({ "tier2:llms": { outcome: "ok", at: 1, consecutive: 0 } })).toBe(true);
    expect(isSourceHealthMap({})).toBe(true);
    expect(isSourceHealthMap(null)).toBe(false);
    expect(isSourceHealthMap([])).toBe(false);
    expect(isSourceHealthMap({ x: 5 })).toBe(false);
    expect(isSourceHealthMap("nope")).toBe(false);
  });
});

