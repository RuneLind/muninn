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
import { listConnectors, updateConnector } from "./connectors.ts";

setupTestDb();

const SCRIPT = path.resolve(import.meta.dir, "../../scripts/seed-connectors.ts");
let botsDir = "";

afterAll(async () => {
  if (botsDir) await rm(botsDir, { recursive: true, force: true });
});

async function runSeed(...args: string[]): Promise<string> {
  botsDir ||= await testTempDir(path.join(tmpdir(), "muninn-seed-connectors-"));
  const proc = Bun.spawn([process.execPath, "--no-env-file", SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: TEST_DATABASE_URL, MUNINN_BOTS_DIR: botsDir, LOG_DIR: "none" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
  return out;
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
