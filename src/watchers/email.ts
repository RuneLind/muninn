import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku, HAIKU_TIMEOUT_MS, type HaikuTelemetry } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { loadRawMcpServers } from "../ai/mcp-config-utils.ts";
import { loadInterestProfile } from "../profile/generator.ts";
import { withInterestProfile } from "../profile/inject.ts";
import { computeWatcherTimeoutMs, TICK_TIMEOUT_MS } from "./timeout.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "email");

/**
 * What a completed check reports: its alerts, and the window it actually covered.
 *
 * Named for WATCHERS, not email: `runChecker` returns this for all eight types.
 * Only the email checker ever sets `coveredFrom`, but an email-specific name here
 * is what made a false "email never reaches this" comment read plausibly during
 * the refactor that deleted email's dispatch entirely.
 *
 * The RUNNER — not this module — writes the watermark, and only AFTER the alerts
 * have been delivered. Writing it here (an earlier cut did) re-opened the very
 * hole this PR closes, one door along: a Telegram 502 between the write and the
 * send left the watermark advanced over alerts that were never delivered AND
 * never recorded in `lastNotifiedIds`, so the next tick's narrower window
 * stepped straight over them. Unread mail is re-offered by nothing else.
 */
export interface WatcherCheckResult {
  alerts: WatcherAlert[];
  /**
   * The instant this run's window is covered UP TO — set only for a run that
   * reached Gmail AND returned a parseable answer; `null` otherwise.
   *
   * A RETURN value, not an out-parameter. As an optional out-param it could be
   * dropped at either call hop with `tsc` clean and every test green, leaving
   * `last_success_at` NULL forever and the whole feature inert — this repo's
   * named recurring defect. Threading it through the return type makes that
   * edit a compile error instead.
   */
  coveredFrom: Date | null;
}

/**
 * Per-attempt model timeout — `spawnHaiku`'s own default, named here because the
 * retry budget below is derived against it and the two must not drift.
 */
const EMAIL_ATTEMPT_TIMEOUT_MS = HAIKU_TIMEOUT_MS;
/**
 * Attempts per check.
 *
 * ⚠️ **This is a COST decision, not an arithmetic limit — do not "fix" it by
 * re-deriving the budget.** A third attempt now *would* fit (170s budget: 60 + 60
 * leaves 50s, which clears `EMAIL_MIN_ATTEMPT_MS`); an earlier revision of this
 * comment claimed it did not, which was true only under the old 120s floor. The cap
 * is 2 because the returns collapse: at the measured ~12.5% per-spawn failure rate,
 * one retry takes a tick to ~1.6% and a second would take it to ~0.2% — buying that
 * 1.4 points costs a third 60s spawn and another ~110k input tokens on an HOURLY
 * background job that nothing waits on. Raise it only against a measured failure
 * rate, and re-check the net still holds N attempts (`email.test.ts` asserts it).
 */
export const EMAIL_MAX_ATTEMPTS = 2;
/**
 * Headroom left under the runner's net. Small (vs `checkX`'s 60s) because the
 * work AFTER the last spawn returns is one `extractJson` call — there is no
 * second concurrent leg to land, so the margin only has to cover the gap between
 * `runChecker`'s clock and this function's, plus scheduler jitter.
 */
const EMAIL_BUDGET_SAFETY_MARGIN_MS = 10_000;
/**
 * Don't start a retry with less than this left. Calibrated from the live row's
 * SUCCESSFUL ticks over 2026-08-12/13: min 21.1s, median ~44s, max 56.5s. Under
 * ~45s a retry mostly buys a second failure at the cost of a real spawn — but the
 * band between this and the 60s attempt timeout is deliberately kept, because a
 * clamped 50s retry still covers everything up to the median and most of the tail.
 */
const EMAIL_MIN_ATTEMPT_MS = 45_000;

// Gmail's `after:` filter is date-only — compute the date in Oslo (where the
// user lives) so a run just after UTC-midnight doesn't query the wrong day.
const OSLO_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const DEFAULT_EMAIL_PROMPT = `For each new unread email, evaluate if it's worth notifying the user.

Worth notifying:
- From real people (not automated marketing/newsletters)
- Urgent or time-sensitive
- Action items or requests
- Security alerts, expiring tokens, important notifications

Not worth notifying:
- Marketing, newsletters, promotional offers
- Social-network noise (LinkedIn connection suggestions, follow recommendations, digests)`;


