/**
 * Keep an e2e muninn off the chat platforms.
 *
 * Every muninn this repo's Playwright specs boot inherits the developer's `.env`
 * — including `TELEGRAM_BOT_TOKEN_*`. Telegram allows ONE long-poller per token
 * and terminates the *other* one on conflict, so an e2e server knocks the running
 * production jarvis off Telegram and leaves `409: Conflict: terminated by other
 * getUpdates request` in its log (observed during the #400 review). Slack socket
 * mode has the same shape.
 *
 * The blank makes discovery skip the platform side of each bot
 * (`discoverActiveBots` requires a non-empty token), so nothing connects out. The
 * /chat + dashboard surface is unaffected: it is built from `discoverAllBots()`,
 * which only needs `bots/<name>/CLAUDE.md` — so bot pills, threads and the
 * inspector still render exactly as they do with live tokens. No spec exercises
 * Telegram or Slack.
 *
 * Names are collected from BOTH the caller's env and the dotenv FILES, because the
 * child auto-loads those itself (Bun) and the caller may not carry any of them —
 * notably `playwright.config.ts`, which the Playwright runner evaluates under
 * **node**, where none of the tokens are in `process.env` and the file scan is the
 * only source. An empty-string env var DOES beat a dotenv line in Bun — verified —
 * so the blank has to be a real assignment, not a delete.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// fileURLToPath, not `new URL(...).pathname`: the latter stays percent-encoded, so
// a repo path containing a space would silently miss every dotenv file below.
const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The env prefixes that make muninn open an outbound connection to a chat platform.
 *  Exactly the names `discoverActiveBots` gates on (`src/bots/config.ts`). */
const TOKEN_PREFIXES = ["TELEGRAM_BOT_TOKEN_", "SLACK_BOT_TOKEN_", "SLACK_APP_TOKEN_"];

/** Every dotenv file Bun auto-loads that could carry a token. `.env.local` is not
 *  hypothetical tidiness — a developer moving tokens there would silently restore
 *  the 409 fight, since a missed name looks exactly like "no tokens configured". */
const DOTENV_FILES = [".env", ".env.local"];

/**
 * Every platform-token env name we can see, mapped to `""` — spread into the env
 * of any muninn an e2e run spawns. Also blanks them on the CALLER's own env, so
 * anything else that process spawns (a Playwright worker, a nested helper)
 * inherits the blank rather than a live token.
 */
/**
 * Every env name matching one of `prefixes`, from the caller's env AND the dotenv
 * FILES. Exported because the instance-profile blank needs exactly this scan for
 * the `VERTEX_REGION_CLAUDE_*` family: that one is an open-ended PREFIX, so no
 * fixed list of names can enumerate it, and the file half is load-bearing for
 * the same reason it is here — `playwright.config.ts` is evaluated under node,
 * where a name that lives only in `.env` is not in `process.env` at all.
 */
export function envNamesMatchingPrefixes(prefixes: readonly string[]): Set<string> {
  // Case-insensitive so a lowercase `.env` line is blanked under the name it
  // actually exports, not an uppercased guess.
  const matches = (k: string): boolean =>
    prefixes.some((p) => k.toUpperCase().startsWith(p));
  const names = new Set(Object.keys(process.env).filter(matches));
  for (const file of DOTENV_FILES) {
    let text: string;
    try {
      text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    } catch {
      continue; // not present — normal for `.env.local`
    }
    for (const line of text.split("\n")) {
      // `export ` is optional because Bun honours it; a `#` comment can't match,
      // since `#` is outside the name charset.
      const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=/.exec(line);
      if (m && matches(m[1]!)) names.add(m[1]!);
    }
  }
  return names;
}

export function blankBotTokens(): Record<string, string> {
  const names = envNamesMatchingPrefixes(TOKEN_PREFIXES);
  const blanked: Record<string, string> = {};
  for (const n of names) {
    blanked[n] = "";
    process.env[n] = "";
  }
  if (Object.keys(blanked).length === 0) {
    // Loud on purpose: an empty result is indistinguishable from "this machine has
    // no bot tokens", and the failure mode is silent — e2e quietly resumes
    // 409-fighting whatever bot IS configured.
    console.warn(
      `[e2e] blankBotTokens found no platform-token names in ${DOTENV_FILES.join(" / ")} or the ` +
        `environment — if this machine runs bots, an e2e server may fight them for Telegram/Slack.`,
    );
  }
  return blanked;
}
