/**
 * The guard behind `own-server.ts`. Run by `bun test`, not by Playwright: a
 * spec that boots its own muninn must refuse a port something else already
 * answers on, and must stop waiting once its own process has exited.
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";

describe("assertPortFree", () => {
  it("rejects a port another server already listens on", async () => {
    const busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("foreign") });
    try {
      const t0 = Date.now();
      await expect(assertPortFree(busy.port!)).rejects.toThrow(`port ${busy.port} is already in use`);
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      busy.stop(true);
    }
  });

  it("resolves on a free port", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port!;
    probe.stop(true);
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });
});

describe("waitForOwnServer", () => {
  it("fails fast when the spawned process has exited", async () => {
    const child = spawn("bun", ["-e", "process.exit(3)"], { stdio: "ignore" });
    const t0 = Date.now();
    await expect(waitForOwnServer(child, "http://127.0.0.1:1/never", 20_000)).rejects.toThrow("exited");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("resolves once the URL answers while the process runs", async () => {
    const up = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const child = spawn("bun", ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    try {
      await expect(waitForOwnServer(child, `http://127.0.0.1:${up.port}/`, 5_000)).resolves.toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      up.stop(true);
    }
  });
});
