import { test, expect, describe, afterEach } from "bun:test";
import { Hono } from "hono";
import { requireOwnUser, extractionsForcedOff, sessionIdentity, sessionRole } from "./guard.ts";
import { __setAuthPolicyForTest } from "./policy.ts";
import { __resetAuditDedupForTest } from "./audit.ts";
import { activityLog } from "../observability/activity-log.ts";
import type { ActivityEvent } from "../types.ts";
import type { Identity } from "./introspect.ts";
import type { AuthRole } from "./role.ts";

afterEach(() => {
  __setAuthPolicyForTest(null);
  __resetAuditDedupForTest();
});

const LOCAL: Identity = {
  userId: "rune",
  displayName: "Rune",
  navIdent: null,
  oid: null,
  provider: "local",
  expiresAt: null,
};
const ENTRA: Identity = { ...LOCAL, userId: "nav-a150244", provider: "entra", navIdent: "A150244" };

/** A real Hono app, because `requireOwnUser` reads `c.get("identity")` and a
 *  hand-rolled context object would not exercise the OPTIONAL typing that PR B's
 *  review found could let a guard compile green and throw on the default
 *  config. `identity` omitted ⇒ auth off, exactly as in production. */
function appWith(identity: Identity | null, role: AuthRole | null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (identity) c.set("identity", identity);
    if (role) c.set("role", role);
    await next();
  });
  app.get("/probe/:userId", (c) => {
    const own = requireOwnUser(c, c.req.param("userId"), c.req.query("username"));
    if (!own.ok) return own.response;
    return c.json({ userId: own.userId ?? null, username: own.username ?? null });
  });
  app.get("/absent", (c) => {
    const own = requireOwnUser(c, undefined);
    if (!own.ok) return own.response;
    return c.json({ userId: own.userId ?? null, username: own.username ?? null });
  });
  app.get("/extractions", (c) => c.json({ forced: extractionsForcedOff(c) }));
  app.get("/context", (c) => c.json({
    identity: sessionIdentity(c)?.userId ?? null,
    role: sessionRole(c),
  }));
  return app;
}

describe("auth off — the DEFAULT configuration", () => {
  // The whole campaign's "off is off" rule. Every assertion here would also
  // pass if `requireOwnUser` threw on a missing identity — which it must not,
  // because with MUNINN_AUTH unset no middleware is mounted and `c.get(
  // "identity")` is `undefined` on every request muninn serves today.
  const app = appWith(null, null);

  test("a claimed id passes through verbatim", async () => {
    const res = await app.request("/probe/someone-else?username=Faked");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "someone-else", username: "Faked" });
  });

  test("an ABSENT claim stays absent, so a call site keeps its own default", async () => {
    // This is what leaves `body.userId ?? "sim-user-1"` working with auth off.
    const res = await app.request("/absent");
    expect(await res.json()).toEqual({ userId: null, username: null });
  });

  test("no identity in context means no role and no identity", async () => {
    expect(await (await app.request("/context")).json()).toEqual({ identity: null, role: null });
  });
});

describe("an authenticating mode, role user", () => {
  const app = appWith(LOCAL, "user");

  test("a DIFFERING claimed id is 403, and the response does not echo it back", async () => {
    const res = await app.request("/probe/colleague-b");
    expect(res.status).toBe(403);
    const body = await res.text();
    // The id set is derivable (`sha256("<userId>:<bot>:web")`), so a refusal
    // that repeated the claim would confirm ids back to a prober.
    expect(body).not.toContain("colleague-b");
    expect(JSON.parse(body).error).toBe("forbidden");
  });

  test("a MATCHING claimed id is allowed and answers the session id", async () => {
    const res = await app.request("/probe/rune");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "rune", username: "Rune" });
  });

  test("an ABSENT claim resolves to the session — never undefined", async () => {
    // Acceptance 9's "`sim-user-1` is unreachable": `own.userId ?? "sim-user-1"`
    // can only pick the fallback when this is undefined, and here it never is.
    const res = await app.request("/absent");
    expect(await res.json()).toEqual({ userId: "rune", username: "Rune" });
  });

  test("username is FORCED from the session, not taken from the client", async () => {
    // `username` is a second claimed identity. It never clobbers users.username
    // (the web path passes lockUsername), but it reaches the prompt's speaker
    // label, traces.username, the activity_log row and AgentRun.username.
    const res = await app.request("/probe/rune?username=Someone%20Else");
    expect(await res.json()).toEqual({ userId: "rune", username: "Rune" });
  });

  test("an EMPTY claimed id is treated as absent, not as a differing claim", async () => {
    const empty = new Hono();
    empty.use("*", async (c, next) => { c.set("identity", LOCAL); c.set("role", "user"); await next(); });
    empty.get("/e", (c) => {
      const own = requireOwnUser(c, "");
      return own.ok ? c.json({ userId: own.userId }) : own.response;
    });
    expect(await (await empty.request("/e")).json()).toEqual({ userId: "rune" });
  });
});

describe("an authenticating mode, role admin", () => {
  // Inert in `local` mode — `resolveRole` answers `user` for the pinned
  // identity unconditionally, and that is load-bearing: an admin passthrough
  // for the local identity would make acceptance 9 pass without the diff. The
  // branch is tested here because the deferred Entra half is what activates it.
  const app = appWith(ENTRA, "admin");

  test("a differing claim passes through unchanged", async () => {
    const res = await app.request("/probe/colleague-b?username=Colleague");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "colleague-b", username: "Colleague" });
  });

  test("an absent claim falls back to the admin's own id", async () => {
    expect(await (await app.request("/absent")).json()).toEqual({ userId: "nav-a150244", username: null });
  });

  test("the admin passthrough WRITES an audit row (the call site, not just the fn)", async () => {
    // Mutation proof: replacing the `auditAdminPassthrough(...)` call in
    // requireOwnUser with a no-op leaves 264 tests green — every existing test
    // asserts the returned userId, none proves the guard CALLS the audit. This
    // one does. `authMode()` reads the policy, which the test preload clears to
    // `off`, so entra is injected explicitly.
    __setAuthPolicyForTest({ authenticating: true, mode: "entra" });
    const rows: ActivityEvent[] = [];
    const stop = activityLog.subscribe((e) => rows.push(e));
    try {
      const res = await app.request("/probe/colleague-b");
      expect(res.status).toBe(200);
    } finally {
      stop();
    }
    const passthrough = rows.filter((r) => r.metadata?.audit === "admin-passthrough");
    expect(passthrough).toHaveLength(1);
    expect(passthrough[0]!.metadata).toMatchObject({ reader: "nav-a150244", owner: "colleague-b", kind: "claimed-id" });
  });
});

describe("extractionsForcedOff", () => {
  test("false with auth off and for a local identity — inert today", async () => {
    expect(await (await appWith(null, null).request("/extractions")).json()).toEqual({ forced: false });
    expect(await (await appWith(LOCAL, "user").request("/extractions")).json()).toEqual({ forced: false });
  });

  test("true for an entra account — §8's ROS decision", async () => {
    expect(await (await appWith(ENTRA, "user").request("/extractions")).json()).toEqual({ forced: true });
  });
});
