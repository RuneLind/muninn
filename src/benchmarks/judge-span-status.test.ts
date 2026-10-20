/**
 * Span status on the judge's failure exits (arch review 2026-10 finding 54):
 * `Tracer.end` never infers status from attributes, so a failed
 * `claude-cli-call` must pass "error" as its third argument or /traces draws
 * it green.
 *
 * A fake `claude` on PATH stands in for the CLI. Uses mock.module, so this
 * file runs in its own `bun test` link in every chain
 * (`src/test/mock-isolation.test.ts`).
 */

import { test, expect, mock, spyOn, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTempDirSync } from "../test/temp-dir.ts";

type EndCall = { label: string; status: string };
const ends: EndCall[] = [];

class FakeTracer {
  traceId = "trace-judge-test";
  constructor(_name: string, _opts?: unknown) {}
  start() {}
  event() {}
  error() {}
  finish() {}
  end(label: string, _attrs?: unknown, status: string = "ok") {
    ends.push({ label, status });
    return 1;
  }
}

mock.module("../tracing/index.ts", () => ({ Tracer: FakeTracer }));

const { runJudge } = await import("./judge.ts");

const root = testTempDirSync(join(tmpdir(), "judge-span-status-"));
const bin = join(root, "bin");
const saved = { PATH: process.env.PATH, MUNINN_AGENT_CWD: process.env.MUNINN_AGENT_CWD };
// The both-attempts-failed exit writes a debug dump under /tmp. The spy records
// the dumps this file's runs create, so cleanup never removes one another run
// wrote meanwhile. `makeDir` is the unspied original, for a dump that run makes.
const makeDir = fs.mkdirSync;
const mkdirSpy = spyOn(fs, "mkdirSync");
const ownDumps = () =>
  mkdirSpy.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith("/tmp/benchmark-judge-debug-"));

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "prompt-v1.md"), "judge");
  writeFileSync(join(root, "gold.md"), "gold");
  writeFileSync(join(root, "candidate.md"), "candidate");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.MUNINN_AGENT_CWD = join(root, "agent-home");
});

afterAll(() => {
  process.env.PATH = saved.PATH;
  if (saved.MUNINN_AGENT_CWD === undefined) delete process.env.MUNINN_AGENT_CWD;
  else process.env.MUNINN_AGENT_CWD = saved.MUNINN_AGENT_CWD;
  removeOwnDumps();
  mkdirSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function removeOwnDumps() {
  for (const d of ownDumps()) rmSync(d, { recursive: true, force: true });
}

function fakeClaude(body: string) {
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "claude"), 0o755);
}

const run = (timeoutMs: number) =>
  runJudge({
    manifest: { issueKey: "T-1", gold: { path: join(root, "gold.md") }, highlightedClaims: [] } as never,
    candidatePath: join(root, "candidate.md"),
    judgePromptPath: join(root, "prompt-v1.md"),
    timeoutMs,
  });

test("a timed-out judge ends claude-cli-call as error", async () => {
  ends.length = 0;
  fakeClaude("exec sleep 5");
  await expect(run(300)).rejects.toThrow(/Judge timed out/);
  expect(ends).toEqual([{ label: "claude-cli-call", status: "error" }]);
}, 10_000);

test("a judge that fails both attempts ends claude-cli-call as error", async () => {
  ends.length = 0;
  fakeClaude("exit 1");
  await expect(run(5_000)).rejects.toThrow(/claude exited with code 1/);
  expect(ends).toEqual([{ label: "claude-cli-call", status: "error" }]);
}, 10_000);

test("cleanup removes this file's dump and leaves one another run wrote meanwhile", () => {
  const foreign = `/tmp/benchmark-judge-debug-${Date.now()}-other-run-${process.pid}`;
  makeDir(foreign);
  try {
    const own = ownDumps();
    expect(own).toHaveLength(1); // the both-attempts-failed test above
    removeOwnDumps();
    expect(existsSync(own[0]!)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});
