import { test, expect, describe } from "bun:test";
import {
  HEALTH_ESCALATE_AFTER,
  HEALTH_RE_ESCALATE_EVERY,
  buildHealthAlerts,
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

  test("does not re-fire every run once escalated, but does nag again later", () => {
    const h = failing(HEALTH_ESCALATE_AFTER, { escalatedAtCount: HEALTH_ESCALATE_AFTER });
    expect(shouldEscalate(h)).toBe(false);
    expect(shouldEscalate({ ...h, consecutive: HEALTH_ESCALATE_AFTER + 1 })).toBe(false);
    expect(shouldEscalate({ ...h, consecutive: HEALTH_ESCALATE_AFTER + HEALTH_RE_ESCALATE_EVERY })).toBe(true);
  });

  test("buildHealthAlerts emits one alert per crossing source and records the bookkeeping", () => {
    const map = {
      "tier2:llms": failing(3),
      "tier2:blog:news": { outcome: "ok" as const, at: NOW, consecutive: 0, lastOkAt: NOW },
      "tier2:blog:research": failing(1),
    };
    const alerts = buildHealthAlerts("Anthropic Highlights", map, NOW);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.summary).toContain("tier2:llms");
    expect(alerts[0]!.summary).toContain("3 consecutive");
    // Names the thing that made this invisible for six days.
    expect(alerts[0]!.summary).toContain("watcher itself is running fine");
    expect(alerts[0]!.urgency).toBe("medium");
    // Mutated so the next run doesn't re-alert.
    expect(map["tier2:llms"].escalatedAtCount).toBe(3);
    expect(buildHealthAlerts("Anthropic Highlights", map, NOW)).toHaveLength(0);
  });

  test("the alert id varies with the streak so a later escalation is not id-deduped away", () => {
    const a = buildHealthAlerts("W", { s: failing(3) }, NOW)[0]!;
    const b = buildHealthAlerts("W", { s: failing(27) }, NOW)[0]!;
    expect(a.id).not.toBe(b.id);
    // ...but the SAME state re-reported keeps the same id, so a re-run stays deduped.
    expect(buildHealthAlerts("W", { s: failing(3) }, NOW)[0]!.id).toBe(a.id);
  });
});

describe("staleness", () => {
  test("the window is floored at 24h and ceilinged, not a raw 3x interval", () => {
    // 3x on the 2h Highlights row is 6h — far too twitchy.
    expect(stalenessMs(2 * H)).toBe(24 * H);
    // 3x on the 7d weekly row is 21 DAYS — uselessly permissive; the wedge it came from
    // lasted six days and must not be able to hide inside the window.
    expect(stalenessMs(7 * 24 * H)).toBe(4 * 24 * H);
    // In between, the multiplier applies.
    expect(stalenessMs(24 * H)).toBe(3 * 24 * H);
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
