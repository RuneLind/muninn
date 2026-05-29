import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getLog } from "../logging.ts";
import { optionalEnvInt } from "../config.ts";

const log = getLog("hivemind", "broker");

const DEFAULT_BROKER_PORT = 7899;
const DEFAULT_BROKER_SCRIPT = resolve(homedir(), "source/private/claude-hivemind/src/broker.ts");
const HEALTH_TIMEOUT_MS = 1500;
const STARTUP_POLL_INTERVAL_MS = 100;
const STARTUP_MAX_WAIT_MS = 6_000;

function brokerScript(): string {
  return process.env.HIVEMIND_BROKER_SCRIPT ?? DEFAULT_BROKER_SCRIPT;
}

/** Append-mode fd for the broker log, or undefined if file logging is disabled
 *  (LOG_DIR=none) or the directory can't be created. `||` (not `??`) so a blank
 *  `LOG_DIR=` falls through to the default — otherwise `join("", "hivemind-
 *  broker.log")` would land the log in the muninn process cwd. */
function openBrokerLogFd(): number | undefined {
  const logDir = process.env.LOG_DIR || "./logs";
  if (logDir === "none") return undefined;
  try {
    mkdirSync(logDir, { recursive: true });
    return openSync(join(logDir, "hivemind-broker.log"), "a");
  } catch (e) {
    log.warn("Could not open broker log file in {logDir}: {error}", {
      logDir,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

export function brokerPort(): number {
  return optionalEnvInt("HIVEMIND_BROKER_PORT", DEFAULT_BROKER_PORT);
}

/** Check if the broker's HTTP /health endpoint responds. */
export async function isBrokerAlive(port = brokerPort()): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the hivemind broker daemon is running. If not alive, spawn it
 * detached and wait up to ~6s for /health to respond.
 *
 * Returns false if the broker script can't be found — caller should
 * surface this to the user (probably means claude-hivemind isn't installed).
 */
export async function ensureBrokerRunning(): Promise<boolean> {
  const port = brokerPort();
  if (await isBrokerAlive(port)) {
    log.info("Broker already running on :{port}", { port });
    return true;
  }

  const script = brokerScript();
  if (!existsSync(script)) {
    log.warn(
      "Broker script not found at {script}. Set HIVEMIND_BROKER_SCRIPT or install claude-hivemind at the default path.",
      { script },
    );
    return false;
  }

  log.info("Spawning broker daemon: bun {script}", { script });
  // Redirect the detached broker's stdout/stderr to a log file so a crash after
  // the /health window is diagnosable (the process outlives muninn, so the file
  // — not proc.exited — is the durable record). logFd is declared outside the
  // try so the `finally` can close it whether spawn succeeds or throws (a
  // spawn failure mid-try would otherwise leak the fd, and repeated retries
  // would compound the leak).
  let logFd: number | undefined;
  try {
    logFd = openBrokerLogFd();
    const proc = Bun.spawn(["bun", script], {
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    });
    proc.unref();
    // Best-effort: if the broker dies while muninn is still up, log it. (For a
    // daemon that outlives muninn this never fires — the log file covers that.)
    proc.exited
      .then((code) => log.warn("Broker process exited with code {code}", { code }))
      .catch(() => {});
  } catch (e) {
    log.warn("Failed to spawn broker: {error}", { error: e instanceof Error ? e.message : String(e) });
    return false;
  } finally {
    // The child has its own dup of the fd; close our copy. Wrapped in a
    // best-effort try because a closeSync failure (e.g. EIO on a network FS)
    // shouldn't fail the whole startup after the broker is already running.
    if (logFd !== undefined) {
      try { closeSync(logFd); } catch { /* best-effort */ }
    }
  }

  const deadline = Date.now() + STARTUP_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isBrokerAlive(port)) {
      log.info("Broker started on :{port}", { port });
      return true;
    }
    await new Promise((r) => setTimeout(r, STARTUP_POLL_INTERVAL_MS));
  }
  log.warn("Broker failed to come online within {ms}ms", { ms: STARTUP_MAX_WAIT_MS });
  return false;
}
