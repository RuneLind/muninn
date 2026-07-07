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
