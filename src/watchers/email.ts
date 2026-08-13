import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku, type HaikuTelemetry } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { loadRawMcpServers } from "../ai/mcp-config-utils.ts";
import { loadInterestProfile } from "../profile/generator.ts";
import { withInterestProfile } from "../profile/inject.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "email");

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

  const { result, toolCalls } = await spawnHaiku(prompt, { source: "watcher-email", entrypoint: "jarvis-watcher", botDir, botName, model: config.model, ...telemetry });

  // Liveness predicate. "No important email today" is this checker's modal CORRECT
  // output, which is exactly what makes a broken run invisible: every failure mode
  // here — denied Gmail permissions, no MCP server, a model that never invokes the
  // tool — arrives as `[]` and reads as a quiet inbox. The distinguishing signal is
  // whether Gmail was reached at all: there is no path to a truthful answer that
  // skips `search_emails`, so zero Gmail tool calls means the check never happened.
  //
  // Measured 2026-08-13 on the live row: of 7 organic ticks, 3 (08:56, 11:59, 13:00)
  // returned `[]` having never called a Gmail tool — the model looped on ToolSearch
  // (11 times on the 11:59 tick, 445k input tokens) or simulated the call through
  // Bash, then answered `[]`. Two were fully silent; the third tripped the JSON
  // parse warning below. All three advanced last_run_at.
  //
  // `toolCalls` is UNDEFINED only when the stream parser never saw the run and
  // `parseLegacyHaikuOutput` took over — no tool list exists, so we genuinely cannot
  // tell, and the check stays inert (that path warns on its own). A run the parser
  // DID see always yields a definite list, INCLUDING the empty one: `spawnHaiku`
  // normalizes StreamParser's zero-tools `undefined` to `[]` precisely so the most
  // dangerous case — Gmail MCP down or its permission denied, model answers `[]` in
  // one turn having called nothing — is caught here instead of being mistaken for a
  // parser degradation. Before that normalization this branch could not see it.
  //
  // Resolved only when there IS something to judge — a `undefined` toolCalls run
  // can't fail the check, so reading the config (and possibly warning about it)
  // would be noise.
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
  if (toolCalls && prefixes && !reachedGmail) {
    const called = [...new Set(toolCalls.map((t) => String(t.name)))].join(", ") || "none";
    throw new Error(
      `Email check made no Gmail tool call (${toolCalls.length} tool call(s): ${called}) — ` +
        `the empty result is not a quiet inbox`,
    );
  }

  try {
    return extractJson<WatcherAlert[]>(result);
  } catch {
    log.warn("Failed to parse Haiku response as JSON, skipping. Raw: {raw}", { raw: result.slice(0, 300) });
    return [];
  }
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