/**
 * The full prompt one email check sends, assembled from the pieces a run varies:
 * the Gmail query, the watcher row's criteria, and the owner's interest profile.
 *
 * Extracted from `checkEmail` (byte-identical output) so the deferral probe in
 * `scripts/probe-toolsearch-deferral.ts` can send the REAL prompt instead of a
 * copy. The copy had already drifted: it omitted the interest-profile block,
 * which the live jarvis owner HAS — so the probe's "byte-identical argv" claim
 * was false about the one argument that carries the most bytes, in a study whose
 * whole subject is model behaviour.
 *
 * Email's criteria sit mid-prompt (the CRITICAL + "Return ONLY a JSON array"
 * format contract comes AFTER the user criteria), so the FULL assembled prompt is
 * wrapped — the interest-profile block lands last, after the format contract, and
 * `withInterestProfile`'s "the output-format instructions above still apply"
 * trailer then correctly refers to the format block above it. With no profile the
 * wrapper returns the base string verbatim.
 */
export function buildEmailPrompt(
  query: string,
  userPrompt: string,
  interestProfile: string | null,
): string {
  const basePrompt = `You have access to Gmail MCP tools.
Search for unread emails matching: "${query}"

${userPrompt}

CRITICAL:
- "id" MUST be the exact Gmail message ID from the API (e.g. "19abc123def"). Copy it verbatim.
- "sender" MUST be the exact From header value (e.g. "Posten Norge")
- "subject" MUST be the exact email subject line, verbatim — do NOT rephrase or shorten it.

Return ONLY a JSON array (no markdown fences):
[{"id":"msg_id","source":"email","sender":"exact sender","subject":"exact subject","summary":"**Fra:** sender — subject brief","urgency":"high|medium|low"}]
If nothing worth notifying, return: []`;
  return withInterestProfile(basePrompt, interestProfile);
}

/**
 * `botDir` is the bot folder whose `.mcp.json` declares the Gmail server. It used
 * to be the spawn's cwd (MCP by auto-discovery); it is now handed to the CLI as
 * `--mcp-config` so the run itself happens outside the repo. This is the ONLY
 * spawnHaiku caller that still needs bot MCP — every other one is a tool-less
 * prompt and runs `--strict-mcp-config`.
 */
