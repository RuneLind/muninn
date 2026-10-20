/**
 * `scripts/seed-connectors.ts` against the migrated test database: a re-run
 * must not add a NULL-effort twin beside a seeded connector the user set an
 * effort on (the table's unique key includes effort since migration 084).
 *
 * The script runs as a child, `--no-env-file`, with the test database as its
 * DATABASE_URL and an empty bot roster, so it never reads a developer's `.env`.
 */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTestDb } from "../test/setup-db.ts";
import { TEST_DATABASE_URL } from "../test/test-db-url.ts";
import { testTempDir } from "../test/temp-dir.ts";
import { createConnector, listConnectors, updateConnector } from "./connectors.ts";
import { holdUncommittedConnector } from "../test/connector-race.ts";

setupTestDb();

const SCRIPT = path.resolve(import.meta.dir, "../../scripts/seed-connectors.ts");
let botsDir = "";

afterAll(async () => {
  if (botsDir) await rm(botsDir, { recursive: true, force: true });
});

async function runSeed(...args: string[]): Promise<string> {
  const { out, err, code } = await spawnSeed(...args);
  expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
  return out;
}

async function spawnSeed(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  botsDir ||= await testTempDir(path.join(tmpdir(), "muninn-seed-connectors-"));
  const proc = Bun.spawn([process.execPath, "--no-env-file", SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: TEST_DATABASE_URL, MUNINN_BOTS_DIR: botsDir, LOG_DIR: "none" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

test("a re-run skips a default the user has since set an effort on", async () => {
  await runSeed();
  const [seeded] = (await listConnectors()).filter((c) => c.connectorType === "copilot-sdk");
  expect(seeded?.model).toBe("claude-sonnet-5.5");
  await updateConnector(seeded!.id, { effort: "high" });
  await runSeed();
  await runSeed("--add", "copilot-sdk", "claude-sonnet-5.5");
  const copilot = (await listConnectors()).filter((c) => c.connectorType === "copilot-sdk");
  expect(copilot.map((c) => `${c.model}|${c.effort ?? null}`)).toEqual(["claude-sonnet-5.5|high"]);
  // A connector with no row yet is still created.
  await runSeed("--add", "openai-compat", "qwen3.5:35b", "http://localhost:11434/v1");
  expect((await listConnectors()).filter((c) => c.connectorType === "openai-compat")).toHaveLength(1);
});

test("a seed at another base URL is created beside the default one", async () => {
  await runSeed();
  await runSeed("--add", "copilot-sdk", "claude-sonnet-5.5", "http://proxy:1");
  const copilot = (await listConnectors()).filter((c) => c.connectorType === "copilot-sdk");
  expect(copilot.map((c) => c.baseUrl ?? null).sort()).toEqual(["http://proxy:1", null]);
});

// The script catches a failed insert and prints `✗` but still exits 0, so the
// race shows on stderr. ON CONFLICT turns the wait on the held row into a skip.
test("eight scripts adding one connector at once leave one row and print no failure", async () => {
  await createConnector({ name: "Existing CLI", connectorType: "claude-cli" });
  const held = await holdUncommittedConnector("openai-compat", "race-model", null);
  let runs: { out: string; err: string; code: number }[] = [];
  try {
    const pending = Array.from({ length: 8 }, () => spawnSeed("--add", "openai-compat", "race-model"));
    await held.waitForBlocked(8, 30_000);
    await held.commit();
    runs = await Promise.all(pending);
  } finally {
    await held.end();
  }
  expect(runs.map((r) => [r.code, r.err.includes("✗") ? r.err : ""])).toEqual(Array(8).fill([0, ""]));
  expect((await listConnectors()).filter((c) => c.connectorType === "openai-compat")).toHaveLength(1);
}, 60_000);
