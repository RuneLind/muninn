import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { shouldSkipWikiDraftingRun } from "./wiki-drafting.ts";
import { __setWikiReadonlyForTest } from "../wiki/readonly.ts";
import {
  runChecker,
  finishWatcherRun,
  coverageToRecord,
  contentHash,
  dedupContentHash,
  filterUnseenAlerts,
  notifiedEntriesFor,
  extractProperNouns,
  formatAlerts,
  computeWatcherTimeoutMs,
  withWatcherTimeout,
  claimChecker,
  releaseChecker,
  __resetCheckerGuardForTest,
  watcherConnectorInfo,
  newWatcherUsage,
  accumulateWatcherUsage,
  isQuietHoursRunExempt,
  DEFAULT_WATCHER_CHECKERS,
  type WatcherCheckers,
} from "./runner.ts";
import { DEFAULT_MODEL } from "../scheduler/executor.ts";
// Imported to assert the DEFAULT table's bindings identity-wise — the production
// path uses that table, and every dispatch test injects spies instead.
import { checkEmail } from "./email.ts";
import { checkNews } from "./news.ts";
import { checkX } from "./x.ts";
import { checkAnthropic } from "./anthropic.ts";
import { checkWikiGardener } from "./wiki-gardener.ts";
import { checkWikiLinter } from "./wiki-linter.ts";
import { checkWikiCommitter } from "./wiki-committer.ts";
import { checkConsolidationGardener } from "./consolidation-gardener.ts";
import type { Watcher, WatcherAlert } from "../types.ts";
import { buildHealthAlerts, type SourceHealthMap } from "./source-health.ts";

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
    lastSuccessAt: null,
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

// ── watcher usage accumulator (token + cost summing) ─────────────────

describe("accumulateWatcherUsage", () => {
  test("sums tokens, turns, and cost across multiple calls (x/anthropic gate+digest)", () => {
    const acc = newWatcherUsage();
    accumulateWatcherUsage(acc, { model: "claude-haiku", inputTokens: 100, outputTokens: 20, numTurns: 1, costUsd: 0.01 });
    accumulateWatcherUsage(acc, { model: "claude-sonnet", inputTokens: 300, outputTokens: 40, numTurns: 2, costUsd: 0.05 });
    expect(acc.inputTokens).toBe(400);
    expect(acc.outputTokens).toBe(60);
    expect(acc.numTurns).toBe(3);
    expect(acc.calls).toBe(2);
    expect(acc.model).toBe("claude-sonnet"); // last call wins
    expect(acc.costUsd).toBeCloseTo(0.06, 10);
  });

  test("all-undefined cost leaves costUsd undefined (→ dash), a summed 0 stays 0 (→ $0.00)", () => {
    const noCost = newWatcherUsage();
    accumulateWatcherUsage(noCost, { model: "m", inputTokens: 10, outputTokens: 2 });
    expect(noCost.costUsd).toBeUndefined();

    const zeroCost = newWatcherUsage();
    accumulateWatcherUsage(zeroCost, { model: "m", inputTokens: 10, outputTokens: 2, costUsd: 0 });
    expect(zeroCost.costUsd).toBe(0);
  });

  test("a missing cost on one call doesn't wipe an already-summed total", () => {
    const acc = newWatcherUsage();
    accumulateWatcherUsage(acc, { model: "m", inputTokens: 10, outputTokens: 2, costUsd: 0.03 });
    accumulateWatcherUsage(acc, { model: "m", inputTokens: 10, outputTokens: 2 }); // no cost
    expect(acc.costUsd).toBeCloseTo(0.03, 10);
  });
});

// ── watcherConnectorInfo ─────────────────────────────────────────────