export async function checkEmail(
  watcher: Watcher,
  botDir?: string,
  botName?: string,
  telemetry?: HaikuTelemetry,
): Promise<WatcherCheckResult> {
  // Anchored at ENTRY, not at the first spawn: the runner's net starts here too, and
  // the profile load below is a DB read that must come out of the same budget.
  const startedAt = Date.now();
  const config = watcher.config as { filter?: string; prompt?: string; model?: string };
  // Bounded on the SUCCESS watermark. A row that has never succeeded (every row
  // for one tick after migration 069) has no window to trust, so it takes the
  // old date-only query — broad, and broad is the safe direction for a cold
  // start: the failure mode of guessing narrow is mail that is never looked at.
  const query = watcher.lastSuccessAt
    ? buildGmailQuery(config.filter, watcher.lastSuccessAt, startedAt)
    : buildGmailQueryByDate(config.filter, watcher.lastRunAt);
  // A defensive skip that persists across runs needs a counter, a bound AND a
  // surface (`src/watchers/CLAUDE.md`); the clamp has a bound, and this is the
  // surface. Logged at the CALLER so the query builder stays pure. Gated on a
  // meaningful span so a watermark a few seconds past the ceiling does not print
  // "skipping 0.0h … search Gmail manually".
  const clamp = watcher.lastSuccessAt ? emailClampWarning(watcher.lastSuccessAt, startedAt) : null;
  if (clamp) {
    log.warn(
      "email-check lookback clamped to {maxHours}h — skipping {skippedHours}h of unread mail that no run " +
        "will now evaluate (last successful check was {staleHours}h ago). Search Gmail manually for that window.",
      {
        botName,
        maxHours: EMAIL_MAX_LOOKBACK_MS / 3_600_000,
        skippedHours: +(clamp.skippedMs / 3_600_000).toFixed(1),
        staleHours: +(clamp.staleMs / 3_600_000).toFixed(1),
      },
    );
  }

  const userPrompt = config.prompt || DEFAULT_EMAIL_PROMPT;
  const interestProfile = await loadInterestProfile(watcher.userId, botName ?? watcher.botName);

  const prompt = buildEmailPrompt(query, userPrompt, interestProfile);

  // Bounded retry (2026-08-13). The liveness predicate below turned a silent wrong
  // answer into a loud failure; it did not make the check succeed. Root cause, from
  // 96 probe runs on byte-identical argv (the harness in PR #435,
  // `scripts/probe-toolsearch-deferral.ts` — parked as a tool, may not be on main):
  // the Gmail tools are presented to the spawn as DEFERRED, so 95 of 96 runs had to
  // resolve `mcp__gmail__search_emails` through a ToolSearch round-trip first, and
  // when that resolution fails the tool never becomes callable — the model then
  // loops on ToolSearch, or fakes the call through Bash, and answers `[]`. 7 of 56
  // production-shape runs (12.5%) never reached Gmail at all. Deferral tracks the
  // CLI's built-in tool surface in the agent home, so muninn cannot switch it off;
  // ruled out by measurement and not worth re-litigating: the CLI version (.228 4/8
  // vs .231 3/8), #431's argv shape (12/16 vs 11/16), `--allowed-tools` (5/12 vs
  // 4/12) and a gmail-only `--mcp-config` (5/12 vs 7/12).
  //
  // Failures are therefore INDEPENDENT per spawn, which is exactly the failure class
  // a retry remedies: ~12.5% ⇒ ~1.6% with one retry. Retried on BOTH observed shapes
  // — the predicate failure AND a `spawnHaiku` throw — because they are one mechanism
  // (a run that loops on ToolSearch long enough simply hits the 60s timeout instead
  // of answering `[]`; the 08-13 17:04 transcript shows `search_emails` called at the
  // 10s mark and then stalling 49s), and because some 60s "timeouts" are legitimately
  // slow healthy runs: the slowest SUCCESSFUL tick measured 56.5s.
  const budgetMs = emailRetryBudgetMs(watcher);
  const deadline = startedAt + budgetMs;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= EMAIL_MAX_ATTEMPTS; attempt++) {
    // ONE clock read per iteration — the guard below and the logged `remainingMs`
    // must describe the same instant, or the log cannot reproduce the decision.
    const remainingMs = deadline - Date.now();
    if (!shouldStartEmailAttempt(attempt, remainingMs)) {
      log.warn(
        "email-check budget-exhausted: attempt={attempt}/{max} remainingMs={remainingMs} budgetMs={budgetMs} — not retrying",
        // `attempt` counts attempts actually MADE, matching the sibling
        // `x-capture-gate` line's documented convention — a budget-exhausted line
        // before attempt 2 reports 1. One parser must be able to mine both prefixes.
        { botName, attempt: attempt - 1, max: EMAIL_MAX_ATTEMPTS, remainingMs, budgetMs },
      );
      break;
    }
    const attemptTimeoutMs = emailAttemptTimeoutMs(attempt, remainingMs);
    const attemptStart = Date.now();

    try {
      const { result, toolCalls } = await spawnHaiku(prompt, {
        source: "watcher-email",
        entrypoint: "jarvis-watcher",
        botDir,
        botName,
        model: config.model,
        timeoutMs: attemptTimeoutMs,
        ...telemetry,
      });

      const { failure, reached } = gmailLiveness(toolCalls, botDir);
      if (failure) {
        lastError = new Error(failure);
        log.warn(
          "email-check failed: attempt={attempt}/{max} durationMs={durationMs} attemptTimeoutMs={attemptTimeoutMs} reason={reason}",
          { botName, attempt, max: EMAIL_MAX_ATTEMPTS, durationMs: Date.now() - attemptStart, attemptTimeoutMs, reason: failure },
        );
        continue;
      }

      // One grep-stable outcome line per check, so "how often does the retry rescue a
      // tick?" is countable (`email-check ok: attempt=2`) rather than inferred. Logged
      // only AFTER the parse succeeds: a run that reached Gmail on attempt 2 and then
      // returned unparseable text delivers nothing, and counting it as a rescue would
      // inflate the exact metric this PR asks to be watched. Unparseable is its own
      // outcome word, so the two stay separable when mining.
      const durationMs = Date.now() - attemptStart;
      let alerts: WatcherAlert[];
      try {
        alerts = extractJson<WatcherAlert[]>(result);
      } catch {
        // NOT retried: this run DID reach Gmail, so the answer is real and only its
        // formatting is wrong — a different failure from the one the retry exists for.
        log.warn(
          "email-check unparseable: attempt={attempt}/{max} durationMs={durationMs} attemptTimeoutMs={attemptTimeoutMs} raw={raw}",
          { botName, attempt, max: EMAIL_MAX_ATTEMPTS, durationMs, attemptTimeoutMs, raw: result.slice(0, 300) },
        );
        return { alerts: [], coveredFrom: null };
      }
      log.info(
        "email-check ok: attempt={attempt}/{max} durationMs={durationMs} attemptTimeoutMs={attemptTimeoutMs} alerts={alerts}",
        { botName, attempt, max: EMAIL_MAX_ATTEMPTS, durationMs, attemptTimeoutMs, alerts: alerts.length },
      );
      // The ONLY place coverage is claimed, and only for a run that BOTH
      // demonstrably reached Gmail and produced a parseable answer. Every other
      // exit — unparseable, predicate failure, unjudgeable run, throw, budget
      // exhaustion — leaves it unset, so the next tick re-offers this window
      // instead of stepping over mail nothing ever looked at.
      //
      // Anchored on `startedAt` (function ENTRY), not `now()`: entry predates
      // the spawn, and therefore the model's own `search_emails` call, by the
      // 21–56s the check takes. Anchoring at the end would silently drop every
      // message that arrived while the check ran.
      return { alerts, coveredFrom: reached ? new Date(startedAt) : null };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(
        "email-check failed: attempt={attempt}/{max} durationMs={durationMs} attemptTimeoutMs={attemptTimeoutMs} error={error}",
        { botName, attempt, max: EMAIL_MAX_ATTEMPTS, durationMs: Date.now() - attemptStart, attemptTimeoutMs, error: lastError.message },
      );
    }
  }

  // Every attempt failed. Rethrowing the LAST error keeps the runner's existing
  // contract (log.error + an errored `watcher:email` child span, `last_run_at`
  // still advanced) — the retry changes how often we get here, never what happens.
  throw lastError ?? new Error("Email check made no attempt");
}

