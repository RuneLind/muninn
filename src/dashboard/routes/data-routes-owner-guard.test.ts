/**
 * PR D's resource guard at the DASHBOARD's id-addressed routes.
 *
 * These exist because the review round's mutation pass found the opposite of a
 * broken guard: the guards were present and **unpinned** — deleting any one of
 * them left `bun run test` green. A guard nobody tests is a guard the next
 * refactor removes, and three of the five below are WRITES.
 *
 * Two of them were not in the plan's §4 list at all. The empirical pass
 * demonstrated why they had to join it: an authenticated non-admin renamed and
 * DISABLED another user's email watcher and morning-briefing task, and
 * force-queued their Gmail-MCP watcher to run now.
 *
 * No DB and no `mock.module`: the owner lookup is the injected seam, and the
 * assertion is what reached it. That matters more than it looks, because a
 * response-shaped assertion cannot work here BY DESIGN. The refusal is
 * deliberately byte-identical to the route's own miss, so — as this file found
 * when it first ran inside the full `bun test` chain, where an earlier file has
 * initialised the DB — `PUT /api/watchers/:id` answering
 * `404 {"error":"Watcher not found"}` is EXACTLY what an unguarded route
 * answers for an id the table does not hold, and exactly what the guard
 * answers for one it does. Two assertions were written against the response
 * and deleted: an "admin passes through" case that could not tell the
 * passthrough from `updateWatcher` returning null, and a "refuses before
 * reading" case that only held while no DB existed.
 *
 * So what is pinned here is the CALL: that each route consults the owner lookup,
 * on the right resource KIND, and answers its own miss when the lookup says no —
 * and that with auth off it consults nothing at all. The decision itself
 * (admin passthrough, NULL owners, the found/missing split) is
 * `src/auth/resource-guard.test.ts`'s, over primitives, where every branch is
 * reachable.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { Hono } from "hono";
import { createDashboardRoutes } from "../index.ts";
import { __setOwnerLookupForTest, type ResourceKind } from "../../auth/resource-guard.ts";
import type { Config } from "../../config.ts";
import type { Identity } from "../../auth/introspect.ts";
import type { AuthRole } from "../../auth/role.ts";

const A: Identity = {
  userId: "owner-a",
  displayName: "A",
  navIdent: null,
  oid: null,
  provider: "local",
  expiresAt: null,
};

/** A well-formed uuid the injected lookup reports as someone else's. */
const FOREIGN = "11111111-2222-4333-8444-555555555555";

let lookups: { kind: ResourceKind; id: string }[] = [];

function stubLookup(): void {
  __setOwnerLookupForTest(async (kind, id) => {
    lookups.push({ kind, id });
    return id === FOREIGN ? { found: true, userId: "owner-b" } : { found: false };
  });
}

function appWith(identity: Identity | null, role: AuthRole | null): Hono {
  lookups = [];
  stubLookup();
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (identity) c.set("identity", identity);
    if (role) c.set("role", role);
    await next();
  });
  app.route("/", createDashboardRoutes({} as unknown as Config));
  return app;
}

afterEach(() => __setOwnerLookupForTest(null));

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

interface Case {
  name: string;
  path: string;
  init?: RequestInit;
  kind: ResourceKind;
  status: number;
  miss: unknown;
}

const CASES: Case[] = [
  {
    name: "PUT /api/watchers/:id",
    path: `/api/watchers/${FOREIGN}`,
    init: json("PUT", { name: "PWNED", enabled: false }),
    kind: "watcher", status: 404, miss: { error: "Watcher not found" },
  },
  {
    name: "POST /api/watchers/:id/trigger",
    path: `/api/watchers/${FOREIGN}/trigger`,
    init: json("POST", {}),
    kind: "watcher", status: 404, miss: { error: "Watcher not found" },
  },
  {
    name: "PUT /api/tasks/:id",
    path: `/api/tasks/${FOREIGN}`,
    init: json("PUT", { title: "PWNED", enabled: false }),
    kind: "scheduledTask", status: 404, miss: { error: "Task not found" },
  },
  {
    name: "POST /api/tasks/:id/trigger",
    path: `/api/tasks/${FOREIGN}/trigger`,
    init: json("POST", {}),
    kind: "scheduledTask", status: 404, miss: { error: "Task not found" },
  },
  {
    name: "DELETE /api/threads/:id",
    path: `/api/threads/${FOREIGN}`,
    init: { method: "DELETE" },
    kind: "thread", status: 404, miss: { error: "Thread not found or is the main thread" },
  },
  {
    name: "GET /api/traces/:traceId",
    path: `/api/traces/${FOREIGN}`,
    // Not a 404: this route already answers an empty span list for an id it
    // does not know, so the denial has to be the same expression.
    kind: "trace", status: 200, miss: { spans: [] },
  },
  {
    name: "GET /api/prompts/:traceId",
    path: `/api/prompts/${FOREIGN}`,
    kind: "trace", status: 404, miss: { error: "Prompt snapshot not found" },
  },
];

describe("dashboard resource guards", () => {
  for (const testCase of CASES) {
    test(`${testCase.name} refuses another user's row with the route's own miss`, async () => {
      const res = await appWith(A, "user").request(testCase.path, testCase.init);
      expect(res.status).toBe(testCase.status);
      expect(await res.json()).toEqual(testCase.miss);
      // The guard ran on the right KIND — a guard pointed at the wrong table
      // would refuse for the wrong reason and pass the assertion above.
      expect(lookups).toContainEqual({ kind: testCase.kind, id: FOREIGN });
    });

    test(`${testCase.name} consults NO owner lookup with auth off`, async () => {
      const app = appWith(null, null);
      try {
        await app.request(testCase.path, testCase.init);
      } catch {
        // Past the guard these reach the DB this process has none of. The
        // assertion is the lookup count, not the response.
      }
      expect(lookups, "the owner lookup ran with auth off").toEqual([]);
    });

  }
});
