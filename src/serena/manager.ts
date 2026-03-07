import { resolve } from "node:path";
import type { Subprocess } from "bun";
import type { SerenaInstanceConfig } from "./config.ts";
import { discoverSerenaConfigs } from "./config.ts";
import { getLog } from "../logging.ts";

const log = getLog("serena", "manager");

export type SerenaStatus = "stopped" | "starting" | "indexing" | "running" | "error";

export interface SerenaInstance {
  config: SerenaInstanceConfig;
  botName: string;
  status: SerenaStatus;
  error?: string;
  startedAt?: number;
  /** The Serena MCP endpoint URL when running */
  mcpUrl?: string;
  /** Serena's own dashboard URL when running */
  dashboardUrl?: string;
  /** Internal — spawned process */
  proc?: Subprocess;
}

/** How long to wait for Serena to become ready (health check) */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;

class SerenaManager {
  private instances = new Map<string, SerenaInstance>();
  /** Guards against concurrent start/stop/index on the same instance */
  private pending = new Set<string>();

  /** Initialize from bot configs. Call once at startup. */
  init(): void {
    const botsDir = resolve(import.meta.dir, "../../bots");
    const configs = discoverSerenaConfigs(botsDir);
    for (const botConfig of configs) {
      for (const inst of botConfig.instances) {
        if (this.instances.has(inst.name)) {
          log.warn("Duplicate Serena instance name \"{name}\" in bot \"{bot}\" — overwriting", { name: inst.name, bot: botConfig.botName });
        }
        this.instances.set(inst.name, {
          config: inst,
          botName: botConfig.botName,
          status: "stopped",
        });
      }
    }
    if (this.instances.size > 0) {
      log.info("Discovered {count} Serena instances", { count: this.instances.size });
    }
  }

  getInstances(): SerenaInstance[] {
    return Array.from(this.instances.values());
  }

  getInstance(name: string): SerenaInstance | undefined {
    return this.instances.get(name);
  }

  async start(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`Unknown Serena instance: ${name}`);
    if (instance.status !== "stopped" && instance.status !== "error") return;
    if (this.pending.has(name)) return;
    this.pending.add(name);

    instance.status = "starting";
    instance.error = undefined;