/**
 * Wall-clock the check may spend across ALL attempts, anchored at `checkEmail`
 * entry (effectively the runner's clock — the only work before it is the prompt
 * assembly and one interest-profile DB read).
 *
 * `min(net, tick)` mirrors `checkX`'s capture budget and for the same reason: the
 * per-watcher net can exceed the scheduler tick, and whichever fires first is the
 * real ceiling. Overrunning it is not a soft loss — `withWatcherTimeout` rejects,
 * the runner's catch re-saves the OLD `lastNotifiedIds`, and the whole batch is
 * re-evaluated next run.
 *
 * On the live row (no `config.timeoutMs`) email's own 180s net floor yields **170s**,
 * so BOTH attempts get their full 60s and neither is clamped. Setting
 * `config.timeoutMs` on the row is NOT needed and NOT recommended: anything at or
 * below 150 000 is a no-op (it resolves to the same 180s net), and the field means
 * something different here than on x/anthropic — `checkEmail` has never passed it to
 * `spawnHaiku`, so on an email row it widens the runner's net only. The floor lives
 * in `timeout.ts` precisely so no row edit is required; see it for why.
 *
 * The 180s floor means this can never return less than 170s, whatever the row
 * says — so the `EMAIL_MIN_ATTEMPT_MS` guard is NOT a misconfiguration check (an
 * earlier cut warned about that and the warn was unreachable). It guards WALL CLOCK:
 * a `setTimeout(60s)` can fire far later than 60s after arming, because macOS
 * suspends the process on laptop sleep and fires every overdue timer on wake. That
 * is observed here, not hypothetical — 2026-08-13 16:03 — and it is the one way
 * attempt 1 can eat the whole budget.
 */
