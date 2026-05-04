import { $ } from "bun";
import { getLog } from "../logging.ts";

const log = getLog("startup", "adapter-audit");

/**
 * MCP adapter processes whose env is examined at muninn startup. Each entry's
 * pattern is fed to `pgrep -f`. The label is what shows up in log output.
 *
 * The motivating bug is huginn's `knowledge_api_mcp_adapter.py`: it captures
 * `HUGINN_TRACE_*` at Python module-load time, so an adapter spawned before
 * those env vars reached its parent process will silently skip all trace
 * marker emission for the rest of its lifetime. Logging adapter PID + env at
 * muninn startup makes intermittent search-trace failures self-explanatory in
 * the logs without needing per-span instrumentation.
 */
const TARGETS: Array<{ label: string; pattern: string }> = [
  { label: "knowledge MCP adapter", pattern: "knowledge_api_mcp_adapter" },
  { label: "copilot SDK headless child", pattern: "@github/copilot/index.js --headless" },
];

/** Subset of process env relevant to trace-marker emission. */
const ENV_KEYS_TO_REPORT = ["HUGINN_TRACE_POINTER", "HUGINN_TRACE_DEFAULT", "YGGDRASIL_TRACE_DEFAULT"];

interface AdapterProc {
  pid: number;
  ppid: number;
  etime: string;
  env: Partial<Record<string, string>>;
}

async function pgrep(pattern: string): Promise<number[]> {
  const out = await $`pgrep -f ${pattern}`.nothrow().text();
  return out.trim().split("\n").filter(Boolean).map(Number);
}

async function describe(pid: number): Promise<{ ppid: number; etime: string } | null> {
  const out = await $`ps -o ppid=,etime= -p ${pid}`.nothrow().text();
  const m = out.trim().match(/^(\d+)\s+(\S+)$/);
  if (!m) return null;
  return { ppid: Number(m[1]), etime: m[2]! };
}

/**
 * Pluck the env keys we care about out of `ps eww` output. Pure helper so the
 * tokenizing rules — split on whitespace, key=value with `=` strictly inside —
 * are independently testable without spawning a process.
 */
export function parseHuginnEnvFromPs(text: string, keys: readonly string[] = ENV_KEYS_TO_REPORT): Partial<Record<string, string>> {
  const env: Partial<Record<string, string>> = {};
  for (const tok of text.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    if (keys.includes(key)) env[key] = tok.slice(eq + 1);
  }
  return env;
}

async function readHuginnEnv(pid: number): Promise<Partial<Record<string, string>>> {
  // ps eww emits the full env on darwin/linux; filtering here keeps the log
  // output bounded to what diagnoses the silent-skip path.
  const out = await $`ps eww -o command= -p ${pid}`.nothrow().text();
  return parseHuginnEnvFromPs(out);
}

export async function findAdapters(target: { label: string; pattern: string }): Promise<AdapterProc[]> {
  const pids = await pgrep(target.pattern);
  const procs: AdapterProc[] = [];
  for (const pid of pids) {
    const meta = await describe(pid);
    if (!meta) continue;
    const env = await readHuginnEnv(pid);
    procs.push({ pid, ppid: meta.ppid, etime: meta.etime, env });
  }
  return procs;
}

/**
 * Snapshot existing MCP adapter processes and log their HUGINN_TRACE_* env to
 * the structured log. Idempotent and best-effort: any error short-circuits to
 * a single warn. Run early in startup, after `setupLogging`, before the first
 * connector spawn.
 *
 * After `predev: "cleanup:kill"` ran, this should typically log "no adapters
 * present" — that's the healthy state. If adapters survive cleanup (e.g. they
 * belong to a sibling muninn or Claude Desktop), the env audit lets us tell at
 * a glance whether they'll emit trace markers or not.
 */
export async function auditMcpAdapters(): Promise<void> {
  try {
    for (const target of TARGETS) {
      const procs = await findAdapters(target);
      if (procs.length === 0) {
        log.info("MCP audit: no {label} processes running", { label: target.label });
        continue;
      }
      for (const p of procs) {
        const traceCapable =
          p.env.HUGINN_TRACE_POINTER === "1" || p.env.HUGINN_TRACE_DEFAULT === "1";
        log.info(
          "MCP audit: {label} pid={pid} ppid={ppid} age={etime} pointer={pointer} default={default_} traceCapable={cap}",
          {
            label: target.label,
            pid: p.pid,
            ppid: p.ppid,
            etime: p.etime,
            pointer: p.env.HUGINN_TRACE_POINTER ?? "(unset)",
            default_: p.env.HUGINN_TRACE_DEFAULT ?? "(unset)",
            cap: traceCapable,
          },
        );
        if (!traceCapable) {
          log.warn(
            "Stale {label} pid={pid} has no HUGINN_TRACE_* env — search calls routed to it will silently skip the trace marker. Run `bun run cleanup:kill` to evict it.",
            { label: target.label, pid: p.pid },
          );
        }
      }
    }
  } catch (e) {
    log.warn("MCP adapter audit failed: {error}", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
