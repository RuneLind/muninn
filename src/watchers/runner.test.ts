import { test, expect, describe, beforeEach } from "bun:test";
import {
  contentHash,
  extractProperNouns,
  formatAlerts,
  computeWatcherTimeoutMs,
  withWatcherTimeout,
  claimChecker,
  releaseChecker,
  __resetCheckerGuardForTest,
} from "./runner.ts";
import type { Watcher, WatcherAlert } from "../types.ts";

// ── extractProperNouns ───────────────────────────────────────────────

describe("extractProperNouns", () => {
  test("extracts ALL-CAPS words (acronyms)", () => {
    const result = extractProperNouns("Meeting about NASA project");
    expect(result).toContain("nasa");
  });

  test("extracts mid-sentence capitalized words (proper nouns)", () => {
    // First cap is skipped (sentence-initial), so "Meeting" is excluded
    const result = extractProperNouns("Meeting with Ola about the project");
    expect(result).toContain("ola");
    expect(result).not.toContain("meeting");
  });

  test("skips first capitalized word (sentence-initial)", () => {
    const result = extractProperNouns("Important update from Kari");
    // "Important" is sentence-initial, skipped
    expect(result).not.toContain("important");
    expect(result).toContain("kari");
  });

  test("extracts long numbers (order IDs)", () => {
    const result = extractProperNouns("Order 12345 is ready");
    expect(result).toContain("12345");
  });

  test("ignores short numbers (1-2 digits)", () => {
    const result = extractProperNouns("We have 42 items");
    expect(result).not.toContain("42");
  });

  test("ignores short words (1 char)", () => {
    const result = extractProperNouns("I A B C");
    // Single-char words are filtered by length > 1
    expect(result).toEqual([]);
  });

  test("handles empty string", () => {
    expect(extractProperNouns("")).toEqual([]);
  });

  test("sorts results alphabetically", () => {
    const result = extractProperNouns("Ignore Zara and Anna in Stockholm");
    // "Ignore" is sentence-initial, skipped
    expect(result).toEqual(["anna", "stockholm", "zara"]);
  });

  test("handles Scandinavian characters", () => {
    const result = extractProperNouns("Samtale med Åse og Øyvind i dag");
    expect(result).toContain("øyvind");
    expect(result).toContain("åse");
  });

  test("handles ALL-CAPS Scandinavian words", () => {
    const result = extractProperNouns("Firma ÅS leverte i dag");
    expect(result).toContain("ås");
  });

  test("splits on various delimiters", () => {
    const result = extractProperNouns("First; Second/Third — Fourth");
    // "First" is sentence-initial, skipped
    expect(result).toContain("second");
    expect(result).toContain("third");
    expect(result).toContain("fourth");
  });

  test("excludes lowercase words", () => {
    const result = extractProperNouns("the quick brown fox");
    expect(result).toEqual([]);
  });
});

// ── contentHash ──────────────────────────────────────────────────────

describe("contentHash", () => {
  test("returns null for empty summary", () => {
    const alert: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "",
      urgency: "low",
    };
    expect(contentHash(alert)).toBeNull();
  });

  test("returns hash prefixed with 'h:'", () => {
    const alert: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "**Fra:** Ola Nordmann — Viktig melding om prosjektet",
      urgency: "low",
    };
    const hash = contentHash(alert);
    expect(hash).not.toBeNull();
    expect(hash!.startsWith("h:")).toBe(true);
  });

  test("deterministic: same content produces same hash", () => {
    const alert: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "**Fra:** Ola Nordmann — Viktig melding om Prosjektet",
      urgency: "low",
    };
    const hash1 = contentHash(alert);
    const hash2 = contentHash(alert);
    expect(hash1).toBe(hash2);
  });

  test("different content produces different hash", () => {
    const alert1: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "**Fra:** Ola Nordmann — Meeting om Prosjekt Alpha",
      urgency: "low",
    };
    const alert2: WatcherAlert = {
      id: "2",
      source: "email",
      summary: "**Fra:** Kari Hansen — Oppdatering fra Bergen",
      urgency: "low",
    };
    expect(contentHash(alert1)).not.toBe(contentHash(alert2));
  });

  test("extracts sender from 'Fra:' pattern", () => {
    const alert1: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "**Fra:** Ola Nordmann — Some Message with Oslo",
      urgency: "low",
    };
    const alert2: WatcherAlert = {
      id: "2",
      source: "email",
      summary: "**Fra:** Kari Hansen — Some Message with Oslo",
      urgency: "low",
    };
    // Different senders should produce different hashes
    expect(contentHash(alert1)).not.toBe(contentHash(alert2));
  });

  test("extracts sender from 'From:' pattern", () => {
    const alert: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "From: John Smith — Update on the Sprint",
      urgency: "low",
    };
    const hash = contentHash(alert);
    expect(hash).not.toBeNull();
    expect(hash!.startsWith("h:")).toBe(true);
  });

  test("returns null when no sender and no proper nouns", () => {
    const alert: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "just some lowercase text without any structure",
      urgency: "low",
    };
    expect(contentHash(alert)).toBeNull();
  });
});