export function emailRetryBudgetMs(watcher: Watcher): number {
  return Math.min(computeWatcherTimeoutMs(watcher), TICK_TIMEOUT_MS) - EMAIL_BUDGET_SAFETY_MARGIN_MS;
}

/**
 * Timeout for one attempt. Attempt 1 always gets the FULL budget — the invariant
 * that keeps this change safe to reason about — and only a retry is clamped to what
 * is left.
 *
 * Pure and separately tested because both halves are mutation-survivable inside the
 * loop: every retry test returns from attempt 1 instantly, so no integration test
 * can distinguish a clamped retry from an unclamped one, and the review that caught
 * this deleted the clamp outright with all 29 tests still green. The clamp is
 * load-bearing (at the old 120s net its absence overran the runner by 3ms and cost
 * the whole batch's `lastNotifiedIds`), so it needs an assertion that fails when it
 * is removed, not an assertion that merely passes while it is present.
 */
export function emailAttemptTimeoutMs(attempt: number, remainingMs: number): number {
  if (attempt === 1) return EMAIL_ATTEMPT_TIMEOUT_MS;
  return Math.min(EMAIL_ATTEMPT_TIMEOUT_MS, remainingMs);
}

/**
 * Whether to START this attempt. Attempt 1 is unconditional; a retry needs
 * {@link EMAIL_MIN_ATTEMPT_MS} left.
 *
 * With email's own 180s net floor a full 60s attempt 1 leaves ~110s, so on a healthy
 * box this never blocks. It exists for WALL CLOCK: a 60s timer can fire ~17 minutes
 * after arming when macOS suspends the process on laptop sleep and replays every
 * overdue timer on wake (observed 2026-08-13 16:03). That is the one way attempt 1
 * eats the budget, and it is why this is not a misconfiguration check.
 */
export function shouldStartEmailAttempt(attempt: number, remainingMs: number): boolean {
  return attempt === 1 || remainingMs >= EMAIL_MIN_ATTEMPT_MS;
}

/**
 * The liveness predicate, as a message describing HOW the run failed — or `null`
 * when the run is trustworthy (reached Gmail) or unjudgeable (see below).
 *
 * "No important email today" is this checker's modal CORRECT output, which is
 * exactly what makes a broken run invisible: every failure mode here — denied Gmail
 * permissions, no MCP server, a model that never invokes the tool — arrives as `[]`
 * and reads as a quiet inbox. The distinguishing signal is whether Gmail was reached
 * at all: there is no path to a truthful answer that skips `search_emails`, so zero
 * Gmail tool calls means the check never happened.
 *
 * Measured 2026-08-13 on the live row: of 7 organic ticks, 3 (08:56, 11:59, 13:00)
 * returned `[]` having never called a Gmail tool — the model looped on ToolSearch
 * (11 times on the 11:59 tick, 445k input tokens) or simulated the call through
 * Bash, then answered `[]`. Two were fully silent; the third tripped the JSON parse
 * warning. All three advanced last_run_at.
 *
 * `toolCalls` is UNDEFINED only when the stream parser never saw the run and
 * `parseLegacyHaikuOutput` took over — no tool list exists, so we genuinely cannot
 * tell, and the check stays inert (that path warns on its own). A run the parser
 * DID see always yields a definite list, INCLUDING the empty one: `spawnHaiku`
 * normalizes StreamParser's zero-tools `undefined` to `[]` precisely so the most
 * dangerous case — Gmail MCP down or its permission denied, model answers `[]` in
 * one turn having called nothing — is caught here instead of being mistaken for a
 * parser degradation. Before that normalization this branch could not see it.
 *
 * The config is read only when there IS something to judge — an `undefined`
 * toolCalls run can't fail the check, so reading it (and possibly warning about it)
 * would be noise.
 *
 * NB: an unjudgeable run returns `null` = "trustworthy", so it is NOT retried. That
 * is deliberate and unchanged by the retry loop: we have no evidence the run failed,
 * and burning a second spawn on every legacy-parser degradation would double the
 * cost of a CLI bug that has nothing to do with Gmail.
 *
 * ---
 *
 * Read TWO ways, because the retry and the query watermark ask different
 * questions of the same evidence.
 *
 * `failure` is the predicate above, unchanged, and drives the retry. `reached`
 * is STRICTER: did this run *demonstrably* touch Gmail? They differ exactly on
 * the unjudgeable cases — `toolCalls` undefined, and "no MCP server key looks
 * like Gmail" — where `failure` is `null` ("no evidence it broke, so don't fail
 * it") but `reached` is `false` ("no evidence it worked either").
 *
 * Collapsing the two is a data-loss bug, not a style choice. A bot whose
 * `.mcp.json` names the server `google-mail` has the predicate DISABLED by
 * design (see {@link gmailToolPrefixes}); if that state also claimed coverage,
 * the row would march its watermark forward an hour per tick while never
 * reading a single message, and because the mail stays unread nothing would ever
 * re-offer it. Under the date-only query this cost nothing — every tick re-swept
 * the day — which is why the distinction only becomes load-bearing now.
 */
