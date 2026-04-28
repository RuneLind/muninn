import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
  try {
    const proc = Bun.spawn(["bun", script], { stdio: ["ignore", "ignore", "ignore"] });
    proc.unref();
  } catch (e) {
    log.warn("Failed to spawn broker: {error}", { error: e instanceof Error ? e.message : String(e) });
    return false;
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
