import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { Watcher } from "../types.ts";

// --- Module mocks (registered before the dynamic import below) ---
// checkEmail spawns Haiku (Gmail MCP) and loads the interest profile. Both are
// mocked so the gate assembles + runs without a real `claude -p` spawn or a live
// Postgres — we only need to capture the assembled prompt to assert the
// interest-profile injection (augment-only) and the null-profile byte-identity.

let lastPrompt = "";
// What the mocked spawn reports having called. `undefined` is the DEFAULT because
// that is what the legacy-JSON parser fallback produces, and it is the value every
// pre-existing test in this file runs under — the liveness predicate must stay inert
// for them.
let nextToolCalls: { name: string }[] | undefined;
// NB: mock.module leaks across the watcher test files in a shared process (see the
// same note in x.test.ts). runner.test.ts — co-located in the test:unit group and
// evaluated after this file — transitively imports `trackUsage`, so export the full
// runtime surface of executor.ts here; a partial mock would break its module load.
// Only DEFAULT_MODEL + spawnHaiku are exercised; the rest are inert stand-ins.
mock.module("../scheduler/executor.ts", () => ({
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  HAIKU_TIMEOUT_MS: 60_000,
  spawnHaiku: async (prompt: string) => {
    lastPrompt = prompt;
    return { result: "[]", inputTokens: 0, outputTokens: 0, model: "claude-haiku-4-5-20251001", toolCalls: nextToolCalls };
  },
  parseHaikuJson: () => ({}),
  parseLegacyHaikuOutput: () => ({ result: "", inputTokens: 0, outputTokens: 0, model: "" }),
  readAndParseHaikuStream: async () => ({ result: "", inputTokens: 0, outputTokens: 0, model: "" }),
  callHaiku: async () => ({ result: "", inputTokens: 0, outputTokens: 0, model: "" }),
  trackUsage: async () => {},
}));

// Interest profile keyed by the EXPLICIT userId (loadInterestProfile) — mirrors
// x.test / anthropic.test. loadInterestProfileForBot is exported inert so sibling
// files' static imports still resolve under the leaked mock.
const profileByUser = new Map<string, string>();
mock.module("../profile/generator.ts", () => ({
  loadInterestProfile: async (userId: string | undefined) =>
    (userId ? profileByUser.get(userId) : null) ?? null,
  loadInterestProfileForBot: async () => "WRONG-DEFAULT-USER-PROFILE",
}));

const { buildGmailQuery, checkEmail } = await import("./email.ts");

describe("buildGmailQuery", () => {
  test("always includes is:unread", () => {
    expect(buildGmailQuery(undefined, null)).toBe("is:unread");
  });

  test("appends the custom filter", () => {
    expect(buildGmailQuery("from:boss", null)).toBe("is:unread from:boss");
  });

  test("formats after: as YYYY/MM/DD", () => {
    // 2026-01-15 12:00 UTC — well inside the same Oslo day.
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(buildGmailQuery(undefined, ts)).toBe("is:unread after:2026/01/15");
  });

  test("uses the Oslo date, not UTC, just after UTC midnight", () => {
    // 2026-06-15 23:30 UTC is already 2026-06-16 01:30 in Oslo (UTC+2 in summer).
    const ts = Date.UTC(2026, 5, 15, 23, 30, 0);
    expect(buildGmailQuery(undefined, ts)).toBe("is:unread after:2026/06/16");
  });

  test("uses the Oslo date in winter (UTC+1)", () => {
    // 2026-01-15 23:30 UTC is 2026-01-16 00:30 in Oslo (UTC+1 in winter).
    const ts = Date.UTC(2026, 0, 15, 23, 30, 0);
    expect(buildGmailQuery(undefined, ts)).toBe("is:unread after:2026/01/16");
  });

  test("combines filter and date", () => {
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(buildGmailQuery("from:boss", ts)).toBe("is:unread from:boss after:2026/01/15");
  });
});

function baseWatcher(overrides: Partial<Watcher> = {}): Watcher {
  return {
    id: "w-email-1",
    userId: "watcher-owner",
    botName: "jarvis",
    type: "email",
    name: "Email",
    config: {},
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    ...overrides,
  } as Watcher;
}