export function gmailLiveness(
  toolCalls: { name: string }[] | undefined,
  botDir: string | undefined,
): { failure: string | null; reached: boolean } {
  const prefixes = toolCalls ? gmailToolPrefixes(botDir) : null;
  const reachedGmail = toolCalls?.some(
    (t) => typeof t.name === "string" && prefixes?.some((p) => t.name.startsWith(p)),
  );
  return { failure: livenessFailureMessage(toolCalls, prefixes, reachedGmail), reached: reachedGmail === true };
}

function livenessFailureMessage(
  toolCalls: { name: string }[] | undefined,
  prefixes: string[] | null,
  reachedGmail: boolean | undefined,
): string | null {
  // `prefixes === null` means we could not identify which server IS Gmail — same
  // "can't tell" stance as an undefined toolCalls, and for the same reason: the
  // alternative is failing closed on no evidence. A bot that renamed the key to
  // something without "gmail" in it (google-mail, workspace-mail) has a WORKING
  // Gmail server that we simply cannot name, and hard-failing every healthy tick
  // there would be the very trap this derivation was written to remove.
  if (!toolCalls || !prefixes || reachedGmail) return null;
  const called = [...new Set(toolCalls.map((t) => String(t.name)))].join(", ") || "none";
  return (
    `Email check made no Gmail tool call (${toolCalls.length} tool call(s): ${called}) — ` +
    `the empty result is not a quiet inbox`
  );
}

/**
 * MCP tool-name prefixes that count as "reached Gmail", derived from the bot's OWN
 * `.mcp.json` — or `null` when we cannot tell which server is Gmail, in which case
 * the caller must NOT judge the run.
 *
 * A tool is named `mcp__<serverKey>__<tool>`, and serverKey is whatever the bot's
 * config calls the server — "gmail" on every bot that has one today, but bot folders
 * other than jarvis are gitignored and synced from a separate repo. Hardcoding the
 * prefix means a rename there turns every HEALTHY run into an hourly hard failure,
 * with no code change to point at and nothing that would catch it in review.
 *
 * Matching is the server KEY containing "gmail" (case-insensitive): `gmail`,
 * `gmail-mcp` and `Gmail` all resolve. Two known trades, both deliberate:
 *
 *  - **ANY match passes.** `{gmail, gmail-backup}` yields two prefixes and a call to
 *    either counts. Both servers are genuinely on the spawn's tool surface, so a call
 *    to either is evidence the model reached mail.
 *  - **The substring can over-match** (`gmail-old` left beside a live server by a
 *    sloppy sync). A call to the stale server would then read as success. That is a
 *    narrow false-PASS, versus the false-FAIL of the hardcode it replaces, which
 *    broke on every rename; the false-fail was the live-fire risk.
 *
 * When no key matches we return `null` rather than guessing, because the failure is
 * asymmetric: a bot that renamed the key to `google-mail` has a WORKING server we
 * merely cannot name, and throwing on every healthy tick there is the exact trap this
 * derivation exists to remove. Warns once per botDir so the misconfiguration is
 * legible in the log instead of inferred from a thrown message.
 *
 * NB: this reads the SAME `botDir` that `spawnHaiku` hands to `buildInlineMcpConfig`
 * / `buildInlineSettings` (`runner.ts` passes `botConfig.dir` to both). A refactor
 * that lets those two diverge desyncs the predicate from the argv it is judging.
 */
