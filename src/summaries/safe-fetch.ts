/**
 * Guarded fetch for the capture verticals' enrichment paths.
 *
 * The URL these paths follow is chosen by a THIRD PARTY — the `**Links:**` footer of
 * a captured tweet, or a destination-keyed candidate row — and muninn runs on a host
 * whose loopback and tailnet carry unauthenticated services (the dashboard on
 * 127.0.0.1:3010 exposes MCP tools, logs, traces and full CRUD). A bare `fetch` of
 * such a URL is an SSRF: the fetched body is then handed to the summarizer and
 * ingested, so "fetch anything the tweet names" reads internal state out to a wiki
 * page. `capContent` (100k chars) bounds the PROMPT, never the process — a bare
 * `await res.text()` buffers the whole body first.
 *
 * So: scheme allowlist → resolve and judge the ADDRESS → manual redirects, judged
 * again at every hop → content-type gate → streaming size cap. Refusals return
 * `null` and log ONCE; this function never throws, so callers degrade exactly as
 * they already do when a fetch fails.
 *
 * ACCEPTED, deliberately: the check-then-fetch TOCTOU. We resolve the hostname,
 * judge the addresses, then fetch BY HOSTNAME — a resolver that answers differently
 * the second time (DNS rebinding) slips through. Pinning the connection to the
 * checked IP would break TLS SNI/vhosts, and the exposure is bounded: muninn binds
 * loopback and serves one user, so the attacker needs both a rebinding resolver and
 * a target on that host. Reopen this if muninn ever binds non-loopback with real
 * users (`DASHBOARD_HOST=0.0.0.0`) — then pin the socket, or fetch through a proxy
 * that does.
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { getLog } from "../logging.ts";

const log = getLog("summaries", "safe-fetch");

/** Bounds the PROCESS (the prompt cap `capContent` is a separate, smaller clamp). */
export const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
/** Covers the whole operation — every hop plus the body read, not just the headers. */
export const SAFE_FETCH_TIMEOUT_MS = 20_000;
export const SAFE_FETCH_MAX_REDIRECTS = 3;

/** Resolve a hostname to its addresses. Test seam — production uses `node:dns`. */
export type HostLookup = (hostname: string) => Promise<string[]>;

