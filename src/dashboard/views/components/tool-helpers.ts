/** Priority keys checked when extracting a short readable label from a tool's
 *  input JSON. Order matters — first match wins. */
export const TOOL_INPUT_PRIORITY_KEYS = ['query', 'pattern', 'prompt', 'text', 'command', 'url', 'file_path', 'path', 'subject', 'q', 'search', 'message', 'name', 'skill'];
export const TOOL_INPUT_MAX_LENGTH = 140;

/** Extract a short readable summary from tool input (JSON string or object). Exported for testing. */
export function extractToolInputLabel(input: unknown): string {
  if (!input) return '';
  try {
    const obj = typeof input === 'object' ? input as Record<string, unknown> : JSON.parse(input as string);
    for (const key of TOOL_INPUT_PRIORITY_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) {
        return v.length > TOOL_INPUT_MAX_LENGTH ? v.slice(0, TOOL_INPUT_MAX_LENGTH - 3) + '...' : v;
      }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.length > TOOL_INPUT_MAX_LENGTH ? val.slice(0, TOOL_INPUT_MAX_LENGTH - 3) + '...' : val;
      }
    }
  } catch { /* invalid JSON — return empty */ }
  return '';
}

/** Strip the redundant MCP-server prefix from a tool span's display name when
 *  we're going to append a more specific identifier (e.g. a collection name). */
export const TOOL_NAME_PREFIX_RE = /^(knowledge|huginn|yggdrasil)[-_]/;

/** Strip the `mcp__` prefix and rejoin server/tool with a dash so claude-cli's
 *  `mcp__yggdrasil__symbol_context` converges on copilot-sdk's
 *  `yggdrasil-symbol_context` for regex matching. */
export function normalizeToolName(name: string): string {
  if (!name || !name.startsWith("mcp__")) return name;
  const rest = name.slice(5);
  const idx = rest.lastIndexOf("__");
  if (idx === -1) return name;
  return rest.slice(0, idx) + "-" + rest.slice(idx + 2);
}

/** Inline JS: extract a short readable summary from tool input JSON */
export function toolInputLabelScript(): string {
  return `
    function toolInputLabel(input) {
      if (!input) return '';
      try {
        var obj = typeof input === 'object' ? input : JSON.parse(input);
        var keys = ${JSON.stringify(TOOL_INPUT_PRIORITY_KEYS)};
        for (var i = 0; i < keys.length; i++) {
          var v = obj[keys[i]];
          if (typeof v === 'string' && v.length > 0) return v.length > ${TOOL_INPUT_MAX_LENGTH} ? v.slice(0, ${TOOL_INPUT_MAX_LENGTH - 3}) + '...' : v;
        }
        var allKeys = Object.keys(obj);
        for (var j = 0; j < allKeys.length; j++) {
          var val = obj[allKeys[j]];
          if (typeof val === 'string' && val.length > 0) return val.length > ${TOOL_INPUT_MAX_LENGTH} ? val.slice(0, ${TOOL_INPUT_MAX_LENGTH - 3}) + '...' : val;
        }
      } catch (e) {}
      return '';
    }
  `;
}
