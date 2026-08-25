import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import * as realExecutor from "../scheduler/executor.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Watcher } from "../types.ts";

// buildGmailQuery takes an explicit clock now (the shared-clock invariant with
// the coverage anchor); these cases pass no watermark, so the value is inert.
const NOW_FIXED = Date.UTC(2026, 0, 15, 12, 0, 0);

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
// Per-ATTEMPT scripting for the retry tests. When non-empty each entry is consumed
// by one spawn, so a test can say "attempt 1 fails the predicate, attempt 2 reaches
// Gmail". Empty ⇒ every spawn answers from `nextToolCalls` (the pre-retry behavior
// every other test in this file relies on).
// `delayMs` makes the mocked spawn take measurable time. Without it every spawn
// resolves in <1ms, and no assertion can tell a check-ENTRY anchor from a
// check-END one — the gap the review found in the first cut of that test.
type SpawnScript = { toolCalls?: { name: string }[]; result?: string; throws?: string; delayMs?: number };
let spawnScript: SpawnScript[] = [];
// One entry per spawn actually made — the attempt COUNT is the thing under test, so
// it has to be observable rather than inferred from the return value.
let spawnOpts: { timeoutMs?: number }[] = [];
// NB: mock.module leaks across the watcher test files in a shared process (see the
// same note in x.test.ts).
/**
 * The executor mock is SPREAD OVER THE REAL MODULE, not hand-listed.
 *
 * `mock.module` invalidates the target for the WHOLE `bun test` process, so any
 * module evaluated afterwards that names an export the mock omits dies with
 * `SyntaxError: Export named 'X' not found` — and it is `haiku-direct.ts`'s
 * `trackUsage` import that gets hit here, through modules these tests never
 * mention. Whether that happens at all depends on which file in the chunk loaded
 * `haiku-direct.ts` FIRST, which is why it stayed invisible on macOS and took
 * out five files in `src/watchers/` on the CI runner.
 *
 * Hand-listing the surface (what `email.test.ts` did) works until the next export
 * is added to `executor.ts`, and then it fails the same way somewhere else. The
 * spread cannot drift.
 */
