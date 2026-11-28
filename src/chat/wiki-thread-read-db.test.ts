/**
 * /chat's reads of a wiki thread (Discuss v3 P4) against the REAL test
 * database: the message read joins each user message to its turn (id,
 * question, passage) and names the page (title from the wiki index); a chat
 * thread's read is unchanged; a wiki thread of another user, named on one's
 * own conversation, gets neither; and the thread read's list-only form
 * (`?closed=1`) lists the page's closed threads for the thread's user only,
 * without their messages. Invented pages, users and bots only (public repo).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "../db/client.ts";
import { ensureDefaultThread, getOrCreateWikiThread } from "../db/threads.ts";
import { finishDiscussTurn, startDiscussTurn, storeDiscussAssistantMessage } from "../db/wiki-discuss-turns.ts";
import { chatState } from "./state.ts";
import { createChatRoutes } from "./routes.ts";
import { createDiscussEngine } from "../wiki/discuss-engine.ts";
import { registerWikiDiscussRoute, WIKI_DISCUSS_THREAD_CLOSE_PATH } from "../dashboard/routes/wiki-discuss.ts";
import { EXPLAIN_QUESTION } from "../wiki/discuss-bounds.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../wiki/store.ts";
import { testTempDir } from "../test/temp-dir.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";

setupTestDb();

const REL = "notes/harbour.md";
const PASSAGE = "The harbour opens at six.";
const ivar: BotConfig = { name: "ivar", dir: "/nonexistent", persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], connector: "claude-sdk", model: "invented-model" };
const config = { profile: "default", dashboardPort: 4321, claudeModel: "fallback-model", decisionTriageRepoRoots: null } as unknown as Config;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
let dir = "";

beforeAll(async () => {
  dir = await realpath(await testTempDir(path.join(tmpdir(), "muninn-chat-wiki-read-")));
  const wiki = path.join(dir, "harbour");
  await Bun.write(path.join(wiki, REL), `---\ntitle: Harbour note\n---\n\n# Harbour note\n\n${PASSAGE}\n`);
  __setWikiRegistryForTest([{ name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" }]);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

function app() {
  const engine = createDiscussEngine(config, {
    bots: () => [ivar],
    chatUsers: async () => [
      { id: "kari", name: "Kari" },
      { id: "per", name: "Per" },
    ],
    defaultUser: async () => "kari",
    log: quiet,
  });
  const a = new Hono();
  registerWikiDiscussRoute(a, config, { engine, log: quiet, bots: () => [ivar], mirror: null });
  a.route("/chat", createChatRoutes([ivar], config, { discussEngine: engine }));
  return a;
}

/** One finished turn on the thread, with its two messages, as the engine stores them. */
async function turn(threadId: string, userId: string, question: string, selection: string | null): Promise<{ id: string; userMessageId: string }> {
  const started = await startDiscussTurn(
    {
      discussionId: threadId,
      threadId,
      wiki: "harbour",
      relPath: REL,
      pageHash: "h",
      userMessage: { userId, botName: "ivar", content: selection ? `> ${selection}\n\n${question}` : question },
      selection,
      question,
      location: null,
      botName: "ivar",
      connector: "claude-sdk",
      model: null,
      surface: null,
    },
    { staleRunningMs: 60_000 },
  );
  await finishDiscussTurn(started.id, { endState: "done", answer: `Answer to ${question}` });
  await storeDiscussAssistantMessage(started.id, `Answer to ${question}`);
  return { id: started.id, userMessageId: started.userMessageId! };
}

async function wikiThread(userId: string) {
  return getOrCreateWikiThread(userId, "ivar", "harbour", REL, (s) => `wiki: harbour note${s}`);
}

type Msg = { id: string; sender: string; text: string; turn?: { id: string; question: string; passage: string | null } };