export interface SafeFetchOptions {
  /** Whole-operation timeout (default {@link SAFE_FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Body cap in bytes (default {@link SAFE_FETCH_MAX_BYTES}). */
  maxBytes?: number;
  /** Redirect hops to follow (default {@link SAFE_FETCH_MAX_REDIRECTS}). */
  maxRedirects?: number;
  /** Test seam: stubbed DNS. */
  lookup?: HostLookup;
  /**
   * Test seam ONLY: nothing local is reachable by its real name once the address
   * guard is on, so tests point a public-looking host at a loopback server. Never
   * set in production — it is exactly the TOCTOU the header documents.
   */
  fetchImpl?: typeof fetch;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Content types whose body is text we can hand to a summarizer. Anything else
 * (images, archives, binaries) is refused BEFORE the body is read — it would only
 * become mojibake in the prompt, and reading it is the expensive half.
 * A response with no content-type at all is refused too: we do not sniff.
 */
function isAllowedContentType(raw: string | null): boolean {
  if (!raw) return false;
  const type = raw.split(";")[0]!.trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type === "application/xhtml+xml";
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const res = await dnsLookup(hostname, { all: true, verbatim: true });
  return res.map((r) => r.address);
}

// ── Address classification ───────────────────────────────────────────────────

function parseIpv4(addr: string): number[] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/** Expand any IPv6 text form (`::`, embedded IPv4, zone id) to 16 bytes. */
function parseIpv6(addr: string): number[] | null {
  const bare = addr.split("%")[0]!.toLowerCase();
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    const parts = s.split(":");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i === parts.length - 1 && part.includes(".")) {
        const v4 = parseIpv4(part);
        if (!v4) return null;
        out.push(v4[0]!, v4[1]!, v4[2]!, v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      const n = Number.parseInt(part, 16);
      out.push(n >> 8, n & 0xff);
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/**
 * Non-public IPv4 space. Loopback/private/link-local/CGNAT are the reachable-and-
 * interesting ones on this host (the tailnet lives in 100.64/10); 0/8 and
 * everything from 224 up (multicast, reserved, broadcast) are never a public
 * article and are refused for free.
 */
function isBlockedIpv4(b: number[]): boolean {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && c === 254) return true; // 169.254/16 link-local (cloud metadata)
  if (a === 172 && (c & 0xf0) === 16) return true; // 172.16/12 private
  if (a === 192 && c === 168) return true; // 192.168/16 private
  if (a === 100 && c >= 64 && c <= 127) return true; // 100.64/10 CGNAT — the tailnet
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(b: number[]): boolean {
  const allZeroThrough = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (allZeroThrough(15) && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) both reach the v4
  // internet through a v6 literal — judge the embedded address, not the wrapper.
  if (allZeroThrough(10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4(b.slice(12));
  }
  if (allZeroThrough(12)) return isBlockedIpv4(b.slice(12));
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** Unparseable ⇒ blocked: we refuse what we cannot judge. */
function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    const b = parseIpv4(addr);
    return b ? isBlockedIpv4(b) : true;
  }
  if (family === 6) {
    const b = parseIpv6(addr);
    return b ? isBlockedIpv6(b) : true;
  }
  return true;
}

/** Strip the brackets an IPv6 literal carries in a URL's hostname. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

// ── The guarded fetch ────────────────────────────────────────────────────────

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch `rawUrl` and return its body as text, or `null` if anything about it is
 * refused or fails. Never throws; every refusal logs exactly one warning naming
 * the reason and the URL, so a blocked capture is distinguishable from a dead link.
 */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  const lookup = options.lookup ?? defaultLookup;
  const doFetch = options.fetchImpl ?? fetch;

  const refuse = (reason: string, url: string, detail?: Record<string, unknown>): null => {
    log.warn("Refused fetch of {url}: {reason}", { url, reason, ...detail });
    return null;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let url: URL;
      try {
        url = new URL(current);
      } catch {
        return refuse("unparseable URL", current);
      }
      if (!ALLOWED_SCHEMES.has(url.protocol)) {
        return refuse(`refused scheme ${url.protocol}`, current);
      }

      // Resolve, then judge the ADDRESS — a hostname tells us nothing (`x.test` can
      // be an A record for 127.0.0.1). An IP literal is judged as-is, no DNS.
      const host = bareHost(url.hostname);
      let addresses: string[];
      if (isIP(host)) {
        addresses = [host];
      } else {
        try {
          addresses = await lookup(host);
        } catch (err) {
          return refuse("host does not resolve", current, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (addresses.length === 0) return refuse("host resolves to no address", current);
      }
      // ALL of them: a split-horizon name answering with one public and one private
      // address must not be reachable by retrying.
      const blocked = addresses.find(isBlockedAddress);
      if (blocked !== undefined) {
        return refuse(`non-public address ${blocked}`, current, { hop });
      }

      const res = await doFetch(url.toString(), {
        signal: controller.signal,
        redirect: "manual",
      });

      if (REDIRECT_STATUS.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) return refuse(`redirect ${res.status} without a location`, current);
        try {
          current = new URL(location, url).toString();
        } catch {
          return refuse("redirect to an unparseable location", current, { location });
        }
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return refuse(`status ${res.status}`, current);
      }

      const contentType = res.headers.get("content-type");
      if (!isAllowedContentType(contentType)) {
        await res.body?.cancel().catch(() => {});
        return refuse(`refused content-type ${contentType ?? "(none)"}`, current);
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        return refuse(`body too large (declared ${declared} > ${maxBytes})`, current);
      }

      // Stream with a hard cap — `await res.text()` on a 50 MB body would buffer all
      // 50 MB before `capContent` ever sees it.
      const body = res.body;
      if (!body) return "";
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return refuse(`body too large (over ${maxBytes} bytes)`, current);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock?.();
      }
      const buf = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        buf.set(c, offset);
        offset += c.byteLength;
      }
      return new TextDecoder("utf-8").decode(buf);
    }
    return refuse(`more than ${maxRedirects} redirect hops`, rawUrl);
  } catch (err) {
    return refuse("fetch failed", rawUrl, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}