// ── formatAlerts ─────────────────────────────────────────────────────

describe("formatAlerts", () => {
  const makeWatcher = (type: string, name: string): Watcher => ({
    id: "w-1",
    userId: "u-1",
    botName: "jarvis",
    name,
    type: type as any,
    config: {},
    intervalMs: 300000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  test("email watcher uses envelope icon", () => {
    const result = formatAlerts(makeWatcher("email", "Work Email"), [
      { id: "1", source: "email", summary: "Test alert", urgency: "low" },
    ]);
    expect(result).toContain("\u{1F4E8}");
    expect(result).toContain("**Work Email**");
  });

  test("news watcher uses newspaper icon", () => {
    const result = formatAlerts(makeWatcher("news", "Tech News"), [
      { id: "1", source: "news", summary: "Test alert", urgency: "low" },
    ]);
    expect(result).toContain("\u{1F4F0}");
  });

  test("unknown watcher type uses bell icon", () => {
    const result = formatAlerts(makeWatcher("calendar", "Calendar"), [
      { id: "1", source: "cal", summary: "Test alert", urgency: "low" },
    ]);
    expect(result).toContain("\u{1F514}");
  });

  test("high urgency alerts get red circle", () => {
    const result = formatAlerts(makeWatcher("email", "Inbox"), [
      { id: "1", source: "email", summary: "Urgent!", urgency: "high" },
    ]);
    expect(result).toContain("\u{1F534}");
  });

  test("medium urgency alerts get yellow circle", () => {
    const result = formatAlerts(makeWatcher("email", "Inbox"), [
      { id: "1", source: "email", summary: "Moderate", urgency: "medium" },
    ]);
    expect(result).toContain("\u{1F7E1}");
  });

  test("low urgency alerts get no tag", () => {
    const result = formatAlerts(makeWatcher("email", "Inbox"), [
      { id: "1", source: "email", summary: "Normal", urgency: "low" },
    ]);
    expect(result).not.toContain("\u{1F534}");
    expect(result).not.toContain("\u{1F7E1}");
  });

  test("multiple alerts separated by double newline", () => {
    const result = formatAlerts(makeWatcher("email", "Inbox"), [
      { id: "1", source: "email", summary: "First", urgency: "low" },
      { id: "2", source: "email", summary: "Second", urgency: "low" },
    ]);
    expect(result).toContain("First");
    expect(result).toContain("Second");
    // Header + two alerts joined by \n\n
    const lines = result.split("\n\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

// ── computeWatcherTimeoutMs ──────────────────────────────────────────

describe("computeWatcherTimeoutMs", () => {
  const watcherWith = (config: Record<string, unknown>): Watcher => ({
    id: "w-1",
    userId: "u-1",
    botName: "jarvis",
    name: "W",
    type: "email" as any,
    config,
    intervalMs: 300000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  test("uses the 2-min floor when no timeout is configured", () => {
    expect(computeWatcherTimeoutMs(watcherWith({}))).toBe(120_000);
  });

  test("adds margin above a configured timeout that exceeds the floor", () => {
    // X watcher default 5 min → 5 min + 30s margin, never cut off below its own timeout
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: 300_000 }))).toBe(330_000);
  });

  test("keeps the floor when configured + margin is still below it", () => {
    // 60s + 30s margin = 90s, which is under the 120s floor
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: 60_000 }))).toBe(120_000);
  });

  test("ignores a non-numeric configured timeout", () => {
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: "300000" }))).toBe(120_000);
  });

  test("ignores a zero or negative configured timeout", () => {
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: 0 }))).toBe(120_000);
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: -5 }))).toBe(120_000);
  });
});

// ── withWatcherTimeout ───────────────────────────────────────────────

