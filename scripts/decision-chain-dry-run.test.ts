/**
 * The dry run over a temp wiki (fix round 1, batch 4, F12): `plan_status` is
 * read as the index reads it, so a trailing comment does not hide `proposed`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dc-dry-run-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  const page = [
    "---",
    "title: Commented",
    "plan_status: proposed   # pending O2",
    "---",
    "",
    "<DecisionLog>",
    "",
    "- **D1** — Ship PR 1 first.",
    "",
    "</DecisionLog>",
    "",
    "### At a glance",
    "",
    "| PR | What |",
    "|---|---|",
    "| 1 | a |",
    "",
  ].join("\n");
  await writeFile(path.join(root, "plans", "commented.md"), page, "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a commented proposed plan's glance slate gives its PRs the planned state", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", path.join(import.meta.dir, "decision-chain-dry-run.ts"), root], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("ledger[glance] rows=1");
  expect(out).toContain("  D1 → PR 1 (planned)");
});
