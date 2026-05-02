/**
 * Maps MCP tool names to human-friendly status text for real-time UI updates.
 *
 * Tool names arrive in different formats depending on the connector:
 *   - Claude CLI:   mcp__<server>__<tool>     (e.g. mcp__knowledge__search_knowledge)
 *   - Copilot SDK:  <server>-<tool>            (e.g. knowledge-search_knowledge)
 *
 * All formats are normalized to "server/tool" before matching.
 *
 * Display text is resolved in this order:
 *   1. `tool-display.config.json` at the repo root (user-editable overrides)
 *   2. Hardcoded `TOOL_STATUS` entries below (built-in defaults)
 *   3. Server-level fallback from `SERVER_STATUS`
 *   4. Generic "tool (server)" fallback with first-field detail
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getLog } from "../logging.ts";
import { isReportIntentTool } from "./stream-parser.ts";

const log = getLog("ai", "tool-status");

interface ToolStatusEntry {
  /** Base status text (e.g. "Searching knowledge base") */
  label: string;
  /** Extract a meaningful detail from the tool input (e.g. the search query) */
  detail?: (input: string | undefined) => string | undefined;
}

/** Shape of each entry in tool-display.config.json */
interface ToolDisplayConfigEntry {
  /** Display label, e.g. "Searching knowledge base" */
  label: string;
  /** Ordered list of input JSON field names to extract and render as "key=value · ..." */
  fields?: string[];
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

type ScalarValue = { value: string; type: "string" | "boolean" | "number" };

/** Parse the tool input JSON into a plain object, or undefined if malformed/truncated. */
function parseInputObject(input: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(input);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Read a scalar field from a parsed input object (structured path). */
function lookupFromParsed(obj: Record<string, unknown>, field: string): ScalarValue | undefined {
  const v = obj[field];
  if (v == null) return undefined;
  if (typeof v === "string") return { value: v, type: "string" };
  if (typeof v === "boolean") return { value: String(v), type: "boolean" };
  if (typeof v === "number") return { value: String(v), type: "number" };
  return undefined;
}

/**
 * Read a scalar field from raw JSON-ish text via regex. Used as a fallback when
 * {@link parseInputObject} fails — tool inputs are abbreviated to 500 chars upstream,
 * so over-long inputs arrive with a trailing `...` and cannot be parsed strictly.
 */
function extractRawField(input: string, field: string): ScalarValue | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const strMatch = input.match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`, "i"));
  if (strMatch?.[1] !== undefined) return { value: strMatch[1], type: "string" };
  const boolMatch = input.match(new RegExp(`"${escaped}"\\s*:\\s*(true|false)`, "i"));
  if (boolMatch?.[1] !== undefined) return { value: boolMatch[1], type: "boolean" };
  const numMatch = input.match(new RegExp(`"${escaped}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
  if (numMatch?.[1] !== undefined) return { value: numMatch[1], type: "number" };
  return undefined;
}

/**
 * Build a detail string from a list of field names using the Option A format:
 * `key=value · flag · key=value`.
 *
 * - String / number fields render as `field=value` (each value truncated to 80 chars)
 * - Boolean `true` renders as a bare flag (just `field`); boolean `false` is omitted
 * - Missing fields are skipped
 * - The joined result is truncated to 180 chars as a hard cap
 *
 * Prefers structured JSON parse for correctness (handles escaped quotes, nested
 * objects) and falls back to regex extraction when input is truncated or malformed.
 */
function buildDetailFromFields(input: string | undefined, fields: string[]): string | undefined {
  if (!input || fields.length === 0) return undefined;
  const parsed = parseInputObject(input);
  const parts: string[] = [];
  for (const field of fields) {
    const raw = parsed ? lookupFromParsed(parsed, field) : extractRawField(input, field);
    if (!raw) continue;
    if (raw.type === "boolean") {
      if (raw.value === "true") parts.push(field);
      continue;
    }
    parts.push(`${field}=${truncate(raw.value, 80)}`);
  }
  if (parts.length === 0) return undefined;
  return truncate(parts.join(" · "), 180);
}

/**
 * Load tool-display.config.json from the repo root. Returns {} when the file is
 * missing (silent — config is optional) or when the file exists but is invalid
 * (logged so the user gets feedback about config mistakes).
 */
function loadToolDisplayConfig(): Record<string, ToolDisplayConfigEntry> {
  const configPath = resolve(import.meta.dir, "../../tool-display.config.json");
  if (!existsSync(configPath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    log.warn("Failed to parse tool-display.config.json: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("tool-display.config.json must be a JSON object at the top level");
    return {};
  }

  const out: Record<string, ToolDisplayConfigEntry> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith("_")) continue; // underscore-prefixed keys are comments
    if (!value || typeof value !== "object") {
      log.warn("tool-display.config.json: entry {key} is not an object — skipping", { key });
      continue;
    }
    const entry = value as { label?: unknown; fields?: unknown };
    if (typeof entry.label !== "string") {
      log.warn("tool-display.config.json: entry {key} is missing a string label — skipping", { key });
      continue;
    }
    const fields = Array.isArray(entry.fields)
      ? entry.fields.filter((f): f is string => typeof f === "string")
      : undefined;
    out[key] = { label: entry.label, fields };
  }
  return out;
}

const TOOL_DISPLAY_CONFIG: Record<string, ToolDisplayConfigEntry> = loadToolDisplayConfig();

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
  // Skip report_intent — it generates its own intent events.
  if (isReportIntentTool(toolName)) return undefined;

  const parsed = parseToolName(toolName);
  if (!parsed) {
    // Non-MCP / unparseable tool — still try to extract detail
    const label = `Using ${toolName.replace(/_/g, " ")}`;
    const detail = genericDetail(input);
    return formatStatus(label, detail);
  }

  const { server, tool } = parsed;
  const key = `${server}/${tool}`;

  // 1. User-editable config override (tool-display.config.json)
  const configEntry = TOOL_DISPLAY_CONFIG[key];
  if (configEntry) {
    const detail = configEntry.fields ? buildDetailFromFields(input, configEntry.fields) : undefined;
    return formatStatus(configEntry.label, detail);
  }

  // 2. Hardcoded exact match
  const entry = TOOL_STATUS[key];
  if (entry) {
    const detail = entry.detail?.(input);
    return formatStatus(entry.label, detail);
  }

  // 3. Server-level fallback
  const serverStatus = SERVER_STATUS[server];
  if (serverStatus) return `${serverStatus}...`;

  // 4. Fallback: use waterfall-style "tool (server)" format with detail
  const label = `${tool} (${server})`;
  const detail = genericDetail(input);
  return formatStatus(label, detail);
}
