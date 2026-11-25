/**
 * Discuss v2 wiki threads (mimir plan muninn-wiki-discuss-v2, PR 3) against the
 * REAL test database, both entry points on one Discuss engine with a fake
 * connector: a pane turn (`POST /api/wiki/discuss`) and a /chat turn
 * (`POST /chat/conversations/:id/messages`) on the same wiki thread run on the
 * wiki's pinned bot and the fenced surface, whatever connector /chat names or
 * the thread carries; each writes one ledger row and two `source 'wiki'`
 * messages that hold no context pack; turn 2 gets fresh snapshots and turn 1
 * in its prompt; Edit mode sends the rules' edit section and Apply accepts the
 * row; the chat pipeline refuses the thread outright.
 *
 * ⚠️ Own `bun test` link: `mock.module` replaces `core/metadata-extractor.ts`
 * with a spy on `runExtractionPipelines`, the one door to the memory, goal and
 * schedule extractors. The chat route imports the chat pipeline, which imports
 * that module, so a wiki turn that fell through to `processChatMessage` would
 * reach the spy. Invented pages, users and bots only (public repo).
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";

const realExtractor = await import("../../core/metadata-extractor.ts");
const extractorCalls: unknown[][] = [];
mock.module("../../core/metadata-extractor.ts", () => ({
  ...realExtractor,
  runExtractionPipelines: (...args: unknown[]) => {
    extractorCalls.push(args);
  },
}));

const { realpath, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { Hono } = await import("hono");
const { setupTestDb } = await import("../../test/setup-db.ts");
const { getDb } = await import("../../db/client.ts");
const { getThreadById, switchThread, updateThreadConnector, WikiThreadRefused } = await import("../../db/threads.ts");
const { listDiscussTurns } = await import("../../db/wiki-discuss-turns.ts");
const { processMessage } = await import("../../core/message-processor.ts");
const { chatState } = await import("../../chat/state.ts");
const { createChatRoutes } = await import("../../chat/routes.ts");
const { createDiscussEngine } = await import("../../wiki/discuss-engine.ts");
const { registerWikiDiscussRoute, WIKI_DISCUSS_PATH } = await import("./wiki-discuss.ts");
const { registerWikiDiscussApplyRoute, WIKI_DISCUSS_APPLY_PATH } = await import("./wiki-discuss-apply.ts");
const { STORED_EDIT_MARKER, WIKI_AGENT_RULES_FILE } = await import("../../wiki/discuss-agent.ts");
const { __resetWikiRegistryForTest, __setWikiRegistryForTest } = await import("../../wiki/registry-memo.ts");
const { __resetWikiCacheForTest } = await import("../../wiki/store.ts");
const { testTempDir } = await import("../../test/temp-dir.ts");
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { OneShotOptions } from "../../ai/one-shot.ts";
import type { ChatEvent } from "../../chat/state.ts";

setupTestDb();

const RULES = [
  "# Wiki agent: discussing a page",
  "",
  "## Answering",
  "- Answer the marked passage first.",
  "",
  "<!-- discuss:edit -->",
  "## Changing the page",
  "- EDIT-RULES-SENTINEL: return at most one proposed edit, in a fenced json block.",
  "<!-- /discuss:edit -->",
  "",
  "## Language",
  "- Reply in the language of the question.",
  "",
].join("\n");
const NOTE = "---\ntitle: Harbour note\n---\n\n# Harbour note\n\nThe harbour opens at six.\n";
const EDIT_ANSWER = [
  "The page says six; the timetable says seven.",
  "",
  "```json",
  '{"edits": [{"claimIndex": 1, "verdict": "❌", "old": "The harbour opens at six.", "new": "The harbour opens at seven.", "reason": "The timetable says seven."}]}',
  "```",
].join("\n");

let dir = "";
let wiki = "";
const ivar: BotConfig = { name: "ivar", dir: "/nonexistent", persona: "PERSONA-SENTINEL: you are Ivar the butler.", telegramAllowedUserIds: [], slackAllowedUserIds: [], connector: "claude-sdk", model: "invented-model" };
const config = { profile: "default", dashboardPort: 4321, claudeModel: "fallback-model", decisionTriageRepoRoots: null } as unknown as Config;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

interface Call {
  prompt: string;
  opts: OneShotOptions;
  bot: BotConfig;
}
let calls: Call[] = [];
let snaps = 0;
let answer = "It opens at six.";
let events: ChatEvent[] = [];
let unsubscribe: () => void = () => {};

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: wiki, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeAll(async () => {
  dir = await realpath(await testTempDir(path.join(tmpdir(), "muninn-wiki-threads-")));
  wiki = path.join(dir, "harbour");
  await Bun.write(path.join(wiki, WIKI_AGENT_RULES_FILE), RULES);
  await Bun.write(path.join(wiki, "notes", "harbour.md"), NOTE);
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  // Pinned (D6): the wiki answers on ivar or not at all.
  __setWikiRegistryForTest([{ name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" }]);
});

beforeEach(() => {
  calls = [];
  answer = "It opens at six.";
  events = [];
  extractorCalls.length = 0;
  unsubscribe();
  unsubscribe = chatState.subscribe((e) => events.push(e));
});

afterAll(async () => {
  unsubscribe();
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

/** One engine behind both entry points, as in the process. */
function apps() {
  const engine = createDiscussEngine(config, {
    bots: () => [ivar],
    chatUsers: async () => [{ id: "kari", name: "Kari" }],
    defaultUser: async () => "kari",
    surfaceBlocker: async () => null,
    // A fresh snapshot directory per turn: a copy of the wiki as it is now.
    wikiSnapshot: async (d) => {
      const to = path.join(dir, "snaps", `wiki-${++snaps}`);
      await Bun.write(path.join(to, "notes", "harbour.md"), Bun.file(path.join(d, "notes", "harbour.md")));
      return { kind: "wiki", dir: to, key: `k${snaps}`, source: d };
    },
    oneShot: async (prompt, _config, bot, opts) => {
      calls.push({ prompt, opts, bot });
      opts.onProgress?.({ type: "tool_start", id: "t1", name: "Read", displayName: "Read", input: '{"file_path":"notes/harbour.md"}' });
      opts.onProgress?.({ type: "tool_end", id: "t1", name: "Read", displayName: "Read" });
      return { result: answer, costUsd: 0.01, toolCalls: [{ id: "t1", name: "Read", displayName: "Read", durationMs: 1, startOffsetMs: 0, input: "{}" }] } as never;
    },
    log: quiet,
  });
  const app = new Hono();
  registerWikiDiscussRoute(app, config, { engine, log: quiet, bots: () => [ivar] });
  registerWikiDiscussApplyRoute(app, config, { readonlyRefusal: () => null, egressRefusal: () => null });
  app.route("/chat", createChatRoutes([ivar], config, { discussEngine: engine }));
  return app;
}