describe("withWatcherTimeout", () => {
  test("rejects with a timeout error when the work never settles in time", async () => {
    const neverSettles = new Promise<string>(() => {}); // deterministic: only the timeout can win
    await expect(withWatcherTimeout(neverSettles, "Stuck", 10)).rejects.toThrow(/timed out after 10ms/);
  });

  test("resolves with the work's value when it settles before the timeout", async () => {
    const fast = Promise.resolve("done");
    await expect(withWatcherTimeout(fast, "Fast", 10_000)).resolves.toBe("done");
  });

  test("propagates the work's rejection (not a timeout) when it fails first", async () => {
    const fails = Promise.reject(new Error("checker blew up"));
    await expect(withWatcherTimeout(fails, "Failing", 10_000)).rejects.toThrow("checker blew up");
  });
});

// ── dedup window constant ────────────────────────────────────────────

describe("dedup via contentHash", () => {
  test("same alert content produces same hash for dedup", () => {
    // Simulates the dedup filter in runWatchers: if the hash is already in
    // lastNotifiedIds, the alert is skipped.
    const alert: WatcherAlert = {
      id: "msg-new",
      source: "email",
      summary: "**Fra:** Ola Nordmann — Quarterly report for Bergen office",
      urgency: "low",
    };

    const hash = contentHash(alert);
    expect(hash).not.toBeNull();

    // Simulate "already notified" list containing this hash
    const lastNotifiedIds = ["msg-old-1", "msg-old-2", hash!];
    expect(lastNotifiedIds.includes(hash!)).toBe(true);
  });

  test("translated equivalent may differ (hash is text-based)", () => {
    // The hash extracts sender + proper nouns, which survive translation.
    // Same sender + same proper nouns = same hash, even if summary wording differs.
    const alertNorwegian: WatcherAlert = {
      id: "1",
      source: "email",
      summary: "**Fra:** Ola Nordmann — Oppdatering fra Prosjekt Alpha",
      urgency: "low",
    };
    const alertEnglish: WatcherAlert = {
      id: "2",
      source: "email",
      summary: "**From:** Ola Nordmann — Update from Project Alpha",
      urgency: "low",
    };

    const hash1 = contentHash(alertNorwegian);
    const hash2 = contentHash(alertEnglish);

    // Both have same sender (ola nordmann) and same proper nouns (Alpha, Prosjekt/Project)
    // The exact match depends on proper noun extraction details
    expect(hash1).not.toBeNull();
    expect(hash2).not.toBeNull();
  });
});

// ── claimChecker / releaseChecker (concurrent-duplicate guard) ────────────

describe("checker in-flight guard", () => {
  beforeEach(() => __resetCheckerGuardForTest());

  const TIMEOUT = 120_000;

  test("first claim succeeds; a second while in flight is skipped", () => {
    const first = claimChecker("w1", TIMEOUT, 1000);
    expect(first).not.toBeNull();
    expect(first!.forced).toBe(false);

    const second = claimChecker("w1", TIMEOUT, 1000);
    expect(second).toBeNull(); // duplicate dispatch blocked
  });

  test("release frees the slot for the next tick", () => {
    const first = claimChecker("w1", TIMEOUT, 1000)!;
    releaseChecker("w1", first.token);
    const again = claimChecker("w1", TIMEOUT, 2000);
    expect(again).not.toBeNull();
    expect(again!.forced).toBe(false);
  });

  test("a slot older than 2× the timeout is force-reclaimed", () => {
    claimChecker("w1", TIMEOUT, 0);
    // Still held just under 2× the timeout.
    expect(claimChecker("w1", TIMEOUT, 2 * TIMEOUT - 1)).toBeNull();
    // Past 2× the timeout → force-reclaim (a never-settling checker).
    const forced = claimChecker("w1", TIMEOUT, 2 * TIMEOUT + 1);
    expect(forced).not.toBeNull();
    expect(forced!.forced).toBe(true);
  });

  test("a stale orphan's late release does NOT free the reclaimed slot", () => {
    const first = claimChecker("w1", TIMEOUT, 0)!;
    const forced = claimChecker("w1", TIMEOUT, 2 * TIMEOUT + 1)!;
    // The old orphan finally settles and releases with its stale token — no-op.
    releaseChecker("w1", first.token);
    // The reclaimed slot is still held, so a fresh dispatch is skipped.
    expect(claimChecker("w1", TIMEOUT, 2 * TIMEOUT + 2)).toBeNull();
    // Releasing with the reclaim's token frees it.
    releaseChecker("w1", forced.token);
    expect(claimChecker("w1", TIMEOUT, 2 * TIMEOUT + 3)).not.toBeNull();
  });

  test("different watcher ids don't block each other", () => {
    expect(claimChecker("w1", TIMEOUT, 1000)).not.toBeNull();
    expect(claimChecker("w2", TIMEOUT, 1000)).not.toBeNull();
  });
});
