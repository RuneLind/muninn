/**
 * Regression guard for the ONE thing `/api/goals/:userId` and
 * `/api/scheduled-tasks/:userId` got wrong: they dropped the `?bot=` the chat
 * inspector and the dashboard detail panel both send, so selecting a bot in the
 * inspector listed EVERY bot's goals and tasks. Both DB helpers have accepted and
 * branched on `botName` all along (`src/db/goals.ts`, `src/db/scheduled-tasks.ts`)
 * — only the routes never passed it.
 *
 * Deliberately asserts on what reaches the DB layer rather than on filtered rows:
 * the filtering itself is already covered by the real-Postgres tests in
 * `src/db/{goals,scheduled-tasks}.test.ts`, and the defect was purely the wiring.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test:unit` chain,
 * like `src/profile/` and `task-executor.test.ts`) — and it MUST stay that way.
 * `mock.module` invalidates the target module for the whole process graph, so
 * sharing a process with anything that transitively imports `db/goals.ts` breaks
 * that importer's export resolution: dropped into `test:unit`'s first chunk it
 * fails with `SyntaxError: Export named 'refreshInterestProfile' not found in
 * module src/profile/generator.ts`. Spreading the real modules below does NOT
 * prevent that — process isolation is the only thing that does.
 */

import { test, expect, mock, beforeEach } from "bun:test";

const goalCalls: Array<[string, string | undefined]> = [];
const taskCalls: Array<[string, string | undefined]> = [];

// Spread the REAL modules and override only the two readers under test —
// `mock.module` replaces the whole module, so without the spread the route file's
// other imports from them (`getAllGoals`, `getScheduledTaskById`, …) resolve to
// undefined and the import throws. This is about THIS process's own imports; see
// the header for why it can't protect other files. Importing the real modules is
// safe: `getDb()` is called inside the functions, not at module load.
const realGoals = await import("../../db/goals.ts");
const realTasks = await import("../../db/scheduled-tasks.ts");

mock.module("../../db/goals.ts", () => ({
  ...realGoals,
  getActiveGoals: async (userId: string, botName?: string) => {
    goalCalls.push([userId, botName]);
    return [];
  },
}));
mock.module("../../db/scheduled-tasks.ts", () => ({
  ...realTasks,
  getScheduledTasksForUser: async (userId: string, botName?: string) => {
    taskCalls.push([userId, botName]);
    return [];
  },
}));

const { Hono } = await import("hono");
const { registerDataRoutes } = await import("./data-routes.ts");

function app() {
  const a = new Hono();
  registerDataRoutes(a);
  return a;
}

beforeEach(() => {
  goalCalls.length = 0;
  taskCalls.length = 0;
});

test("GET /api/goals/:userId forwards ?bot= to the DB layer", async () => {
  const res = await app().request("/api/goals/u1?bot=jarvis");
  expect(res.status).toBe(200);
  expect(goalCalls).toEqual([["u1", "jarvis"]]);
});

test("GET /api/scheduled-tasks/:userId forwards ?bot= to the DB layer", async () => {
  const res = await app().request("/api/scheduled-tasks/u1?bot=jarvis");
  expect(res.status).toBe(200);
  expect(taskCalls).toEqual([["u1", "jarvis"]]);
});

test("no ?bot= still means unscoped — the all-bots read stays available", async () => {
  await app().request("/api/goals/u1");
  await app().request("/api/scheduled-tasks/u1");
  expect(goalCalls).toEqual([["u1", undefined]]);
  expect(taskCalls).toEqual([["u1", undefined]]);
});

test("an empty ?bot= is unscoped, not a literal empty bot name", async () => {
  // `?bot=` with no value is what a client sends when nothing is selected; it
  // must not become `bot_name = ''` and match zero rows.
  await app().request("/api/goals/u1?bot=");
  await app().request("/api/scheduled-tasks/u1?bot=");
  expect(goalCalls).toEqual([["u1", undefined]]);
  expect(taskCalls).toEqual([["u1", undefined]]);
});