const pane = (app: InstanceType<typeof Hono>, body: Record<string, unknown>) =>
  app.request(WIKI_DISCUSS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: "harbour", relPath: "notes/harbour.md", ...body }) });

async function frames(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  return (await res.text())
    .split("\n\n")
    .filter((f) => f.trim())
    .map((f) => ({ event: /^event: (.*)$/m.exec(f)?.[1] ?? "", data: JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? "{}") }));
}

async function messagesOf(threadId: string) {
  return getDb()`SELECT id, role, content, source, platform FROM messages WHERE thread_id = ${threadId} ORDER BY created_at, role DESC`;
}

/** Wait until the thread's turns have all ended (a /chat turn runs in the background). */
async function settled(threadId: string, n: number) {
  for (let i = 0; i < 200; i++) {
    const rows = await listDiscussTurns(threadId);
    if (rows.length === n && rows.every((r) => r.endState !== "running") && rows.every((r) => r.assistantMessageId)) return rows;
    await Bun.sleep(10);
  }
  throw new Error("the turns did not settle");
}

test("a pane turn, then a /chat turn on the same thread: pinned bot, fenced surface, fresh snapshots, history, ledger rows and pack-free messages", async () => {
  const app = apps();
  const first = await frames(await pane(app, { question: "When does the harbour open?", selection: "The harbour opens at six." }));
  const turn = first.find((f) => f.event === "turn")!.data;
  const threadId = turn.discussionId as string;
  expect(turn.threadId).toBe(threadId);
  expect(turn.userId).toBe("kari");

  const thread = (await getThreadById(threadId))!;
  expect(thread.kind).toBe("wiki");
  expect(thread.wiki).toBe("harbour");
  expect(thread.relPath).toBe("notes/harbour.md");
  expect(thread.isActive).toBe(false);
  expect(thread.name).toBe("wiki: harbour note");

  // A stamped connector (written past the refusing helper) and an inline one.
  const [conn] = await getDb()`INSERT INTO connectors (name, connector_type, model) VALUES ('stamp', 'copilot-sdk', 'gpt-invented') RETURNING id`;
  await getDb()`UPDATE threads SET connector_id = ${conn!.id as string} WHERE id = ${threadId}`;
  // The wiki changes between the turns.
  await Bun.write(path.join(wiki, "notes", "harbour.md"), NOTE + "\nOn Sundays it opens at eight.\n");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "sunday");
  __resetWikiCacheForTest();

  const conv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "kari" });
  const res = await app.request(`/chat/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "And on Sundays?", threadId, connector: "copilot-sdk" }),
  });
  expect(res.status).toBe(202);
  const rows = await settled(threadId, 2);

  // Both turns: the pinned bot's own connector and the read-and-search fence.
  expect(calls).toHaveLength(2);
  for (const c of calls) {
    expect(c.bot.name).toBe("ivar");
    expect(c.bot.connector).toBe("claude-sdk");
    const surface = c.opts.toolSurface;
    expect(typeof surface === "object" && surface !== null && "readSearch" in surface).toBe(true);
  }
  // Fresh snapshots: turn 2 reads another directory, holding the new line.
  const snap = (c: Call) => (c.opts.toolSurface as { readSearch: string[] }).readSearch[0]!;
  expect(snap(calls[0]!)).not.toBe(snap(calls[1]!));
  expect(calls[1]!.prompt).toContain(snap(calls[1]!));
  expect(calls[1]!.prompt).toContain("On Sundays it opens at eight.");
  // The second prompt carries the first exchange.
  expect(calls[1]!.prompt).toContain("## The discussion so far");
  expect(calls[1]!.prompt).toContain("Question about «The harbour opens at six.»: When does the harbour open?");
  expect(calls[1]!.prompt).toContain("Answer: It opens at six.");

  // One ledger row per turn, each with its two messages.
  expect(rows.map((r) => `${r.seq}:${r.endState}:${r.threadId === threadId}`)).toEqual(["1:done:true", "2:done:true"]);
  const msgs = await messagesOf(threadId);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(msgs.every((m) => m.source === "wiki" && m.platform === "web")).toBe(true);
  expect(msgs.map((m) => m.id)).toEqual(rows.flatMap((r) => [r.userMessageId, r.assistantMessageId]));
  expect(msgs[0]!.content).toBe("> The harbour opens at six.\n\nWhen does the harbour open?");
  expect(msgs[2]!.content).toBe("And on Sundays?");
  // No pack in a stored message.
  for (const m of msgs) {
    expect(m.content).not.toContain("## The page");
    expect(m.content).not.toContain("## What you can read");
    expect(m.content).not.toContain("Line numbers are the file's");
  }
  // D7: no extractor, still not the active thread, and never switchable to.
  expect(extractorCalls).toHaveLength(0);
  expect((await getThreadById(threadId))!.isActive).toBe(false);
  await expect(switchThread("kari", "ivar", thread.name)).rejects.toBeInstanceOf(WikiThreadRefused);
  await expect(updateThreadConnector(threadId, null)).rejects.toBeInstanceOf(WikiThreadRefused);
  // The /chat mirror carried the thread id on every event it published.
  const mirrored = events.filter((e) => "conversationId" in e && e.conversationId === conv.id);
  expect(mirrored.length).toBeGreaterThan(0);
  expect(mirrored.some((e) => e.type === "status")).toBe(false);
  for (const e of mirrored) {
    const tid = e.type === "message" ? e.message.threadId : (e as { threadId?: string | null }).threadId;
    expect(tid).toBe(threadId);
  }
  await Bun.write(path.join(wiki, "notes", "harbour.md"), NOTE);
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "back");
  __resetWikiCacheForTest();
});

test("the pane's SSE order, with the status line after the last tool event, and the /chat mirror events carrying the thread id", async () => {
  const app = apps();
  const evs = await frames(await pane(app, { question: "When?" }));
  const order = evs.map((e) => (e.event === "status" ? `status:${e.data.phase}` : e.event));
  expect(order).toEqual(["turn", "status:snapshots", "status:card", "status:model", "tool", "status:writing", "done", "end"]);
  expect(evs.find((e) => e.data.phase === "writing")!.data.text).toBe("writing the answer");
  const threadId = evs[0]!.data.threadId as string;
  const types = events.filter((e) => "conversationId" in e).map((e) => `${e.type}:${e.type === "message" ? e.message.threadId : (e as { threadId?: string | null }).threadId}`);
  expect(types).toEqual([`message:${threadId}`, `tool_status:${threadId}`, `stream_clear:${threadId}`, `message:${threadId}`]);
});

test("processMessage throws on a wiki thread, before it saves or calls anything", async () => {
  const app = apps();
  const evs = await frames(await pane(app, { question: "When?" }));
  const threadId = evs[0]!.data.threadId as string;
  const before = (await messagesOf(threadId)).length;
  await expect(
    processMessage({ text: "hi", userId: "kari", username: "Kari", platform: "web", botConfig: ivar, config, say: async () => {}, setStatus: async () => {}, threadId }),
  ).rejects.toThrow(/wiki page's Discuss thread/);
  expect((await messagesOf(threadId)).length).toBe(before);
  expect(extractorCalls).toHaveLength(0);
});

test("Edit mode: the rules' edit section goes only to an Edit turn, the stored message carries the marker, and Apply accepts the row", async () => {
  const app = apps();
  const explore = await frames(await pane(app, { question: "When?" }));
  const threadId = explore[0]!.data.threadId as string;
  expect(calls[0]!.opts.systemPrompt).not.toContain("EDIT-RULES-SENTINEL");
  expect(calls[0]!.opts.systemPrompt).not.toContain("Changing the page");
  expect(calls[0]!.opts.systemPrompt).not.toContain("discuss:edit");
  expect(calls[0]!.opts.systemPrompt).toContain("Reply in the language of the question.");

  answer = EDIT_ANSWER;
  const edit = await frames(await pane(app, { question: "Fix it", mode: "edit", discussionId: threadId }));
  expect(calls[1]!.opts.systemPrompt).toContain("EDIT-RULES-SENTINEL");
  expect(calls[1]!.opts.systemPrompt).toContain("## Changing the page");
  expect(calls[1]!.opts.systemPrompt).not.toContain("discuss:edit");
  const done = edit.find((e) => e.event === "done")!.data;
  expect(done.proposedEdit).not.toBeNull();

  const rows = await listDiscussTurns(threadId);
  const msgs = await messagesOf(threadId);
  const stored = msgs.find((m) => m.id === rows[1]!.assistantMessageId)!;
  expect(stored.content).toBe(`The page says six; the timetable says seven.\n\n${STORED_EDIT_MARKER}`);
  expect(stored.content).not.toContain('"edits"');
  expect(rows[1]!.answer).toContain('"edits"');

  const preview = await app.request(WIKI_DISCUSS_APPLY_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: rows[1]!.id, preview: true }) });
  expect(preview.status).toBe(200);
  const p = (await preview.json()) as { baseHash: string; previewHash: string };
  const applied = await app.request(WIKI_DISCUSS_APPLY_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: rows[1]!.id, baseHash: p.baseHash, previewHash: p.previewHash }) });
  expect(applied.status).toBe(200);
  expect(await Bun.file(path.join(wiki, "notes", "harbour.md")).text()).toContain("The harbour opens at seven.");
  git("reset", "-q", "--hard", "HEAD~1");
  __resetWikiCacheForTest();
});

test("a refusal stores nothing: an unknown discussion, an old one-shot id and a posted user /chat does not list", async () => {
  const app = apps();
  const unknown = await pane(app, { question: "When?", discussionId: crypto.randomUUID() });
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as { reason: string }).reason).toBe("unknown-discussion");
  const stranger = await pane(app, { question: "When?", userId: "mallory" });
  expect(stranger.status).toBe(422);
  expect(((await stranger.json()) as { reason: string }).reason).toBe("unknown-user");
  const [n] = await getDb()`SELECT (SELECT count(*) FROM threads)::int AS threads, (SELECT count(*) FROM messages)::int AS messages, (SELECT count(*) FROM wiki_discuss_turns)::int AS turns`;
  expect(n).toEqual({ threads: 0, messages: 0, turns: 0 });
});

test("a /chat send on a closed wiki thread is refused as a transient event, and stores nothing", async () => {
  const app = apps();
  const evs = await frames(await pane(app, { question: "When?" }));
  const threadId = evs[0]!.data.threadId as string;
  await getDb()`UPDATE threads SET closed_at = now() WHERE id = ${threadId}`;
  const before = (await messagesOf(threadId)).length;
  events = [];
  const conv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "kari" });
  const res = await app.request(`/chat/conversations/${conv.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Again?", threadId }) });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { reason: string }).reason).toBe("closed");
  expect(events.map((e) => e.type)).toEqual(["transient_error"]);
  expect((await messagesOf(threadId)).length).toBe(before);
  expect(await listDiscussTurns(threadId)).toHaveLength(1);
});

