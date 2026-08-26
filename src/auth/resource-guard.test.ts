import { test, expect, describe, afterEach } from "bun:test";
import { Hono } from "hono";
import {
  decideResourceAccess,
  requireOwnedResource,
  filterToOwner,
  __setOwnerLookupForTest,
  type ResourceKind,
  type ResourceOwner,
} from "./resource-guard.ts";
import { __setAuthPolicyForTest } from "./policy.ts";
import { __resetAuditDedupForTest } from "./audit.ts";
import { activityLog } from "../observability/activity-log.ts";
import type { ActivityEvent } from "../types.ts";
import type { Identity } from "./introspect.ts";
import type { AuthRole } from "./role.ts";

const A: Identity = {
  userId: "user-a",
  displayName: "A",
  navIdent: null,
  oid: null,
  provider: "local",
  expiresAt: null,
};

const FOUND_A: ResourceOwner = { found: true, userId: "user-a" };
const FOUND_B: ResourceOwner = { found: true, userId: "user-b" };
const FOUND_NOBODY: ResourceOwner = { found: true, userId: null };
const MISSING: ResourceOwner = { found: false };

afterEach(() => {
  __setOwnerLookupForTest(null);
  __setAuthPolicyForTest(null);
  __resetAuditDedupForTest();
});

/** Rows the given fn wrote, read off the in-memory feed. */
async function captureRows(fn: () => Promise<void>): Promise<ActivityEvent[]> {
  const rows: ActivityEvent[] = [];
  const stop = activityLog.subscribe((e) => rows.push(e));
  try {
    await fn();
  } finally {
    stop();
  }
  return rows;
}

describe("decideResourceAccess — the whole decision, over primitives", () => {
  // Every combination, not the two a route happens to reach. The pure function
  // exists precisely so this table is writable.

  test("auth off allows everything, INCLUDING another user's row", () => {
    // "Off is off". This is what keeps today's default muninn unchanged, and it
    // has to hold for the not-found case too or a 404 would start depending on
    // the auth mode.
    for (const owner of [FOUND_A, FOUND_B, FOUND_NOBODY, MISSING]) {
      expect(decideResourceAccess({ sessionUserId: null, role: null, owner, nullOwnerAllowed: false }).ok)
        .toBe(true);
    }
  });

  test("a session reaching its OWN row is allowed", () => {
    expect(decideResourceAccess({ sessionUserId: "user-a", role: "user", owner: FOUND_A, nullOwnerAllowed: false }))
      .toEqual({ ok: true });
  });

  test("a session reaching ANOTHER user's row is refused as not-owned", () => {
    expect(decideResourceAccess({ sessionUserId: "user-a", role: "user", owner: FOUND_B, nullOwnerAllowed: false }))
      .toEqual({ ok: false, reason: "not-owned" });
  });

  test("a row that does not exist is refused as missing, and BEFORE the role check", () => {
    // Ordering matters: an admin passthrough placed first would answer `ok` for
    // an id nothing owns, and the call site's own "not found" would then be the
    // only thing standing between a prober and a 200.
    expect(decideResourceAccess({ sessionUserId: "user-a", role: "admin", owner: MISSING, nullOwnerAllowed: true }))
      .toEqual({ ok: false, reason: "missing" });
  });

  test("admin passes through to another user's row", () => {
    expect(decideResourceAccess({ sessionUserId: "op", role: "admin", owner: FOUND_B, nullOwnerAllowed: false }))
      .toEqual({ ok: true });
  });

  test("a NULL owner is admin-only when nullOwnerAllowed is false", () => {
    expect(decideResourceAccess({ sessionUserId: "user-a", role: "user", owner: FOUND_NOBODY, nullOwnerAllowed: false }))
      .toEqual({ ok: false, reason: "no-owner" });
    expect(decideResourceAccess({ sessionUserId: "op", role: "admin", owner: FOUND_NOBODY, nullOwnerAllowed: false }))
      .toEqual({ ok: true });
  });

  test("a NULL owner is allowed in local mode, where there is one human", () => {
    // §4's stated trade: `resolveRole` answers `user` for a local identity
    // unconditionally, so without this the operator loses their own watcher and
    // gardener traces on their own instance.
    expect(decideResourceAccess({ sessionUserId: "user-a", role: "user", owner: FOUND_NOBODY, nullOwnerAllowed: true }))
      .toEqual({ ok: true });
  });
});

