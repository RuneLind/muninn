import { loadConfig } from "../config.ts";
import { getLog } from "../logging.ts";
import { extractMcpResultText } from "./huginn-trace.ts";

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
 * 16-hex id, 5-min TTL on the producer side, non-consumptive get.
 */

const POINTER_RE =
  /\n+yggdrasil-trace-url: (https?:\/\/\S+?\/api\/trace\/[0-9a-f]{16})\s*$/;

export interface PointerExtraction {
  /** Tool output with the pointer line stripped. Same string when no pointer. */
  text: string;
  /** Resolved fetch URL, or null if no pointer was present / origin disallowed. */
  fetchUrl: string | null;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Origins muninn is willing to issue trace fetches against. Defaults to the
 * `YGGDRASIL_MCP_URL` origin so a planted `yggdrasil-trace-url:` line in a
 * search hit can't redirect muninn at an arbitrary host.
 */
function getDefaultAllowedOrigins(): string[] {
  const origin = safeOrigin(loadConfig().yggdrasilMcpUrl);
  return origin === null ? [] : [origin];
}

function isUrlOriginAllowed(url: string, allowedOrigins: string[]): boolean {
  const origin = safeOrigin(url);
  return origin !== null && allowedOrigins.includes(origin);
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

/**
 * Fetch a yggdrasil trace by URL. Returns the parsed JSON body on 2xx, null
 * otherwise. Never throws — pointer traces are observability and must never
 * break the request.
 */
export async function fetchYggdrasilTrace(
  url: string,
  timeoutMs = 2000,
): Promise<unknown | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      log.warn("Trace fetch returned {status} for {url}", { status: resp.status, url });
      return null;
    }
    return await resp.json();
  } catch (e) {
    log.warn("Trace fetch failed for {url}: {error}", {
      url,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
