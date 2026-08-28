/**
 * Which MCP servers `Full` technical depth needs.
 *
 * `code` (the serena proxy) and `yggdrasil` are the ONLY path to NAV source on the
 * pinned Jira bot, which runs `copilot-sdk` — so a `Full` draft written with them
 * down is not a degraded draft: it is a confident task about code nobody opened.
 * `POST /api/jira/draft/from-thread` pre-flights on this list (`missingFullServers`
 * in `jira-routes.ts`) and refuses with a 503 naming the servers.
 *
 * **The per-depth tool FENCE is gone with the notes path.** It fenced the
 * server-side one-shot that drafted from pasted notes, in the connector's own
 * dialect (`mcp:*` / `builtin:*` on copilot, an enumerated `mcp__*` list on the
 * Claude dialects, derived from the live probe). A draft is now a turn in a chat
 * thread: the person's own conversation, with the bot's ordinary tool surface,
 * which is the whole reason the thread path exists. Nothing fences a chat turn,
 * and pretending otherwise by keeping an unused builder was the inert half of a
 * contract nothing enforced.
 */

/** MCP servers `Full` depth is allowed to reach. The only path to NAV source. */
export const JIRA_FULL_MCP_SERVERS = ["code", "yggdrasil"] as const;

/**
 * How `Full` depth is blocked, per server. The probe already tells these two
 * states apart and the refusal used to collapse them: an ABSENT name means the
 * bot carries no such entry in its `.mcp.json` at all — the nais pod's steady
 * state, where the overlay ships only `research` — while a present-but-`down`
 * name is a laptop with the Serena listeners stopped. Only the second has a
 * remedy, and offering it in a pod sends the reader to a dashboard that cannot
 * start anything.
 */
export interface FullDepthGap {
  /** Named in {@link JIRA_FULL_MCP_SERVERS} but absent from the bot's `.mcp.json`. */
  unconfigured: string[];
  /** Configured, but the probe reports it down. */
  down: string[];
}

/**
 * The `Full` pre-flight's refusal sentence. Its own function because the wording
 * is the whole point: it is the one refusal a reader is expected to act on, and
 * the action differs by state. Naming a server the instance was never built with
 * as "nede" invites a reader to go start it.
 */
export function fullDepthUnavailableMessage(gap: FullDepthGap): string {
  const clauses: string[] = [];
  if (gap.unconfigured.length > 0) {
    clauses.push(`de er ikke tilgjengelige i denne installasjonen: ${gap.unconfigured.join(", ")}`);
  }
  if (gap.down.length > 0) {
    clauses.push(`disse er nede: ${gap.down.join(", ")}`);
  }
  // Exported without a guard of its own, and only today's single call site
  // happens to check the length first — a second caller must not ship "og .".
  if (clauses.length === 0) return "Full teknisk dybde er ikke tilgjengelig. Velg dybde «Skisse».";
  // The remedy names the servers that can actually be started, and nothing else:
  // offering to start a server the same sentence just called absent is the exact
  // confusion this split exists to remove.
  const remedy = gap.down.length > 0
    ? `Start ${gap.down.join(" og ")} fra dashbordet, eller velg dybde «Skisse».`
    : "Velg dybde «Skisse».";
  return `Full teknisk dybde krever kodeverktøyene, og ${clauses.join("; ")}. ${remedy}`;
}
