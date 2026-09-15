/**
 * The shared claude-usage warn-once registry (fix round 2).
 *
 * All three proxies of that service — the `/models` Pipeline ledger card, the
 * `/plans` board, the wiki provenance chips — dedupe their degrade messages
 * through one helper. They churn at wildly different rates, and a single
 * registry cleared WHOLESALE at its cap meant the noisy one could evict the
 * quiet one's only key and make it re-warn for an outage in its tenth hour.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  claudeUsageWarnOnce,
  __resetClaudeUsageWarnsForTest,
} from "./claude-usage-fetch.ts";
import type { getLog } from "../logging.ts";

type Logger = ReturnType<typeof getLog>;

/** A logger that records the LEVEL each line went out at — which is the whole
 *  observable of a warn-once: first sighting warns, repeats drop to info. */
function recorder(): { levels: string[]; log: Logger } {
  const levels: string[] = [];
  const log = {
    warn: () => levels.push("warn"),
    info: () => levels.push("info"),
    debug: () => levels.push("debug"),
    error: () => levels.push("error"),
    fatal: () => levels.push("fatal"),
    trace: () => levels.push("trace"),
  } as unknown as Logger;
  return { levels, log };
}

const BASE = "http://127.0.0.1:8787";

beforeEach(() => __resetClaudeUsageWarnsForTest());

describe("claudeUsageWarnOnce", () => {
  test("the first sighting warns and every repeat drops to info", () => {
    const { levels, log } = recorder();
    for (let i = 0; i < 3; i += 1) {
      claudeUsageWarnOnce({ log, baseUrl: BASE, key: "down", error: "down", what: "plan ledger" });
    }
    expect(levels).toEqual(["warn", "info", "info"]);
  });

  test("the key is per (base URL, reason) — two hosts are two facts", () => {
    const { levels, log } = recorder();
    claudeUsageWarnOnce({ log, baseUrl: BASE, key: "down", error: "down", what: "plan ledger" });
    claudeUsageWarnOnce({ log, baseUrl: "http://mini:8787", key: "down", error: "down", what: "plan ledger" });
    claudeUsageWarnOnce({ log, baseUrl: BASE, key: "other", error: "other", what: "plan ledger" });
    expect(levels).toEqual(["warn", "warn", "warn"]);
  });

  /**
   * The eviction. The provenance chips fire once per page open and their keys
   * carry the failing endpoint, so a bad afternoon mints a stream of distinct
   * ones; the `/models` card polls one endpoint every 5 minutes and holds one
   * key. Sharing a capped registry, the churning caller's overflow cleared the
   * card's key out with its own and the card re-warned.
   */
  test("a churning caller cannot evict ANOTHER caller's key", () => {
    const card = recorder();
    // The quiet caller's one key, already warned about.
    claudeUsageWarnOnce({
      log: card.log,
      baseUrl: BASE,
      key: "unreachable",
      error: "unreachable",
      what: "claude-usage overview",
    });
    expect(card.levels).toEqual(["warn"]);

    // The noisy one churns well past any per-caller cap.
    const noisy = recorder();
    for (let i = 0; i < 500; i += 1) {
      claudeUsageWarnOnce({
        log: noisy.log,
        baseUrl: BASE,
        key: `endpoint-${i}`,
        error: `endpoint-${i}`,
        what: "session ledger",
      });
    }

    // The card's key is still remembered, so its repeat is an info.
    claudeUsageWarnOnce({
      log: card.log,
      baseUrl: BASE,
      key: "unreachable",
      error: "unreachable",
      what: "claude-usage overview",
    });
    expect(card.levels).toEqual(["warn", "info"]);
  });

  test("a caller can still evict ITSELF — the registry stays bounded", () => {
    const { levels, log } = recorder();
    const warn = (key: string) =>
      claudeUsageWarnOnce({ log, baseUrl: BASE, key, error: key, what: "session ledger" });
    warn("first");
    for (let i = 0; i < 200; i += 1) warn(`k-${i}`);
    levels.length = 0;
    warn("first"); // forgotten by its own overflow, so it warns again
    expect(levels).toEqual(["warn"]);
  });

  test("the reset forgets every caller, not just the last one", () => {
    const a = recorder();
    const b = recorder();
    claudeUsageWarnOnce({ log: a.log, baseUrl: BASE, key: "x", error: "x", what: "plan ledger" });
    claudeUsageWarnOnce({ log: b.log, baseUrl: BASE, key: "x", error: "x", what: "session ledger" });
    __resetClaudeUsageWarnsForTest();
    a.levels.length = 0;
    b.levels.length = 0;
    claudeUsageWarnOnce({ log: a.log, baseUrl: BASE, key: "x", error: "x", what: "plan ledger" });
    claudeUsageWarnOnce({ log: b.log, baseUrl: BASE, key: "x", error: "x", what: "session ledger" });
    expect(a.levels).toEqual(["warn"]);
    expect(b.levels).toEqual(["warn"]);
  });
});
