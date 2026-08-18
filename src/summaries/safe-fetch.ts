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
 * The size cap TRUNCATES, it does not refuse: it bounds the PROCESS, never the
 * prompt — `capContent` still trims what comes back. A 3 MB Wikipedia article is a
 * legitimate capture that used to be fetched whole and then trimmed to 100k chars;
 * turning it into "no enrichment at all" would be a regression dressed as a guard.
 * The only thing the cap has to prevent is muninn buffering the whole body.
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
/** Covers the whole operation — DNS, every hop, and the body read. */
export const SAFE_FETCH_TIMEOUT_MS = 20_000;
/**
 * Headroom over the chains the vertical's OWN `directFetchUrl` rewrite walks.
 * Measured 2026-08-18 on `docs.anthropic.com/**.md`: the ordinary page is 2 hops
 * (301 to platform.claude.com → 307 path rewrite → 200), but a page that has moved
 * off the docs site is 4 — `…/agents-and-tools/mcp.md` lands on
 * modelcontextprotocol.io, and at a cap of 3 it was refused where 4 and 5 return
 * 274 836 chars. So 3 was not headroom, it was already cutting real doc URLs.
 */
export const SAFE_FETCH_MAX_REDIRECTS = 5;

/** Resolve a hostname to its addresses. Test seam — production uses `node:dns`. */
export type HostLookup = (hostname: string) => Promise<string[]>;

export interface SafeFetchOptions {
  /** Whole-operation timeout (default {@link SAFE_FETCH_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Body cap in bytes (default {@link SAFE_FETCH_MAX_BYTES}). Over it ⇒ truncated. */
  maxBytes?: number;
  /** Redirect hops to follow (default {@link SAFE_FETCH_MAX_REDIRECTS}). */
  maxRedirects?: number;
  /**
   * Which call site this is (`"enrichment"`, `"direct"`, …). Logged with every
   * refusal — both call sites follow third-party URLs and a bare "Refused fetch of
   * …" line does not say which capture path just degraded.
   */
  caller?: string;
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
 * everything from 224 up (multicast, 240/4 reserved, broadcast) are never a public
 * article and are refused for free. The documentation and benchmarking ranges are
 * in here for the same reason — nothing legitimate is served from them, and
 * 192.88.99/24 (the 6to4 relay anycast) is a router, not a web page.
 */
function isBlockedIpv4(b: number[]): boolean {
  const [a, second, third] = [b[0]!, b[1]!, b[2]!];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && second === 254) return true; // 169.254/16 link-local (cloud metadata)
  if (a === 172 && (second & 0xf0) === 16) return true; // 172.16/12 private
  if (a === 192 && second === 168) return true; // 192.168/16 private
  if (a === 100 && second >= 64 && second <= 127) return true; // 100.64/10 CGNAT — the tailnet
  if (a === 192 && second === 0 && third === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 192 && second === 0 && third === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && second === 88 && third === 99) return true; // 192.88.99/24 6to4 relay anycast
  if (a === 198 && (second & 0xfe) === 18) return true; // 198.18/15 benchmarking
  if (a === 198 && second === 51 && third === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && second === 0 && third === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // multicast + 240/4 reserved + broadcast
  return false;
}

/**
 * Where RFC 6052 puts the embedded IPv4 for each translation-prefix length. The
 * `u` octet (byte 8) is reserved and skipped, which is why these are not four
 * consecutive indices below /96.
 */
const RFC6052_V4_SLOTS: number[][] = [
  [6, 7, 9, 10], // /48
  [7, 9, 10, 11], // /56
  [9, 10, 11, 12], // /64
  [12, 13, 14, 15], // /96
];

function ipv4At(b: number[], slot: number[]): number[] {
  return slot.map((i) => b[i]!);
}

/**
 * Non-public IPv6 space, INCLUDING every form that carries an IPv4 address inside a
 * v6 literal. That second half is the one that bites: `64:ff9b::7f00:1`,
 * `2002:7f00:1::` and `::ffff:0:7f00:1` are all "IPv6 addresses" no v6 range test
 * flags, and all three reach 127.0.0.1 through a translator. Unwrap them and judge
 * the embedded v4 with the v4 rules — blanket-refusing the wrapper prefixes instead
 * would refuse the legitimate public destinations reached through them.
 */
function isBlockedIpv6(b: number[]): boolean {
  const allZeroThrough = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (allZeroThrough(15) && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified

  // ── v4-in-v6 wrappers: judge what is INSIDE ──
  if (allZeroThrough(10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4(b.slice(12)); // ::ffff:a.b.c.d — IPv4-mapped
  }
  if (allZeroThrough(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return isBlockedIpv4(b.slice(12)); // ::ffff:0:a.b.c.d — IPv4-translated (RFC 2765)
  }
  if (allZeroThrough(12)) return isBlockedIpv4(b.slice(12)); // ::a.b.c.d — IPv4-compatible
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b[4] === 0x00 && b[5] === 0x01) {
      // 64:ff9b:1::/48 — RFC 8215 local-use NAT64. The operator picks the embedding
      // length, so judge EVERY slot the prefix leaves room for and refuse if any of
      // them reads as a blocked v4; guessing one slot is how a bypass gets in.
      return RFC6052_V4_SLOTS.some((slot) => isBlockedIpv4(ipv4At(b, slot)));
    }
    return isBlockedIpv4(b.slice(12)); // 64:ff9b::/96 — the well-known NAT64 prefix
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4(b.slice(2, 6)); // 2002::/16 — 6to4

  // ── ranges that are non-public whatever they contain ──
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) {
    return true; // 100::/64 discard-only
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3]! & 0xf0) === 0x20) {
    return true; // 2001:20::/28 ORCHIDv2
  }
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
 * A promise that rejects when `signal` aborts, plus the cleanup that removes the
 * listener when it does not. Exists so the DNS phase is inside the timeout: `fetch`
 * takes the signal, `lookup` cannot, and a resolver that hangs for 3 s under a
 * 300 ms budget made the header's "covers the whole operation" a lie.
 */
function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let dispose = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => signal.removeEventListener("abort", onAbort);
  });
  // The lookup usually wins the race, leaving this promise to reject with nobody
  // awaiting it — swallow that rather than tripping an unhandled rejection.
  promise.catch(() => {});
  return { promise, dispose };
}