test("the default root (WIKI_DIR, no wiki named): the pane stores wiki '' and a /chat turn on that thread runs on the engine", async () => {
  const prev = process.env.WIKI_DIR;
  process.env.WIKI_DIR = wiki;
  __resetWikiCacheForTest();
  try {
    const app = apps();
    const res = await app.request(WIKI_DISCUSS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relPath: "notes/harbour.md", question: "When?" }) });
    const threadId = (await frames(res))[0]!.data.threadId as string;
    const thread = (await getThreadById(threadId))!;
    expect(thread.kind).toBe("wiki");
    expect(thread.wiki).toBe("");
    expect(thread.relPath).toBe("notes/harbour.md");

    const conv = await chatState.findOrCreateBotConversation({ botName: thread.botName, userId: thread.userId });
    const sent = await app.request(`/chat/conversations/${conv.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "And on Sundays?", threadId }) });
    if (sent.status !== 202) throw new Error(`/chat refused the turn: ${sent.status} ${await sent.text()}`);
    const rows = await settled(threadId, 2);
    expect(rows.map((r) => `${r.seq}:${r.endState}`)).toEqual(["1:done", "2:done"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("Answer: It opens at six.");
  } finally {
    if (prev === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prev;
    __resetWikiCacheForTest();
  }
});

// ── PR 4: the pane on the thread ─────────────────────────────────────────

test("a pane refusal on the page's thread reaches /chat as a transient event; one naming no live thread of this page does not", async () => {
  const app = apps();
  const evs = await frames(await pane(app, { question: "When?" }));
  const threadId = evs[0]!.data.threadId as string;
  await getDb()`UPDATE threads SET closed_at = now() WHERE id = ${threadId}`;
  const conv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "kari" });
  events = [];
  const closed = await pane(app, { question: "Again?", discussionId: threadId });
  expect(closed.status).toBe(409);
  expect(((await closed.json()) as { reason: string }).reason).toBe("closed");
  const mirrored = events.filter((e) => e.type === "transient_error");
  expect(mirrored).toHaveLength(1);
  expect(mirrored[0]).toMatchObject({ type: "transient_error", conversationId: conv.id, threadId });
  events = [];
  const unknown = await pane(app, { question: "Again?", discussionId: crypto.randomUUID() });
  expect(unknown.status).toBe(404);
  expect(events.filter((e) => e.type === "transient_error")).toEqual([]);
});

test("the thread read gives each closed thread its messages, and /chat's thread list hides a closed wiki thread but lists an open one", async () => {
  const app = apps();
  const first = (await frames(await pane(app, { question: "When does it open?" })))[0]!.data.threadId as string;
  await app.request("/api/wiki/discuss/thread/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: first }) });
  const second = (await frames(await pane(app, { question: "And on Sundays?" })))[0]!.data.threadId as string;
  expect(second).not.toBe(first);

  const read = (await (await app.request("/api/wiki/discuss/thread?wiki=harbour&relPath=notes%2Fharbour.md")).json()) as {
    thread: { id: string };
    messages: { role: string }[];
    closed: { id: string; messages: { role: string; content: string; turn: { question: string } | null }[] }[];
  };
  expect(read.thread.id).toBe(second);
  expect(read.closed.map((t) => t.id)).toEqual([first]);
  expect(read.closed[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(read.closed[0]!.messages[0]!.content).toBe("When does it open?");
  expect(read.closed[0]!.messages[1]!.turn?.question).toBe("When does it open?");

  const list = (await (await app.request("/chat/threads/kari/ivar")).json()) as { threads: { id: string; kind: string }[] };
  const ids = list.threads.map((t) => t.id);
  expect(ids).toContain(second);
  expect(ids).not.toContain(first);
  expect(list.threads.find((t) => t.id === second)?.kind).toBe("wiki");
});