describe("watcherConnectorInfo", () => {
  // spawnHaiku-based checkers ALWAYS run the Claude CLI on Haiku, regardless of
  // the bot's chat connector — the label must not leak the chat connector.
  const sdkBot = { connector: "claude-sdk", model: "claude-sonnet-5" };

  test("email uses the CLI label + Haiku default model, never the bot's chat connector", () => {
    expect(watcherConnectorInfo({ type: "email", config: {} }, sdkBot)).toEqual({
      label: "Claude Code",
      model: DEFAULT_MODEL,
    });
  });

  test("x/anthropic honor config.model but keep the CLI label", () => {
    expect(watcherConnectorInfo({ type: "x", config: { model: "claude-sonnet-4-6" } }, sdkBot)).toEqual({
      label: "Claude Code",
      model: "claude-sonnet-4-6",
    });
    expect(watcherConnectorInfo({ type: "anthropic", config: { model: "claude-sonnet-4-6" } }, sdkBot)).toEqual({
      label: "Claude Code",
      model: "claude-sonnet-4-6",
    });
  });

  test("wiki-gardener labels from the bot's own connector/model (the draft runs there)", () => {
    expect(watcherConnectorInfo({ type: "wiki-gardener", config: {} }, sdkBot)).toEqual({
      label: "Claude SDK",
      model: "claude-sonnet-5",
    });
  });

  test("wiki-gardener falls back to the bot fallback model when unset", () => {
    expect(
      watcherConnectorInfo({ type: "wiki-gardener", config: {} }, { connector: "claude-cli" }, "sonnet"),
    ).toEqual({ label: "Claude Code", model: "sonnet" });
  });

  test("non-AI watchers (news, wiki-linter) stamp nothing", () => {
    expect(watcherConnectorInfo({ type: "news", config: {} }, sdkBot)).toBeNull();
    expect(watcherConnectorInfo({ type: "wiki-linter", config: {} }, sdkBot)).toBeNull();
  });
});

// ── isQuietHoursRunExempt (quiet-hours run vs alert-send suppression) ─

describe("isQuietHoursRunExempt", () => {
  test("wiki-committer runs during quiet hours (its side effect is a git commit, not a ping)", () => {
    expect(isQuietHoursRunExempt("wiki-committer")).toBe(true);
  });

  test("notification watchers are NOT exempt — quiet hours skip the whole run", () => {
    for (const t of ["email", "news", "x", "anthropic", "wiki-gardener", "wiki-linter", "consolidation-gardener"] as const) {
      expect(isQuietHoursRunExempt(t)).toBe(false);
    }
  });
});

// ── computeWatcherTimeoutMs ──────────────────────────────────────────

