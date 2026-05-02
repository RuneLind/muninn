import { loadConfig } from "../config.ts";
import { getLog } from "../logging.ts";
import { extractMcpResultText } from "./huginn-trace.ts";
import {
  isUrlOriginAllowed,
  safeOrigin,
  type PointerExtraction,
} from "./huginn-trace-pointer.ts";

const log = getLog("ai", "yggdrasil-trace-pointer");

/**
 * Yggdrasil per-tool trace pointer. Mirrors {@link parseHuginnTracePointer}
 * but for the yggdrasil code-intelligence MCP. Yggdrasil only ever emits the
 * URL form — there is no bare-id variant and no fence fallback (it's
 * pointer-only by design).
 *
 * Wire format (one line, end of tool result):
 *
 *     yggdrasil-trace-url: http://127.0.0.1:9130/api/trace/a3f8b21c4e9d0a55
 *
 * The `/api/trace/<16-hex>` shape is locked into the regex so a malformed
 * URL embedded in a search hit can never reach the trace fetcher.
 */

const POINTER_RE =
  /\n+yggdrasil-trace-url: (https?:\/\/\S+?\/api\/trace\/[0-9a-f]{16})\s*$/;

function getDefaultAllowedOrigins(): string[] {
  const origin = safeOrigin(loadConfig().yggdrasilMcpUrl);
  return origin === null ? [] : [origin];
}

export function parseYggdrasilTracePointer(
  output: string,
  allowedOrigins: string[] = getDefaultAllowedOrigins(),
): PointerExtraction {
  if (output.length === 0) return { text: output, fetchUrl: null };

  const direct = matchPointer(output, allowedOrigins);
  if (direct !== null) return direct;

  const inner = extractMcpResultText(output);
  if (inner !== null && inner !== output) {
    const wrapped = matchPointer(inner, allowedOrigins);
    if (wrapped !== null) return wrapped;
  }

  return { text: output, fetchUrl: null };
}

function matchPointer(
  output: string,
  allowedOrigins: string[],
): PointerExtraction | null {
  const match = output.match(POINTER_RE);
  if (!match) return null;

  const url = match[1]!;
  const text = output.slice(0, match.index!).replace(/\s+$/, "");

  if (isUrlOriginAllowed(url, allowedOrigins)) {
    return { text, fetchUrl: url };
  }
  log.warn(
    "Pointer URL {url} origin not in allow-list {allowed}; trace will not be fetched",
    { url, allowed: allowedOrigins.join(",") },
  );
  return { text, fetchUrl: null };
}
