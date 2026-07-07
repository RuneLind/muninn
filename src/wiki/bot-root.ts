/**
 * Maps a `?bot=<name>` query param to the wiki root the store should scan.
 * Kept pure (takes a bots array, no filesystem) so the dashboard route logic is
 * unit-testable without spinning up bot discovery.
 */

import type { BotConfig } from "../bots/config.ts";

export interface WikiRootResolution {
  /** Explicit root to scan (a bot's `wikiDir`). Undefined = store default (jarvis). */
  root?: string;
  /** True when a `?bot=` was given but the bot is unknown or has no `wikiDir`. */
  unknownBot?: boolean;
}

/**
 * Resolve the wiki root for a `?bot=` param:
 *   - no/blank bot → `{}` (store falls back to `WIKI_DIR` env → jarvis default).
 *   - known bot with a `wikiDir` → `{ root }`.
 *   - unknown bot, or a bot without a configured `wikiDir` → `{ unknownBot: true }`.
 */
export function resolveBotWikiRoot(bots: BotConfig[], botName: string | undefined): WikiRootResolution {
  const wanted = botName?.trim();
  if (!wanted) return {};
  const bot = bots.find((b) => b.name.toLowerCase() === wanted.toLowerCase());
  if (!bot || !bot.wikiDir) return { unknownBot: true };
  return { root: bot.wikiDir };
}

/** Names of bots that expose a browsable wiki — populates the reader's wiki selector. */
export function listWikiBots(bots: BotConfig[]): string[] {
  return bots.filter((b) => b.wikiDir).map((b) => b.name);
}

/**
 * The bot whose wiki a bare `/wiki` (no `?bot=`) renders: jarvis if it exposes a
 * `wikiDir`, else the first wiki-exposing bot, else undefined (no bot has a wiki).
 * Derives the "default wiki" from the actual bot configs instead of a hardcoded
 * constant, so the picker's selection and the rendered content can't disagree.
 */
export function defaultWikiBot(bots: BotConfig[]): string | undefined {
  const wikiBots = listWikiBots(bots);
  return wikiBots.find((b) => b.toLowerCase() === "jarvis") ?? wikiBots[0];
}

export interface WikiRequestResolution {
  /** Bot the picker highlights AND the client uses as its `?bot=` param. "" = none. */
  bot: string;
  /** True when a bare `/wiki` is served from the legacy `WIKI_DIR` env override. */
  envOverride: boolean;
}

/**
 * Resolve which bot the `/wiki` reader page selects (picker + client `?bot=`),
 * unifying content and picker state onto one path:
 *   - `?bot=<name>` → canonical bot name (case-corrected) so the picker's
 *     `selected` and the client's fetches match `resolveBotWikiRoot`'s
 *     case-insensitive lookup. An unknown bot keeps the raw name so the client
 *     re-queries it and lands on the empty state (not a silent default).
 *   - bare `/wiki` with `WIKI_DIR` set → `{ bot: "", envOverride: true }`: the
 *     legacy env override stays explicit and the picker claims no bot.
 *   - bare `/wiki` otherwise → the `defaultWikiBot`, resolved through the same
 *     bot→wikiDir path as `?bot=<default>` (or "" when no bot has a wiki, so the
 *     store's own env/hardcoded fallback still serves a true no-config setup).
 */
export function resolveWikiRequest(
  bots: BotConfig[],
  rawBot: string | undefined,
  envWikiDir: string | undefined,
): WikiRequestResolution {
  const wanted = rawBot?.trim();
  if (wanted) {
    const bot = bots.find((b) => b.name.toLowerCase() === wanted.toLowerCase() && !!b.wikiDir);
    return { bot: bot ? bot.name : wanted, envOverride: false };
  }
  if (envWikiDir && envWikiDir.trim()) return { bot: "", envOverride: true };
  return { bot: defaultWikiBot(bots) ?? "", envOverride: false };
}
