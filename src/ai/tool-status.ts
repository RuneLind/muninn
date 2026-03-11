/**
 * Maps MCP tool names to human-friendly status text for real-time UI updates.
 *
 * Tool names arrive in different formats depending on the connector:
 *   - Claude CLI:   mcp__<server>__<tool>     (e.g. mcp__knowledge__search_knowledge)
 *   - Copilot SDK:  <server>-<tool>            (e.g. knowledge-search_knowledge)
 *
 * All formats are normalized to "server/tool" before matching.
 */

interface ToolStatusEntry {
  /** Base status text (e.g. "Searching knowledge base") */
  label: string;
  /** Extract a meaningful detail from the tool input (e.g. the search query) */
  detail?: (input: string | undefined) => string | undefined;
}

/** Extract a field value from abbreviated JSON input */
function extractField(input: string | undefined, ...fieldNames: string[]): string | undefined {
  if (!input) return undefined;
  for (const field of fieldNames) {
    const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, "i");
    const match = input.match(re);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Truncate text to max length with ellipsis */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Extract query/search detail from input */
const searchDetail = (input: string | undefined) => {
  const query = extractField(input, "query", "search", "q", "text");
  return query ? truncate(query, 140) : undefined;
};

/** Generic detail extractor — tries common field names across any tool, then first string value */
const genericDetail = (input: string | undefined) => {
  const value = extractField(
    input,
    "query", "search", "q", "text", "pattern", "regex", "command", "name",
    "symbol", "symbol_name", "path", "file", "file_path", "uri", "url", "title",
  );
  if (value) return truncate(value, 140);
  // Last resort: grab the first short string value from the JSON
  return firstStringValue(input);
};

/** Extract the first short string value from JSON input */
function firstStringValue(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const match = input.match(/"[^"]*"\s*:\s*"([^"]{2,80})"/);
  return match?.[1] ? truncate(match[1], 140) : undefined;
}

/** Extract document name/title from input — tries title first, falls back to ID fields */
const docDetail = (input: string | undefined) => {
  const title = extractField(input, "title", "name", "document_name", "doc_title");
  if (title) return truncate(title, 140);
  const id = extractField(input, "document_id", "doc_id", "id", "collection_id");
  return id ? truncate(id, 140) : undefined;
};

/** Extract detail for proxy call_tool — show inner tool + server + detail */
const proxyCallToolDetail = (input: string | undefined): string | undefined => {
  if (!input) return undefined;
  const tool = extractField(input, "tool");
  const server = extractField(input, "server");
  // Dig into the nested "arguments" object for the actual search detail
  const argsMatch = input.match(/"arguments"\s*:\s*\{([^}]*)\}/);
  const argsJson = argsMatch?.[1];
  const innerDetail = argsJson
    ? extractField(`{${argsJson}}`, "name_path_pattern", "name_path", "substring_pattern", "pattern", "name", "file_mask", "relative_path", "body")
    : undefined;
  const parts: string[] = [];
  if (server) parts.push(server);
  if (innerDetail) parts.push(truncate(innerDetail, 80));
  return parts.length > 0 ? parts.join(": ") : tool ?? undefined;
};

/** Extract detail for proxy search_tools */
const proxySearchToolsDetail = (input: string | undefined): string | undefined => {
  return extractField(input, "query");
};

/** Tool entries keyed by normalized "server/tool" */
const TOOL_STATUS: Record<string, ToolStatusEntry> = {
  // Serena Tool Proxy (code MCP)
  "code/call_tool": {
    label: "Code analysis",
    detail: (input) => {
      const tool = extractField(input, "tool");
      const detail = proxyCallToolDetail(input);
      // Show "find_symbol: serena-web: Feilmelding" instead of generic "call_tool"
      if (tool && detail) return `${tool.replace(/_/g, " ")}: ${detail}`;
      if (tool) return tool.replace(/_/g, " ");
      return detail;
    },
  },
  "code/search_tools": { label: "Discovering code tools", detail: proxySearchToolsDetail },

  // Knowledge MCP
  "knowledge/search_knowledge": { label: "Searching knowledge base", detail: searchDetail },
  "knowledge/get_document": { label: "Loading document", detail: docDetail },
  "knowledge/list_collections": { label: "Listing collections" },

  // Gmail MCP
  "gmail/search_emails": { label: "Searching email", detail: searchDetail },
  "gmail/read_email": { label: "Reading email" },
  "gmail/send_email": { label: "Sending email" },
  "gmail/draft_email": { label: "Drafting email" },
  "gmail/list_emails": { label: "Checking email" },

  // Google Calendar MCP
  "google-calendar/list_events": { label: "Checking calendar" },
  "google-calendar/create_event": { label: "Creating calendar event" },
  "google-calendar/get-current-time": { label: "Checking current time" },
};

/** Server name → generic status (fallback when tool not in TOOL_STATUS) */
const SERVER_STATUS: Record<string, string> = {
  "gmail": "Checking email",
  "google-calendar": "Checking calendar",
  "knowledge": "Searching knowledge",
};

/** Known MCP server names (longest first for greedy prefix matching with dash format) */
const KNOWN_SERVERS = Object.keys(SERVER_STATUS).sort((a, b) => b.length - a.length);

/** Format a status entry with optional detail into final text */
function formatStatus(label: string, detail?: string): string {
  if (detail) return `${label}: ${detail}`;
  return `${label}...`;
}

/**
 * Normalize a tool name from any connector format to { server, tool }.
 *
 *   mcp__knowledge__search_knowledge  → { server: "knowledge", tool: "search_knowledge" }
 *   knowledge__search_knowledge       → { server: "knowledge", tool: "search_knowledge" }
 *   knowledge-search_knowledge        → { server: "knowledge", tool: "search_knowledge" }
 *   google-calendar-list_events       → { server: "google-calendar", tool: "list_events" }
 */
export function parseToolName(name: string): { server: string; tool: string } | undefined {
  // Format 1: mcp__server__tool
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const idx = rest.lastIndexOf("__");
    if (idx !== -1) return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
  }

  // Format 2: server__tool
  const dunderIdx = name.lastIndexOf("__");
  if (dunderIdx !== -1) {
    return { server: name.slice(0, dunderIdx), tool: name.slice(dunderIdx + 2) };
  }

  // Format 3: server-tool (Copilot SDK) — match known servers first for multi-dash names
  for (const server of KNOWN_SERVERS) {
    if (name.startsWith(server + "-")) {
      return { server, tool: name.slice(server.length + 1) };
    }
  }

  // Heuristic for multi-dash server names (e.g. serena-api-search_for_pattern):
  // MCP tool names use underscores, server names use dashes. Split at the last dash
  // before the first underscore to correctly separate "serena-api" from "search_for_pattern".
  const underscoreIdx = name.indexOf("_");
  if (underscoreIdx > 0) {
    const dashIdx = name.lastIndexOf("-", underscoreIdx);
    if (dashIdx > 0) return { server: name.slice(0, dashIdx), tool: name.slice(dashIdx + 1) };
  }

  // Fallback: split on first dash
  const dashIdx = name.indexOf("-");
  if (dashIdx > 0) return { server: name.slice(0, dashIdx), tool: name.slice(dashIdx + 1) };

  return undefined;
}

/**
 * Get human-friendly status text for a tool call.
 * Returns undefined for tools that should not show status (e.g. report_intent).
 */
export function getToolStatus(toolName: string, input?: string): string | undefined {
  // Skip report_intent — it generates its own intent events
  if (toolName === "report_intent") return undefined;

  const parsed = parseToolName(toolName);
  if (!parsed) {
    // Non-MCP / unparseable tool — still try to extract detail
    const label = `Using ${toolName.replace(/_/g, " ")}`;
    const detail = genericDetail(input);
    return formatStatus(label, detail);
  }

  const { server, tool } = parsed;
  const key = `${server}/${tool}`;

  // 1. Exact match
  const entry = TOOL_STATUS[key];
  if (entry) {
    const detail = entry.detail?.(input);
    return formatStatus(entry.label, detail);
  }

  // 2. Server-level fallback
  const serverStatus = SERVER_STATUS[server];
  if (serverStatus) return `${serverStatus}...`;

  // 3. Fallback: use waterfall-style "tool (server)" format with detail
  const label = `${tool} (${server})`;
  const detail = genericDetail(input);
  return formatStatus(label, detail);
}
