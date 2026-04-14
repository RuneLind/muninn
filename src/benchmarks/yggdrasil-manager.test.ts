/**
 * Tests for the benchmark-scoped Yggdrasil manager.
 *
 * The pure tests (port allocation, bench-name building) run under `bun test`
 * normally. The lifecycle integration test is gated behind the env var
 * RUN_YGGDRASIL_INTEGRATION_TEST=1 because it:
 *   1. spawns the real Yggdrasil indexer subprocess,
 *   2. talks to the shared muninn Postgres (requires `bun run db:up`),
 *   3. writes and then deletes a row in `ci_repos`.
 *
 * All of that is too heavy for the normal unit suite, but it's the only way
 * to actually exercise the full path (index → spawn MCP → DELETE → cascade).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { loadConfig } from "../config.ts";
import {
  allocateBenchmarkYggdrasilPort,
  BENCHMARK_YGGDRASIL_PORT_BASE,
  benchmarkYggdrasilManager,
  buildBenchRepoName,
} from "./yggdrasil-manager.ts";

describe("buildBenchRepoName", () => {
  test("prefixes with bench-<issue>-<repo>", () => {
    expect(buildBenchRepoName("MELOSYS-7588", "melosys-api")).toBe(
      "bench-MELOSYS-7588-melosys-api",
    );
  });

  test("is stable for the same inputs", () => {
    const a = buildBenchRepoName("FOO-1", "bar");
    const b = buildBenchRepoName("FOO-1", "bar");
    expect(a).toBe(b);
  });
});

describe("allocateBenchmarkYggdrasilPort", () => {
  test("returns the base port when nothing is held", () => {
    expect(allocateBenchmarkYggdrasilPort([])).toBe(BENCHMARK_YGGDRASIL_PORT_BASE);
  });

  test("skips held ports and returns the next free one", () => {
    const port = allocateBenchmarkYggdrasilPort([
      BENCHMARK_YGGDRASIL_PORT_BASE,
      BENCHMARK_YGGDRASIL_PORT_BASE + 1,
    ]);
    expect(port).toBe(BENCHMARK_YGGDRASIL_PORT_BASE + 2);
  });

  test("handles non-contiguous holds", () => {
    const port = allocateBenchmarkYggdrasilPort([BENCHMARK_YGGDRASIL_PORT_BASE + 3]);
    expect(port).toBe(BENCHMARK_YGGDRASIL_PORT_BASE);
  });
});

// ── Gated integration test ─────────────────────────────────────────────
const INTEGRATION_ENABLED = process.env.RUN_YGGDRASIL_INTEGRATION_TEST === "1";
const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip;

describeIntegration("BenchmarkYggdrasilManager (integration)", () => {
  const ISSUE_KEY = "BENCH-TEST";
  const REPO_LABEL = "fixture";
  const MANAGER_NAME = "ygg-bench-test";
  let fixtureDir: string;

  beforeAll(async () => {
    initDb(loadConfig());

    fixtureDir = await mkdtemp(join(tmpdir(), "ygg-bench-fixture-"));
    // Minimal Java file so the indexer has something to parse. Yggdrasil's
    // symbol extractor walks java/kotlin/typescript by default.
    const srcDir = join(fixtureDir, "src", "main", "java", "bench");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, "Hello.java"),
      "package bench;\n\npublic class Hello {\n  public String greet() { return \"hi\"; }\n}\n",
      "utf8",
    );

    // Make it a git repo so the indexer's `git rev-parse HEAD` call doesn't
    // short-circuit awkwardly. An empty repo is fine.
    const git = (args: string[]) =>
      Bun.spawn(["git", "-C", fixtureDir, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init"]);
  });

  afterAll(async () => {
    // Best-effort: stop any leftover instance, purge the bench row, remove fixture.
    await benchmarkYggdrasilManager.stop(MANAGER_NAME).catch(() => { /* ignore */ });
    try {
      const sql = getDb();
      await sql`DELETE FROM ci_repos WHERE name = ${buildBenchRepoName(ISSUE_KEY, REPO_LABEL)}`;
    } catch { /* ignore */ }
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    await closeDb().catch(() => { /* ignore */ });
  });

  test("indexes a fixture, creates the bench row, and cleans it up on stop", async () => {
    const port = allocateBenchmarkYggdrasilPort([]);
    const instance = await benchmarkYggdrasilManager.start({
      name: MANAGER_NAME,
      issueKey: ISSUE_KEY,
      port,
      repos: [{ repo: REPO_LABEL, worktreePath: fixtureDir }],
    });

    const expectedRepoName = buildBenchRepoName(ISSUE_KEY, REPO_LABEL);
    expect(instance.indexedRepos.map((r) => r.repoName)).toEqual([expectedRepoName]);
    expect(instance.port).toBe(port);
    expect(instance.mcpUrl).toBe(`http://127.0.0.1:${port}/mcp`);

    const sql = getDb();
    const countRows = async (): Promise<number> => {
      const rows = await sql<Array<{ name: string }>>`
        SELECT name FROM ci_repos WHERE name = ${expectedRepoName}
      `;
      return rows.length;
    };

    expect(await countRows()).toBe(1);

    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(health.ok).toBe(true);

    await benchmarkYggdrasilManager.stop(MANAGER_NAME);
    expect(await countRows()).toBe(0);
  }, 180_000);
});
