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
 * Per-attempt model timeout — `spawnHaiku`'s own default, named here because the
 * retry budget below is derived against it and the two must not drift.
 */
const EMAIL_ATTEMPT_TIMEOUT_MS = HAIKU_TIMEOUT_MS;
/** Attempts per check. 2, not 3 — see the budget note on `emailRetryBudgetMs`. */
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
 * `botDir` is the bot folder whose `.mcp.json` declares the Gmail server. It used
 * to be the spawn's cwd (MCP by auto-discovery); it is now handed to the CLI as
 * `--mcp-config` so the run itself happens outside the repo. This is the ONLY
 * spawnHaiku caller that still needs bot MCP — every other one is a tool-less
 * prompt and runs `--strict-mcp-config`.
 */
export async function checkEmail(watcher: Watcher, botDir?: string, botName?: string, telemetry?: HaikuTelemetry): Promise<WatcherAlert[]> {
  // Anchored at ENTRY, not at the first spawn: the runner's net starts here too, and
  // the profile load below is a DB read that must come out of the same budget.
  const startedAt = Date.now();
  const config = watcher.config as { filter?: string; prompt?: string; model?: string };
  const query = buildGmailQuery(config.filter, watcher.lastRunAt);

  const userPrompt = config.prompt || DEFAULT_EMAIL_PROMPT;
  const interestProfile = await loadInterestProfile(watcher.userId, botName ?? watcher.botName);

  // Email's criteria sit mid-prompt (the CRITICAL + "Return ONLY a JSON array"
  // format contract comes AFTER the user criteria), so we wrap the FULL assembled
  // prompt — the interest-profile block lands last, after the format contract, and
  // `withInterestProfile`'s "the output-format instructions above still apply"
  // trailer then correctly refers to the format block above it. With no profile the
  // wrapper returns this string verbatim, so the prompt is byte-identical to before.
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
  const prompt = withInterestProfile(basePrompt, interestProfile);

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

      const failure = gmailLivenessFailure(toolCalls, botDir);
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
        return [];
      }
      log.info(
        "email-check ok: attempt={attempt}/{max} durationMs={durationMs} attemptTimeoutMs={attemptTimeoutMs} alerts={alerts}",
        { botName, attempt, max: EMAIL_MAX_ATTEMPTS, durationMs, attemptTimeoutMs, alerts: alerts.length },
      );
      return alerts;
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
 * On the live row (no `config.timeoutMs`, so the 120s floor) this yields 110s:
 * a 60s attempt 1 leaves 50s, which clears `EMAIL_MIN_ATTEMPT_MS` and buys a
 * clamped-but-real retry. Setting `config.timeoutMs: 150000` on the row widens the
 * net to 180s and gives BOTH attempts their full 60s — worth doing if the clamped
 * retries show up as attempt-2 timeouts, but deliberately not required to ship,
 * because a fix that only works after a hand-edited DB row is a fix that is inert
 * where it matters. Three attempts do not fit under the 120s floor at all, which
 * is why {@link EMAIL_MAX_ATTEMPTS} is 2.
 *
 * The net's 120s FLOOR means this can never return less than 110s, whatever the row
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
 */
function gmailLivenessFailure(
  toolCalls: { name: string }[] | undefined,
  botDir: string | undefined,
): string | null {
  const prefixes = toolCalls ? gmailToolPrefixes(botDir) : null;
  const reachedGmail = toolCalls?.some(
    (t) => typeof t.name === "string" && prefixes?.some((p) => t.name.startsWith(p)),
  );
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

export function buildGmailQuery(filter: string | undefined, lastRunAt: number | null): string {
  const parts: string[] = ["is:unread"];
  if (filter) parts.push(filter);
  if (lastRunAt) {
    // en-CA → "YYYY-MM-DD" in Oslo TZ; Gmail's `after:` wants slashes.
    const oslo = OSLO_DATE_FMT.format(new Date(lastRunAt)).replace(/-/g, "/");
    parts.push(`after:${oslo}`);
  }
  return parts.join(" ");
}
