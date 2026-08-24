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
