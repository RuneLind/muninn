import type { BotConfig } from "../bots/config.ts";
import { getEnabledWatcherOwners } from "../db/watchers.ts";
import { isProfileStale } from "../db/interest-profiles.ts";
import { refreshInterestProfile } from "../profile/generator.ts";
import { getLog } from "../logging.ts";

const log = getLog("scheduler", "profile-refresh");

/** `bot:user` keys with an interest-profile refresh in flight — guards against a
 *  slow Haiku refresh being re-dispatched by ticks that fire before it writes its
 *  row. Per-owner (not per-bot) so a multi-user bot refreshes each owner. */
const profileRefreshInFlight = new Set<string>();

/** Test-only: clear the module-level in-flight guard between cases (the set
 *  persists across a test file's cases otherwise). Not used in production. */
export function __resetProfileRefreshInFlight(): void {
  profileRefreshInFlight.clear();
}

/**
 * Refresh the interest profile of every user who OWNS an enabled watcher for
 * this bot and whose profile is stale (missing or > 7 days old). A watcher run
 * personalizes against its OWN owner (`watcher.userId`), so the profile that
 * matters is the owner's — not `bot_default_user` (which the web-chat dropdown
 * clobbers and which leaks one user's interests into another's alerts). A bot
 * with no enabled watchers refreshes nobody: its profile would never be read.
 *
 * Per owner: the staleness check is awaited (cheap PK lookup); the refresh
 * itself runs detached so a slow Haiku call never blocks the tick. The in-flight
 * guard (keyed on `bot:user`) prevents a slow refresh from being re-queued by
 * the next tick before it writes its row. Best-effort throughout — a failure
 * here must never disrupt the scheduler tick.
 */
export async function maybeRefreshInterestProfile(botConfig: BotConfig): Promise<void> {
  const botName = botConfig.name;
  try {
    const owners = await getEnabledWatcherOwners(botName);
    for (const userId of owners) {
      const key = `${botName}:${userId}`;
      if (profileRefreshInFlight.has(key)) continue;
      if (!(await isProfileStale(userId, botName, 7))) continue;

      profileRefreshInFlight.add(key);
      // Detached: matches how the async extractors are dispatched. The generator
      // swallows its own errors; this .finally only clears the in-flight guard.
      void refreshInterestProfile(userId, botName, {
        connector: botConfig.connector,
        haikuBackend: botConfig.haikuBackend,
      }).finally(() => profileRefreshInFlight.delete(key));
    }
  } catch (err) {
    log.error("Interest-profile refresh dispatch failed: {error}", {
      botName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