/** A real Hono app — `requireOwnedResource` reads `c.get("identity")`, which is
 *  typed OPTIONAL for the reason `guard.test.ts` documents. */
function appWith(identity: Identity | null, role: AuthRole | null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (identity) c.set("identity", identity);
    if (role) c.set("role", role);
    await next();
  });
  app.get("/res/:kind/:id", async (c) => {
    const owned = await requireOwnedResource(c, c.req.param("kind") as ResourceKind, c.req.param("id"));
    // The call-site pattern: the route answers with the expression it already
    // had, so a denial and a genuine miss are byte-identical.
    if (!owned.ok) return c.json({ error: "Thread not found" }, 404);
    return c.json({ ok: true });
  });
  app.get("/collection", (c) => {
    const rows = [
      { id: "1", userId: "user-a" },
      { id: "2", userId: "user-b" },
      { id: "3", userId: null },
    ];
    return c.json({ rows: filterToOwner(c, rows, (r) => r.userId) });
  });
  return app;
}

describe("requireOwnedResource", () => {
  test("with auth off it never consults the lookup at all", async () => {
    let calls = 0;
    __setOwnerLookupForTest(async () => {
      calls++;
      return FOUND_B;
    });
    const res = await appWith(null, null).request("/res/thread/anything");
    expect(res.status).toBe(200);
    // Not merely "allowed": a DB read per request on the default configuration
    // would be a cost this campaign promised not to add.
    expect(calls, "the owner lookup ran with auth off").toBe(0);
  });

  test("a session gets 404 — not 403 — on another user's resource", async () => {
    __setOwnerLookupForTest(async () => FOUND_B);
    const res = await appWith(A, "user").request("/res/thread/other-id");
    expect(res.status).toBe(404);
    // A 403 would confirm the id exists. A conversation id is
    // sha256("<userId>:<bot>:web")[0:16] — derivable — so the two answers must
    // be indistinguishable.
    expect(await res.json()).toEqual({ error: "Thread not found" });
  });

  test("the refusal is byte-identical to the route's own miss", async () => {
    const app = appWith(A, "user");
    __setOwnerLookupForTest(async () => FOUND_B);
    const denied = await app.request("/res/thread/other-id");
    __setOwnerLookupForTest(async () => MISSING);
    const missing = await app.request("/res/thread/no-such-id");
    expect(denied.status).toBe(missing.status);
    expect(await denied.text()).toBe(await missing.text());
  });

  test("a session reaches its own resource", async () => {
    __setOwnerLookupForTest(async () => FOUND_A);
    const res = await appWith(A, "user").request("/res/thread/mine");
    expect(res.status).toBe(200);
  });

  test("an empty or absent id is refused without a lookup", async () => {
    let calls = 0;
    __setOwnerLookupForTest(async () => {
      calls++;
      return FOUND_A;
    });
    // Hono will not match an empty `:id` segment, so this drives the helper's
    // own contract rather than a URL. It matters for the body/query call sites
    // (`body.threadId`, `?thread=`), where an absent id is a real request.
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("identity", A);
      c.set("role", "user");
      await next();
    });
    app.get("/empty", async (c) => c.json(await requireOwnedResource(c, "thread", "")));
    app.get("/absent", async (c) => c.json(await requireOwnedResource(c, "thread", undefined)));
    expect(await (await app.request("/empty")).json()).toEqual({ ok: false, reason: "missing" });
    expect(await (await app.request("/absent")).json()).toEqual({ ok: false, reason: "missing" });
    expect(calls).toBe(0);
  });

  test("the NULL-owner rule reads pinnedLocalUserId, so local mode relaxes it", async () => {
    __setOwnerLookupForTest(async () => FOUND_NOBODY);
    const app = appWith(A, "user");

    __setAuthPolicyForTest({ authenticating: true, pinnedUserId: null });
    expect((await app.request("/res/trace/watcher-trace")).status).toBe(404);

    __setAuthPolicyForTest({ authenticating: true, pinnedUserId: "user-a" });
    expect((await app.request("/res/trace/watcher-trace")).status).toBe(200);
  });

  test("the admin passthrough WRITES an audit row (the call site, not just the fn)", async () => {
    // Mutation proof: replacing the `auditAdminPassthrough(...)` call in
    // requireOwnedResource with a no-op leaves the suite green — the audit-a-
    // cross-user-read trail vanishes silently. This proves the guard CALLS it.
    // `authMode()` is injected because the preload clears it to `off`.
    __setOwnerLookupForTest(async () => FOUND_B);
    __setAuthPolicyForTest({ authenticating: true, pinnedUserId: null, mode: "entra" });
    const rows = await captureRows(async () => {
      const res = await appWith({ ...A, userId: "op" }, "admin").request("/res/trace/colleague-trace");
      expect(res.status).toBe(200);
    });
    const passthrough = rows.filter((r) => r.metadata?.audit === "admin-passthrough");
    expect(passthrough).toHaveLength(1);
    expect(passthrough[0]!.metadata).toMatchObject({ reader: "op", owner: "user-b", kind: "trace" });
  });

  test("an admin reading a NULL-owner row writes NO 'owned by null' audit row", async () => {
    // A NULL-owner row (an orphaned jira_draft off a deleted thread, a watcher
    // trace) satisfies the admin passthrough, but its whole purpose is naming
    // WHO was read — and "owned by null" names nobody. The guard must not fire
    // the passthrough audit for an owner-less row.
    __setOwnerLookupForTest(async () => FOUND_NOBODY);
    __setAuthPolicyForTest({ authenticating: true, pinnedUserId: null, mode: "entra" });
    const rows = await captureRows(async () => {
      const res = await appWith({ ...A, userId: "op" }, "admin").request("/res/trace/watcher-trace");
      // Admin still READS it (nullOwnerAllowed is false here, but admin passes) —
      // the point is only that no passthrough row is written naming a null owner.
      expect(res.status).toBe(200);
    });
    const passthrough = rows.filter((r) => r.metadata?.audit === "admin-passthrough");
    expect(passthrough).toEqual([]);
  });

  test("HEAD is guarded like its GET sibling, and Bun emits no body", async () => {
    // Hono dispatches HEAD to the app.get handler and RUNS it, so the guard
    // running before the side effect is the whole story; the bodyless response
    // is Bun's doing, measured on 1.3.14.
    __setOwnerLookupForTest(async () => FOUND_B);
    const res = await appWith(A, "user").request("/res/thread/other-id", { method: "HEAD" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("filterToOwner", () => {
  test("auth off returns every row", async () => {
    const res = await appWith(null, null).request("/collection");
    expect((await res.json() as { rows: unknown[] }).rows).toHaveLength(3);
  });

  test("a session sees only its own rows, and NOT the owner-less one", async () => {
    __setAuthPolicyForTest({ authenticating: true, pinnedUserId: null });
    const res = await appWith(A, "user").request("/collection");
    expect((await res.json() as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual(["1"]);
  });

  test("in local mode the owner-less row rides along, matching the gate's rule", async () => {
    __setAuthPolicyForTest({ authenticating: true, pinnedUserId: "user-a" });
    const res = await appWith(A, "user").request("/collection");
    expect((await res.json() as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual(["1", "3"]);
  });

  test("admin sees every row — the operator surface stays whole", async () => {
    const res = await appWith({ ...A, userId: "op" }, "admin").request("/collection");
    expect((await res.json() as { rows: unknown[] }).rows).toHaveLength(3);
  });
});
