/**
 * The per-depth tool fence, written in the CONNECTOR'S OWN DIALECT.
 *
 * ── Why this file is not three string constants ──────────────────────────────
 *
 * `FENCED_EXCLUDED_TOOLS` covers built-ins only (`Write`, `Bash`, `Agent`,
 * `Task`, …) and the share layer adds `WebSearch`/`WebFetch`; nothing there
 * touches MCP, and the copilot connector loads the bot's whole `.mcp.json` —
 * FIVE servers on melosys. So "tool-less" is not a property `Ingen`/`Skisse` get
 * for free, and the fence must be spelled the way the connector reads it.
 *
 * **Probed, not assumed** (2026-08-22, this machine, the running servers):
 *
 *   · `@github/copilot-sdk` `SessionConfig` (`dist/types.d.ts:1490-1512`) documents
 *     the filter dialect as source-qualified with a SINGLE colon — `builtin:*`,
 *     `builtin:<name>`, `mcp:*`, `mcp:<name>`, `custom:*`, `custom:<name>` — plus
 *     a bare exact-name form. A list of Claude Code's `mcp__*` strings matches
 *     nothing there and the fence ships **inert**.
 *   · `mcp:<name>` matches a tool WIRE NAME, not a server. `mcp:code` would select
 *     a tool literally called `code`, of which there is none.
 *   · `availableTools` — the SDK's allow-list knob, which DOES take those
 *     patterns — appears **nowhere in `src/`** (grepped): `copilot-sdk.ts:164`
 *     forwards `excludedTools` only. `BotConfig.allowedTools` is read by
 *     `claude-sdk.ts` alone. So an allow-list for `Full` ships inert twice over,
 *     which is why `Full` is ALSO an exclusion list.
 *   · Copilot's MCP wire names are `<server>-<tool>` (documented in
 *     `src/ai/tool-status.ts`'s header and visible in the `yggdrasil-symbol_context`
 *     / `yggdrasil-list_files` / `yggdrasil-read_source` renderer keys in
 *     `tool-detail-renderers.ts`). Claude CLI/SDK use `mcp__<server>__<tool>`.
 *
 * ── Why the `Full` list is DERIVED, not a constant ───────────────────────────
 *
 * The plan called for hardcoded constants over probed wire names. Probing them
 * is exactly what showed why a constant is the wrong artifact: the names are a
 * function of the pinned bot's `.mcp.json` server keys AND of what each server
 * currently exposes, so a constant is stale the moment either moves — the
 * inert-fix class this plan is written against, one layer up.
 *
 * Instead the list is built from the SAME `getMcpStatus` probe the `Full`
 * pre-flight already runs (`buildFullFence` takes its result), keeping every tool
 * of every server that is not `code`/`yggdrasil`. The measurement that made this
 * decision, recorded verbatim because it is the thing a future reader will want
 * and cannot cheaply re-take:
 *
 *   code (serena proxy, :9120)  2 tools — search_tools, call_tool
 *   yggdrasil (:9130)          10 tools — search, symbol_context, impact,
 *                                         detect_changes, analyze_ticket,
 *                                         file_outline, read_source, list_repos,
 *                                         search_pattern, list_files
 *   knowledge (stdio)           6 tools — search_knowledge, get_document,
 *                                         list_collections, list_tags,
 *                                         get_graph_node, get_graph_subtree
 *   hivemind (:9180)            4 tools — list_peers, ask_peer, send_to_peer,
 *                                         delegate_task
 *   research (:9190)            1 tool  — research_knowledge
 *
 * So on melosys today `Full` excludes 11 wire names and keeps 12.
 *
 * ── The acceptance rule this file exists to make satisfiable ─────────────────
 *
 * An options-object assertion alone passes while the fence is inert. `Ingen`'s
 * acceptance therefore reads the EFFECTIVE session options the connector builds
 * (see `jira-routes.test.ts`), and `Full`'s reads a real `code`/`yggdrasil` tool
 * call out of the trace.
 */

import type { ConnectorType } from "../bots/config.ts";
import type { McpServerStatus } from "../ai/mcp-status.ts";
import type { JiraDepth } from "./wire.ts";

/** MCP servers `Full` depth is allowed to reach. The only path to NAV source. */
export const JIRA_FULL_MCP_SERVERS = ["code", "yggdrasil"] as const;

/**
 * The connector-native "every MCP tool" pattern.
 *
 * `copilot-sdk` has one (`mcp:*`). The Claude dialects have NO wildcard — the CLI
 * `--disallowedTools` and the SDK `disallowedTools` are name lists — so on those
 * connectors a tool-less depth falls back to enumerating the bot's servers, which
 * `buildDepthFence` does from the same probe.
 */
export function allMcpPattern(connector: ConnectorType | undefined): string | null {
  return (connector ?? "claude-cli") === "copilot-sdk" ? "mcp:*" : null;
}

/** Wire name of one MCP tool, in the connector's dialect. */
export function mcpWireName(
  connector: ConnectorType | undefined,
  server: string,
  tool: string,
): string {
  return (connector ?? "claude-cli") === "copilot-sdk"
    ? `${server}-${tool}`
    : `mcp__${server}__${tool}`;
}

/**
 * Built-in tools excluded at EVERY depth.
 *
 * The product of this call is its RETURN TEXT, and nothing in a Jira draft is
 * served by shell access or a sub-agent. `runFencedOneShot` already unions
 * `FENCED_EXCLUDED_TOOLS` (Claude Code's spellings) on top; copilot's built-ins
 * are lowercase, which is why `src/chat/processor.ts`'s jira-analysis fence
 * spells them `bash`/`grep`/`view`/`glob`. On copilot the single `builtin:*`
 * pattern covers all of them and cannot go stale as the SDK adds tools.
 */
export function builtinFence(connector: ConnectorType | undefined): string[] {
  return (connector ?? "claude-cli") === "copilot-sdk"
    ? ["builtin:*", "custom:*"]
    : ["WebSearch", "WebFetch"];
}

/**
 * The exclusion list for one depth.
 *
 * `servers` is the live `getMcpStatus` result for the pinned bot — the same probe
 * the `Full` pre-flight runs, so this costs nothing extra. Pass `[]` when it is
 * unavailable: `Ingen`/`Skisse` still bind on copilot (the `mcp:*` wildcard needs
 * no probe) and `Full` degrades to the built-in fence, which is honest — a depth
 * that could not probe its servers is one the pre-flight has already refused.
 */
export function buildDepthFence(
  depth: JiraDepth,
  connector: ConnectorType | undefined,
  servers: McpServerStatus[],
): string[] {
  const out = new Set<string>(builtinFence(connector));

  if (depth === "full") {
    const allowed = new Set<string>(JIRA_FULL_MCP_SERVERS);
    for (const s of servers) {
      if (allowed.has(s.name)) continue;
      for (const t of s.tools ?? []) out.add(mcpWireName(connector, s.name, t.name));
    }
    return [...out];
  }

  // Tool-less depths.
  const wildcard = allMcpPattern(connector);
  if (wildcard) {
    out.add(wildcard);
    return [...out];
  }
  // No wildcard in this dialect — enumerate every probed tool of every server.
  for (const s of servers) {
    for (const t of s.tools ?? []) out.add(mcpWireName(connector, s.name, t.name));
  }
  return [...out];
}
