import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentCwdRoot, resolveAgentCwd, spawnCwd } from "./agent-cwd.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ORIGINAL = process.env.MUNINN_AGENT_CWD;
const scratch: string[] = [];

/** A fresh root per test — fixed `$TMPDIR` names race when `test` and `test:unit` run concurrently. */
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "muninn-agent-cwd-test-"));
  scratch.push(dir);
  process.env.MUNINN_AGENT_CWD = dir;
  return dir;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MUNINN_AGENT_CWD;
  else process.env.MUNINN_AGENT_CWD = ORIGINAL;
  for (const dir of scratch.splice(0)) {
    try { chmodSync(dir, 0o700); } catch { /* already writable */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default root lives outside the repo, under ~/.muninn", () => {
  delete process.env.MUNINN_AGENT_CWD;
  // Asserted through agentCwdRoot(), which does no mkdir — resolveAgentCwd() here
  // would create a real dir in whatever $HOME runs the suite.
  expect(agentCwdRoot()).toBe(join(homedir(), ".muninn", "agent-cwd"));
  expect(agentCwdRoot().startsWith(REPO_ROOT)).toBe(false);
});

/**
 * The load-bearing invariant: the fix works only because the cwd is outside the
 * checkout — inside it, the CLI walks parents for CLAUDE.md and files the
 * transcript into the repo's own project folder. A relative override is the easy
 * way to break that, since it resolves against process.cwd() (the repo root).
 */
test("an override resolving inside the repo is refused, not honored", () => {
  process.env.MUNINN_AGENT_CWD = ".agents";
  expect(agentCwdRoot()).toBe(join(homedir(), ".muninn", "agent-cwd"));

  process.env.MUNINN_AGENT_CWD = join(REPO_ROOT, "bots", "jarvis");
  expect(agentCwdRoot().startsWith(REPO_ROOT)).toBe(false);

  process.env.MUNINN_AGENT_CWD = REPO_ROOT;
  expect(agentCwdRoot().startsWith(REPO_ROOT)).toBe(false);

  // A sibling path that merely shares the prefix is a different directory, not inside.
  process.env.MUNINN_AGENT_CWD = `${REPO_ROOT}-agents`;
  expect(agentCwdRoot()).toBe(`${REPO_ROOT}-agents`);
});

test("absolute override outside the repo is honored", () => {
  const root = scratchRoot();
  expect(agentCwdRoot()).toBe(root);
});

test("per-bot subdir is created on use, repeatedly", () => {
  const root = scratchRoot();

  const dir = resolveAgentCwd("jarvis");
  expect(dir).toBe(join(root, "jarvis"));
  expect(existsSync(dir)).toBe(true);
  // Distinct bots get distinct project folders, so claude-usage can tell them apart.
  expect(resolveAgentCwd("melosys")).toBe(join(root, "melosys"));

  // Re-created after the dir vanishes under a long-lived process: a memoized path
  // would hand back a missing dir and every spawn would die with ENOENT.
  rmSync(dir, { recursive: true, force: true });
  expect(resolveAgentCwd("jarvis")).toBe(dir);
  expect(existsSync(dir)).toBe(true);
});

test("missing or unsafe bot name collapses to the shared bucket", () => {
  const root = scratchRoot();

  expect(resolveAgentCwd()).toBe(join(root, "shared"));
  expect(resolveAgentCwd("../../escape")).toBe(join(root, "shared"));
  expect(resolveAgentCwd("/abs")).toBe(join(root, "shared"));
  expect(resolveAgentCwd("..")).toBe(join(root, "shared"));
  expect(resolveAgentCwd("bot 2")).toBe(join(root, "shared"));
  // Legal bot folder names stay their own bucket — case-normalized so `Jarvis`
  // and `jarvis` don't fork into two projects.
  expect(resolveAgentCwd("Jarvis")).toBe(join(root, "jarvis"));
  expect(resolveAgentCwd("_scratch")).toBe(join(root, "_scratch"));
  expect(resolveAgentCwd("bot-2.x")).toBe(join(root, "bot-2.x"));
});

test("unusable root degrades to a private temp dir, never bare $TMPDIR", () => {
  const root = scratchRoot();
  // Root occupied by a regular file ⇒ mkdir of a child cannot succeed.
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "");
  process.env.MUNINN_AGENT_CWD = blocked;

  const dir = resolveAgentCwd("jarvis");
  expect(dir).not.toBe(tmpdir());
  expect(dir.startsWith(join(tmpdir(), "muninn-agent-"))).toBe(true);
  expect(existsSync(dir)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Pins the precedence at the one production call site (`spawnHaiku`'s Bun.spawn).
 * Inverting it would strip the email watcher's Gmail MCP discovery and the
 * extractors' persona — both invisible to every other test in the suite.
 */
test("spawnCwd prefers the caller's explicit cwd, falls back to the agent home", () => {
  const root = scratchRoot();
  const botDir = join(REPO_ROOT, "bots", "jarvis");

  expect(spawnCwd(botDir, "jarvis")).toBe(botDir);
  expect(existsSync(join(root, "jarvis"))).toBe(false); // no dir made when unused
  expect(spawnCwd(undefined, "jarvis")).toBe(join(root, "jarvis"));
  expect(spawnCwd(undefined)).toBe(join(root, "shared"));
});