mock.module("../scheduler/executor.ts", () => ({
  ...realExecutor,
  // ⚠️ The spread above installs the REAL implementations of everything these
  // tests do not override, and two of them have side effects that must never run
  // from a test: `trackUsage` calls `getDb()` and INSERTs into `haiku_usage`
  // (`src/watchers/wiki-gardener.ts` calls it, in this same `bun test` process),
  // and `callHaiku` calls the module-internal real `spawnHaiku`, which spawns the
  // `claude` CLI. Nothing reaches them today — but the whole reason the hand-listed
  // surface was deleted is that the next change is not supposed to have to notice.
  // (`buildHaikuArgs` also writes temp files, via `buildInlineSettings`, and is
  // NOT stubbed: its only caller is the real `spawnHaiku`, which every file here
  // overrides. Everything else executor.ts exports is pure or stream-local.)
  trackUsage: () => {},
  // `Promise<string>`, not a `HaikuResult` — the real `callHaiku` returns the
  // text. A stub with the `spawnHaiku` shape would reach the next caller as
  // "[object Object]" in a prompt, or as `.trim is not a function`, and
  // `mock.module`'s factory is untyped so tsc cannot see the mismatch.
  callHaiku: async () => "",
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  HAIKU_TIMEOUT_MS: 60_000,
  spawnHaiku: async (prompt: string, opts: { timeoutMs?: number }) => {
    lastPrompt = prompt;
    spawnOpts.push({ timeoutMs: opts?.timeoutMs });
    const step = spawnScript.shift();
    if (step?.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step?.throws) throw new Error(step.throws);
    return {
      result: step?.result ?? "[]",
      inputTokens: 0,
      outputTokens: 0,
      model: "claude-haiku-4-5-20251001",
      toolCalls: step ? step.toolCalls : nextToolCalls,
    };
  },
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

const {
  buildGmailQuery,
  buildGmailQueryByDate,
  EMAIL_QUERY_OVERLAP_MS,
  EMAIL_MAX_LOOKBACK_MS,
  emailLookbackClampMs,
  emailClampWarning,
  EMAIL_CLAMP_WARN_MIN_MS,
  buildEmailPrompt,
  DEFAULT_EMAIL_PROMPT,
  checkEmail,
  gmailToolPrefixes,
  emailRetryBudgetMs,
  emailAttemptTimeoutMs,
  shouldStartEmailAttempt,
  EMAIL_MAX_ATTEMPTS,
} = await import("./email.ts");

describe("buildGmailQuery (success-watermark window)", () => {
  const SINCE = Date.UTC(2026, 0, 15, 12, 0, 0);
  const NOW = SINCE + 3_600_000; // one tick later, so the 24h clamp is not in play

  test("always includes is:unread", () => {
    expect(buildGmailQuery(undefined, null, NOW_FIXED)).toBe("is:unread");
  });

  test("appends the custom filter", () => {
    expect(buildGmailQuery("from:boss", null, NOW_FIXED)).toBe("is:unread from:boss");
  });

  test("emits after: as Unix SECONDS, not a date", () => {
    // The whole point of the window: a date-granular after: re-evaluates the
    // entire day every hour. Asserting the numeric form (no slashes) is what
    // fails if someone reverts to OSLO_DATE_FMT here.
    const q = buildGmailQuery(undefined, SINCE, NOW);
    expect(q).toMatch(/^is:unread after:\d+$/);
    expect(q).not.toContain("/");
  });

  test("subtracts the overlap from the watermark", () => {
    // Kills the mutation that drops EMAIL_QUERY_OVERLAP_MS: without it the
    // boundary message is straddled and lost silently.
    expect(buildGmailQuery(undefined, SINCE, NOW)).toBe(
      `is:unread after:${(SINCE - EMAIL_QUERY_OVERLAP_MS) / 1000}`,
    );
    expect(buildGmailQuery(undefined, SINCE, NOW)).not.toBe(`is:unread after:${SINCE / 1000}`);
  });

  test("clamps a stale watermark to the 24h lookback ceiling", () => {
    // A row disabled for three days must not ask for three days of mail.
    const stale = NOW - 3 * 24 * 3_600_000;
    expect(buildGmailQuery(undefined, stale, NOW)).toBe(
      `is:unread after:${(NOW - EMAIL_MAX_LOOKBACK_MS) / 1000}`,
    );
  });

  test("does NOT clamp a watermark inside the ceiling", () => {
    // Guards the max() direction: a min() here would pin every query to 24h ago
    // and re-introduce exactly the accumulation this replaces.
    const recent = NOW - 2 * 3_600_000;
    expect(buildGmailQuery(undefined, recent, NOW)).toBe(
      `is:unread after:${(recent - EMAIL_QUERY_OVERLAP_MS) / 1000}`,
    );
  });

  test("floors sub-second precision rather than rounding up", () => {
    // Rounding up would exclude the very boundary message the overlap adds.
    // since = 1_700_000_000_500 ⇒ 1700000000.5s. Math.round would give ...001.
    const odd = 1_700_000_000_500 + EMAIL_QUERY_OVERLAP_MS;
    expect(buildGmailQuery(undefined, odd, odd + 1000)).toBe("is:unread after:1700000000");
    expect(buildGmailQuery(undefined, odd, odd + 1000)).not.toBe("is:unread after:1700000001");
  });

  test("a watermark AHEAD of the clock cannot produce a future query floor", () => {
    // A backwards clock step (NTP, VM resume, a second muninn on a shared DB)
    // would otherwise hand Gmail a future `after:` argument. See the ceiling's
    // comment for what that does and does not buy.
    const future = NOW + 3_600_000;
    expect(buildGmailQuery(undefined, future, NOW)).toBe(`is:unread after:${NOW / 1000}`);
  });

  test("combines filter and window", () => {
    expect(buildGmailQuery("from:boss", SINCE, NOW)).toBe(
      `is:unread from:boss after:${(SINCE - EMAIL_QUERY_OVERLAP_MS) / 1000}`,
    );
  });
});

describe("buildGmailQueryByDate (cold-start fallback)", () => {
  test("always includes is:unread", () => {
    expect(buildGmailQueryByDate(undefined, null)).toBe("is:unread");
  });

  test("appends the custom filter", () => {
    expect(buildGmailQueryByDate("from:boss", null)).toBe("is:unread from:boss");
  });

  test("formats after: as YYYY/MM/DD", () => {
    // 2026-01-15 12:00 UTC — well inside the same Oslo day.
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(buildGmailQueryByDate(undefined, ts)).toBe("is:unread after:2026/01/15");
  });

  test("uses the Oslo date, not UTC, just after UTC midnight", () => {
    // 2026-06-15 23:30 UTC is already 2026-06-16 01:30 in Oslo (UTC+2 in summer).
    const ts = Date.UTC(2026, 5, 15, 23, 30, 0);
    expect(buildGmailQueryByDate(undefined, ts)).toBe("is:unread after:2026/06/16");
  });

  test("uses the Oslo date in winter (UTC+1)", () => {
    // 2026-01-15 23:30 UTC is 2026-01-16 00:30 in Oslo (UTC+1 in winter).
    const ts = Date.UTC(2026, 0, 15, 23, 30, 0);
    expect(buildGmailQueryByDate(undefined, ts)).toBe("is:unread after:2026/01/16");
  });

  test("combines filter and date", () => {
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(buildGmailQueryByDate("from:boss", ts)).toBe("is:unread from:boss after:2026/01/15");
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
    lastSuccessAt: null,
    lastNotifiedIds: [],
    ...overrides,
  } as Watcher;
}

describe("checkEmail query-window selection", () => {
  beforeEach(() => {
    lastPrompt = "";
    profileByUser.clear();
    spawnScript = [];
    spawnOpts = [];
  });

  test("bounds the query on lastSuccessAt when there is one", async () => {
    const since = Date.now() - 3_600_000;
    await checkEmail(baseWatcher({ lastSuccessAt: since, lastRunAt: Date.now() }), undefined, "jarvis");
    expect(lastPrompt).toContain(`after:${Math.floor((since - EMAIL_QUERY_OVERLAP_MS) / 1000)}`);
  });

  test("IGNORES lastRunAt when a watermark exists", async () => {
    // The load-bearing distinction. `lastRunAt` advances on quiet-hours skips and
    // on failures, so a window derived from it would exclude the overnight pile
    // and every failed tick's mail having never looked at either. If someone
    // "simplifies" the selection to `lastSuccessAt ?? lastRunAt` this still
    // passes — which is why the fallback test below asserts the DATE form.
    const since = Date.now() - 6 * 3_600_000;
    const lastRun = Date.now() - 60_000;
    await checkEmail(baseWatcher({ lastSuccessAt: since, lastRunAt: lastRun }), undefined, "jarvis");
    expect(lastPrompt).toContain(`after:${Math.floor((since - EMAIL_QUERY_OVERLAP_MS) / 1000)}`);
    expect(lastPrompt).not.toContain(`after:${Math.floor((lastRun - EMAIL_QUERY_OVERLAP_MS) / 1000)}`);
  });

  test("falls back to the DATE query when no success has been recorded", async () => {
    // Cold start (every row for one tick after migration 069). Broad is the safe
    // direction here; asserting the slash form is what fails if the fallback is
    // collapsed into the epoch window, which would silently narrow a row whose
    // watermark does not exist yet.
    const lastRun = Date.UTC(2026, 0, 15, 12, 0, 0);
    await checkEmail(baseWatcher({ lastSuccessAt: null, lastRunAt: lastRun }), undefined, "jarvis");
    expect(lastPrompt).toContain("after:2026/01/15");
  });
});

describe("emailClampWarning (the operator surface's gate)", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const stale = (h: number) => NOW - h * 3_600_000;

  test("is silent when nothing is skipped", () => {
    expect(emailClampWarning(stale(3), NOW)).toBeNull();
  });

  test("is silent for a trivial skip below the gate", () => {
    // Kills gate -> 0: a watermark barely past the ceiling must not tell the
    // operator to go search Gmail by hand over a few minutes.
    expect(emailClampWarning(stale(24) - 60_000, NOW)).toBeNull();
  });

  test("WARNS once the skipped span clears the gate", () => {
    // Kills gate -> Infinity, which silences the only signal a human ever gets
    // that mail was permanently skipped — with the whole suite green.
    const w = emailClampWarning(stale(72), NOW);
    expect(w).not.toBeNull();
    expect(w!.skippedMs).toBe(48 * 3_600_000);
    expect(w!.staleMs).toBe(72 * 3_600_000);
  });

  test("warns just above the gate, not just below it", () => {
    const justUnder = stale(24) - (EMAIL_CLAMP_WARN_MIN_MS - 60_000);
    const justOver = stale(24) - (EMAIL_CLAMP_WARN_MIN_MS + 60_000);
    expect(emailClampWarning(justUnder, NOW)).toBeNull();
    expect(emailClampWarning(justOver, NOW)).not.toBeNull();
  });
});

describe("checkEmail coverage reporting", () => {
  // `coveredFrom` is a RETURN value, so these tests pin the half with all the
  // judgement in it: WHEN a run may claim its window was covered. The DB write
  // lives in the runner, deliberately after delivery (see EmailCheckResult), and
  // is pinned separately by `finishWatcherRun`'s tests.
  const GMAIL = [{ name: "mcp__gmail__search_emails" }];
  // The predicate reads the bot's OWN .mcp.json to learn which server is Gmail,
  // so the two dirs below are what separate "reached Gmail" from "cannot tell".
  let botDirWithGmail = "";
  let botDirNoGmail = "";

  beforeEach(() => {
    botDirWithGmail = mkdtempSync(join(tmpdir(), "muninn-email-cov-gmail-"));
    writeFileSync(join(botDirWithGmail, ".mcp.json"), JSON.stringify({ mcpServers: { gmail: { type: "stdio", command: "x" } } }));
    botDirNoGmail = mkdtempSync(join(tmpdir(), "muninn-email-cov-nogmail-"));
    writeFileSync(join(botDirNoGmail, ".mcp.json"), JSON.stringify({ mcpServers: { "google-mail": { type: "stdio", command: "x" } } }));
    lastPrompt = "";
    profileByUser.clear();
    spawnScript = [];
    spawnOpts = [];
    nextToolCalls = undefined;
  });

  afterEach(() => {
    rmSync(botDirWithGmail, { recursive: true, force: true });
    rmSync(botDirNoGmail, { recursive: true, force: true });
  });

  test("claims coverage when the run reached Gmail and parsed", async () => {
    spawnScript = [{ toolCalls: GMAIL, result: "[]" }];
    const r = await checkEmail(baseWatcher(), botDirWithGmail, "jarvis");

    expect(r.coveredFrom).toBeInstanceOf(Date);
  });

  test("anchors coverage at check ENTRY, not at the end of the spawn", async () => {
    // Kills `new Date()` in place of `new Date(startedAt)`. The real spawn takes
    // 21-56s, so anchoring at the end would skip every message that arrived while
    // the check ran. The mocked spawn returns in <1ms, so the assertion needs a
    // deliberate delay to have any resolving power at all — an earlier cut of this
    // test asserted `at <= Date.now()` and could not tell the two apart.
    spawnScript = [{ toolCalls: GMAIL, result: "[]", delayMs: 40 }];
    const entry = Date.now();
    const r = await checkEmail(baseWatcher(), botDirWithGmail, "jarvis");
    const finished = Date.now();

    // Entry precedes the 40ms spawn, so the anchor must sit at least that far
    // back from the finish. A `new Date()` anchor lands within a millisecond of
    // `finished` and fails here.
    expect(r.coveredFrom!.getTime()).toBeGreaterThanOrEqual(entry);
    expect(finished - r.coveredFrom!.getTime()).toBeGreaterThanOrEqual(30);
  });

  test("does NOT claim coverage when the answer is unparseable", async () => {
    // This path returns no alerts having delivered nothing. Claiming coverage
    // here cost a permanent hour of mail: the window advanced past messages no
    // run had evaluated, and unread mail is re-offered by nothing else.
    spawnScript = [{ toolCalls: GMAIL, result: "I looked through your inbox and nothing seemed urgent." }];
    const r = await checkEmail(baseWatcher(), botDirWithGmail, "jarvis");

    expect(r.alerts).toEqual([]);
    expect(r.coveredFrom).toBeNull();
  });

  test("does NOT claim coverage when the run is unjudgeable (legacy parser, no tool list)", async () => {
    // toolCalls undefined ⇒ "can't tell". Deliberately not a FAILURE (no evidence
    // it broke) but equally not COVERAGE (no evidence it worked).
    spawnScript = [{ toolCalls: undefined, result: "[]" }];
    const r = await checkEmail(baseWatcher(), botDirWithGmail, "jarvis");

    expect(r.coveredFrom).toBeNull();
  });

  test("does NOT claim coverage when no MCP server key looks like Gmail", async () => {
    // The predicate is DISABLED for such a bot by design. If that state also
    // claimed coverage, the row would step forward an hour per tick while reading
    // no mail at all — and never recover, because the mail stays unread.
    spawnScript = [{ toolCalls: [{ name: "mcp__google-mail__search" }], result: "[]" }];
    const r = await checkEmail(baseWatcher(), botDirNoGmail, "jarvis");

    expect(r.coveredFrom).toBeNull();
  });

  test("does NOT claim coverage when the liveness predicate fails on every attempt", async () => {
    spawnScript = [
      { toolCalls: [{ name: "ToolSearch" }], result: "[]" },
      { toolCalls: [{ name: "Bash" }], result: "[]" },
    ];
    await expect(checkEmail(baseWatcher(), botDirWithGmail, "jarvis")).rejects.toThrow();
  });

  test("claims coverage when attempt 1 fails the predicate and attempt 2 reaches Gmail", async () => {
    spawnScript = [
      { toolCalls: [{ name: "ToolSearch" }], result: "[]" },
      { toolCalls: GMAIL, result: "[]" },
    ];
    const r = await checkEmail(baseWatcher(), botDirWithGmail, "jarvis");

    expect(r.coveredFrom).toBeInstanceOf(Date);
  });
});

describe("emailLookbackClampMs", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  test("is 0 when the watermark is inside the ceiling", () => {
    expect(emailLookbackClampMs(NOW - 3 * 3_600_000, NOW)).toBe(0);
  });

  test("is 0 exactly at the boundary", () => {
    expect(emailLookbackClampMs(NOW - EMAIL_MAX_LOOKBACK_MS, NOW)).toBe(0);
  });

  test("is 0 for a watermark just inside the overlap of the ceiling", () => {
    // The case the overlap-counting version got wrong: 24h + 4min stale reported
    // a 9-min "loss" and stayed under the warn gate, so genuinely-skipped mail
    // went unreported while a no-loss run was being counted as lossy.
    expect(emailLookbackClampMs(NOW - EMAIL_MAX_LOOKBACK_MS + EMAIL_QUERY_OVERLAP_MS, NOW)).toBe(0);
  });

  test("never returns a negative span", () => {
    expect(emailLookbackClampMs(NOW, NOW)).toBe(0);
    expect(emailLookbackClampMs(NOW + 3_600_000, NOW)).toBe(0);
  });

  test("returns 0 for a falsy watermark, matching buildGmailQuery's own guard", () => {
    // buildGmailQuery emits NO after: clause for a 0 watermark, so nothing is
    // skipped. Without this guard the two disagreed by ~57 years.
    expect(emailLookbackClampMs(0, NOW)).toBe(0);
    expect(buildGmailQuery(undefined, 0, NOW)).toBe("is:unread");
  });

  test("reports the span given up when the ceiling wins", () => {
    // Kills the inverted comparison, which reported a skip on every HEALTHY run
    // and stayed silent on every clamped one — destroying the skip's only surface
    // while the whole suite stayed green.
    const stale = NOW - 72 * 3_600_000;
    // (now − 24h) − stale = 48h. The 5-min overlap is NOT counted: that window
    // was already read by the previous successful check, so including it would
    // overstate every warning and report a "loss" for a watermark barely past the
    // ceiling where nothing new is dropped at all.
    expect(emailLookbackClampMs(stale, NOW)).toBe(48 * 3_600_000);
  });

  test("never returns a negative span", () => {
    expect(emailLookbackClampMs(NOW, NOW)).toBe(0);
    expect(emailLookbackClampMs(NOW + 3_600_000, NOW)).toBe(0);
  });
});


describe("checkEmail interest-profile injection", () => {
  beforeEach(() => {
    lastPrompt = "";
    profileByUser.clear();
    spawnScript = [];
    spawnOpts = [];
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
    const query = buildGmailQuery(undefined, null, NOW_FIXED);
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
  // The predicate only engages when it can NAME the Gmail server, so these tests
  // need a botDir whose .mcp.json declares one — passing `undefined` would leave
  // the check standing down and assert nothing.
  let gmailBotDir: string;
  beforeEach(() => {
    nextToolCalls = undefined;
    profileByUser.clear();
    spawnScript = [];
    spawnOpts = [];
    gmailBotDir = mkdtempSync(join(tmpdir(), "muninn-email-bot-"));
    writeFileSync(join(gmailBotDir, ".mcp.json"), JSON.stringify({ mcpServers: { gmail: { type: "stdio", command: "x" } } }));
  });
  afterEach(() => rmSync(gmailBotDir, { recursive: true, force: true }));

  test("a Gmail tool call makes an empty result a TRUSTWORTHY quiet inbox", async () => {
    nextToolCalls = [{ name: "ToolSearch" }, { name: "mcp__gmail__search_emails" }];
    expect((await checkEmail(baseWatcher(), gmailBotDir, "jarvis")).alerts).toEqual([]);
  });

  test("NO Gmail tool call throws instead of reporting a quiet inbox", async () => {
    // The measured live failure: the model loops on ToolSearch, simulates the call
    // through Bash, and answers `[]`. Pre-fix that reached the runner as an ordinary
    // empty inbox; the whole point of the predicate is that it must not.
    nextToolCalls = [{ name: "ToolSearch" }, { name: "Bash" }, { name: "Bash" }];
    await expect(checkEmail(baseWatcher(), gmailBotDir, "jarvis")).rejects.toThrow(/no Gmail tool call/);
  });

  test("zero tool calls throws — the model answered without reaching any tool", async () => {
    // THE case this predicate exists for: Gmail MCP down or its permission denied,
    // so the model answers `[]` in one turn having called nothing. Reaching it
    // depends on `spawnHaiku` normalizing StreamParser's zero-tools `undefined` to
    // `[]` — without that this state is unreachable and the branch is dead code.
    // `executor.test.ts` → describe("toolCalls: 'saw zero tools' vs 'could not see
    // the run'") pins that normalization at the real seam; THIS test passes against
    // the broken build too, so it does not stand alone.
    nextToolCalls = [];
    await expect(checkEmail(baseWatcher(), gmailBotDir, "jarvis")).rejects.toThrow(/no Gmail tool call/);
  });

  test("UNDEFINED toolCalls does NOT throw — the legacy parser can't tell", async () => {
    // Distinct from `[]`. The legacy-JSON fallback carries no tool list at all, so a
    // throw here would fire on every run that hits the known missing-result-event CLI
    // bug, turning a parser degradation into a watcher outage.
    nextToolCalls = undefined;
    expect((await checkEmail(baseWatcher(), gmailBotDir, "jarvis")).alerts).toEqual([]);
  });

  test("a non-string tool name degrades to the diagnostic, not a TypeError", async () => {
    nextToolCalls = [{ name: undefined as unknown as string }];
    await expect(checkEmail(baseWatcher(), gmailBotDir, "jarvis")).rejects.toThrow(/no Gmail tool call/);
  });

  test("a RENAMED gmail server key still counts as reaching Gmail", async () => {
    // The trap this closes: bot folders other than jarvis are gitignored and synced
    // from another repo, so a `.mcp.json` rename could turn every healthy run into
    // an hourly hard failure with no code change to point at.
    const dir = mkdtempSync(join(tmpdir(), "muninn-email-mcp-"));
    try {
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "gmail-mcp": { type: "stdio", command: "x" } } }));
      expect(gmailToolPrefixes(dir)).toEqual(["mcp__gmail-mcp__"]);
      nextToolCalls = [{ name: "mcp__gmail-mcp__search_emails" }];
      expect((await checkEmail(baseWatcher(), dir, "jarvis")).alerts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no identifiable gmail server ⇒ null ⇒ the predicate stands DOWN", async () => {
    // Deliberately NOT a fallback to `mcp__gmail__`. A bot that renamed the key to
    // something without "gmail" in it has a WORKING server we merely cannot name;
    // guessing would hard-fail every healthy tick — the trap this derivation
    // removes. Failing closed on no evidence is the one thing not allowed here.
    const dir = mkdtempSync(join(tmpdir(), "muninn-email-mcp-"));
    try {
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "google-mail": { type: "stdio", command: "x" } } }));
      expect(gmailToolPrefixes(dir)).toBeNull();
      // …and a run that called only that server is therefore trusted, not thrown on.
      nextToolCalls = [{ name: "mcp__google-mail__search_emails" }];
      expect((await checkEmail(baseWatcher(), dir, "jarvis")).alerts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed .mcp.json ⇒ null, never a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "muninn-email-mcp-"));
    try {
      writeFileSync(join(dir, ".mcp.json"), "{ not json at all");
      expect(gmailToolPrefixes(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multiple gmail-like keys ⇒ ANY of them counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "muninn-email-mcp-"));
    try {
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { gmail: {}, "gmail-backup": {} } }));
      expect(gmailToolPrefixes(dir)?.sort()).toEqual(["mcp__gmail-backup__", "mcp__gmail__"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no botDir ⇒ null, so a botDir-less caller is never judged", () => {
    expect(gmailToolPrefixes(undefined)).toBeNull();
  });

  test("the throw names what WAS called, so the log says how it failed", async () => {
    nextToolCalls = [{ name: "Bash" }, { name: "Bash" }, { name: "ToolSearch" }];
    // Deduped — 4 Bash calls should not print "Bash, Bash, Bash, Bash".
    await expect(checkEmail(baseWatcher(), gmailBotDir, "jarvis")).rejects.toThrow(/Bash, ToolSearch/);
  });
});

