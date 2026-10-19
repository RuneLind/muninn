/**
 * The declared tool surface of a one-shot model call.
 *
 * Every `executeOneShot` / `tracedOneShot` / `runCaptureOneShot` caller states
 * which tools the run may reach, as a REQUIRED option, so a new caller cannot
 * inherit the bot's whole surface by omission:
 *
 *   - `"none"`: no tools at all (`toolsDisabled` on every connector).
 *   - `{ read: dirs }`: Read only, confined to `dirs`, no MCP servers.
 *   - `{ web: true }`: WebFetch and WebSearch only, no MCP servers.
 *   - `"bot"`: the bot's own surface, stated on purpose.
 *
 * `executeOneShot` applies the surface by cloning the `BotConfig`; the claude-cli
 * (`src/ai/executor.ts`) and claude-sdk connectors map the two fenced shapes, and
 * copilot-sdk and openai-compat refuse them.
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

export type ToolSurface = "none" | "bot" | { read: string[] } | { web: true };

/** The two surfaces a connector must fence itself (no MCP, a fixed tool list). */
export type FencedToolSurface = { read: string[] } | { web: true };

export function fencedSurface(surface: ToolSurface | undefined): FencedToolSurface | undefined {
  return typeof surface === "object" ? surface : undefined;
}

export function isReadSurface(surface: ToolSurface | undefined): surface is { read: string[] } {
  return typeof surface === "object" && "read" in surface;
}

export function isWebSurface(surface: ToolSurface | undefined): surface is { web: true } {
  return typeof surface === "object" && "web" in surface;
}

/** The built-in tools a fenced surface keeps. */
export function fencedTools(surface: FencedToolSurface): string[] {
  return "read" in surface ? ["Read"] : ["WebFetch", "WebSearch"];
}

/** Oldest Claude CLI with `--restricted` (it confines the file tools and drops
 *  the settings files that pre-approve WebFetch and Bash). */
export const MIN_RESTRICTED_CLI_VERSION = "2.1.303";

/**
 * Test seam: keys merged into the one settings object a fenced run passes
 * (`--settings` on claude-cli, `settings` on claude-sdk). The fake-API test
 * sets `skipWebFetchPreflight` here, because WebFetch's domain preflight goes
 * to api.anthropic.com rather than `ANTHROPIC_BASE_URL`. `--settings` takes
 * one value and the last flag wins, so a second flag would drop the allow
 * rule; this seam is the only way to add a key. Production never sets it.
 */
export const toolSurfaceTestSeam: {
  extraSettings?: Record<string, unknown>;
  /** Hosts `fencedCanUseTool` lets WebFetch reach despite {@link isFetchableWebUrl}: the fake-API page on 127.0.0.1. */
  allowWebHosts?: string[];
  /** Overrides {@link CLI_VERSION_PROBE_TIMEOUT_MS}. */
  cliProbeTimeoutMs?: number;
  /** Overrides {@link CLI_VERSION_PROBE_KILL_GRACE_MS}. */
  cliProbeKillGraceMs?: number;
} = {};

/**
 * The settings object a fenced run passes, or `undefined` when it needs none.
 * `{ web }` pre-approves the web tools: `--restricted` ignores the settings
 * files that approve WebFetch today, and under `-p` an unapproved ask is a
 * terminal deny (measured on CLI 2.1.303: without the rule, WebFetch is denied).
 */
export function fencedSettings(surface: FencedToolSurface): Record<string, unknown> | undefined {
  const base = "web" in surface ? { permissions: { allow: ["WebFetch", "WebSearch"] } } : undefined;
  const extra = toolSurfaceTestSeam.extraSettings;
  if (!base && !extra) return undefined;
  return { ...(base ?? {}), ...(extra ?? {}) };
}

/**
 * The settings object a fenced claude-sdk run passes: the test seam only. The
 * SDK approves through `fencedCanUseTool`, and an allow rule for WebFetch would
 * approve it before the handler is asked (measured: the fake-API WebFetch to
 * 127.0.0.1 ran despite a deny from the handler while the rule was present).
 */
export function fencedSdkSettings(): Record<string, unknown> | undefined {
  const extra = toolSurfaceTestSeam.extraSettings;
  return extra ? { ...extra } : undefined;
}

/**
 * `path` with every symlink resolved the way the OS would, or `null` when that
 * cannot be known. A relative path is `null`: it would resolve against
 * muninn's cwd, not the run's. A path with a `..` segment is `null`, as
 * defense in depth: Bun's `realpathSync` applies `..` lexically before following
 * symlinks, so `<dir>/link/../x` resolves to `<dir>/x` while a raw `open` reads
 * `<link target>/../x`. The CLI and SDK Read tool normalize `..` before opening,
 * so neither reaches that gap today.
 * A path that does not exist yet resolves through its deepest existing
 * ancestor, but only when the first missing component is genuinely absent
 * (ENOENT on `lstat`, so not a dangling symlink). Any other error (ENOTDIR,
 * ENAMETOOLONG, ELOOP) is `null`.
 */