test("a wiki thread's read carries each user message's turn and the page; a chat thread's read is unchanged", async () => {
  const a = app();
  const thread = await wikiThread("kari");
  const explain = await turn(thread.id, "kari", EXPLAIN_QUESTION, PASSAGE);
  const follow = await turn(thread.id, "kari", "Who opens it?", null);
  const conv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "kari" });

  const res = await a.request(`/chat/conversations/${conv.id}/messages?thread=${thread.id}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: Msg[]; wikiPage?: unknown };
  expect(body.wikiPage).toEqual({ wiki: "harbour", relPath: REL, traceKey: null, title: "Harbour note" });
  const users = body.messages.filter((m) => m.sender === "user");
  expect(users.map((m) => m.turn)).toEqual([
    { id: explain.id, question: EXPLAIN_QUESTION, passage: PASSAGE },
    { id: follow.id, question: "Who opens it?", passage: null },
  ]);
  expect(users.map((m) => m.id)).toEqual([explain.userMessageId, follow.userMessageId]);
  // Answers carry no turn.
  expect(body.messages.filter((m) => m.sender === "bot").every((m) => !("turn" in m))).toBe(true);

  // A chat thread: the read's shape as before, no page and no turn on any message.
  const main = await ensureDefaultThread("kari", "ivar");
  await getDb()`INSERT INTO messages (user_id, bot_name, role, content, platform, thread_id) VALUES ('kari', 'ivar', 'user', 'hello', 'web', ${main})`;
  const chatRes = (await (await a.request(`/chat/conversations/${conv.id}/messages?thread=${main}`)).json()) as Record<string, unknown>;
  expect(Object.keys(chatRes)).toEqual(["messages"]);
  const chatMsgs = chatRes.messages as Record<string, unknown>[];
  expect(chatMsgs).toHaveLength(1);
  expect(Object.keys(chatMsgs[0]!).sort()).toEqual(["fromPeerId", "id", "model", "sender", "text", "threadId", "timestamp", "traceId"]);
});

test("another user's wiki thread named on one's own conversation: no page, no turns, no messages", async () => {
  const a = app();
  const kari = await wikiThread("kari");
  await turn(kari.id, "kari", EXPLAIN_QUESTION, PASSAGE);
  const perConv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "per" });
  const body = (await (await a.request(`/chat/conversations/${perConv.id}/messages?thread=${kari.id}`)).json()) as Record<string, unknown>;
  expect(body).toEqual({ messages: [] });
});

test("the list-only thread read: the page's closed threads for the thread's own user, without messages", async () => {
  const a = app();
  const first = await wikiThread("kari");
  await turn(first.id, "kari", EXPLAIN_QUESTION, PASSAGE);
  const close = await a.request(WIKI_DISCUSS_THREAD_CLOSE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: first.id }) });
  expect(close.status).toBe(200);
  // Per's own closed thread of the same page, which Kari's list must not show.
  const per = await wikiThread("per");
  await getDb()`UPDATE threads SET closed_at = now() WHERE id = ${per.id}`;
  // Kari's live thread after Start over: not in the closed list.
  const second = await wikiThread("kari");
  expect(second.id).not.toBe(first.id);

  const q = (user: string) => `/api/wiki/discuss/thread?closed=1&wiki=harbour&relPath=${encodeURIComponent(REL)}&userId=${user}`;
  const kariList = (await (await a.request(q("kari"))).json()) as { userId: string; closed: Record<string, unknown>[]; closedTotal: number };
  expect(kariList.userId).toBe("kari");
  expect(kariList.closed.map((t) => t.id)).toEqual([first.id]);
  expect(kariList.closedTotal).toBe(1);
  expect(Object.keys(kariList.closed[0]!).sort()).toEqual(["closedAt", "createdAt", "id", "name"]);
  const perList = (await (await a.request(q("per"))).json()) as { closed: { id: string }[] };
  expect(perList.closed.map((t) => t.id)).toEqual([per.id]);
  // A user /chat does not list for the bot is refused, as on the full read.
  expect((await a.request(q("nobody"))).status).toBe(422);
});
