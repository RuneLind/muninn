/**
 * The process backstop for synchronous throws nothing caught: a throw in a
 * timer, an event listener or an abort listener (architecture review 2026-11,
 * F47). The `unhandledRejection` handler beside it covers promises only.
 *
 * After boot: log at error with the stack and keep running, the rejection
 * backstop's policy (a single background failure must never take down the bot).
 * Before boot: log and exit 1, so a boot that fails still stops the process.
 *
 * Measured on Bun 1.3.10: once an `uncaughtException` handler is installed, a
 * top-level throw in the main module and a rejected top-level await are both
 * delivered to it (not to `unhandledRejection`), and the process carries on with
 * exit code 0. Without the pre-boot exit, a boot that throws after this is
 * installed would leave a half-started process running.
 */
import type { Logger } from "@logtape/logtape";

export const UNCAUGHT_EXCEPTION_MESSAGE = "Uncaught exception: {error}";

export interface UncaughtBackstop {
  /** Call once boot is complete: from here on a throw is logged and survived. */
  markBooted(): void;
  booted(): boolean;
}

export function installUncaughtBackstop(
  log: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): UncaughtBackstop {
  let booted = false;
  process.on("uncaughtException", (err) => {
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(UNCAUGHT_EXCEPTION_MESSAGE, { error, phase: booted ? "running" : "boot" });
    if (!booted) exit(1);
  });
  return {
    markBooted: () => {
      booted = true;
    },
    booted: () => booted,
  };
}
