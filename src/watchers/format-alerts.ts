/**
 * Watcher alert → markdown. A LEAF module (no imports beyond types) on purpose.
 *
 * It lived in `runner.ts` until `run-health.ts` needed it to format a failure
 * escalation, and `runner.ts` imports every checker — so importing it from there
 * pulled `x.ts`/`anthropic.ts`/the gardeners into any test that touches run
 * health. That is not merely heavy: a `mock.module` test loading this graph
 * evaluates `x.ts` with the REAL logger bound, and `x.test.ts` (running later in
 * the same `bun test src/watchers/` process) then mocks `../logging.ts` too late
 * to rebind it — six of its assertions went silently log-less. Keeping the
 * formatter free of imports is what lets the health module stay a leaf too.
 *
 * `runner.ts` re-exports it, so its existing import sites are unchanged.
 */
import type { Watcher, WatcherAlert } from "../types.ts";

export function formatAlerts(watcher: Watcher, alerts: WatcherAlert[]): string {
  const icon = watcher.type === "email" ? "\u{1F4E8}" : watcher.type === "news" ? "\u{1F4F0}" : watcher.type === "x" ? "\u{1D54F}" : watcher.type === "anthropic" ? "\u{1F9E0}" : watcher.type === "wiki-gardener" ? "\u{1F331}" : watcher.type === "wiki-linter" ? "\u{1F9F9}" : watcher.type === "wiki-committer" ? "\u{1F4BE}" : watcher.type === "consolidation-gardener" ? "\u{1F9E9}" : "\u{1F514}";
  const header = `${icon} **${watcher.name}**\n`;
  const lines = alerts.map((a) => {
    const urgencyTag = a.urgency === "high" ? " \u{1F534}" : a.urgency === "medium" ? " \u{1F7E1}" : "";
    return `${urgencyTag} ${a.summary}`;
  });
  return header + lines.join("\n\n");
}
