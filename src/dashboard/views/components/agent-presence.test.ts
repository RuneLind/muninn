import { test, expect } from "bun:test";
import {
  computePresence,
  PRESENCE_HORIZON_MS,
  type PresenceRunLike,
  type PresenceUpNextLike,
} from "./agent-presence.ts";
import { estimateIdentity } from "../../agent-eta.ts";

const NOW = 1_700_000_000_000;

function run(overrides: Partial<PresenceRunLike>): PresenceRunLike {
  return { kind: "gardener_drain", botName: "jarvis", name: "Backlog drain", startedAt: NOW, ...overrides };
}

test("running: gardener drain with progress + estimate → label + ETA", () => {
  const running = [run({ phase: "drafting", startedAt: NOW - 60_000, progress: { done: 2, total: 5 } })];
  const estimates = { [estimateIdentity("gardener_drain", "Backlog drain")]: 300_000 };
  const m = computePresence({ kinds: ["gardener_drain", "watcher"] }, running, [], estimates, NOW);
  expect(m.state).toBe("running");
  if (m.state !== "running") throw new Error("unreachable");
  expect(m.label).toBe("Drain: drafting 2/5");
  expect(m.etaLabel).toBe("~4m left"); // 300s expected − 60s elapsed = 240s
});

test("running: no progress, no estimate → label only, no ETA", () => {
  const running = [run({ phase: "clustering" })];
  const m = computePresence({ kinds: ["gardener_drain"] }, running, [], {}, NOW);
  expect(m.state).toBe("running");
  if (m.state !== "running") throw new Error("unreachable");
  expect(m.label).toBe("Drain: clustering");
  expect(m.etaLabel).toBeUndefined();
});

test("running: watcher shows its name as detail", () => {
  const running = [run({ kind: "watcher", name: "email", phase: "running_watcher" })];
  const m = computePresence({ kinds: ["watcher"] }, running, [], {}, NOW);
  expect(m.state).toBe("running");
  if (m.state !== "running") throw new Error("unreachable");
  expect(m.label).toBe("Watcher: email");
});

test("running wins over an eligible preflight", () => {
  const running = [run({ phase: "drafting" })];
  const upNext: PresenceUpNextLike[] = [
    { kind: "gardener_drain", bot: "jarvis", name: "Backlog drain", nextRunAt: NOW + 60_000 },
  ];
  const m = computePresence({ kinds: ["gardener_drain"] }, running, upNext, {}, NOW);
  expect(m.state).toBe("running");
});

test("preflight: up-next within the horizon → amber 'starts in Nm'", () => {
  const upNext: PresenceUpNextLike[] = [
    { kind: "watcher", bot: "jarvis", name: "wiki-gardener", nextRunAt: NOW + 12 * 60_000 },
  ];
  const m = computePresence({ kinds: ["gardener_drain", "watcher"] }, [], upNext, {}, NOW);
  expect(m.state).toBe("preflight");
  if (m.state !== "preflight") throw new Error("unreachable");
  expect(m.label).toBe("Watcher starts in 12m");
});

test("preflight: earliest matching entry is chosen", () => {
  const upNext: PresenceUpNextLike[] = [
    { kind: "watcher", bot: "jarvis", name: "b", nextRunAt: NOW + 30 * 60_000 },
    { kind: "watcher", bot: "jarvis", name: "a", nextRunAt: NOW + 5 * 60_000 },
  ];
  const m = computePresence({ kinds: ["watcher"] }, [], upNext, {}, NOW);
  expect(m.state).toBe("preflight");
  if (m.state !== "preflight") throw new Error("unreachable");
  expect(m.nextRunAt).toBe(NOW + 5 * 60_000);
});

test("preflight: entry beyond the horizon → none", () => {
  const upNext: PresenceUpNextLike[] = [
    { kind: "watcher", bot: "jarvis", name: "wiki-gardener", nextRunAt: NOW + PRESENCE_HORIZON_MS + 60_000 },
  ];
  const m = computePresence({ kinds: ["watcher"] }, [], upNext, {}, NOW);
  expect(m.state).toBe("none");
});

test("none: no run and no up-next of the filtered kinds", () => {
  const running = [run({ kind: "chat", name: "Chat turn" })];
  const upNext: PresenceUpNextLike[] = [
    { kind: "scheduled_task", bot: "jarvis", name: "digest", nextRunAt: NOW + 60_000 },
  ];
  const m = computePresence({ kinds: ["gardener_drain", "research"] }, running, upNext, {}, NOW);
  expect(m.state).toBe("none");
});

test("bot filter: a run for a different bot does not match", () => {
  const running = [run({ botName: "melosys" })];
  const m = computePresence({ kinds: ["gardener_drain"], bot: "jarvis" }, running, [], {}, NOW);
  expect(m.state).toBe("none");
});

test("completed runs are ignored", () => {
  const running = [run({ phase: "drafting", completed: true })];
  const m = computePresence({ kinds: ["gardener_drain"] }, running, [], {}, NOW);
  expect(m.state).toBe("none");
});
