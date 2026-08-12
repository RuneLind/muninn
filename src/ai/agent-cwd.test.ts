import { test, expect, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentCwdRoot, resolveAgentCwd } from "./agent-cwd.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ORIGINAL = process.env.MUNINN_AGENT_CWD;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MUNINN_AGENT_CWD;
  else process.env.MUNINN_AGENT_CWD = ORIGINAL;
});

test("default root lives outside the repo, under ~/.muninn", () => {
  delete process.env.MUNINN_AGENT_CWD;
  expect(agentCwdRoot()).toBe(join(homedir(), ".muninn", "agent-cwd"));
});

/**
 * The load-bearing invariant: the whole point is that `claude -p` neither loads
 * muninn's CLAUDE.md/`.claude/` surface nor files its transcript into the repo's
 * own `~/.claude/projects/` folder. Both follow from the cwd being outside the
 * repo — a future "keep it in the repo, it's tidier" refactor breaks the fix
 * silently, so it fails here instead.
 */
test("resolved cwd is never inside the muninn repo", () => {
  delete process.env.MUNINN_AGENT_CWD;
  expect(resolveAgentCwd("jarvis").startsWith(REPO_ROOT)).toBe(false);
  process.env.MUNINN_AGENT_CWD = join(tmpdir(), "muninn-agent-cwd-test-outside");
  expect(resolveAgentCwd("jarvis").startsWith(REPO_ROOT)).toBe(false);
  rmSync(join(tmpdir(), "muninn-agent-cwd-test-outside"), { recursive: true, force: true });
});

test("per-bot subdir is created on first use and is idempotent", () => {
  const root = join(tmpdir(), "muninn-agent-cwd-test-create");
  rmSync(root, { recursive: true, force: true });
  process.env.MUNINN_AGENT_CWD = root;

  const dir = resolveAgentCwd("jarvis");
  expect(dir).toBe(join(root, "jarvis"));
  expect(existsSync(dir)).toBe(true);
  expect(resolveAgentCwd("jarvis")).toBe(dir);
  // Distinct bots get distinct project folders, so claude-usage can tell them apart.
  expect(resolveAgentCwd("melosys")).toBe(join(root, "melosys"));

  rmSync(root, { recursive: true, force: true });
});

test("missing or unsafe bot name collapses to the shared bucket", () => {
  const root = join(tmpdir(), "muninn-agent-cwd-test-bucket");
  rmSync(root, { recursive: true, force: true });
  process.env.MUNINN_AGENT_CWD = root;

  expect(resolveAgentCwd()).toBe(join(root, "shared"));
  expect(resolveAgentCwd("../../escape")).toBe(join(root, "shared"));
  expect(resolveAgentCwd("/abs")).toBe(join(root, "shared"));
  // Case is normalized so `Jarvis` and `jarvis` don't fork into two projects.
  expect(resolveAgentCwd("Jarvis")).toBe(join(root, "jarvis"));

  rmSync(root, { recursive: true, force: true });
});

test("relative MUNINN_AGENT_CWD is resolved to an absolute path", () => {
  process.env.MUNINN_AGENT_CWD = "./scratch-agent-cwd";
  expect(agentCwdRoot()).toBe(resolve("./scratch-agent-cwd"));
});
