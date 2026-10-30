/**
 * Boot guards for a spec that spawns its own muninn.
 *
 * Polling the port alone accepts whatever answers there: when another muninn
 * already listens on the spec's port, the spawned one dies on `EADDRINUSE` and
 * the spec tests the foreign server (false passes and spurious failures).
 * Call `assertPortFree` before `spawn`, and `waitForOwnServer` instead of a
 * bare poll loop.
 */

import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";

/** Rejects when something accepts a TCP connection on `host:port`. */
export async function assertPortFree(port: number, host = "127.0.0.1"): Promise<void> {
  const answered = await new Promise<boolean>((resolve) => {
    const sock = connect({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1_000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
  if (answered) throw new Error(`port ${port} is already in use on ${host}: stop that server before running this spec`);
}

/** Polls `url` until it answers 2xx. Rejects at once when `child` has exited,
 *  and after `timeoutMs`. */
export async function waitForOwnServer(child: ChildProcess, url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`spawned muninn exited (code ${child.exitCode}, signal ${child.signalCode}) before ${url} answered`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        // A foreign server could still answer if ours died between the checks.
        if (child.exitCode !== null || child.signalCode !== null) continue;
        return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`spawned muninn did not answer ${url} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
