/**
 * The env every muninn an e2e run spawns is built from.
 *
 * Two independent classes of ambient value have to be neutralised before a
 * spawned server is comparable across machines, and both had to be learned the
 * hard way:
 *
 *   1. PLATFORM TOKENS — `blankBotTokens()`, whose reasoning lives in its own
 *      module: an e2e server that inherits a live `TELEGRAM_BOT_TOKEN_*` opens a
 *      second long-poller and Telegram terminates the production bot.
 *
 *   2. INSTANCE-PROFILE FLAGS — `MUNINN_WIKI_READONLY`, `SYNC_REPOS` and the
 *      `MUNINN_AUTH` family. These say WHICH INSTANCE this
 *      is, so inheriting them makes the suite host-dependent: on the Mac mini,
 *      whose `.env` carries `MUNINN_WIKI_READONLY=1`, spawned servers came up
 *      read-only and a large part of the suite went red while the laptop stayed
 *      green. `bun test` has been hermetic against exactly this since
 *      `src/test/preload.ts`; nothing did the equivalent for Playwright, and
 *      `playwright.config.ts`'s `webServer.env` blanked only the tokens.
 *
 * THE TRAP, for both classes: a spawned muninn re-reads the dotenv files itself
 * (Bun auto-load, cwd = repo root), so `delete env.MUNINN_WIKI_READONLY` in the
 * parent achieves NOTHING — the absent name is precisely what makes the child
 * fall back to the `.env` line. An empty-string env var DOES beat a dotenv line
 * in Bun (verified), so every blank here must be a real assignment.
 *
 * Use `e2eEnv()` at EVERY spawn site, including `playwright.config.ts`'s shared
 * server. A spec that spreads only `blankBotTokens()` is the shape of the bug.
 */

import { AMBIENT_INSTANCE_ENV, AMBIENT_INSTANCE_ENV_PREFIXES } from "../src/test/ambient-env.ts";
import { blankBotTokens, envNamesMatchingPrefixes } from "./blank-bot-tokens.ts";

/**
 * Every instance-profile flag mapped to `""`. Unlike `blankBotTokens()` this
 * needs no scan of the dotenv files: the names are a fixed, known list, and
 * assigning `""` to one the host never set is inert — an unset flag and an empty
 * one resolve identically in every reader (`optionalEnvFlag`, the comma-split
 * parsers, and `resolveAuthConfig`'s `off` default).
 */
export function blankInstanceProfile(): Record<string, string> {
  const blanked: Record<string, string> = {};
  for (const name of AMBIENT_INSTANCE_ENV) blanked[name] = "";
  // The open-ended families DO need the scan `blankBotTokens` does, for both of
  // its reasons: no fixed list can enumerate a prefix, and `playwright.config.ts`
  // runs under node, where a name living only in `.env` is not in `process.env`.
  // Without this a single `VERTEX_REGION_CLAUDE_4_5_SONNET=global` line makes
  // every spawned muninn REFUSE TO BOOT — the config guard firing correctly, on
  // a host where the suite has nothing to do with Vertex.
  for (const name of envNamesMatchingPrefixes(AMBIENT_INSTANCE_ENV_PREFIXES)) blanked[name] = "";
  return blanked;
}

/**
 * The full blank set for a spawned e2e muninn. Spread it AFTER `...process.env`
 * and BEFORE the spec's own overrides, so a spec that deliberately wants one of
 * these flags (`plans-write.spec.ts` boots a read-only instance on purpose) can
 * still set it back.
 */
export function e2eEnv(): Record<string, string> {
  return { ...blankBotTokens(), ...blankInstanceProfile() };
}