/**
 * Fetch `rawUrl` and return its body as text, or `null` if anything about it is
 * refused or fails. Never throws; every refusal logs exactly one warning naming
 * the reason, the CURRENT hop and the caller, so a blocked capture is
 * distinguishable from a dead link and from a timeout.
 *
 * A body over `maxBytes` comes back TRUNCATED to the cap (logged at info), not
 * refused — see the header.
 */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const lookup = options.lookup ?? defaultLookup;
  const doFetch = options.fetchImpl ?? fetch;
  const caller = options.caller ?? "unspecified";

  const refuse = (reason: string, url: string, detail?: Record<string, unknown>): null => {
    log.warn("Refused fetch of {url} for {caller}: {reason}", { url, caller, reason, ...detail });
    return null;
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Declared outside the try so the catch-all can name the hop that actually failed
  // rather than the URL we started from — after two redirects they are different
  // hosts, and "fetch failed: <original>" sends the operator to the wrong one.
  let current = rawUrl;
  try {
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
        const abortRace = rejectOnAbort(controller.signal);
        try {
          addresses = await Promise.race([lookup(host), abortRace.promise]);
        } catch (err) {
          // A timeout during DNS is a timeout, not an NXDOMAIN — rethrow so the
          // catch-all reports it as one.
          if (timedOut) throw err;
          return refuse("host does not resolve", current, {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          abortRace.dispose();
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

      // Cheap early-out only. `content-length` is the WIRE length, and real hosts
      // serve gzip, so it is compared against a cap that measures the DECOMPRESSED
      // body — on a compressed response it under-reports and this practically never
      // fires. The streaming cap below is the one that actually bounds the process;
      // this just avoids opening a body that admits, uncompressed, to being oversized.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        return refuse(`body too large (declared ${declared} > ${maxBytes})`, current);
      }

      // Stream with a hard cap — `await res.text()` on a 50 MB body would buffer all
      // 50 MB before `capContent` ever sees it. Over the cap we keep what we have and
      // stop pulling: a truncated article still summarizes, a refused one does not.
      const body = res.body;
      if (!body) return "";
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          // `>` not `>=`: a body that ends exactly ON the cap is complete, not
          // truncated, and must not be logged (or reported) as cut short.
          const room = maxBytes - total;
          if (value.byteLength > room) {
            chunks.push(value.subarray(0, room));
            total += room;
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
          total += value.byteLength;
        }
      } finally {
        reader.releaseLock?.();
      }
      if (truncated) {
        log.info("Truncated {url} for {caller} at the {maxBytes}-byte cap", {
          url: current,
          caller,
          maxBytes,
        });
      }
      const buf = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        buf.set(c, offset);
        offset += c.byteLength;
      }
      // Non-fatal decode: cutting at a byte boundary can split a multi-byte
      // codepoint, and one U+FFFD at the tail is not worth losing the article over.
      return new TextDecoder("utf-8").decode(buf);
    }
    return refuse(`more than ${maxRedirects} redirect hops`, current);
  } catch (err) {
    return refuse(timedOut ? `timed out after ${timeoutMs}ms` : "fetch failed", current, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}