    try {
      const port = instance.config.port;

      // Kill any stale process left on this port from a previous muninn run
      await this.killStaleProcess(port);

      // Spawn Serena with native streamable-http transport
      const proc = Bun.spawn([
        "uvx", "--from", "git+https://github.com/oraios/serena",
        "serena", "start-mcp-server",
        "--transport", "streamable-http",
        "--port", String(port),
        "--host", "127.0.0.1",
        "--context", "claude-code",
        "--project", instance.config.projectPath,
        "--open-web-dashboard", "False",
      ], {
        stdout: "inherit",
        stderr: "inherit",
      });

      instance.proc = proc;
      instance.mcpUrl = `http://127.0.0.1:${port}/mcp`;
      instance.dashboardUrl = `http://127.0.0.1:24282/dashboard/index.html`;

      // Wait for the MCP endpoint to become reachable
      const ready = await this.waitForReady(instance.mcpUrl, proc, READY_TIMEOUT_MS);

      if (!ready) {
        if (proc.exitCode !== null) {
          throw new Error(`Serena exited with code ${proc.exitCode} (check terminal for output)`);
        }
        throw new Error(`Serena did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
      }

      // Double-check our process is still alive (not a stale port hit)
      if (proc.exitCode !== null) {
        throw new Error(`Serena exited with code ${proc.exitCode} during startup`);
      }

      instance.startedAt = Date.now();
      instance.status = "running";

      // Monitor for unexpected exit
      proc.exited.then((code) => {
        if (instance.status === "running") {
          instance.status = "error";
          instance.error = `Process exited unexpectedly with code ${code}`;
          instance.proc = undefined;
          log.error("Serena {name} exited unexpectedly with code {code}", { name, code });
        }
      });

      log.info("Serena {name} started on port {port}", { name, port });
    } catch (e) {
      instance.status = "error";
      instance.error = String(e);
      log.error("Failed to start Serena {name}: {error}", { name, error: String(e) });
      this.killProc(instance);
    } finally {
      this.pending.delete(name);
    }
  }

  async stop(name: string, force = false): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`Unknown Serena instance: ${name}`);
    if (instance.status === "stopped") return;
    if (!force && this.pending.has(name)) return;

    log.info("Stopping Serena {name}{force}", { name, force: force ? " (forced)" : "" });
    this.killProc(instance);
    instance.status = "stopped";
    instance.error = undefined;
    instance.startedAt = undefined;
    instance.mcpUrl = undefined;
    instance.dashboardUrl = undefined;
  }

  async index(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`Unknown Serena instance: ${name}`);
    if (instance.status === "running" || instance.status === "starting") {
      throw new Error(`Stop ${name} before re-indexing`);
    }
    if (this.pending.has(name)) return;
    this.pending.add(name);

    instance.status = "indexing";
    instance.error = undefined;

    try {
      log.info("Indexing Serena {name} at {path}", {
        name,
        path: instance.config.projectPath,
      });

      const indexProc = Bun.spawn([
        "uvx", "--from", "git+https://github.com/oraios/serena",
        "serena", "project", "index",
        instance.config.projectPath,
        "--timeout", "300",
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });

      // Store so stopAll() can kill it
      instance.proc = indexProc;

      const exitCode = await indexProc.exited;
      instance.proc = undefined;
      instance.status = "stopped";

      if (exitCode !== 0) {
        const stderr = await new Response(indexProc.stderr).text();
        instance.error = `Index exited with code ${exitCode}: ${stderr.slice(0, 500)}`;
        log.error("Serena index {name} failed: {error}", { name, error: instance.error });
      } else {
        log.info("Serena {name} indexed successfully", { name });
      }
    } catch (e) {
      instance.proc = undefined;
      instance.status = "stopped";
      instance.error = String(e);
      log.error("Serena index {name} error: {error}", { name, error: String(e) });
    } finally {
      this.pending.delete(name);
    }
  }

  async stopAll(): Promise<void> {
    const active = Array.from(this.instances.values()).filter(
      (i) => i.status !== "stopped",
    );
    // Force-stop all instances, bypassing pending guards (shutdown path)
    await Promise.allSettled(active.map((i) => this.stop(i.config.name, true)));
  }

  private killProc(instance: SerenaInstance): void {
    if (instance.proc) {
      try {
        instance.proc.kill();
      } catch { /* ignore */ }
      instance.proc = undefined;
    }
  }

  /** Kill any process listening on the given port (orphan from previous run). */
  private async killStaleProcess(port: number): Promise<void> {
    try {
      const proc = Bun.spawn(["lsof", "-ti", `:${port}`], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      const pids = output.trim().split("\n").filter(Boolean);
      for (const pid of pids) {
        const n = parseInt(pid, 10);
        if (!isNaN(n)) {
          log.warn("Killing stale process {pid} on port {port}", { pid: n, port });
          process.kill(n, "SIGTERM");
        }
      }
      if (pids.length > 0) {
        // Give it a moment to release the port
        await Bun.sleep(1000);
      }
    } catch {
      // lsof not found or no process — fine
    }
  }

  private async waitForReady(url: string, proc: Subprocess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Bail early if the process already exited
      if (proc.exitCode !== null) return false;
      try {
        // A simple GET to the MCP endpoint — Serena returns 405 (Method Not Allowed)
        // when it's up but only accepts POST. Any non-connection-error means it's ready.
        await fetch(url, { signal: AbortSignal.timeout(2000) });
        // Any response (even 4xx/5xx) means the server is listening
        return true;
      } catch {
        // Connection refused — not ready yet
      }
      await Bun.sleep(READY_POLL_MS);
    }
    return false;
  }
}

export const serenaManager = new SerenaManager();