function canonicalPath(path: string): string | null {
  if (!isAbsolute(path) || path.split(sep).includes("..")) return null;
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  const segments = path.split(sep).filter((s) => s !== "" && s !== ".");
  for (let i = segments.length - 1; i >= 0; i--) {
    let real: string;
    try {
      real = realpathSync(sep + segments.slice(0, i).join(sep));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    const rest = segments.slice(i);
    try {
      lstatSync(join(real, rest[0]!));
      return null; // it exists (a dangling symlink), yet the full path did not resolve
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    return join(real, ...rest);
  }
  return null;
}

/** Whether `path`, symlinks and `..` resolved, lies inside one of `dirs`. Fails closed. */
export function isInsideDirs(path: string, dirs: string[]): boolean {
  const target = canonicalPath(path);
  if (target === null) return false;
  return dirs.some((dir) => {
    const root = canonicalPath(dir);
    if (root === null) return false;
    const prefix = root.endsWith(sep) ? root : root + sep;
    return target === root || target.startsWith(prefix);
  });
}

/**
 * Whether WebFetch on a `{ web }` run may reach `url`: http or https (the CLI
 * upgrades http), and a host that is neither a local-only name (`localhost`,
 * `*.localhost`, `*.internal`, `*.local`) nor an IP literal in a blocked range.
 * IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
 * 192.0.2/24, 192.168/16, 198.18/15 and 224/3. IPv6: fc00::/7, fe80::/10,
 * fec0::/10, ff00::/8 and 64:ff9b::/32 outside its /96 (the local-use
 * 64:ff9b:1::/48 maps private IPv4 at any prefix length), plus four prefixes
 * judged by the IPv4 they embed, checked against the IPv4 list: ::/96 (so `::`
 * and `::1` are blocked as 0.0.0.0 and 0.0.0.1), ::ffff:0:0/96, 64:ff9b::/96
 * (last 4 bytes) and 2002::/16 (bytes 2–5). No other range is blocked:
 * 198.51.100/24, 203.0.113/24, 2001:db8::/32, 100::/64 and Teredo 2001::/32
 * pass. The denylist table in tool-surface.test.ts is this list. The URL
 * parser normalizes `2130706433` and `0x7f.1` to `127.0.0.1` first. A name that
 * RESOLVES to a private address passes: this checks the URL, not DNS.
 */
export function isFetchableWebUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost") return false;
  if (/\.(localhost|internal|local)$/.test(host)) return false;
  if (host.startsWith("[")) {
    const bytes = ipv6Bytes(host.slice(1, -1));
    return bytes !== null && isPublicIpv6(bytes);
  }
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return isPublicIpv4(v4.slice(1).map(Number));
  return true;
}

function testSeamAllowsHost(url: string): boolean {
  const hosts = toolSurfaceTestSeam.allowWebHosts;
  if (!hosts) return false;
  try {
    return hosts.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast + reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0/24 IETF protocol assignments, 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  return true;
}

/** The 16 bytes of a URL-normalized IPv6 literal (hex groups, at most one `::`), or `null`. */
function ipv6Bytes(literal: string): number[] | null {
  const halves = literal.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function isPublicIpv6(b: number[]): boolean {
  const zeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped).
  if (zeroUpTo(10) && ((b[10] === 0 && b[11] === 0) || (b[10] === 0xff && b[11] === 0xff))) {
    return isPublicIpv4(b.slice(12));
  }
  // NAT64 64:ff9b::/96, by its IPv4 (RFC 6052 §3.1 bars it from carrying a non-global one).
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return isPublicIpv4(b.slice(12));
  }
  // The rest of 64:ff9b::/32: RFC 8215's local-use 64:ff9b:1::/48 translates to private IPv4 at any prefix length.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return false;
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicIpv4(b.slice(2, 6)); // 6to4 2002::/16
  if ((b[0]! & 0xfe) === 0xfc) return false; // unique-local fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0x80) === 0x80) return false; // link-local fe80::/10 and site-local fec0::/10
  if (b[0] === 0xff) return false; // multicast
  return true;
}

/**
 * The claude-sdk permission handler for a fenced run: Read only under the
 * `{ read }` dirs, WebSearch and {@link isFetchableWebUrl} WebFetch only on
 * `{ web }`, everything else denied.
 * In `default` mode a Read inside the working dirs never reaches this handler;
 * every other call does.
 */
export function fencedCanUseTool(surface: FencedToolSurface): CanUseTool {
  return async (toolName, input) => {
    if ("read" in surface && toolName === "Read") {
      const filePath = input.file_path;
      if (typeof filePath === "string" && isInsideDirs(filePath, surface.read)) {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "Read is limited to the directories this run was given." };
    }
    if ("web" in surface && toolName === "WebSearch") {
      return { behavior: "allow", updatedInput: input };
    }
    if ("web" in surface && toolName === "WebFetch") {
      const url = input.url;
      if (typeof url === "string" && (isFetchableWebUrl(url) || testSeamAllowsHost(url))) {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "WebFetch is limited to public https hosts." };
    }
    return { behavior: "deny", message: `${toolName} is not available to this run.` };
  };
}

/**
 * Throw on a fenced surface in a connector that cannot express one. The
 * `executeOneShot` pre-flight already refuses it by capability; this is the
 * connector's own refusal, for a caller that reaches it another way.
 */
export function refuseFencedSurface(connector: string, surface: ToolSurface | undefined): void {
  const fence = fencedSurface(surface);
  if (!fence) return;
  const kind = "read" in fence ? "{ read }" : "{ web }";
  throw new Error(`${connector}: the ${kind} tool surface is not supported — only claude-cli and claude-sdk can fence it.`);
}

/** Compare dotted numeric versions; negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** How long `claude --version` may take before the probe reads it as absent. */
export const CLI_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** How long a timed-out probe gets to exit on SIGTERM before it is sent SIGKILL. */
export const CLI_VERSION_PROBE_KILL_GRACE_MS = 1_000;

/** Resolves true when `proc` exits within `ms`, false otherwise. */
function exitsWithin(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([proc.exited.then(() => true as const), late]).finally(() => clearTimeout(timer));
}

/** SIGTERM, then SIGKILL after a grace period, so a probe that ignores SIGTERM does not outlive the call. */
async function stopProbe(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const grace = toolSurfaceTestSeam.cliProbeKillGraceMs ?? CLI_VERSION_PROBE_KILL_GRACE_MS;
  proc.kill("SIGTERM");
  if (await exitsWithin(proc, grace)) return;
  proc.kill("SIGKILL");
  await exitsWithin(proc, grace);
}

/** A version that passed the gate: the only thing cached, so a failed or old read is retried next call. */
let cliVersion: string | undefined;
let pinnedVersion: { version: string | null } | undefined;
let inFlight: Promise<string | null> | undefined;

async function probeCliVersion(): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch {
    return null;
  }
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      void stopProbe(proc).then(() => resolve(null));
    }, toolSurfaceTestSeam.cliProbeTimeoutMs ?? CLI_VERSION_PROBE_TIMEOUT_MS);
  });
  const read = (async () => {
    const out = await new Response(stdout).text();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return (await proc.exited) === 0 && match ? match[1]! : null;
  })().catch(() => null);
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The installed `claude` CLI version, `null` when unreadable. Read off the
 * event loop with a timeout; only a version new enough for `--restricted` is
 * cached, so a transient failure (an auto-update mid-flight) or an upgrade
 * after an old read is picked up by the next fenced call without a restart.
 */