export function gmailToolPrefixes(botDir?: string): string[] | null {
  if (!botDir) return null;
  const servers = loadRawMcpServers(botDir);
  if (!servers) return null;
  const keys = Object.keys(servers).filter((k) => k.toLowerCase().includes("gmail"));
  if (keys.length === 0) {
    warnNoGmailServerOnce(botDir, Object.keys(servers));
    return null;
  }
  return keys.map((k) => `mcp__${k}__`);
}

const warnedNoGmailServer = new Set<string>();
function warnNoGmailServerOnce(botDir: string, present: string[]): void {
  if (warnedNoGmailServer.has(botDir)) return;
  warnedNoGmailServer.add(botDir);
  log.warn(
    "No gmail-like MCP server key in {botDir} (servers: {present}) — the email " +
      "checker cannot tell which server is Gmail, so its liveness predicate is " +
      "DISABLED for this bot and an empty result is trusted as a quiet inbox again. " +
      "Rename the server key to contain \"gmail\", or disable the watcher.",
    { botDir, present: present.join(", ") || "none" },
  );
}

/**
 * Overlap subtracted from the watermark, so the boundary is re-offered rather
 * than straddled. Covers the gap between `checkStartedAt` and the moment the
 * model actually calls `search_emails` (measured 5–12s of prompt + startup),
 * plus Gmail's internal-date vs delivery-time skew. Re-offering is free: an
 * already-notified message is dropped by `lastNotifiedIds` dedup, whereas a
 * message that falls in the gap is dropped SILENTLY and forever.
 */
export const EMAIL_QUERY_OVERLAP_MS = 5 * 60_000;
/**
 * Ceiling on the lookback, whatever the watermark says. A row disabled for a
 * week (or whose success watermark is otherwise stale) would otherwise ask for
 * a week of mail on its first tick back — the exact overload this window exists
 * to prevent, arriving by a different door. 24h also bounds the worst case
 * BELOW today's behaviour: the date-only `after:` this replaces expands to a
 * full week in the same scenario, because it is derived from `lastRunAt`.
 */
export const EMAIL_MAX_LOOKBACK_MS = 24 * 3_600_000;
/**
 * Don't shout about a trivial clamp. A watermark a few seconds past the ceiling
 * skips essentially nothing, and the warn's copy tells the operator to go search
 * Gmail by hand — advice worth giving for hours of mail, not for seconds of it.
 */
export const EMAIL_CLAMP_WARN_MIN_MS = 15 * 60_000;

/**
 * The Gmail query for one check.
 *
 * `sinceMs` is the run's SUCCESS watermark (`watcher.lastSuccessAt`), not
 * `lastRunAt`. Passing `lastRunAt` here would be a silent data-loss bug: it
 * advances on quiet-hours skips and on failures, so the overnight pile and every
 * failed tick's window would be excluded from the next query having never been
 * looked at. `null` (no success yet) falls back to the previous date-only form,
 * which is broad and therefore safe as a cold start.
 *
 * Why epoch seconds rather than the date-only `after:YYYY/MM/DD` this replaces:
 * a date-granular filter makes every hourly tick re-evaluate the WHOLE day's
 * unread pile, so the work per tick grows monotonically until it exceeds the
 * per-attempt budget. Measured on the live mailbox 2026-08-14 18:50 —
 * `is:unread after:2026/08/14` returned 38 threads, `is:unread after:<epoch 1h
 * ago>` returned 6. Over 48h of ticks, output tokens explained 91% of tick
 * duration (R²=0.914, ~8.9ms/token) while turn count explained none (R²=0.000),
 * and duration tracked hour-of-day at r=0.776 — mean 21s at 08:00 against 56s at
 * 21:00, with every 60s timeout falling in the back half of the day. The set
 * size is the cost driver, and this is what bounds it.
 *
 * Gmail accepts a Unix-seconds argument to `after:` (verified against the live
 * API, above); it is not in the operator help, which documents only the date
 * form.
 */
