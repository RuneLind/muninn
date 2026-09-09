import { test, expect, describe, afterEach } from "bun:test";
import { Hono } from "hono";
import { registerSummariesPromptRoutes, type SummariesPromptDeps } from "./summaries-prompt.ts";
import { __setAuthPolicyForTest } from "../../auth/policy.ts";

/**
 * `GET /api/summaries/prompt?url=` — the seam a /summaries doc-panel
 * "Show prompt" control will call. No such control exists yet (PR 3).
 *
 * It answers from the SNAPSHOT, never from the trace: a capture's trace is
 * swept after 7 days and its prompt is kept for 90, so a route that resolved
 * the trace first would go dark on every summary older than a week. What the
 * trace decides is only whether the `/traces` deep link is offered
 * (`traceExists`).
 */
const SNAPSHOT = {
  traceId: "11111111-2222-3333-4444-555555555555",
  pass: "claude",
  systemPrompt: "summarize the talk",
  userPrompt: "### [00:00:00]\nthe transcript",
  createdAt: 1_700_000_000_000,
};

function deps(over: Partial<SummariesPromptDeps> = {}): SummariesPromptDeps {
  return {
    loadSnapshot: async (url: string) => (url === "https://example.test/talk" ? SNAPSHOT : null),
    traceExists: async () => true,
    ...over,
  };
}

function appWith(d: SummariesPromptDeps): Hono {
  const app = new Hono();
  registerSummariesPromptRoutes(app, d);
  return app;
}

afterEach(() => __setAuthPolicyForTest(null));

describe("GET /api/summaries/prompt", () => {
  test("answers the stored capture snapshot for that url", async () => {
    const res = await appWith(deps()).request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Ftalk");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      traceId: SNAPSHOT.traceId,
      pass: "claude",
      systemPrompt: "summarize the talk",
      userPrompt: "### [00:00:00]\nthe transcript",
      createdAt: SNAPSHOT.createdAt,
      traceExists: true,
    });
  });

  test("reports traceExists=false once the trace has been swept", async () => {
    const app = appWith(deps({ traceExists: async () => false }));
    const res = await app.request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Ftalk");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traceExists: boolean; systemPrompt: string };
    // The body still comes back — only the waterfall link is withheld.
    expect(body.traceExists).toBe(false);
    expect(body.systemPrompt).toBe("summarize the talk");
  });

  test("404s for a document with no snapshot", async () => {
    const res = await appWith(deps()).request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Fother");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no snapshot for this document" });
  });

  test("400s when url is missing", async () => {
    const res = await appWith(deps()).request("/api/summaries/prompt");
    expect(res.status).toBe(400);
  });

  test("400s when url is blank", async () => {
    const res = await appWith(deps()).request("/api/summaries/prompt?url=");
    expect(res.status).toBe(400);
  });

  test("never reaches the lookup when the guard refuses", async () => {
    // A plain `user` on a multi-identity instance. The guard is REQUEST-derived
    // (`sessionIdentity(c)`), so the refusal has to be driven with an identity
    // on the request — setting the policy module alone leaves the request
    // unidentified, which is "auth off" and correctly admits.
    __setAuthPolicyForTest({ authenticating: true });
    let looked = 0;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("identity", {
        userId: "user-a", displayName: "A", navIdent: null, oid: null,
        provider: "entra", expiresAt: null,
      });
      c.set("role", "user");
      await next();
    });
    registerSummariesPromptRoutes(app, deps({ loadSnapshot: async () => { looked++; return SNAPSHOT; } }));
    const res = await app.request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Ftalk");
    expect(res.status).toBe(403);
    expect(looked).toBe(0);
  });

  test("an admin identity is admitted", async () => {
    __setAuthPolicyForTest({ authenticating: true });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("identity", {
        userId: "user-a", displayName: "A", navIdent: null, oid: null,
        provider: "entra", expiresAt: null,
      });
      c.set("role", "admin");
      await next();
    });
    registerSummariesPromptRoutes(app, deps());
    const res = await app.request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Ftalk");
    expect(res.status).toBe(200);
  });

  test("auth off answers any reader", async () => {
    __setAuthPolicyForTest(null);
    const res = await appWith(deps()).request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Ftalk");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/summaries/prompt — hygiene", () => {
  test("400s when url is whitespace only", async () => {
    // Reached the lookup untrimmed before, which then 404'd with a message
    // about the DOCUMENT — a malformed request reported as a missing one.
    let looked: string | null = null;
    const app = appWith(deps({ loadSnapshot: async (u) => { looked = u; return null; } }));
    const res = await app.request("/api/summaries/prompt?url=%20%20");
    expect(res.status).toBe(400);
    expect(looked).toBeNull();
  });

  test("a url with surrounding whitespace is looked up trimmed", async () => {
    const res = await appWith(deps()).request("/api/summaries/prompt?url=%20https%3A%2F%2Fexample.test%2Ftalk%20");
    expect(res.status).toBe(200);
  });

  test("a throwing trace lookup still answers the prompt, with traceExists=false", async () => {
    // The trace lookup decides ONE thing: whether to offer the waterfall link.
    // A 500 over it would withhold the body the route exists to serve.
    const app = appWith(deps({ traceExists: async () => { throw new Error("traces table is gone"); } }));
    const res = await app.request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Ftalk");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traceExists: boolean; systemPrompt: string };
    expect(body.traceExists).toBe(false);
    expect(body.systemPrompt).toBe("summarize the talk");
  });

  test("a throwing SNAPSHOT lookup is still a 500 — that one is the body", async () => {
    const app = appWith(deps({ loadSnapshot: async () => { throw new Error("db down"); } }));
    const res = await app.request("/api/summaries/prompt?url=https%3A%2F%2Fexample.test%2Ftalk");
    expect(res.status).toBe(500);
  });
});
