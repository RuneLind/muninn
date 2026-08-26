import { test, expect, describe, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { createChatRoutes, researchStageForPrompt } from "./routes.ts";
import { chatState } from "./state.ts";
import { Hono } from "hono";
import { __setAuthPolicyForTest } from "../auth/policy.ts";
import type { Identity } from "../auth/introspect.ts";
import type { AuthRole } from "../auth/role.ts";

// The /specs endpoints persist the domain layer of a spec as a first-class
// artifact (Phase 0). They mirror /reports and share the path-traversal guards.
// Frontmatter enrichment is best-effort (DB call, try/caught) so these run
// without a DB — content with no leading `---` block is saved verbatim.

const tmpDirs: string[] = [];
async function appWithBot() {
  const dir = await mkdtemp(join(tmpdir(), "muninn-spec-test-"));
  tmpDirs.push(dir);
  const bot = { name: "testbot", dir } as unknown as BotConfig;
  const app = createChatRoutes([bot], {} as unknown as Config);
  return { app, dir };
}
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

const jsonPost = (content: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content }),
});

const jsonPostWith = (payload: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

// Phase 5: the Investigate / Deep prompt markers drive the dev_run research_stage
// (server-authoritative) so the chat keys affordances off run state, not a count.
test("researchStageForPrompt maps the analysis-phase markers, ignores the rest", () => {
  expect(researchStageForPrompt("<!-- prompt:investigate -->find the code")).toBe("investigation");
  expect(researchStageForPrompt("<!-- prompt:deepAnalysis -->verify")).toBe("deep");
  // Other research markers + ordinary chat must not move the stage.
  expect(researchStageForPrompt("<!-- prompt:specDomain -->draft the spec")).toBeNull();
  expect(researchStageForPrompt("<!-- research:jira -->analyze")).toBeNull();
  expect(researchStageForPrompt("just a normal message")).toBeNull();
  // Marker must be at the start (mirrors the client's button prefix).
  expect(researchStageForPrompt("noise <!-- prompt:investigate -->")).toBeNull();
});

test("spec round-trip: POST saves, GET returns, HEAD reports existence", async () => {
  const { app, dir } = await appWithBot();
  const body = "# Domain spec\n\nForretningsregel: …";

  const post = await app.request("/specs/testbot/user_1/MELOSYS-123", jsonPost(body));
  expect(post.status).toBe(201);
  expect((await post.json()).path).toBe("specs/user_1/MELOSYS-123.md");
  expect(await readFile(join(dir, "specs", "user_1", "MELOSYS-123.md"), "utf8")).toBe(body);

  const get = await app.request("/specs/testbot/user_1/MELOSYS-123");
  expect(get.status).toBe(200);
  expect((await get.json()).content).toBe(body);

  expect((await app.request("/specs/testbot/user_1/MELOSYS-123", { method: "HEAD" })).status).toBe(200);
  expect((await app.request("/specs/testbot/user_1/MELOSYS-999", { method: "HEAD" })).status).toBe(404);
});

test("spec accepts the synthetic research-<8hex> issue key (chat-started research)", async () => {
  const { app } = await appWithBot();
  const post = await app.request("/specs/testbot/user_1/research-abcd1234", jsonPost("x"));
  expect(post.status).toBe(201);
});

test("spec rejects path-traversal-ish issueKey / userId and unknown bot", async () => {
  const { app } = await appWithBot();
  // lowercase / non-Jira-non-synthetic issue key
  expect((await app.request("/specs/testbot/user_1/lowercase-1", jsonPost("x"))).status).toBe(400);
  // userId with a space (decoded from %20) fails VALID_USER_ID
  expect((await app.request("/specs/testbot/bad%20id/MELOSYS-1", jsonPost("x"))).status).toBe(400);
  // unknown bot
  expect((await app.request("/specs/nope/user_1/MELOSYS-1", jsonPost("x"))).status).toBe(404);
  // missing content
  const noContent = await app.request("/specs/testbot/user_1/MELOSYS-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(noContent.status).toBe(400);
});

test("GET / HEAD report 404 for a spec that does not exist", async () => {
  const { app } = await appWithBot();
  expect((await app.request("/specs/testbot/user_1/MELOSYS-404")).status).toBe(404);
  expect((await app.request("/specs/testbot/user_1/MELOSYS-404", { method: "HEAD" })).status).toBe(404);
});

test("spec POST accepts an optional dev_run status and saves regardless of the DB", async () => {
  // The dev_run link is best-effort (try/caught) — with no DB initialized here
  // the save must still succeed and write the file. (The link itself is covered
  // by linkSpecToDevRun in the db test group.)
  const { app, dir } = await appWithBot();
  const post = await app.request(
    "/specs/testbot/user_1/MELOSYS-200",
    jsonPostWith({ content: "domain spec", status: "spec_approved" }),
  );
  expect(post.status).toBe(201);
  expect(await readFile(join(dir, "specs", "user_1", "MELOSYS-200.md"), "utf8")).toBe("domain spec");
});

test("spec POST rejects an unknown status before writing the file", async () => {
  const { app, dir } = await appWithBot();
  const post = await app.request(
    "/specs/testbot/user_1/MELOSYS-201",
    jsonPostWith({ content: "x", status: "bogus" }),
  );
  expect(post.status).toBe(400);
  // file must NOT have been written
  await expect(readFile(join(dir, "specs", "user_1", "MELOSYS-201.md"), "utf8")).rejects.toBeDefined();
});

// ── `GET /bots`'s `jiraBot` ──────────────────────────────────────────────────
//
// The chat page renders «Lag Jira-sak» only on the bot this field names, so the
// field has to agree with the resolver `/api/jira/*` actually 503s on. That is
// the LIVE discovery (`discoverAllBots`), not the token-gated list captured at
// process start and handed to `createChatRoutes` — a bot folder with no Telegram
// token resolved for the routes and not for this payload.
//
// `bots/jarvis/` is the one bot folder checked into the repo, so it is present in
// any checkout; `testbot` (the caller's list) is present in NEITHER discovery.
describe("GET /bots — jiraBot", () => {
  const prev = process.env.JIRA_BOT;
  afterAll(() => {
    if (prev === undefined) delete process.env.JIRA_BOT;
    else process.env.JIRA_BOT = prev;
  });

  test("names the LIVE-discovered bot, not one from the caller's startup list", async () => {
    process.env.JIRA_BOT = "jarvis";
    const { app } = await appWithBot();
    const body = (await (await app.request("/bots")).json()) as { jiraBot: string | null };
    expect(body.jiraBot).toBe("jarvis");
  });

  test("is null when JIRA_BOT names nothing discovered — the control then never renders", async () => {
    process.env.JIRA_BOT = "testbot";
    const { app } = await appWithBot();
    const body = (await (await app.request("/bots")).json()) as { jiraBot: string | null };
    // `testbot` IS in the list this router was constructed with. Resolving from
    // that list answered "testbot" for a name every /api/jira/* route 503s on.
    expect(body.jiraBot).toBeNull();
  });
});

/**
 * PR A acceptance 3, id half — a web conversation is addressable forever.
 *
 * `POST /chat/conversations` used to mint `crypto.randomUUID()` for every type,
 * and the chat page takes this route on a user's first turn with a bot. That
 * shell was unreachable after a restart (`hydrateFromDb` rebuilds conversations
 * under the deterministic id and can never produce a UUID) and unreachable
 * in-process from any off-band broadcaster, all of which address
 * `botConversationId(userId, botName)`.
 */
describe("POST /conversations — web conversations get the deterministic id", () => {
  test("the created id is the one hydrateFromDb and every broadcaster compute", async () => {
    const { app } = await appWithBot();
    const res = await app.request("/conversations", jsonPostWith({
      type: "web", botName: "testbot", userId: "u-det-1", username: "alice",
    }));

    expect(res.status).toBe(201);
    const { conversation } = await res.json();
    expect(conversation.id).toBe(await chatState.botConversationId("u-det-1", "testbot"));
    expect(conversation.type).toBe("web");
    expect(conversation.userId).toBe("u-det-1");
    expect(conversation.username).toBe("alice");
  });

  test("a second POST returns the same conversation rather than a second shell", async () => {
    const { app } = await appWithBot();
    const first = await (await app.request("/conversations", jsonPostWith({
      type: "web", botName: "testbot", userId: "u-det-2", username: "alice",
    }))).json();
    const second = await (await app.request("/conversations", jsonPostWith({
      type: "web", botName: "testbot", userId: "u-det-2", username: "alice",
    }))).json();

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(chatState.getConversations().filter((c) => c.userId === "u-det-2")).toHaveLength(1);
  });

  test("non-web types keep their random shells", async () => {
    // Telegram/Slack conversations are addressed only by the live object — there
    // is no `<user>:<bot>:<platform>` id anyone computes for them here.
    const { app } = await appWithBot();
    const a = await (await app.request("/conversations", jsonPostWith({
      type: "telegram_dm", botName: "testbot", userId: "u-det-3", username: "alice",
    }))).json();
    const b = await (await app.request("/conversations", jsonPostWith({
      type: "telegram_dm", botName: "testbot", userId: "u-det-3", username: "alice",
    }))).json();

    expect(a.conversation.id).not.toBe(b.conversation.id);
  });
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
  const A: Identity = {
    userId: "guard-a", displayName: "A", navIdent: null, oid: null,
    provider: "local", expiresAt: null,
  };

  async function appAs(identity: Identity | null, role: AuthRole | null) {
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

  test("POST …/messages is refused on another user's conversation", async () => {
    // The route this whole PR exists for: it spends a model turn AS the owner
    // and writes into their thread.
    const { theirs } = await seed();
    const app = await appAs(A, "user");
    const res = await app.request(`/conversations/${theirs.id}/messages`, jsonPostWith({ text: "hi" }));
    expect(res.status).toBe(404);
  });

  test("HEAD on another user's conversation is refused too, and carries no body", async () => {
    // Hono dispatches HEAD to the app.get handler and RUNS it.
    const { theirs } = await seed();
    const app = await appAs(A, "user");
    const res = await app.request(`/conversations/${theirs.id}`, { method: "HEAD" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
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
