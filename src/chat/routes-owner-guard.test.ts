/**
 * PR D's resource guard and the replacement event stream, at the CHAT routes.
 *
 * **Its own file, and its own `&&` link in the `test` / `test:unit` chains.**
 * Not for `mock.module` — this file uses none — but for the same reason those
 * links exist: added to `routes.test.ts` inside the first chunk, the chunk
 * finished with 4275 passing tests and then Bun panicked at teardown
 * (`exit 133`, "A C++ exception occurred", every assertion green). Skipping any
 * individual test here did not fix it and skipping the whole group did, so it is
 * the chunk's size rather than anything in one assertion. Splitting is the
 * repo's remedy for a chunk that has outgrown its process; keep it split.
 *
 * What is pinned here: that each id-addressed chat route consults the owner
 * lookup and answers its OWN miss when the lookup says no, that auth off
 * consults nothing at all, and that `GET /chat/events` is scoped to its viewer
 * and carries neither of the two channels the `/api/events` denial exists for.
 */
import { test, expect, describe, afterAll, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { createChatRoutes } from "./routes.ts";
import { chatState } from "./state.ts";
import { setPendingMessage, consumePendingMessage } from "./pending-messages.ts";
import { agentStatus } from "../observability/agent-status.ts";
import { __setAuthPolicyForTest } from "../auth/policy.ts";
import { __setOwnerLookupForTest } from "../auth/resource-guard.ts";
import type { Identity } from "../auth/introspect.ts";
import type { AuthRole } from "../auth/role.ts";

const tmpDirs: string[] = [];
async function appWithBot() {
  const dir = await mkdtemp(join(tmpdir(), "muninn-guard-test-"));
  tmpDirs.push(dir);
  const bot = { name: "testbot", dir } as unknown as BotConfig;
  const app = createChatRoutes([bot], {} as unknown as Config);
  return { app, dir };
}
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

const jsonPostWith = (payload: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

/**
 * PR D's resource guard, at the routes that carry no claimed `userId` at all —
 * the shape `requireOwnUser` structurally cannot reach.
 *
 * Driven through the real router (no DB: the conversation kind resolves out of
 * `chatState`), with an identity set by a middleware in front, exactly as
 * `createAuthMiddleware` sets one in production.
 */
describe("resource guards on the conversation routes", () => {
  afterEach(() => __setOwnerLookupForTest(null));

  const A: Identity = {
    userId: "guard-a", displayName: "A", navIdent: null, oid: null,
    provider: "local", expiresAt: null,
  };

  async function appAs(identity: Identity | null, role: AuthRole | null) {
    // Only the `thread` kind is stubbed — it would otherwise reach the DB. The
    // `conversation` kind MUST keep resolving out of the real `chatState`, or
    // this override silently turns every conversation assertion below into
    // "not found" and the whole describe passes for the wrong reason.
    __setOwnerLookupForTest(async (kind, id) => {
      if (kind !== "thread") {
        const owner = chatState.conversationOwner(id);
        return owner === undefined ? { found: false } : { found: true, userId: owner };
      }
      return id === FOREIGN_THREAD_ID ? { found: true, userId: "guard-b" } : { found: false };
    });
    const { app: chat } = await appWithBot();
    const app = new Hono();
    app.use("*", async (c, next) => {
      if (identity) c.set("identity", identity);
      if (role) c.set("role", role);
      await next();
    });
    app.route("/", chat);
    return app;
  }

  /** A uuid that the injected lookup reports as owned by someone else. */
  const FOREIGN_THREAD_ID = "11111111-2222-4333-8444-555555555555";

  /** Two conversations on one bot, one per owner. */
  async function seed() {
    const mine = await chatState.findOrCreateBotConversation({
      botName: "testbot", userId: "guard-a", username: "A",
    });
    const theirs = chatState.createConversation({
      type: "telegram_dm", botName: "testbot", userId: "guard-b", username: "B",
    });
    return { mine, theirs };
  }

  test("with auth off every conversation is reachable — off is off", async () => {
    const { theirs } = await seed();
    const app = await appAs(null, null);
    expect((await app.request(`/conversations/${theirs.id}`)).status).toBe(200);
  });

  test("a session gets 404 on another user's conversation, byte-identical to a miss", async () => {
    const { theirs } = await seed();
    const app = await appAs(A, "user");
    const denied = await app.request(`/conversations/${theirs.id}`);
    const missing = await app.request("/conversations/no-such-conversation");
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
  });

  test("a session reaches its OWN conversation", async () => {
    const { mine } = await seed();
    const app = await appAs(A, "user");
    expect((await app.request(`/conversations/${mine.id}`)).status).toBe(200);
  });

  test("DELETE is refused BEFORE the delete happens", async () => {
    // The guard has to run before the effect, not after: a guard that answers
    // 404 having already dropped the conversation is no guard at all.
    const { theirs } = await seed();
    const app = await appAs(A, "user");
    expect((await app.request(`/conversations/${theirs.id}`, { method: "DELETE" })).status).toBe(404);
    expect(chatState.getConversation(theirs.id), "the conversation was deleted anyway").toBeDefined();
  });

  test("POST …/messages guards body.threadId, not only the conversation", async () => {
    // The review round's highest finding: this route addresses TWO resources.
    // Owning the conversation says nothing about owning the thread, and
    // `body.threadId` reaches `handlePeerOutbound` (which writes under the
    // THREAD owner's user_id), `setResearchStageByThread` (a cross-user UPDATE)
    // and `processChatMessage`'s persisted turn.
    const { mine } = await seed();
    const app = await appAs(A, "user");
    // The conversation IS A's, so only the thread guard can refuse this.
    const res = await app.request(
      `/conversations/${mine.id}/messages`,
      jsonPostWith({ text: "hi", threadId: FOREIGN_THREAD_ID }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Conversation not found" });
  });

  test("POST …/messages with NO threadId still works — the guard is not a blanket refusal", async () => {
    const { mine } = await seed();
    const app = await appAs(A, "user");
    const res = await app.request(`/conversations/${mine.id}/messages`, jsonPostWith({ text: "hi" }));
    // 202 = accepted for async processing. Anything but a 404 proves the thread
    // guard did not fire on an absent id.
    expect(res.status).toBe(202);
  });

  test("POST …/messages is refused on another user's conversation", async () => {
    // The route this whole PR exists for: it spends a model turn AS the owner
    // and writes into their thread.
    const { theirs } = await seed();
    const app = await appAs(A, "user");
    const res = await app.request(`/conversations/${theirs.id}/messages`, jsonPostWith({ text: "hi" }));
    expect(res.status).toBe(404);
  });

  test("a non-uuid thread id is the route's own miss, never a 500", async () => {
    // `threads.id` is a uuid COLUMN, so an unparseable value reaches postgres as
    // a cast ERROR rather than an empty result. `GET /chat/pending/:threadId`
    // has no `try`, so the guard turned `{text:null}` into an unhandled 500.
    const app = await appAs(A, "user");
    const pending = await app.request("/pending/garbage");
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ text: null });

    const del = await app.request("/threads/garbage", { method: "DELETE" });
    expect(del.status).toBe(404);
  });

  test("HEAD on another user's conversation is refused too, and carries no body", async () => {
    // Hono dispatches HEAD to the app.get handler and RUNS it.
    const { theirs } = await seed();
    const app = await appAs(A, "user");
    const res = await app.request(`/conversations/${theirs.id}`, { method: "HEAD" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  /**
   * Every THREAD-addressed route, in one table.
   *
   * The mutation round found the guards present but unpinned: deleting the
   * guard on any of these left `bun run test` green. A guard nobody tests is a
   * guard the next refactor removes — and two of these (`/pending`, the
   * DELETEs) destroy or mutate what they address.
   */
  const THREAD_ROUTES: { name: string; path: string; init?: RequestInit; miss: unknown; status: number }[] = [
    { name: "GET /pending/:threadId", path: `/pending/${FOREIGN_THREAD_ID}`, miss: { text: null }, status: 200 },
    {
      name: "GET /dev-run/by-thread/:threadId",
      path: `/dev-run/by-thread/${FOREIGN_THREAD_ID}`,
      miss: { error: "No dev_run for thread" }, status: 404,
    },
    {
      name: "DELETE /threads/:id", path: `/threads/${FOREIGN_THREAD_ID}`, init: { method: "DELETE" },
      miss: { error: "Thread not found or is the main thread" }, status: 404,
    },
    {
      name: "PATCH /threads/:id/connector", path: `/threads/${FOREIGN_THREAD_ID}/connector`,
      init: { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectorId: null }) },
      miss: { error: "Thread not found" }, status: 404,
    },
    {
      name: "PATCH /threads/:id/auto-respond", path: `/threads/${FOREIGN_THREAD_ID}/auto-respond`,
      init: { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: true }) },
      miss: { error: "Thread not found" }, status: 404,
    },
  ];

  for (const route of THREAD_ROUTES) {
    test(`${route.name} refuses another user's thread with its own miss`, async () => {
      const app = await appAs(A, "user");
      const res = await app.request(route.path, route.init);
      expect(res.status).toBe(route.status);
      expect(await res.json()).toEqual(route.miss);
    });

    test(`${route.name} consults NO owner lookup with auth off`, async () => {
      // The other half, and it has to be measured rather than inferred from the
      // response: several of these routes answer the SAME body with auth off
      // for an innocent reason (`/pending` on an empty store is `{text:null}`
      // either way), so "the answer differs" cannot distinguish an unguarded
      // route from a guarded one. What does: the guard returns before it looks
      // anything up, so a lookup call at all would mean auth-off changed.
      let lookups = 0;
      const app = await appAs(null, null);
      __setOwnerLookupForTest(async () => {
        lookups++;
        return { found: false };
      });
      try {
        await app.request(route.path, route.init);
      } catch {
        // Some of these reach the DB once past the guard, which this app has none
        // of. The assertion is the lookup COUNT, not the response.
      }
      expect(lookups, "the owner lookup ran with auth off").toBe(0);
    });
  }

  test("GET /pending/:threadId does not CONSUME what it refuses", async () => {
    // The sharpest case in the PR: this route destroys what it reads, so a
    // guard placed after the consume would answer 404 having already thrown
    // away the owner's pending message.
    setPendingMessage(FOREIGN_THREAD_ID, "B's pending research");
    const denied = await (await appAs(A, "user")).request(`/pending/${FOREIGN_THREAD_ID}`);
    expect(await denied.json()).toEqual({ text: null });
    // Still there for its owner — i.e. the refusal did not consume it.
    expect(consumePendingMessage(FOREIGN_THREAD_ID)?.text).toBe("B's pending research");
  });

  test("GET /conversations returns only the viewer's rows", async () => {
    // The FILTER shape. Gating the per-id routes while leaving this index open
    // would publish the very id set they protect.
    await seed();
    __setAuthPolicyForTest({ authenticating: true, pinnedUserId: "guard-a" });
    try {
      const app = await appAs(A, "user");
      const { conversations } = await (await app.request("/conversations")).json();
      expect(conversations.length).toBeGreaterThan(0);
      expect(conversations.every((c: { userId: string }) => c.userId === "guard-a")).toBe(true);
      expect(JSON.stringify(conversations)).not.toContain("guard-b");
    } finally {
      __setAuthPolicyForTest(null);
    }
  });

  test("with auth off GET /conversations is unfiltered", async () => {
    await seed();
    const app = await appAs(null, null);
    const { conversations } = await (await app.request("/conversations")).json();
    expect(JSON.stringify(conversations)).toContain("guard-b");
  });
});

/**
 * PR D's replacement for `GET /api/events`, which is now denied to role `user`.
 * Two channels and no more: `agent_runs` and the 50-event `activity` replay are
 * the leak that denial closes, so re-adding either here would undo it.
 */
describe("GET /chat/events — the user-scoped stream", () => {
  test("it serves agent_status and request_progress, and NOTHING else", async () => {
    const { app } = await appWithBot();
    const res = await app.request("/events?viewer=user-a");
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      const deadline = Date.now() + 5_000;
      // `request_progress` is the LAST of the initial writes.
      while (!text.includes("event: request_progress") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }

    expect(text).toContain("event: agent_status");
    expect(text).toContain("event: request_progress");
    expect(text, "the operator's process-wide run snapshot leaked onto the chat stream").not.toContain("agent_runs");
    expect(text, "the 50-event activity replay leaked onto the chat stream").not.toContain("event: activity");
    expect(text).not.toContain("event: stats");
  });

  test("the frames are SCOPED to the viewer, not merely present", async () => {
    // The mutation round's sharpest survivor: dropping the `viewer` argument
    // from `agentStatus.get`/`subscribe`/`subscribeProgress` on this route left
    // every assertion green while re-introducing PR A's leak — every chat page
    // rendering every user's phase pill and waterfall — on PR D's own
    // replacement stream. Asserting WHICH event names appear cannot see that;
    // asserting whose run is in the payload can.
    agentStatus.clearRequest();
    agentStatus.startRequest("testbot", "calling_claude", "bob", { userId: "user-b" });
    const aRun = agentStatus.startRequest("testbot", "calling_claude", "alice", { userId: "user-a" });
    agentStatus.set("calling_claude", "bob", "searching B", { userId: "user-b" });
    agentStatus.set("calling_claude", "alice", "searching A", { userId: "user-a" });

    const { app } = await appWithBot();
    const res = await app.request("/events?viewer=user-a");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      const deadline = Date.now() + 5_000;
      while (!text.includes("event: request_progress") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }

    const progress = /event: request_progress\ndata: (.*)\n/.exec(text);
    expect(progress, "no request_progress frame").not.toBeNull();
    expect((JSON.parse(progress![1]!) as { requestId: string }).requestId).toBe(aRun);
    expect(text, "B's run leaked onto A's stream").not.toContain("searching B");
    expect(text).toContain("searching A");

    agentStatus.clearRequest();
  });

  test("a claimed viewer that differs from the session is 403", async () => {
    const { app: chat } = await appWithBot();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("identity", {
        userId: "session-user", displayName: "S", navIdent: null, oid: null,
        provider: "local", expiresAt: null,
      });
      c.set("role", "user");
      await next();
    });
    app.route("/", chat);
    const res = await app.request("/events?viewer=someone-else");
    expect(res.status).toBe(403);
  });
});
