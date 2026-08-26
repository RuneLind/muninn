import { test, expect, describe, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { createChatRoutes } from "../chat/routes.ts";
import { chatState } from "../chat/state.ts";
import type { Identity } from "./introspect.ts";
import type { AuthRole } from "./role.ts";

/**
 * Acceptance item 9 - "identity cannot be claimed" - driven through the REAL
 * chat routes rather than through `requireOwnUser` alone. `guard.test.ts` pins
 * the helper's branches; this file pins that the branches are actually WIRED,
 * which is the failure mode a helper-only suite cannot see.
 *
 * The identity is injected by a stand-in middleware rather than by
 * `createAuthMiddleware`, deliberately: what these routes read is
 * `c.get("identity")` / `c.get("role")`, and the real middleware's own job
 * (credentials, the loopback bypass, the session cookie) is `middleware.test.ts`'s
 * and would only make these cases depend on a shared secret.
 */
const A: Identity = {
  userId: "colleague-a", displayName: "Colleague A",
  navIdent: null, oid: null, provider: "local", expiresAt: null,
};
const B_ID = "colleague-b";
const ISSUE = "MEL-1234";

const tmpDirs: string[] = [];
async function harness(identity: Identity | null, role: AuthRole | null) {
  const dir = await mkdtemp(join(tmpdir(), "muninn-prc-test-"));
  tmpDirs.push(dir);
  // A report that DOES exist for colleague B, so a 403 cannot be mistaken for
  // the 404 an absent file would produce anyway.
  await mkdir(join(dir, "reports", B_ID), { recursive: true });
  await writeFile(join(dir, "reports", B_ID, `${ISSUE}.md`), "B's private research\n");

  const bot = { name: "testbot", dir } as unknown as BotConfig;
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (identity) c.set("identity", identity);
    if (role) c.set("role", role);
    await next();
  });
  app.route("/chat", createChatRoutes([bot], {} as unknown as Config));
  return { app, dir };
}
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

const postJson = (payload: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

describe("acceptance 9 - a claimed userId cannot win over the session", () => {
  test("a differing :userId is 403 on every own-data route", async () => {
    const { app } = await harness(A, "user");
    for (const path of [
      `/chat/threads/${B_ID}/testbot`,
      `/chat/preferences/${B_ID}/testbot`,
      `/chat/context-usage/${B_ID}/testbot`,
      `/chat/tool-usage/${B_ID}/testbot`,
      `/chat/reports/testbot/${B_ID}/${ISSUE}`,
      `/chat/specs/testbot/${B_ID}/${ISSUE}`,
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(403);
    }
  });

  test("the HEAD oracle answers 403 with no body, not 200/404", async () => {
    // Unguarded, HEAD /chat/reports/... tells any authenticated caller whether
    // colleague B has a saved report for a given Jira key - and B's file really
    // is on disk here, so without the guard this would be a 200.
    const { app } = await harness(A, "user");
    const res = await app.request(`/chat/reports/testbot/${B_ID}/${ISSUE}`, { method: "HEAD" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  test("the same routes answer normally for the session's OWN id", async () => {
    const { app } = await harness(A, "user");
    const res = await app.request(`/chat/reports/testbot/${A.userId}/${ISSUE}`, { method: "HEAD" });
    // 404: A has no such report. The point is that it is not a 403 - the guard
    // must not break the owner's own path, which would fail CLOSED and pass
    // every security assertion in this file while breaking the product.
    expect(res.status).toBe(404);
  });

  test("a report POST writes under the SESSION id, not the claimed one", async () => {
    const { app, dir } = await harness(A, "user");
    const res = await app.request(
      `/chat/reports/testbot/${A.userId}/${ISSUE}`,
      postJson({ content: "# mine\n" }),
    );
    expect(res.status).toBe(201);
    expect(await Bun.file(join(dir, "reports", A.userId, `${ISSUE}.md`)).exists()).toBe(true);
  });

  test("a conversation claimed for another user is 403, and nothing is created", async () => {
    const { app } = await harness(A, "user");
    const before = chatState.getConversations().length;
    const res = await app.request("/chat/conversations", postJson({
      type: "web", botName: "testbot", userId: B_ID, username: "Colleague B",
    }));
    expect(res.status).toBe(403);
    // The guard runs BEFORE the body-shape checks and before any state is
    // touched, so a refused claim leaves no shell behind for the id it named.
    expect(chatState.getConversations().length).toBe(before);
  });

  test("username is FORCED from the session even when the userId matches", async () => {
    const { app } = await harness(A, "user");
    const res = await app.request("/chat/conversations", postJson({
      type: "web", botName: "testbot", userId: A.userId, username: "Somebody Else",
    }));
    expect(res.status).toBe(201);
    const { conversation } = await res.json();
    expect(conversation.userId).toBe(A.userId);
    // `username` is the SECOND claimed identity, and the greps in §2 miss it.
    // It reaches the prompt's speaker label, traces.username, the activity_log
    // row and AgentRun.username - four unprotected sinks. It is NOT
    // users.username, which lockUsername already covers on the web path, so a
    // test there would be green without the diff.
    expect(conversation.username).toBe("Colleague A");
    chatState.deleteConversation(conversation.id);
  });

  test("omitting userId entirely still lands on the session, never on sim-user-1", async () => {
    const { app } = await harness(A, "user");
    const res = await app.request("/chat/conversations", postJson({ type: "web", botName: "testbot" }));
    const { conversation } = await res.json();
    expect(conversation.userId).toBe(A.userId);
    expect(conversation.userId).not.toBe("sim-user-1");
    chatState.deleteConversation(conversation.id);
  });
});

describe("off is off - the DEFAULT configuration is unchanged", () => {
  test("a claimed :userId still resolves, and sim-user-1 is still the default", async () => {
    const { app } = await harness(null, null);
    // Would be 403 in an authenticating mode; here it must reach the handler.
    expect((await app.request(`/chat/reports/testbot/${B_ID}/${ISSUE}`, { method: "HEAD" })).status).toBe(200);

    const res = await app.request("/chat/conversations", postJson({ type: "web", botName: "testbot" }));
    const { conversation } = await res.json();
    expect(conversation.userId).toBe("sim-user-1");
    expect(conversation.username).toBe("chat-user");
    chatState.deleteConversation(conversation.id);
  });
});

describe("GET /chat/me - what the client branches on", () => {
  test('auth off answers mode "local", so the page keeps its user picker', async () => {
    const { app } = await harness(null, null);
    expect(await (await app.request("/chat/me")).json()).toEqual({
      mode: "local", userId: null, displayName: null, role: null,
    });
  });

  test('an authenticated session answers mode "session" and the id', async () => {
    const { app } = await harness(A, "user");
    const body = await (await app.request("/chat/me")).json();
    expect(body.mode).toBe("session");
    expect(body.userId).toBe(A.userId);
    expect(body.displayName).toBe("Colleague A");
    expect(body.role).toBe("user");
  });
});