describe("checkEmail interest-profile injection", () => {
  beforeEach(() => {
    lastPrompt = "";
    profileByUser.clear();
  });

  test("gate prompt carries the WATCHER OWNER's profile, not bot_default_user's", async () => {
    // Deliberate mismatch: the owner's profile must win over any bot_default_user
    // profile (the pre-PR2 leak the web-chat dropdown could silently cause).
    profileByUser.set("watcher-owner", "OWNER-INTEREST-MARKER: agentic retrieval");
    await checkEmail(baseWatcher(), undefined, "jarvis");
    expect(lastPrompt).toContain("OWNER-INTEREST-MARKER: agentic retrieval");
    expect(lastPrompt).not.toContain("WRONG-DEFAULT-USER-PROFILE");
  });

  test("injection block augments (does not narrow) and sits AFTER the format contract", async () => {
    profileByUser.set("watcher-owner", "MARKER: mcp servers");
    await checkEmail(baseWatcher(), undefined, "jarvis");
    // Augment-don't-narrow contract wording present.
    expect(lastPrompt).toContain("do NOT narrow");
    // The format contract lands BEFORE the injected profile block, so the trailer's
    // "output-format instructions above still apply" is not contradictory.
    const formatIdx = lastPrompt.indexOf("Return ONLY a JSON array");
    const profileIdx = lastPrompt.indexOf("MARKER: mcp servers");
    expect(formatIdx).toBeGreaterThan(-1);
    expect(profileIdx).toBeGreaterThan(formatIdx);
  });

  test("no profile row ⇒ prompt is byte-identical to the un-wrapped gate prompt", async () => {
    // No profile set for the owner ⇒ loadInterestProfile returns null ⇒
    // withInterestProfile returns the base prompt verbatim.
    await checkEmail(baseWatcher(), undefined, "jarvis");
    const withoutProfile = lastPrompt;

    // Reconstruct the expected base prompt exactly as email.ts assembles it.
    const query = buildGmailQuery(undefined, null);
    const { DEFAULT_EMAIL_PROMPT } = await import("./email.ts");
    const expected = `You have access to Gmail MCP tools.
Search for unread emails matching: "${query}"

${DEFAULT_EMAIL_PROMPT}

CRITICAL:
- "id" MUST be the exact Gmail message ID from the API (e.g. "19abc123def"). Copy it verbatim.
- "sender" MUST be the exact From header value (e.g. "Posten Norge")
- "subject" MUST be the exact email subject line, verbatim — do NOT rephrase or shorten it.

Return ONLY a JSON array (no markdown fences):
[{"id":"msg_id","source":"email","sender":"exact sender","subject":"exact subject","summary":"**Fra:** sender — subject brief","urgency":"high|medium|low"}]
If nothing worth notifying, return: []`;

    expect(withoutProfile).toBe(expected);
    // And no augmentation wording leaked in.
    expect(withoutProfile).not.toContain("do NOT narrow");
  });
});

describe("checkEmail Gmail liveness predicate", () => {
  beforeEach(() => {
    nextToolCalls = undefined;
    profileByUser.clear();
  });

  test("a Gmail tool call makes an empty result a TRUSTWORTHY quiet inbox", async () => {
    nextToolCalls = [{ name: "ToolSearch" }, { name: "mcp__gmail__search_emails" }];
    expect(await checkEmail(baseWatcher(), undefined, "jarvis")).toEqual([]);
  });

  test("NO Gmail tool call throws instead of reporting a quiet inbox", async () => {
    // The measured live failure: the model loops on ToolSearch, simulates the call
    // through Bash, and answers `[]`. Pre-fix that reached the runner as an ordinary
    // empty inbox; the whole point of the predicate is that it must not.
    nextToolCalls = [{ name: "ToolSearch" }, { name: "Bash" }, { name: "Bash" }];
    await expect(checkEmail(baseWatcher(), undefined, "jarvis")).rejects.toThrow(/no Gmail tool call/);
  });

  test("zero tool calls throws — the model answered without reaching any tool", async () => {
    // THE case this predicate exists for: Gmail MCP down or its permission denied,
    // so the model answers `[]` in one turn having called nothing. Reaching it
    // depends on `spawnHaiku` normalizing StreamParser's zero-tools `undefined` to
    // `[]` — without that this state is unreachable and the branch is dead code.
    // `spawn-haiku-toolcalls.test.ts` pins the normalization at the real seam;
    // this test would pass against the broken build, so it does not stand alone.
    nextToolCalls = [];
    await expect(checkEmail(baseWatcher(), undefined, "jarvis")).rejects.toThrow(/no Gmail tool call/);
  });

  test("UNDEFINED toolCalls does NOT throw — the legacy parser can't tell", async () => {
    // Distinct from `[]`. The legacy-JSON fallback carries no tool list at all, so a
    // throw here would fire on every run that hits the known missing-result-event CLI
    // bug, turning a parser degradation into a watcher outage.
    nextToolCalls = undefined;
    expect(await checkEmail(baseWatcher(), undefined, "jarvis")).toEqual([]);
  });

  test("a non-string tool name degrades to the diagnostic, not a TypeError", async () => {
    nextToolCalls = [{ name: undefined as unknown as string }];
    await expect(checkEmail(baseWatcher(), undefined, "jarvis")).rejects.toThrow(/no Gmail tool call/);
  });

  test("the throw names what WAS called, so the log says how it failed", async () => {
    nextToolCalls = [{ name: "Bash" }, { name: "Bash" }, { name: "ToolSearch" }];
    // Deduped — 4 Bash calls should not print "Bash, Bash, Bash, Bash".
    await expect(checkEmail(baseWatcher(), undefined, "jarvis")).rejects.toThrow(/Bash, ToolSearch/);
  });
});
