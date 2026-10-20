/**
 * The dry run over a temp wiki (fix round 1, batch 4, F12): `plan_status` is
 * read as the index reads it, so a trailing comment does not hide `proposed`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../src/test/temp-dir.ts";

let root = "";
let slotRoot = "";

// The reader's own view fixture shape: three chains and a four-row ledger,
// once under a NextMoves and once with no NextMoves or StatusRows.
const NEXT = ["<NextMoves>", "", '<Lane kind="you">', "", "1. Run it.", "", "</Lane>", "", "</NextMoves>", ""].join("\n");
const SLOT_PAGE = [
  "# Plan",
  "",
  NEXT,
  "<DecisionLog>",
  "",
  "- **O1** — Which store? Closed 2026-10-01 (D1).",
  "- **O2** — Which shape? Closed 2026-10-02 (D2).",
  "- **O3** — Which key? Closed 2026-10-03 (D3).",
  "- **D1** — Use the flat file.",
  "- **D2** — Rows per item.",
  "- **D3** — One row per group.",
  "",
  "</DecisionLog>",
  "",
  "**PR ledger.**",
  "",
  "| PR | State | Decisions |",
  "|---|---|---|",
  "| 1 — store | merged | D1 |",
  "| 2 — rows | dropped | D2 |",
  "| 3 — groups | open | D3 |",
  "| 4 — docs | planned | D3 |",
  "",
].join("\n");

beforeAll(async () => {
  root = await testTempDir(path.join(tmpdir(), "dc-dry-run-"));
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
  slotRoot = await testTempDir(path.join(tmpdir(), "dc-dry-run-slot-"));
  await mkdir(path.join(slotRoot, "plans"), { recursive: true });
  await writeFile(path.join(slotRoot, "plans", "a-slotted.md"), SLOT_PAGE, "utf8");
  await writeFile(path.join(slotRoot, "plans", "b-unslotted.md"), SLOT_PAGE.replace(NEXT, ""), "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(slotRoot, { recursive: true, force: true });
});

async function dryRunOut(wiki: string): Promise<string> {
  const proc = Bun.spawn(["bun", "--no-env-file", path.join(import.meta.dir, "decision-chain-dry-run.ts"), wiki], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

test("views count only where the reader has a slot; a page that would draw without one is flagged", async () => {
  const out = await dryRunOut(slotRoot);
  expect(out).toContain("(strip view on 1 pages)");
  expect(out).toContain("chain view on 1 pages");
  expect(out).toContain("1 pages would draw with no slot");
  const line = (rel: string) => out.split("\n").find((l) => l.startsWith(`plans/${rel}:`)) ?? "";
  expect(line("a-slotted.md")).toContain("views=chain,strip");
  expect(line("a-slotted.md")).not.toContain("noSlot=");
  expect(line("b-unslotted.md")).toContain("views=- noSlot=chain,strip");
});

test("a commented proposed plan's glance slate gives its PRs the planned state", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", path.join(import.meta.dir, "decision-chain-dry-run.ts"), root], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("ledger[glance] rows=1");
  expect(out).toContain("  D1 → PR 1 (planned)");
});