describe("checkEmail bounded retry", () => {
  // The retry's whole premise is that deferred-tool resolution fails INDEPENDENTLY
  // per spawn (95 of 96 probe runs had to resolve the Gmail tool through a ToolSearch
  // round-trip; ~12.5% never got there). So the unit under test is: does a second
  // spawn actually happen, is it bounded at two, and does a rescue return real data.
  const GMAIL_CALL = [{ name: "mcp__gmail__search_emails" }];
  const NEVER_REACHED_GMAIL = [{ name: "ToolSearch" }, { name: "Bash" }];
  const ONE_ALERT = JSON.stringify([
    { id: "19abc", source: "email", sender: "Posten", subject: "Pakke", summary: "s", urgency: "low" },
  ]);

  let gmailBotDir: string;
  beforeEach(() => {
    nextToolCalls = undefined;
    profileByUser.clear();
    spawnScript = [];
    spawnOpts = [];
    gmailBotDir = mkdtempSync(join(tmpdir(), "muninn-email-retry-"));
    writeFileSync(join(gmailBotDir, ".mcp.json"), JSON.stringify({ mcpServers: { gmail: { type: "stdio", command: "x" } } }));
  });
  afterEach(() => rmSync(gmailBotDir, { recursive: true, force: true }));

  test("a predicate failure is RETRIED, and the retry's alerts are returned", async () => {
    spawnScript = [
      { toolCalls: NEVER_REACHED_GMAIL, result: "[]" },
      { toolCalls: GMAIL_CALL, result: ONE_ALERT },
    ];
    const { alerts } = await checkEmail(baseWatcher(), gmailBotDir, "jarvis");
    expect(spawnOpts).toHaveLength(2);
    // The rescued run's OWN result, not attempt 1's `[]` — a retry that returned the
    // failed attempt's body would be indistinguishable from no retry at all.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe("19abc");
  });

  test("a spawn THROW is retried too — same root cause, different shape", async () => {
    // A run that loops on ToolSearch long enough hits the 60s timeout instead of
    // answering `[]`. Retrying only the `[]` shape would leave the larger half of the
    // observed failures (3 of the last 30 live ticks) unaddressed.
    spawnScript = [{ throws: "Haiku timed out after 60000ms (budget 60000ms)" }, { toolCalls: GMAIL_CALL, result: ONE_ALERT }];
    const { alerts } = await checkEmail(baseWatcher(), gmailBotDir, "jarvis");
    expect(spawnOpts).toHaveLength(2);
    expect(alerts).toHaveLength(1);
  });

  test("two failures throw the LAST error and stop at 2 attempts", async () => {
    spawnScript = [
      { toolCalls: NEVER_REACHED_GMAIL, result: "[]" },
      { throws: "Haiku timed out after 58000ms (budget 60000ms)" },
    ];
    await expect(checkEmail(baseWatcher(), gmailBotDir, "jarvis")).rejects.toThrow(/timed out after 58000ms/);
    // Bounded: never a third spawn. At 60s per attempt a third does not fit under the
    // runner's 120s net, and overrunning it re-saves the OLD lastNotifiedIds.
    expect(spawnOpts).toHaveLength(2);
  });

  test("attempt 1 gets the FULL attempt timeout — byte-identical to pre-retry", async () => {
    // Integration smoke only: it confirms the loop wires the decider to the spawn. It
    // does NOT pin the attempt-1 rule — under the 180s floor `timeoutMs: 1` no longer
    // shortens anything (the budget is 170s regardless), so this passes even with the
    // `attempt === 1` branch deleted. The rule is pinned by the pure test above.
    spawnScript = [{ toolCalls: NEVER_REACHED_GMAIL, result: "[]" }, { toolCalls: GMAIL_CALL, result: "[]" }];
    await checkEmail(baseWatcher({ config: { timeoutMs: 1 } }), gmailBotDir, "jarvis");
    expect(spawnOpts[0]!.timeoutMs).toBe(60_000);
  });

  // The three decision points below are MUTATION-SURVIVABLE through checkEmail: every
  // retry test returns from attempt 1 instantly, so no integration test can tell a
  // clamped retry from an unclamped one. A review deleted the clamp outright with all
  // 29 tests green — and at the old 120s net its absence overran the runner by 3ms,
  // which costs the whole batch's lastNotifiedIds. Hence direct tests on the pure
  // deciders: these fail when the behavior is removed, not merely pass while present.
  describe("attempt-timeout decider (pure)", () => {
    test("attempt 1 ignores the remaining budget entirely", () => {
      // The safety invariant: nothing — no config, no elapsed time — can shorten the
      // attempt that used to be the whole check.
      expect(emailAttemptTimeoutMs(1, 200_000)).toBe(60_000);
      expect(emailAttemptTimeoutMs(1, 1_000)).toBe(60_000);
      expect(emailAttemptTimeoutMs(1, 0)).toBe(60_000);
    });

    test("a RETRY is clamped to what is left", () => {
      // The live shape at the old 120s net: 110s budget − a 60s attempt 1 = 50s.
      expect(emailAttemptTimeoutMs(2, 50_000)).toBe(50_000);
      expect(emailAttemptTimeoutMs(2, 45_000)).toBe(45_000);
    });

    test("a retry never EXCEEDS the per-attempt timeout when budget is ample", () => {
      expect(emailAttemptTimeoutMs(2, 110_000)).toBe(60_000);
    });
  });

  describe("start-attempt guard (pure)", () => {
    test("attempt 1 always starts", () => {
      expect(shouldStartEmailAttempt(1, 0)).toBe(true);
      expect(shouldStartEmailAttempt(1, -5_000)).toBe(true);
    });

    test("a retry needs EMAIL_MIN_ATTEMPT_MS left", () => {
      expect(shouldStartEmailAttempt(2, 45_000)).toBe(true);
      expect(shouldStartEmailAttempt(2, 44_999)).toBe(false);
      // Laptop sleep is the reachable case: a 60s timer that fired ~17 min late
      // leaves the deadline far in the past.
      expect(shouldStartEmailAttempt(2, -900_000)).toBe(false);
    });
  });

  test("the net holds EMAIL_MAX_ATTEMPTS attempts at FULL length", async () => {
    // The cross-module invariant: email's floor in timeout.ts exists solely to satisfy
    // constants that live in email.ts, and a real import would close a cycle — so the
    // two can only be bound together HERE. Without this, raising
    // EMAIL_ATTEMPT_TIMEOUT_MS (or HAIKU_TIMEOUT_MS, which it aliases) to 100s is a
    // one-line change that silently overruns the net: withWatcherTimeout rejects, the
    // runner re-saves the OLD lastNotifiedIds, and the batch is lost. That is the same
    // 3ms-overrun defect the clamp was written to prevent, re-entering through a
    // different constant.
    //
    // NB this deliberately does NOT test the clamp — at a 170s budget the clamp is
    // unreachable (Math.min(60s, 110s) is inert), so a version of this test that
    // claimed to cover it was vacuous. The clamp is pinned by the pure decider tests
    // above; those are not redundant with this one and must not be deleted as such.
    const { computeWatcherTimeoutMs } = await import("./timeout.ts");
    // Recover the per-attempt timeout through the public API rather than re-stating
    // the constant, so this tracks a change to it instead of masking one.
    const attemptMs = emailAttemptTimeoutMs(1, Number.MAX_SAFE_INTEGER);
    for (const config of [{}, { timeoutMs: 1 }, { timeoutMs: 150_000 }]) {
      const watcher = baseWatcher({ config });
      // Every attempt affordable at full length — no attempt should need clamping.
      expect(emailRetryBudgetMs(watcher)).toBeGreaterThanOrEqual(EMAIL_MAX_ATTEMPTS * attemptMs);
      // …and the whole worst case still inside the net the runner actually enforces.
      expect(EMAIL_MAX_ATTEMPTS * attemptMs).toBeLessThanOrEqual(computeWatcherTimeoutMs(watcher));
    }
  });

  test("email's net floor holds two FULL attempts — no row edit required", async () => {
    // The reason the floor is email-specific. At the generic 120s floor the retry was
    // clamped to ~50s against a 56.5s slowest-healthy tick, so the top decile of good
    // runs could not be rescued without a hand-edited DB row.
    const { computeWatcherTimeoutMs } = await import("./timeout.ts");
    expect(computeWatcherTimeoutMs(baseWatcher())).toBe(180_000);
    const budget = emailRetryBudgetMs(baseWatcher());
    expect(emailAttemptTimeoutMs(2, budget - 60_000)).toBe(60_000);
  });

  test("a run that REACHED Gmail is never retried, however empty the inbox", async () => {
    // The modal correct output. Retrying a quiet inbox would double the cost of every
    // healthy tick — the exact opposite of what this is for.
    spawnScript = [{ toolCalls: GMAIL_CALL, result: "[]" }];
    expect((await checkEmail(baseWatcher(), gmailBotDir, "jarvis")).alerts).toEqual([]);
    expect(spawnOpts).toHaveLength(1);
  });

  test("an UNJUDGEABLE run is not retried — no evidence of failure", async () => {
    // Legacy-JSON parser fallback: no tool list, so the predicate stands down. A retry
    // here would burn a second spawn on a CLI bug unrelated to Gmail.
    spawnScript = [{ toolCalls: undefined, result: "[]" }];
    expect((await checkEmail(baseWatcher(), gmailBotDir, "jarvis")).alerts).toEqual([]);
    expect(spawnOpts).toHaveLength(1);
  });

  test("unparseable JSON from a run that reached Gmail is not retried either", async () => {
    // Different failure: the answer is real, only its formatting is wrong.
    spawnScript = [{ toolCalls: GMAIL_CALL, result: "I looked and found nothing!" }];
    expect((await checkEmail(baseWatcher(), gmailBotDir, "jarvis")).alerts).toEqual([]);
    expect(spawnOpts).toHaveLength(1);
  });

  test("budget floors at 170s, so the retry is never config-starved", () => {
    // Email's net has its own 180s FLOOR, so no row value can push the budget below
    // one full attempt + a full retry. This pins why the start guard is a wall-clock
    // guard (laptop sleep) and not a misconfiguration check.
    expect(emailRetryBudgetMs(baseWatcher())).toBe(170_000);
    expect(emailRetryBudgetMs(baseWatcher({ config: { timeoutMs: 1 } }))).toBe(170_000);
    expect(emailRetryBudgetMs(baseWatcher({ config: { timeoutMs: 0 } }))).toBe(170_000);
    // A configured value only ever RAISES it.
    expect(emailRetryBudgetMs(baseWatcher({ config: { timeoutMs: 300_000 } }))).toBe(320_000);
  });
});

