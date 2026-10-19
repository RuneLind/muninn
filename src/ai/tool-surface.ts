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

/**
 * Agent-home bucket for a fenced run's cwd (`resolveAgentCwd`). An empty dir
 * outside the bot folder: a Read inside the working dir needs no approval, so
 * the bot folder as cwd would leave `config.json` and `.mcp.json` readable.
 */
export const FENCED_AGENT_CWD_BUCKET = "capture";

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
export const toolSurfaceTestSeam: { extraSettings?: Record<string, unknown> } = {};

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
 * `path` with every symlink resolved the way the OS would, or `null` when that
 * cannot be known. A relative path is `null`: it would resolve against
 * muninn's cwd, not the run's. A path with a `..` segment is `null`: Bun's
 * `realpathSync` applies `..` lexically before following symlinks, so
 * `<dir>/link/../x` resolves to `<dir>/x` while the OS reads `<link target>/../x`.
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
 * The claude-sdk permission handler for a fenced run: Read only under the
 * `{ read }` dirs, the web tools only on `{ web }`, everything else denied.
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
    if ("web" in surface && (toolName === "WebFetch" || toolName === "WebSearch")) {
      return { behavior: "allow", updatedInput: input };
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

let cliVersion: string | null | undefined;

/** The installed `claude` CLI version, read once per process; `null` when unreadable. */
export function installedClaudeCliVersion(): string | null {
  if (cliVersion !== undefined) return cliVersion;
  try {
    const out = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "ignore" });
    const match = out.stdout.toString().match(/(\d+\.\d+\.\d+)/);
    cliVersion = out.exitCode === 0 && match ? match[1]! : null;
  } catch {
    cliVersion = null;
  }
  return cliVersion;
}

/** Test seam: pin the version {@link installedClaudeCliVersion} reports (`undefined` re-reads). */
export function __setClaudeCliVersionForTest(version: string | null | undefined): void {
  cliVersion = version;
}

/** Throw unless the installed CLI has `--restricted`, which a fenced surface needs. */
export function assertRestrictedCliAvailable(surface: FencedToolSurface): void {
  const version = installedClaudeCliVersion();
  if (version === null || compareVersions(version, MIN_RESTRICTED_CLI_VERSION) < 0) {
    const kind = "read" in surface ? "{ read }" : "{ web }";
    throw new Error(
      `claude-cli: the ${kind} tool surface needs Claude CLI ${MIN_RESTRICTED_CLI_VERSION} or newer ` +
        `(--restricted); found ${version ?? "no readable version"}.`,
    );
  }
}