describe("computeWatcherTimeoutMs", () => {
  const watcherWith = (config: Record<string, unknown>, type = "x"): Watcher => ({
    id: "w-1",
    userId: "u-1",
    botName: "jarvis",
    name: "W",
    // NOT email: the floor is type-specific (email's is 180s because checkEmail can
    // spawn twice), and these cases are about the GENERIC formula. Email gets its own
    // assertions below.
    type: type as any,
    config,
    intervalMs: 300000,
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
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

  // `email` is the one checker that can spawn TWICE (its bounded retry), and two 60s
  // attempts plus the retry budget's 10s margin need 130s — which the generic floor
  // cannot hold. The whole point is that no row edit is required, so the floor must
  // hold for the UNCONFIGURED row, which is what the live one is.
  test("email gets a 180s floor so two full attempts fit", () => {
    expect(computeWatcherTimeoutMs(watcherWith({}, "email"))).toBe(180_000);
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: 60_000 }, "email"))).toBe(180_000);
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: 0 }, "email"))).toBe(180_000);
  });

  test("a configured email timeout still only ever RAISES the net", () => {
    expect(computeWatcherTimeoutMs(watcherWith({ timeoutMs: 300_000 }, "email"))).toBe(330_000);
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

// ── health alerts must not content-hash-collide (real filter path) ────

describe("filterUnseenAlerts: watcher-health alerts", () => {
  // Real `buildHealthAlerts` output, not hand-written summaries: the collision is a
  // property of that prose skeleton (no `Fra|From … —` sender, and the only proper
  // noun surviving `extractProperNouns` comes from the shared boilerplate), so a
  // fixture that paraphrased it would test nothing.
  const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
  const H = 3_600_000;
  const WATCHER = "X Daily Digest";

  const health = (map: SourceHealthMap) => buildHealthAlerts(WATCHER, map, NOW);

  test("a second source's escalation survives the first source's stored hash", () => {
    const [digest] = health({
      "x:digest": { outcome: "error", at: NOW, consecutive: 3, lastOkAt: NOW - 30 * H, detail: "model call failed" },
    });
    const [authorScores] = health({
      "x:author-scores": {
        outcome: "error", at: NOW, consecutive: 3, lastOkAt: NOW - 70 * H,
        detail: "author-scores unavailable — x-link capture disabled, x-post floors raised",
      },
    });
    expect(digest!.id).not.toBe(authorScores!.id);
    // The precondition this whole test exists for: distinct records, ONE hash.
    expect(contentHash(digest!)).toBe(contentHash(authorScores!));

    // Run 1 escalated x:digest, so the runner stored its id AND (pre-fix) its hash.
    const known = new Set([digest!.id, contentHash(digest!)!]);
    const kept = filterUnseenAlerts("x", [authorScores!], known, "jarvis");
    expect(kept.map((a) => a.id)).toEqual([authorScores!.id]);
  });

  test("the same source's next nag bucket also survives", () => {
    const [first] = health({
      "x:capture-gate": { outcome: "error", at: NOW, consecutive: 3, lastOkAt: NOW - 30 * H },
    });
    const [nag] = health({
      "x:capture-gate": { outcome: "error", at: NOW, consecutive: 27, lastOkAt: NOW - 30 * H },
    });
    expect(first!.id).not.toBe(nag!.id);
    const known = new Set([first!.id, contentHash(first!)!]);
    expect(filterUnseenAlerts("x", [nag!], known, "jarvis")).toHaveLength(1);
  });

  test("an id already notified is still deduped", () => {
    const [alert] = health({
      "x:digest": { outcome: "error", at: NOW, consecutive: 3, lastOkAt: NOW - 30 * H },
    });
    expect(filterUnseenAlerts("x", [alert!], new Set([alert!.id]), "jarvis")).toHaveLength(0);
  });

  test("GUARD: an ordinary x digest with a new id but identical content is still dropped", () => {
    // The reason `x` must NOT be blanket-added to the skip list: its digest ids embed
    // Date.now(), so content-hash is the only thing catching a re-summarised repeat.
    const summary = "**Fra:** Ola Nordmann — Oppdatering fra Prosjekt Alpha";
    const run1: WatcherAlert = { id: "x-digest-1000", source: "x", summary, urgency: "low" };
    const run2: WatcherAlert = { id: "x-digest-2000", source: "x", summary, urgency: "low" };
    const known = new Set([run1.id, contentHash(run1)!]);
    expect(filterUnseenAlerts("x", [run2], known, "jarvis")).toHaveLength(0);
  });

  test("health alerts on a type that skips content-hash anyway are unaffected", () => {
    // `x:digest`, not `tier2:llms`: this fixture's watcher is the X row, and a source key
    // borrowed from the anthropic watcher would read as an anthropic record filed under an
    // X watcher name.
    const [alert] = health({
      "x:digest": { outcome: "error", at: NOW, consecutive: 3, lastOkAt: NOW - 30 * H },
    });
    expect(dedupContentHash("anthropic", alert!)).toBeNull();
    expect(dedupContentHash("x", alert!)).toBeNull();
  });
});

// ── the TYPE-LIST half of dedupContentHash, through the real filter ────
//
// The per-alert `watcher-health` exemption above and this per-TYPE list are two
// independent clauses of one predicate. Every other test in this file exercises the
// first; without this one, deleting `watcherType === "anthropic"` from the list leaves
// `tsc` clean and the whole suite green while anthropic starts false-dropping commits.

describe("filterUnseenAlerts: the per-type skip list", () => {
  // Real anthropic shape (`anthropic.ts` ~1484): the id is `an:<canonical GitHub URL>`
  // (already a complete dedup key) and the summary is `**<sourceLabel>** — <label>\n<url>`
  // — no `Fra:` sender, that is the email watcher's shape. Two DISTINCT commits routinely
  // carry the same subject, and the sha does not survive proper-noun extraction, so they
  // fingerprint identically and content-hash dedup would silently swallow the second one.
  const commit = (sha: string): WatcherAlert => ({
    id: `an:https://github.com/anthropics/docs/commit/${sha}`,
    source: "anthropic",
    summary: `**anthropics/docs** — Update README\nhttps://github.com/anthropics/docs/commit/${sha}`,
    urgency: "low",
  });

  test("two distinct anthropic alerts with ONE fingerprint both survive", () => {
    const commitA = commit("aaa1111");
    const commitB = commit("bbb2222");
    // The precondition: distinct ids, identical (and non-null) content hash.
    expect(commitA.id).not.toBe(commitB.id);
    expect(contentHash(commitA)).not.toBeNull();
    expect(contentHash(commitA)).toBe(contentHash(commitB));

    const known = new Set([commitA.id, contentHash(commitA)!]);
    expect(filterUnseenAlerts("anthropic", [commitB], known, "jarvis")).toHaveLength(1);
    // Same two alerts on a type that is NOT skip-listed: the hash does drop the second.
    expect(filterUnseenAlerts("news", [{ ...commitB, source: "news" }], known, "jarvis")).toHaveLength(0);
  });

  test("id dedup still applies on a skip-listed type", () => {
    const commitA = commit("aaa1111");
    expect(filterUnseenAlerts("anthropic", [commitA], new Set([commitA.id]), "jarvis")).toHaveLength(0);
  });
});

// ── the persistence half: what a run WRITES into lastNotifiedIds ──────
//
// `filterUnseenAlerts` not dropping a health alert is worth nothing if the run still
// PERSISTS its colliding hash — run 1's write is what run 2's filter reads. Both halves
// go through `dedupContentHash`, and this asserts the write end of that.

describe("notifiedEntriesFor", () => {
  const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
  const H = 3_600_000;

  test("a health alert persists its id ONLY; an ordinary x alert persists id + hash", () => {
    const [healthAlert] = buildHealthAlerts("X Daily Digest", {
      "x:digest": { outcome: "error", at: NOW, consecutive: 3, lastOkAt: NOW - 30 * H },
    }, NOW);
    // Precondition: this alert HAS a content hash — it is the exemption, not a null
    // fingerprint, that keeps it out of the window.
    expect(contentHash(healthAlert!)).not.toBeNull();

    const digest: WatcherAlert = {
      id: "x-digest-1000",
      source: "x",
      summary: "**Fra:** Ola Nordmann — Oppdatering fra Prosjekt Alpha",
      urgency: "low",
    };

    const entries = notifiedEntriesFor("x", [healthAlert!, digest]);
    expect(entries).toEqual([healthAlert!.id, digest.id, contentHash(digest)!]);
    expect(entries).not.toContain(contentHash(healthAlert!));
    expect(entries.filter((e) => e.startsWith("h:"))).toHaveLength(1);
  });

  test("trackingIds ride along on both shapes", () => {
    const silent: WatcherAlert = {
      id: "x-digest-2000",
      source: "x",
      summary: "**Fra:** Kari Nordmann — Nytt fra Prosjekt Beta",
      urgency: "low",
      trackingIds: ["tw:1", "tw:2"],
    };
    expect(notifiedEntriesFor("x", [silent])).toEqual([silent.id, contentHash(silent)!, "tw:1", "tw:2"]);
    // Skip-listed type: no hash slot, tracking ids still persisted.
    expect(notifiedEntriesFor("anthropic", [silent])).toEqual([silent.id, "tw:1", "tw:2"]);
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

// ── wiki-readonly guard on SCHEDULED gardener runs ────────────────────────
//
// The SEAM tests (that `runChecker` never reaches the two gardener checkers on a
// readonly instance) are the `runChecker — wiki-readonly guard` describe below,
// via the injectable `checkers` seam — NOT `mock.module`: this chunk already has
// a file mocking `../logging.ts`, which makes log-based assertions invisible
// here, and a second `mock.module` file in the chunk would leak into the
// gardener/linter tests beside it.

const wikiCheckerSpies = () => {
  const calls: string[] = [];
  const emailArgs: unknown[][] = [];
  const alertsFrom = (source: string): WatcherAlert[] => [
    { id: `${source}-1`, source, summary: "ran", urgency: "low" },
  ];
  const spy = (name: string) => async () => {
    calls.push(name);
    return alertsFrom(name);
  };
  return {
    calls,
    emailArgs,
    alertsFrom,
    checkers: {
      // Email's checker returns the {alerts, coveredFrom} shape, not a bare array.
      checkEmail: async (...args: unknown[]) => {
        calls.push("email");
        emailArgs.push(args);
        return { alerts: alertsFrom("email"), coveredFrom: null };
      },
      checkNews: spy("news"),
      checkX: spy("x"),
      checkAnthropic: spy("anthropic"),
      checkWikiGardener: spy("wiki-gardener"),
      checkWikiLinter: spy("wiki-linter"),
      checkWikiCommitter: spy("wiki-committer"),
      checkConsolidationGardener: spy("consolidation-gardener"),
    } satisfies WatcherCheckers,
  };
};

const watcherOfType = (type: string): Watcher => ({
  id: "w-ro",
  userId: "u-1",
  botName: "jarvis",
  name: `${type} row`,
  type: type as any,
  config: {},
  intervalMs: 604_800_000,
  enabled: true,
  lastRunAt: null,
  lastSuccessAt: null,
  lastNotifiedIds: [],
  forceNextRun: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const fakeBot = { name: "jarvis", dir: "/nonexistent", persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [] } as any;

describe("coverageToRecord", () => {
  const at = new Date(1_700_000_000_000);

  test("passes the checker's coverage through on a normal run", () => {
    expect(coverageToRecord(at, false)).toBe(at);
  });

  test("drops coverage when quiet hours suppressed the send", () => {
    // The alerts did not go out, so the window was not dealt with.
    expect(coverageToRecord(at, true)).toBeNull();
  });

  test("stays null when the checker claimed nothing", () => {
    expect(coverageToRecord(null, false)).toBeNull();
  });
});

describe("finishWatcherRun", () => {
  // The watermark write has no other unit-testable seam: runWatchers is not
  // exercised by this file, and this chunk deliberately avoids mock.module. Deps
  // injection is the run-health.ts idiom, used here for the same reason.
  function deps(markImpl?: (id: string, at: Date) => Promise<void>) {
    const calls: { lastRun: [string, string[]][]; marks: [string, Date][] } = { lastRun: [], marks: [] };
    return {
      calls,
      d: {
        updateWatcherLastRun: async (id: string, ids: string[]) => { calls.lastRun.push([id, ids]); },
        markWatcherSuccess: markImpl ?? (async (id: string, at: Date) => { calls.marks.push([id, at]); }),
      },
    };
  }

  test("always advances last_run_at", async () => {
    const { calls, d } = deps();
    await finishWatcherRun("w1", ["a"], null, d);
    expect(calls.lastRun).toEqual([["w1", ["a"]]]);
  });

  test("does NOT write the watermark when the checker claimed no coverage", async () => {
    // The quiet-hours skip and every failed/unjudgeable run land here.
    const { calls, d } = deps();
    await finishWatcherRun("w1", ["a"], null, d);
    expect(calls.marks).toEqual([]);
  });

  test("writes the watermark when the checker claimed coverage", async () => {
    // Kills the inert-fix mutation: dropping this call leaves last_success_at
    // NULL forever and the whole feature dead with the suite green.
    const at = new Date(1_700_000_000_000);
    const { calls, d } = deps();
    await finishWatcherRun("w1", ["a"], at, d);
    expect(calls.marks).toEqual([["w1", at]]);
  });

  test("passes the checker's timestamp through unchanged", async () => {
    // Kills "write now() instead" — the anchor must stay at check ENTRY.
    const at = new Date(1_700_000_000_000);
    const { calls, d } = deps();
    await finishWatcherRun("w1", [], at, d);
    expect(calls.marks[0]![1].getTime()).toBe(at.getTime());
  });

  test("a failing watermark write does not fail the run", async () => {
    // An unmigrated box (069 not applied) throws here on every tick. The alerts
    // are already delivered by this point, so it must degrade to the date-only
    // query rather than turning a degraded state into a broken one.
    const { calls, d } = deps(async () => { throw new Error('column "last_success_at" does not exist'); });
    await expect(finishWatcherRun("w1", ["a"], new Date(), d)).resolves.toBeUndefined();
    expect(calls.lastRun).toHaveLength(1);
  });
});

describe("runChecker — every type reaches its own checker", () => {
  // The regression this exists for: a refactor extracting the per-type switch
  // dropped `case "email"`. Every tick then fell through to `default:`, returned
  // `[]`, and the runner read that as a quiet inbox — so run-health saw a healthy
  // run, the dashboard stayed green, and the user just stopped receiving email
  // alerts. tsc was silent (the import merely went unused; `noUnusedLocals` is
  // off) and all 5457 tests passed. Before this block, deleting the `news`, `x`
  // or `anthropic` case was equally invisible.
  const TYPES = [
    "email", "news", "x", "anthropic",
    "wiki-gardener", "wiki-linter", "wiki-committer", "consolidation-gardener",
  ] as const;

  afterEach(() => __setWikiReadonlyForTest());

  for (const type of TYPES) {
    test(`${type} dispatches to check${type}`, async () => {
      // Write-owner, so the readonly guard never short-circuits a drafting type.
      __setWikiReadonlyForTest(false);
      const { calls, alertsFrom, checkers } = wikiCheckerSpies();
      const { alerts } = await runChecker(watcherOfType(type), fakeBot, undefined, checkers);
      expect(calls).toEqual([type]);
      expect(alerts).toEqual(alertsFrom(type));
    });
  }

  test("email is handed the bot DIR and the bot NAME, in that order", async () => {
    // Both params are `string | undefined`, so swapping them typechecks cleanly
    // and every other test still passes. Live, the swap resolves --mcp-config
    // under a directory named "jarvis", which does not exist ⇒ no Gmail server ⇒
    // the liveness predicate cannot identify Gmail ⇒ the run is UNJUDGEABLE, so
    // no failure is reported and no coverage claimed: a permanently quiet inbox
    // behind a green dashboard, the exact class this PR exists to kill.
    __setWikiReadonlyForTest(false);
    const { emailArgs, checkers } = wikiCheckerSpies();
    await runChecker(watcherOfType("email"), fakeBot, undefined, checkers);

    expect(emailArgs).toHaveLength(1);
    expect(emailArgs[0]![1]).toBe(fakeBot.dir);
    expect(emailArgs[0]![2]).toBe(fakeBot.name);
    expect(fakeBot.dir).not.toBe(fakeBot.name);
  });

  test("the DEFAULT table binds every name to its own checker", async () => {
    // The dispatch tests all inject spies, so the table the PRODUCTION path
    // actually uses is exercised by none of them. A transposed pair — e.g.
    // `checkWikiLinter: checkWikiCommitter` — typechecks (identical signatures)
    // and would run the git sweeper on the report-only linter's schedule.
    expect(DEFAULT_WATCHER_CHECKERS.checkEmail).toBe(checkEmail);
    expect(DEFAULT_WATCHER_CHECKERS.checkNews).toBe(checkNews);
    expect(DEFAULT_WATCHER_CHECKERS.checkX).toBe(checkX);
    expect(DEFAULT_WATCHER_CHECKERS.checkAnthropic).toBe(checkAnthropic);
    expect(DEFAULT_WATCHER_CHECKERS.checkWikiGardener).toBe(checkWikiGardener);
    expect(DEFAULT_WATCHER_CHECKERS.checkWikiLinter).toBe(checkWikiLinter);
    expect(DEFAULT_WATCHER_CHECKERS.checkWikiCommitter).toBe(checkWikiCommitter);
    expect(DEFAULT_WATCHER_CHECKERS.checkConsolidationGardener).toBe(checkConsolidationGardener);
  });

  test("email is the only type that can report coverage", async () => {
    __setWikiReadonlyForTest(false);
    const at = new Date(1_700_000_000_000);
    const { checkers } = wikiCheckerSpies();
    const covering = { ...checkers, checkEmail: async () => ({ alerts: [], coveredFrom: at }) };

    expect((await runChecker(watcherOfType("email"), fakeBot, undefined, covering)).coveredFrom).toBe(at);
    for (const type of TYPES.filter((t) => t !== "email")) {
      expect((await runChecker(watcherOfType(type), fakeBot, undefined, covering)).coveredFrom).toBeNull();
    }
  });
});

describe("runChecker — wiki-readonly guard", () => {
  // Asserted on WHICH CHECKER THE RUN REACHES, not on the returned `[]`: every
  // checker degrades to `[]` on a degraded bot config, so an empty array proves
  // nothing about whether the drafting work ran.
  afterEach(() => __setWikiReadonlyForTest());

  test("a readonly instance never reaches the wiki-DRAFTING checkers", async () => {
    __setWikiReadonlyForTest(true);
    const { calls, checkers } = wikiCheckerSpies();
    expect((await runChecker(watcherOfType("wiki-gardener"), fakeBot, undefined, checkers)).alerts).toEqual([]);
    expect((await runChecker(watcherOfType("consolidation-gardener"), fakeBot, undefined, checkers)).alerts).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("the write owner still runs them — the guard is the FLAG, not the type", async () => {
    __setWikiReadonlyForTest(false);
    const { calls, alertsFrom, checkers } = wikiCheckerSpies();
    expect((await runChecker(watcherOfType("wiki-gardener"), fakeBot, undefined, checkers)).alerts)
      .toEqual(alertsFrom("wiki-gardener"));
    expect((await runChecker(watcherOfType("consolidation-gardener"), fakeBot, undefined, checkers)).alerts)
      .toEqual(alertsFrom("consolidation-gardener"));
    expect(calls).toEqual(["wiki-gardener", "consolidation-gardener"]);
  });

  test("the report-only linter and the git committer run on a readonly instance too", async () => {
    __setWikiReadonlyForTest(true);
    const { calls, alertsFrom, checkers } = wikiCheckerSpies();
    expect((await runChecker(watcherOfType("wiki-linter"), fakeBot, undefined, checkers)).alerts)
      .toEqual(alertsFrom("wiki-linter"));
    expect((await runChecker(watcherOfType("wiki-committer"), fakeBot, undefined, checkers)).alerts)
      .toEqual(alertsFrom("wiki-committer"));
    expect(calls).toEqual(["wiki-linter", "wiki-committer"]);
  });
});

describe("shouldSkipWikiDraftingRun", () => {
  test("only the two wiki-DRAFTING types, and only when readonly", () => {
    for (const type of ["wiki-gardener", "consolidation-gardener"] as const) {
      expect(`${type} readonly: ${shouldSkipWikiDraftingRun(type, true)}`).toBe(`${type} readonly: true`);
      expect(`${type} write-owner: ${shouldSkipWikiDraftingRun(type, false)}`).toBe(`${type} write-owner: false`);
    }
    // wiki-linter is report-only and wiki-committer is git — the flag deliberately
    // leaves both open, exactly as the trigger route does.
    for (const type of ["wiki-linter", "wiki-committer", "email", "x", "anthropic", "news"] as const) {
      expect(`${type}: ${shouldSkipWikiDraftingRun(type, true)}`).toBe(`${type}: false`);
    }
  });
});