// ── buildEmailPrompt ─────────────────────────────────────────────────
//
// Extracted from `checkEmail` so the deferral probe can send the REAL prompt
// instead of a copy that had already drifted (it omitted the interest-profile
// block). The extraction's whole justification is byte-identical output, and
// nothing pinned it — a future edit would change every production email check
// and the probe's fidelity claim together, silently.

describe("buildEmailPrompt", () => {
  const QUERY = "is:unread after:2026/08/14";

  test("carries the query, the criteria and the format contract, in that order", () => {
    const out = buildEmailPrompt(QUERY, DEFAULT_EMAIL_PROMPT, null);
    // `toContain` FIRST: `indexOf` returns -1 for an absent needle, and -1 is less
    // than everything — so the ordering assertions alone passed with the query
    // dropped from the prompt entirely (mutation-verified).
    expect(out).toContain(QUERY);
    expect(out.indexOf(QUERY)).toBeLessThan(out.indexOf("Worth notifying:"));
    expect(out.indexOf("Worth notifying:")).toBeLessThan(out.indexOf("CRITICAL:"));
    expect(out.indexOf("CRITICAL:")).toBeLessThan(out.indexOf("Return ONLY a JSON array"));
  });

  test("the SCAFFOLDING is exactly this, criteria aside", () => {
    // A golden string, because the other assertions here are structural and survive an
    // edit to the prompt text. It pins the SCAFFOLDING only — the criteria are a
    // parameter, so `DEFAULT_EMAIL_PROMPT`'s own body is not pinned by it. The
    // end-to-end claim (what `checkEmail` actually sends) is covered by "no profile row
    // ⇒ prompt is byte-identical to the un-wrapped gate prompt" above, which drives the
    // real checker; this is the cheap unit-level guard beside it.
    expect(buildEmailPrompt(QUERY, "CRITERIA-HERE", null)).toBe(
      `You have access to Gmail MCP tools.\nSearch for unread emails matching: "${QUERY}"\n\nCRITERIA-HERE\n\nCRITICAL:\n- "id" MUST be the exact Gmail message ID from the API (e.g. "19abc123def"). Copy it verbatim.\n- "sender" MUST be the exact From header value (e.g. "Posten Norge")\n- "subject" MUST be the exact email subject line, verbatim — do NOT rephrase or shorten it.\n\nReturn ONLY a JSON array (no markdown fences):\n[{"id":"msg_id","source":"email","sender":"exact sender","subject":"exact subject","summary":"**Fra:** sender — subject brief","urgency":"high|medium|low"}]\nIf nothing worth notifying, return: []`,
    );
  });

  test("a watcher's own criteria replace the default outright", () => {
    const out = buildEmailPrompt(QUERY, "Only mail from my accountant.", null);
    expect(out).toContain("Only mail from my accountant.");
    expect(out).not.toContain("Worth notifying:");
  });

  test("a blank profile is the same as no profile", () => {
    // `withInterestProfile` returns its input verbatim for null/blank. This pins that
    // behaviour only; the byte-identity claim is the end-to-end `checkEmail` test.
    const base = buildEmailPrompt(QUERY, DEFAULT_EMAIL_PROMPT, null);
    expect(buildEmailPrompt(QUERY, DEFAULT_EMAIL_PROMPT, "")).toBe(base);
    expect(buildEmailPrompt(QUERY, DEFAULT_EMAIL_PROMPT, "   ")).toBe(base);
  });

  test("the profile block lands LAST, after the format contract", () => {
    // Load-bearing: `withInterestProfile`'s trailer says "the output-format
    // instructions above still apply", which is only true if the format block is
    // above it. This is why the FULL assembled prompt is wrapped, not the criteria.
    const out = buildEmailPrompt(QUERY, DEFAULT_EMAIL_PROMPT, "Cares about Rust and boats.");
    expect(out).toContain("Cares about Rust and boats.");
    expect(out.indexOf("Return ONLY a JSON array")).toBeLessThan(out.indexOf("Cares about Rust and boats."));
    expect(out.startsWith(buildEmailPrompt(QUERY, DEFAULT_EMAIL_PROMPT, null))).toBe(true);
  });
});
