import { test, expect } from "bun:test";
import {
  computeRowRuntime,
  mergePipelineRuntime,
  type RuntimeMatchable,
  type RuntimeAgents,
} from "./models-runtime.ts";

const NOW = 1_700_000_000_000;

const emptyAgents: RuntimeAgents = { running: [], upNext: [], recent: [] };

// Realistic watcher row: display name ("Viktig e-post") differs from the type
// ("email"). running/upNext carry the display name; trace-sourced recent[]
// entries carry the TYPE — matchRecentName bridges that split.
const watcherRow: RuntimeMatchable = {
  matchKind: "watcher",
  matchBot: "jarvis",
  matchName: "Viktig e-post",
  matchRecentName: "email",
};

test("running match: a live matching run lights runningNow", () => {
  const agents: RuntimeAgents = {
    ...emptyAgents,
    running: [{ kind: "watcher", botName: "jarvis", name: "Viktig e-post" }],
  };
  const rt = computeRowRuntime(watcherRow, agents);
  expect(rt.runningNow).toBe(true);
});

test("next match: earliest matching up-next sets nextRunAt", () => {
  const agents: RuntimeAgents = {
    ...emptyAgents,
    upNext: [
      { kind: "watcher", bot: "jarvis", name: "Viktig e-post", nextRunAt: NOW + 30 * 60_000 },
      { kind: "watcher", bot: "jarvis", name: "Viktig e-post", nextRunAt: NOW + 5 * 60_000 },
    ],
  };
  const rt = computeRowRuntime(watcherRow, agents);
  expect(rt.runningNow).toBe(false);
  expect(rt.nextRunAt).toBe(NOW + 5 * 60_000);
});

test("last-run duration: newest matching finished run (type-named recent rows)", () => {
  const agents: RuntimeAgents = {
    ...emptyAgents,
    recent: [
      { kind: "watcher", bot: "jarvis", name: "email", finishedAt: NOW - 10_000, durationMs: 1000 },
      { kind: "watcher", bot: "jarvis", name: "email", finishedAt: NOW - 1000, durationMs: 2500 },
    ],
  };
  const rt = computeRowRuntime(watcherRow, agents);
  expect(rt.lastDurationMs).toBe(2500);
});

test("recent rows with a foreign type never match via matchRecentName", () => {
  const agents: RuntimeAgents = {
    ...emptyAgents,
    recent: [{ kind: "watcher", bot: "jarvis", name: "anthropic", finishedAt: NOW - 1000, durationMs: 900 }],
  };
  expect(computeRowRuntime(watcherRow, agents).lastDurationMs).toBeUndefined();
});

test("no match: different bot/name does not match", () => {
  const agents: RuntimeAgents = {
    ...emptyAgents,
    running: [{ kind: "watcher", botName: "melosys", name: "email" }],
    upNext: [{ kind: "watcher", bot: "jarvis", name: "other", nextRunAt: NOW + 60_000 }],
  };
  const rt = computeRowRuntime(watcherRow, agents);
  expect(rt.runningNow).toBe(false);
  expect(rt.nextRunAt).toBeUndefined();
});

test("gardener-drain row matches on kind+bot (no name enforced when unset)", () => {
  const row: RuntimeMatchable = { matchKind: "gardener_drain", matchBot: "jarvis", matchName: "Backlog drain" };
  const agents: RuntimeAgents = {
    ...emptyAgents,
    running: [{ kind: "gardener_drain", botName: "jarvis", name: "Backlog drain" }],
  };
  expect(computeRowRuntime(row, agents).runningNow).toBe(true);
});

test("rows without matchKind never match", () => {
  const row: RuntimeMatchable = {};
  const agents: RuntimeAgents = {
    ...emptyAgents,
    running: [{ kind: "watcher", botName: "jarvis", name: "email" }],
  };
  const rt = computeRowRuntime(row, agents);
  expect(rt.runningNow).toBe(false);
  expect(rt.nextRunAt).toBeUndefined();
  expect(rt.lastDurationMs).toBeUndefined();
});

test("recent entries without a duration are skipped for lastDurationMs", () => {
  const agents: RuntimeAgents = {
    ...emptyAgents,
    recent: [{ kind: "watcher", bot: "jarvis", name: "email", finishedAt: NOW - 1000 }],
  };
  expect(computeRowRuntime(watcherRow, agents).lastDurationMs).toBeUndefined();
});

test("mergePipelineRuntime is index-aligned with the rows", () => {
  const rows: RuntimeMatchable[] = [watcherRow, {}];
  const agents: RuntimeAgents = {
    ...emptyAgents,
    running: [{ kind: "watcher", botName: "jarvis", name: "email" }],
  };
  const merged = mergePipelineRuntime(rows, agents);
  expect(merged).toHaveLength(2);
  expect(merged[0]!.runningNow).toBe(true);
  expect(merged[1]!.runningNow).toBe(false);
});