/**
 * How much genuinely-unevaluated mail the 24h ceiling is about to discard — `0`
 * when nothing is lost.
 *
 * NOT the same quantity as the clamp `buildGmailQuery` applies, and deliberately
 * so: the query floor is `now − 24h` against a WANTED floor of
 * `watermark − overlap`, but the overlap window was already read by the previous
 * successful check. Counting it here would overstate every warning by 5 minutes
 * and, worse, make the function report a non-zero "loss" for a watermark barely
 * past the ceiling where nothing new is dropped at all. Mail is only unevaluated
 * if it arrived after the last successful check and before the query floor —
 * hence `(now − 24h) − watermark`.
 *
 * A separate PURE function, not an `if` inside `buildGmailQuery`, for two
 * reasons the review made concrete. It keeps `buildGmailQuery` free of side
 * effects (it is called from `scripts/probe-toolsearch-deferral.ts`, which would
 * otherwise emit an operator-directed warning about a query it never sends); and
 * it puts the comparison somewhere a test can assert on. Inside the query
 * builder the guard was fully mutation-survivable — flipping `floor > wanted` to
 * `wanted > floor` left the whole suite green while warning on every HEALTHY run
 * and staying silent on every genuinely clamped one, destroying the only surface
 * the skip has.
 */
export function emailLookbackClampMs(sinceMs: number, nowMs: number): number {
  // Mirrors `buildGmailQuery`'s own falsy guard: with no watermark there is no
  // window, so there is nothing to have skipped. Without this, a `0` watermark
  // reports a ~57-year loss for a query that carries no `after:` clause at all.
  if (!sinceMs) return 0;
  return Math.max(0, (nowMs - EMAIL_MAX_LOOKBACK_MS) - sinceMs);
}

/**
 * The clamp warning to emit, or `null` for silence.
 *
 * The GATE lives here rather than at the log call so it is testable: as an
 * inline `if` in `checkEmail` both `EMAIL_CLAMP_WARN_MIN_MS → 0` and
 * `→ Infinity` were mutation-survivable, and the second silences the only
 * surface a human ever gets that mail was permanently skipped.
 */
export function emailClampWarning(
  sinceMs: number,
  nowMs: number,
): { skippedMs: number; staleMs: number } | null {
  const skippedMs = emailLookbackClampMs(sinceMs, nowMs);
  if (skippedMs <= EMAIL_CLAMP_WARN_MIN_MS) return null;
  return { skippedMs, staleMs: nowMs - sinceMs };
}

export function buildGmailQuery(filter: string | undefined, sinceMs: number | null, nowMs: number): string {
  const parts: string[] = ["is:unread"];
  if (filter) parts.push(filter);
  if (sinceMs) {
    // `Math.max` clamps a stale watermark to the ceiling; `Math.floor` because
    // Gmail wants whole seconds and rounding UP would exclude the boundary
    // message the overlap was added to include.
    // The `Math.min(…, nowMs)` ceiling matters when the watermark is AHEAD of the
    // clock — a backwards clock step (NTP correction, VM resume, a second muninn
    // on a shared DB with skew). Without it the query asks for mail newer than a
    // future instant, matches nothing, still counts as "reached Gmail", and the
    // run then overwrites the watermark forward — so the window in between is
    // never evaluated by any run and, the mail being unread, nothing re-offers it.
    const since = Math.min(
      Math.max(sinceMs - EMAIL_QUERY_OVERLAP_MS, nowMs - EMAIL_MAX_LOOKBACK_MS),
      nowMs,
    );
    parts.push(`after:${Math.floor(since / 1000)}`);
  }
  return parts.join(" ");
}

/**
 * The date-only query this checker used before the window above. Retained ONLY
 * as the cold-start fallback for a row with no success watermark yet — every
 * row is in that state for exactly one tick after migration 069.
 */
export function buildGmailQueryByDate(filter: string | undefined, lastRunAt: number | null): string {
  const parts: string[] = ["is:unread"];
  if (filter) parts.push(filter);
  if (lastRunAt) {
    // en-CA → "YYYY-MM-DD" in Oslo TZ; Gmail's `after:` wants slashes.
    const oslo = OSLO_DATE_FMT.format(new Date(lastRunAt)).replace(/-/g, "/");
    parts.push(`after:${oslo}`);
  }
  return parts.join(" ");
}