export async function installedClaudeCliVersion(): Promise<string | null> {
  if (pinnedVersion) return pinnedVersion.version;
  if (cliVersion !== undefined) return cliVersion;
  inFlight ??= probeCliVersion().finally(() => {
    inFlight = undefined;
  });
  const version = await inFlight;
  if (version !== null && compareVersions(version, MIN_RESTRICTED_CLI_VERSION) >= 0) cliVersion = version;
  return version;
}

/** Test seam: pin the version {@link installedClaudeCliVersion} reports (`undefined` unpins and clears the cache). */
export function __setClaudeCliVersionForTest(version: string | null | undefined): void {
  pinnedVersion = version === undefined ? undefined : { version };
  cliVersion = undefined;
}

/** Whether the installed CLI has `--restricted`. */
export async function restrictedCliAvailable(): Promise<boolean> {
  const version = await installedClaudeCliVersion();
  return version !== null && compareVersions(version, MIN_RESTRICTED_CLI_VERSION) >= 0;
}

/** Throw unless the installed CLI has `--restricted`, which a fenced surface needs. */
export async function assertRestrictedCliAvailable(surface: FencedToolSurface): Promise<void> {
  const version = await installedClaudeCliVersion();
  if (version === null || compareVersions(version, MIN_RESTRICTED_CLI_VERSION) < 0) {
    const kind = "read" in surface ? "{ read }" : "{ web }";
    throw new Error(
      `claude-cli: the ${kind} tool surface needs Claude CLI ${MIN_RESTRICTED_CLI_VERSION} or newer ` +
        `(--restricted); found ${version ?? "no readable version"}.`,
    );
  }
}
