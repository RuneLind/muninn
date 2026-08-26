import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createZoneMiddleware, __resetZoneWarningsForTest } from "./zone-middleware.ts";
import { resolveAuthConfig, type AuthConfig } from "./mode.ts";
import { AUDITED_COLLECTION_PATHS } from "./zones.ts";
import { __resetAuditDedupForTest, AUDIT_DEDUP_WINDOW_MS } from "./audit.ts";
import { activityLog } from "../observability/activity-log.ts";
import type { ActivityEvent } from "../types.ts";
import type { AuthRole } from "./role.ts";
import type { Identity } from "./introspect.ts";

const LOCAL = resolveAuthConfig({
  MUNINN_AUTH: "local",
  MUNINN_LOCAL_TOKEN: "a-sufficiently-long-secret",
  MUNINN_LOCAL_USER: "rune",
  MUNINN_ADMIN_IDENTS: "A123456",
  MUNINN_ALLOWED_ORIGINS: "https://muninn-host.example-tailnet.ts.net",
});

/** `entra` cannot be built through `resolveAuthConfig` (it refuses to boot until
 *  `AUTH_ZONES_IMPLEMENTED` flips), so the audit gate is exercised over a
 *  literal — the mode is the only field it reads. */
const ENTRA: AuthConfig = { ...LOCAL, mode: "entra", local: null };

const identity = (userId: string): Identity => ({
  userId, displayName: userId, navIdent: null, oid: null, provider: "local", expiresAt: null,
});

/** An app whose identity/role are pinned, so this file tests the ZONE decision
 *  rather than re-testing `createAuthMiddleware`. */
function appAs(role: AuthRole | null, config: AuthConfig = LOCAL, userId = "operator"): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (role !== null) {
      c.set("role", role);
      c.set("identity", identity(userId));
    }
    await next();
  });
  app.use("*", createZoneMiddleware(config));
  app.all("*", (c) => c.text("handler ran"));
  return app;
}

const get = (app: Hono, path: string, method = "GET") => app.request(path, { method });

beforeEach(() => {
  __resetZoneWarningsForTest();
  __resetAuditDedupForTest();
});

describe("the zone middleware", () => {
  test("role `user` gets 403 on the two admin /chat/bot-preferences routes", async () => {
    const app = appAs("user");
    const path = "/chat/bot-preferences/jarvis/default-user";
    expect((await get(app, path)).status).toBe(403);
    expect((await get(app, path, "PUT")).status).toBe(403);
  });

  test("role `user` reaches the chat surface and the routes that page calls", async () => {
    const app = appAs("user");
    for (const path of ["/chat", "/chat/me", "/chat/events", "/api/goals/rune", "/api/jira/templates"]) {
      expect((await get(app, path)).status, path).toBe(200);
    }
  });

  test("role `user` is refused the operator surface", async () => {
    const app = appAs("user");
    for (const path of ["/traces", "/models", "/plans", "/api/users", "/api/traces"]) {
      const res = await get(app, path);
      expect(res.status, path).toBe(403);
      // The reason is deliberately generic: naming the rule that fired would
      // tell a prober which allowlist to aim at.
      expect(await res.json()).toEqual({ error: "forbidden", reason: "admin-only route" });
    }
  });

  test("role `admin` reaches everything", async () => {
    const app = appAs("admin");
    for (const path of ["/traces", "/api/users", "/chat/bot-preferences/jarvis/default-user", "/chat/me"]) {
      expect((await get(app, path)).status, path).toBe(200);
    }
  });

  test("the two health paths answer without a role at all", async () => {
    // They are in `AUTH_EXCLUDED_PATHS`, so no identity was resolved and the
    // zone middleware must skip rather than default-deny them.
    const app = appAs(null);
    expect((await get(app, "/api/live")).status).toBe(200);
    expect((await get(app, "/api/ready")).status).toBe(200);
  });

  test("with no role at all (auth off) nothing is denied", async () => {
    const app = appAs(null);
    expect((await get(app, "/traces")).status).toBe(200);
  });
});

describe("the collection-read audit hook", () => {
  /** Rows this test wrote, read off the in-memory feed. The DB half — that the
   *  row really lands, given `push`'s swallowed `.catch` — is
   *  `src/db/auth-audit.test.ts`. */
  function capture(): { rows: ActivityEvent[]; stop: () => void } {
    const rows: ActivityEvent[] = [];
    const stop = activityLog.subscribe((e) => rows.push(e));
    return { rows, stop };
  }

  test("an admin read of every audited collection writes a row naming reader and route", async () => {
    const app = appAs("admin", ENTRA, "A123456");
    const { rows, stop } = capture();
    try {
      for (const path of AUDITED_COLLECTION_PATHS) expect((await get(app, path)).status, path).toBe(200);
    } finally {
      stop();
    }
    expect(rows.map((r) => r.metadata?.route)).toEqual([...AUDITED_COLLECTION_PATHS]);
    for (const row of rows) {
      expect(row.type).toBe("system");
      expect(row.metadata?.audit).toBe("admin-collection-read");
      expect(row.metadata?.reader).toBe("A123456");
      expect(row.userId).toBe("A123456");
      expect(row.text).toContain("A123456");
    }
  });

  test("the dedup window holds — an open /traces tab polling every 15s writes ONE row", async () => {
    const app = appAs("admin", ENTRA, "A123456");
    const { rows, stop } = capture();
    try {
      // 20 polls is five minutes at the page's real 15s interval.
      for (let i = 0; i < 20; i++) await get(app, "/api/traces");
    } finally {
      stop();
    }
    expect(rows).toHaveLength(1);
    expect(AUDIT_DEDUP_WINDOW_MS).toBeGreaterThan(15_000);
  });

  test("role `user` never reaches the hook — the route is 403 before it", async () => {
    const app = appAs("user", ENTRA);
    const { rows, stop } = capture();
    try {
      expect((await get(app, "/api/traces")).status).toBe(403);
    } finally {
      stop();
    }
    expect(rows).toEqual([]);
  });

  test("on a `local` instance nothing is audited — every row would be self-audit", async () => {
    const app = appAs("admin", LOCAL, "rune");
    const { rows, stop } = capture();
    try {
      expect((await get(app, "/api/traces")).status).toBe(200);
    } finally {
      stop();
    }
    expect(rows).toEqual([]);
  });

  test("the row is written BEFORE the handler — an ATTEMPTED read still rows", async () => {
    // A 404, a 500 or an empty result must all leave a trace. An audit trail
    // that records only successes is one an attacker can walk quietly.
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("role", "admin");
      c.set("identity", identity("A123456"));
      await next();
    });
    app.use("*", createZoneMiddleware(ENTRA));
    app.get("/api/traces", (c) => c.json({ error: "not found" }, 404));
    const { rows, stop } = capture();
    try {
      expect((await app.request("/api/traces")).status).toBe(404);
    } finally {
      stop();
    }
    expect(rows).toHaveLength(1);
  });
});
