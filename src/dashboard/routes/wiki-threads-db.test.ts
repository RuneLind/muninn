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
const { DiscussTurnConflict, finishDiscussTurn, listClosedThreadMessages, listDiscussTurns, markDiscussReaderLeft, setDiscussTurnCard, startDiscussTurn, touchDiscussTurn } = await import("../../db/wiki-discuss-turns.ts");
const { countClosedWikiThreads, listClosedWikiThreads } = await import("../../db/threads.ts");
const { processMessage } = await import("../../core/message-processor.ts");
const { chatState } = await import("../../chat/state.ts");
const { createChatRoutes } = await import("../../chat/routes.ts");
const { createDiscussEngine } = await import("../../wiki/discuss-engine.ts");
const { mentionsWorkTree } = await import("../../wiki/mentions.ts");
const { registerWikiDiscussRoute, WIKI_DISCUSS_PATH } = await import("./wiki-discuss.ts");
const { registerWikiDiscussApplyRoute, WIKI_DISCUSS_APPLY_PATH } = await import("./wiki-discuss-apply.ts");
const { STORED_EDIT_MARKER, WIKI_AGENT_RULES_FILE } = await import("../../wiki/discuss-agent.ts");
const { __resetWikiRegistryForTest, __setWikiRegistryForTest } = await import("../../wiki/registry-memo.ts");
const { __resetWikiCacheForTest } = await import("../../wiki/store.ts");
const { testTempDir } = await import("../../test/temp-dir.ts");
const { TRACE_SUMMARY_QUESTION } = await import("../views/components/wiki-key-trace-model.ts");
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { OneShotOptions } from "../../ai/one-shot.ts";
import type { ChatEvent } from "../../chat/state.ts";
import type { DiscussEngineDeps } from "../../wiki/discuss-engine.ts";

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
/** The fake connector streams `answer` as text, then fails (a turn that ends `error`). */
let streamThenFail = false;
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
  streamThenFail = false;
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
function apps(users: { id: string; name: string }[] = [{ id: "kari", name: "Kari" }], extra: Partial<DiscussEngineDeps> = {}) {
  const engine = createDiscussEngine(config, {
    ...extra,
    bots: () => [ivar],
    chatUsers: async () => users,
    defaultUser: async () => "kari",
    surfaceBlocker: async () => null,
    // A fresh snapshot directory per turn: a copy of the wiki as it is now.
    wikiSnapshot: async (d) => {
      const to = path.join(dir, "snaps", `wiki-${++snaps}`);
      const note = Bun.file(path.join(d, "notes", "harbour.md"));
      if (await note.exists()) await Bun.write(path.join(to, "notes", "harbour.md"), note);
      return { kind: "wiki", dir: to, key: `k${snaps}`, source: d };
    },
    oneShot: async (prompt, _config, bot, opts) => {
      calls.push({ prompt, opts, bot });
      if (streamThenFail) {
        opts.onProgress?.({ type: "text_delta", text: answer });
        throw new Error("the connector broke");
      }
      opts.onProgress?.({ type: "tool_start", id: "t1", name: "Read", displayName: "Read", input: '{"file_path":"notes/harbour.md"}' });
      opts.onProgress?.({ type: "tool_end", id: "t1", name: "Read", displayName: "Read" });
      return { result: answer, costUsd: 0.01, toolCalls: [{ id: "t1", name: "Read", displayName: "Read", durationMs: 1, startOffsetMs: 0, input: "{}" }] } as never;
    },
    log: quiet,
  });
  const app = new Hono();
  registerWikiDiscussRoute(app, config, { engine, log: quiet, bots: () => [ivar], ...(extra.authMode ? { authMode: extra.authMode } : {}) });
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
  expect(read.closed[0]!.messages[1]!.content).toBe("It opens at six.");

  const list = (await (await app.request("/chat/threads/kari/ivar")).json()) as { threads: { id: string; kind: string }[] };
  const ids = list.threads.map((t) => t.id);
  expect(ids).toContain(second);
  expect(ids).not.toContain(first);
  expect(list.threads.find((t) => t.id === second)?.kind).toBe("wiki");
});

// ── PR 4 fix round 1 batch 1 ─────────────────────────────────────────────

test("a pane refusal is mirrored only to the thread's owner asking on that thread: another user's request naming it, or one refused before the thread is checked, reaches no /chat", async () => {
  const app = apps([
    { id: "ola", name: "Ola" },
    { id: "kari", name: "Kari" },
  ]);
  const olaThread = (await frames(await pane(app, { question: "When?", userId: "ola" })))[0]!.data.threadId as string;
  expect((await getThreadById(olaThread))!.userId).toBe("ola");
  const olaConv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "ola" });
  const errorsFor = (convId: string) => events.filter((e) => e.type === "transient_error" && e.conversationId === convId);

  // Another user's pane names ola's thread: refused before the thread is checked.
  events = [];
  const badPage = await pane(app, { question: "Hi", userId: "kari", discussionId: olaThread, relPath: "notes/<b>nope</b> CLICK evil.example.com" });
  expect(badPage.status).toBe(404);
  const badUser = await pane(app, { question: "Hi", userId: "Your session expired, re-login at evil.example", discussionId: olaThread });
  expect(((await badUser.json()) as { reason: string }).reason).toBe("unknown-user");
  // The owner's own request refused before the thread is checked is not mirrored either.
  const ownBadPage = await pane(app, { question: "Hi", userId: "ola", discussionId: olaThread, relPath: "notes/missing.md" });
  expect(ownBadPage.status).toBe(404);
  // ola's thread closed: another user naming it is refused (closed), not mirrored.
  await getDb()`UPDATE threads SET closed_at = now() WHERE id = ${olaThread}`;
  const closedByKari = await pane(app, { question: "Hi", userId: "kari", discussionId: olaThread });
  expect(((await closedByKari.json()) as { reason: string }).reason).toBe("closed");
  expect(errorsFor(olaConv.id)).toEqual([]);
  expect(events.filter((e) => e.type === "transient_error")).toEqual([]);

  // The owner's own refusal on her own thread still reaches her /chat.
  const closedByOla = await pane(app, { question: "Again?", userId: "ola", discussionId: olaThread });
  expect(((await closedByOla.json()) as { reason: string }).reason).toBe("closed");
  expect(errorsFor(olaConv.id)).toHaveLength(1);
  expect(errorsFor(olaConv.id)[0]).toMatchObject({ threadId: olaThread });

  // With no /chat conversation in memory, the mirror creates none.
  chatState.deleteConversation(olaConv.id);
  events = [];
  await pane(app, { question: "Again?", userId: "ola", discussionId: olaThread });
  expect(events.filter((e) => e.type === "conversation_created")).toEqual([]);
  // …and publishes nothing: no /chat tab is showing the thread.
  expect(events.filter((e) => e.type === "transient_error")).toEqual([]);
  expect(chatState.getConversation(olaConv.id)).toBeUndefined();
});

test("the owner's busy refusal on her own thread is mirrored to her /chat; another user naming it is not", async () => {
  const app = apps([
    { id: "ola", name: "Ola" },
    { id: "kari", name: "Kari" },
  ]);
  const olaThread = (await frames(await pane(app, { question: "When?", userId: "ola" })))[0]!.data.threadId as string;
  const olaConv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "ola" });
  // Its last turn reads as still running.
  await getDb()`UPDATE wiki_discuss_turns SET end_state = 'running', heartbeat_at = now() WHERE thread_id = ${olaThread}`;
  events = [];
  const byKari = await pane(app, { question: "Hi", userId: "kari", discussionId: olaThread });
  expect(((await byKari.json()) as { reason: string }).reason).toBe("other-user");
  expect(events.filter((e) => e.type === "transient_error")).toEqual([]);
  const byOla = await pane(app, { question: "Again?", userId: "ola", discussionId: olaThread });
  expect(byOla.status).toBe(409);
  expect(((await byOla.json()) as { reason: string }).reason).toBe("busy");
  const mirrored = events.filter((e) => e.type === "transient_error");
  expect(mirrored).toHaveLength(1);
  expect(mirrored[0]).toMatchObject({ conversationId: olaConv.id, threadId: olaThread });
});

test("the thread read bounds «Earlier discussions»: the 10 newest closed threads, the first 60 messages of each, totals for what is left out, and each ledger row sent once", async () => {
  const app = apps();
  const live = (await frames(await pane(app, { question: "When?" })))[0]!.data.threadId as string;
  await frames(await pane(app, { question: "And then?", discussionId: live }));
  const db = getDb();
  const closedIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const [t] = await db`
      INSERT INTO threads (user_id, bot_name, name, kind, wiki, rel_path, closed_at)
      VALUES ('kari', 'ivar', ${`wiki: harbour note ${i}`}, 'wiki', 'harbour', 'notes/harbour.md', now() - ${`${i} minutes`}::interval)
      RETURNING id`;
    closedIds.push(t!.id as string);
  }
  // The newest closed thread holds 35 turns (70 messages).
  const big = closedIds[0]!;
  for (let seq = 1; seq <= 35; seq++) {
    const [u] = await db`INSERT INTO messages (user_id, bot_name, role, content, source, platform, thread_id, created_at) VALUES ('kari', 'ivar', 'user', ${`q${seq}`}, 'wiki', 'web', ${big}, now() + ${`${seq * 2} seconds`}::interval) RETURNING id`;
    const [a] = await db`INSERT INTO messages (user_id, bot_name, role, content, source, platform, thread_id, created_at) VALUES ('kari', 'ivar', 'assistant', ${`a${seq}`}, 'wiki', 'web', ${big}, now() + ${`${seq * 2 + 1} seconds`}::interval) RETURNING id`;
    await db`
      INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, rel_path, question, answer, end_state, bot_name, connector, thread_id, user_message_id, assistant_message_id)
      VALUES (${big}, ${seq}, 'harbour', 'notes/harbour.md', ${`q${seq}`}, ${`a${seq}`}, 'done', 'ivar', 'claude-sdk', ${big}, ${u!.id as string}, ${a!.id as string})`;
  }

  const read = (await (await app.request("/api/wiki/discuss/thread?wiki=harbour&relPath=notes%2Fharbour.md")).json()) as {
    messages: { id: string; turn: { id: string } | null }[];
    closed: { id: string; messages: Record<string, unknown>[]; messageTotal?: number }[];
    closedTotal?: number;
  };
  expect(read.closed.map((t) => t.id)).toEqual(closedIds.slice(0, 10));
  expect(read.closedTotal).toBe(12);
  const first = read.closed[0]!;
  expect(first.messages).toHaveLength(60);
  expect(first.messageTotal).toBe(70);
  expect(first.messages.slice(0, 2).map((m) => m.content)).toEqual(["q1", "a1"]);
  expect(first.messages[59]!.content).toBe("a30");
  // «Earlier discussions» reads role and content: no ledger row goes out for a closed thread.
  expect(first.messages.some((m) => "turn" in m)).toBe(false);
  expect(read.closed[1]!.messageTotal).toBe(0);
  // The live thread: each turn's ledger row once, on one of its two messages.
  expect(read.messages).toHaveLength(4);
  const withTurn = read.messages.filter((m) => m.turn);
  expect(withTurn).toHaveLength(2);
  expect(new Set(withTurn.map((m) => m.turn!.id)).size).toBe(2);
});

// ── PR 4 fix round 1 batch 2 ─────────────────────────────────────────────

test("a closed wiki thread the /chat list leaves out is found by id with its kind and closedAt, so a deep link knows what it is", async () => {
  const app = apps();
  const id = (await frames(await pane(app, { question: "When does it open?" })))[0]!.data.threadId as string;
  await app.request("/api/wiki/discuss/thread/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: id }) });
  const list = (await (await app.request("/chat/threads/kari/ivar")).json()) as { threads: { id: string }[] };
  expect(list.threads.map((t) => t.id)).not.toContain(id);
  const res = await app.request(`/chat/threads/${id}`);
  expect(res.status).toBe(200);
  const { thread } = (await res.json()) as { thread: { id: string; kind: string; closedAt?: number; botName: string } };
  expect(thread).toMatchObject({ id, kind: "wiki", botName: "ivar" });
  expect(typeof thread.closedAt).toBe("number");
  expect((await app.request(`/chat/threads/${crypto.randomUUID()}`)).status).toBe(404);
  expect((await app.request("/chat/threads/not-a-uuid")).status).toBe(404);
});

// ── PR 4 fix round 2: test-only pins ─────────────────────────────────────

async function closedThread(userId: string, botName: string, relPath: string, minutesAgo: number): Promise<string> {
  const [t] = await getDb()`
    INSERT INTO threads (user_id, bot_name, name, kind, wiki, rel_path, closed_at)
    VALUES (${userId}, ${botName}, ${`wiki: ${relPath} ${minutesAgo}`}, 'wiki', 'harbour', ${relPath}, now() - ${`${minutesAgo} minutes`}::interval)
    RETURNING id`;
  return t!.id as string;
}

async function message(threadId: string, role: "user" | "assistant", content: string, at: string, id?: string): Promise<string> {
  const [m] = id
    ? await getDb()`INSERT INTO messages (id, user_id, bot_name, role, content, source, platform, thread_id, created_at) VALUES (${id}, 'kari', 'ivar', ${role}, ${content}, 'wiki', 'web', ${threadId}, ${at}::timestamptz) RETURNING id`
    : await getDb()`INSERT INTO messages (user_id, bot_name, role, content, source, platform, thread_id, created_at) VALUES ('kari', 'ivar', ${role}, ${content}, 'wiki', 'web', ${threadId}, ${at}::timestamptz) RETURNING id`;
  return m!.id as string;
}

test("closed threads' messages are capped and counted per thread, not across them", async () => {
  const a = await closedThread("kari", "ivar", "notes/harbour.md", 1);
  const b = await closedThread("kari", "ivar", "notes/harbour.md", 2);
  // One role, no ledger rows: time alone orders them.
  for (let i = 1; i <= 5; i++) await message(a, "user", `a${i}`, `2026-01-01T00:00:0${i}Z`);
  for (let i = 1; i <= 4; i++) await message(b, "user", `b${i}`, `2026-01-01T00:00:0${i}Z`);
  const got = await listClosedThreadMessages([a, b], 3);
  expect(got.get(a)!.messages.map((m) => m.content)).toEqual(["a1", "a2", "a3"]);
  expect(got.get(a)!.total).toBe(5);
  expect(got.get(b)!.messages.map((m) => m.content)).toEqual(["b1", "b2", "b3"]);
  expect(got.get(b)!.total).toBe(4);
});

test("a closed thread's turn reads question before answer even when the answer row sorts first by time and id", async () => {
  const t = await closedThread("kari", "ivar", "notes/harbour.md", 1);
  const at = "2026-01-01T00:00:00Z";
  // Same time, and the assistant row's id sorts first: only the role tie-break puts the question first.
  const a = await message(t, "assistant", "It opens at six.", at, "00000000-0000-4000-8000-000000000001");
  const u = await message(t, "user", "When?", at, "00000000-0000-4000-8000-000000000002");
  await getDb()`
    INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, rel_path, question, answer, end_state, bot_name, connector, thread_id, user_message_id, assistant_message_id)
    VALUES (${t}, 1, 'harbour', 'notes/harbour.md', 'When?', 'It opens at six.', 'done', 'ivar', 'claude-sdk', ${t}, ${u}, ${a})`;
  const got = await listClosedThreadMessages([t], 10);
  expect(got.get(t)!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("the closed-thread count is the page's and the listing the user's", async () => {
  const mine = await closedThread("kari", "ivar", "notes/harbour.md", 1);
  await closedThread("kari", "ivar", "notes/other.md", 2);
  await getDb()`INSERT INTO users (id, username, platform) VALUES ('ola', 'Ola', 'web') ON CONFLICT (id) DO NOTHING`;
  await closedThread("ola", "ivar", "notes/harbour.md", 3);
  expect(await countClosedWikiThreads("kari", "ivar", "harbour", "notes/harbour.md")).toBe(1);
  expect((await listClosedWikiThreads("kari", "ivar", "harbour", "notes/harbour.md")).map((t) => t.id)).toEqual([mine]);
});

test("a closed refusal on the requester's own thread of ANOTHER bot is not mirrored to that bot's /chat", async () => {
  const app = apps();
  const other = await closedThread("kari", "rolf", "notes/harbour.md", 1);
  const rolfConv = await chatState.findOrCreateBotConversation({ botName: "rolf", userId: "kari" });
  events = [];
  const res = await pane(app, { question: "Again?", discussionId: other });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { reason: string }).reason).toBe("closed");
  expect(events.filter((e) => e.type === "transient_error")).toEqual([]);
  chatState.deleteConversation(rolfConv.id);
});

test("a busy refusal on the live thread found by user, bot and page (no discussionId) is mirrored with that thread's id", async () => {
  const app = apps();
  const live = (await frames(await pane(app, { question: "When?" })))[0]!.data.threadId as string;
  const conv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "kari" });
  await getDb()`UPDATE wiki_discuss_turns SET end_state = 'running', heartbeat_at = now() WHERE thread_id = ${live}`;
  events = [];
  const res = await pane(app, { question: "Again?" });
  expect(((await res.json()) as { reason: string }).reason).toBe("busy");
  const mirrored = events.filter((e) => e.type === "transient_error");
  expect(mirrored).toHaveLength(1);
  expect(mirrored[0]).toMatchObject({ conversationId: conv.id, threadId: live });
});

test("a concurrent-turn conflict on the requester's existing thread is mirrored with its id", async () => {
  let conflict = false;
  const app = apps(undefined, {
    store: {
      start: async (...args: Parameters<typeof startDiscussTurn>) => {
        if (conflict) throw new DiscussTurnConflict(args[0].discussionId);
        return startDiscussTurn(...args);
      },
      finish: finishDiscussTurn,
      readerLeft: markDiscussReaderLeft,
      setCard: setDiscussTurnCard,
      list: listDiscussTurns,
      heartbeat: touchDiscussTurn,
    },
  });
  const live = (await frames(await pane(app, { question: "When?" })))[0]!.data.threadId as string;
  const conv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "kari" });
  conflict = true;
  events = [];
  const res = await pane(app, { question: "Again?", discussionId: live });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { reason: string }).reason).toBe("busy");
  const mirrored = events.filter((e) => e.type === "transient_error");
  expect(mirrored).toHaveLength(1);
  expect(mirrored[0]).toMatchObject({ conversationId: conv.id, threadId: live });
});

// ── PR 6: a key's trace thread ───────────────────────────────────────────

const gitc = (...args: string[]) => git("-c", "user.name=t", "-c", "user.email=t@example.com", ...args);
const tracePost = (app: InstanceType<typeof Hono>, body: Record<string, unknown>) =>
  app.request(WIKI_DISCUSS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: "harbour", traceKey: "MEL-77", mode: "explore", ...body }) });

test("a trace turn, then a /chat follow-up: one trace thread, its pack rebuilt from the mentions each turn, ledger rows with trace_key and no page, two 'wiki' messages a turn, no extractor, never active", async () => {
  await Bun.write(path.join(wiki, "notes", "ferry.md"), "---\ntitle: Ferry note\n---\n\n# Ferry note\n\nThe ferry case MEL-77 is open.\n");
  await Bun.write(path.join(wiki, "log.md"), "# Log\n\n## [2026-11-20] note | ferry\n\n- MEL-77 was filed.\n");
  gitc("add", ".");
  gitc("commit", "-qm", "Ferry note names MEL-77");
  __resetWikiCacheForTest();
  try {
    const app = apps();
    // The Trace card's own «Summarize» question: it names no key, so the prompts must.
    const evs = await frames(await tracePost(app, { question: TRACE_SUMMARY_QUESTION }));
    expect(evs.map((e) => (e.event === "status" ? `status:${e.data.phase}` : e.event))).toEqual(["turn", "status:snapshots", "status:mentions", "status:model", "tool", "status:writing", "done", "end"]);
    const threadId = evs[0]!.data.threadId as string;
    const thread = (await getThreadById(threadId))!;
    expect(thread).toMatchObject({ kind: "wiki", wiki: "harbour", traceKey: "MEL-77", name: "wiki trace: mel-77", isActive: false });
    expect(thread.relPath).toBeUndefined();

    // The pack is the mentions payload's: the file, the log line and the commit, and no page.
    const p1 = calls[0]!.prompt;
    expect(p1).toContain("## The key");
    expect(p1).toContain("Key: MEL-77");
    expect(p1).toContain("- notes/ferry.md «Ferry note»");
    expect(p1).toContain("The ferry case MEL-77 is open.");
    expect(p1).toContain("log.md:5 [2026-11-20 note] - MEL-77 was filed.");
    expect(p1).toContain("Ferry note names MEL-77");
    expect(p1).not.toContain("## The page");
    expect(calls[0]!.opts.systemPrompt).toContain("You trace one key, «MEL-77»");
    expect(calls[0]!.opts.systemPrompt).not.toContain("EDIT-RULES-SENTINEL");
    expect("readSearch" in (calls[0]!.opts.toolSurface as object)).toBe(true);

    // The wiki changes; the /chat follow-up on the same thread sees it (the pack is rebuilt).
    await Bun.write(path.join(wiki, "notes", "quay.md"), "# Quay\n\nMEL-77 also stops at the quay.\n");
    gitc("add", ".");
    gitc("commit", "-qm", "Quay names MEL-77");
    __resetWikiCacheForTest();
    const conv = await chatState.findOrCreateBotConversation({ botName: "ivar", userId: "kari" });
    const sent = await app.request(`/chat/conversations/${conv.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Where does it stop?", threadId }) });
    expect(sent.status).toBe(202);
    const rows = await settled(threadId, 2);
    expect(calls[1]!.prompt).toContain("MEL-77 also stops at the quay.");
    expect(calls[1]!.prompt).toContain(`Question: ${TRACE_SUMMARY_QUESTION}`);
    expect(calls[1]!.prompt).toContain("Answer: It opens at six.");

    expect(rows.map((r) => ({ seq: r.seq, relPath: r.relPath, traceKey: r.traceKey, pageHash: r.pageHash, threadId: r.threadId }))).toEqual([
      { seq: 1, relPath: null, traceKey: "MEL-77", pageHash: null, threadId },
      { seq: 2, relPath: null, traceKey: "MEL-77", pageHash: null, threadId },
    ]);
    const msgs = await messagesOf(threadId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs.every((m) => m.source === "wiki" && m.platform === "web")).toBe(true);
    for (const m of msgs) expect(m.content).not.toContain("## The key");

    // D7: no extractor, not the active thread, and the chat pipeline refuses it.
    expect(extractorCalls).toHaveLength(0);
    expect((await getThreadById(threadId))!.isActive).toBe(false);
    await expect(
      processMessage({ text: "hi", userId: "kari", username: "Kari", platform: "web", botConfig: ivar, config, say: async () => {}, setStatus: async () => {}, threadId }),
    ).rejects.toThrow(/wiki page's Discuss thread/);
    expect(extractorCalls).toHaveLength(0);

    // A pane turn without the id continues the live trace thread.
    const third = await frames(await tracePost(app, { question: "And now?" }));
    expect(third[0]!.data.threadId).toBe(threadId);

    // Apply refuses a trace turn; Continue names the key and the wiki, and no page.
    const newest = (await settled(threadId, 3))[2]!;
    const apply = await app.request(WIKI_DISCUSS_APPLY_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: newest.id, preview: true }) });
    expect(apply.status).toBe(409);
    expect(((await apply.json()) as { reason: string }).reason).toBe("no-page");
    const cont = await app.request("/api/wiki/discuss/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: newest.id }) });
    expect(cont.status).toBe(200);
    const prompt = ((await cont.json()) as { prompt: string }).prompt;
    expect(prompt).toContain(TRACE_SUMMARY_QUESTION);
    expect(prompt).toContain("Key: MEL-77");
    expect(prompt).toContain(`Wiki: harbour (${wiki})`);
    // No kind in this wiki: the mentions search MEL-77 as a substring, and so do the commands.
    expect(prompt).toContain(`git --no-pager --literal-pathspecs -C '${wiki}' `);
    expect(prompt).toContain(" grep --no-recurse-submodules --no-color -n -I -F -e 'MEL-77' -- .");
    expect(prompt).toContain(" --relative --oneline '-SMEL-77' -- .");
    expect(prompt).toContain("/api/wiki/mentions?wiki=harbour&key=MEL-77");
    expect(prompt).not.toContain("Page:");
    expect(prompt).not.toContain("about the whole page");
    expect(prompt).not.toContain("If the page turns out to be wrong");
    // Once a `keys` kind claims it, the mentions search it whole, and the commands say they are candidates.
    await Bun.write(path.join(wiki, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }] }));
    __resetWikiCacheForTest();
    const whole = ((await (await app.request("/api/wiki/discuss/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: newest.id }) })).json()) as { prompt: string }).prompt;
    expect(whole).toContain(`LC_ALL=C GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git --no-pager --literal-pathspecs -C '${wiki}' `);
    expect(whole).toContain(" -n -I -E -e '(^|[^[:alnum:]])MEL-77([^[:alnum:]]|$)' -- .");
    expect(whole).toContain("Both can list more than that answer");
    expect(whole).not.toContain("-F -e");

    // The thread read by key: the live trace thread and its messages.
    const read = (await (await app.request("/api/wiki/discuss/thread?wiki=harbour&traceKey=MEL-77")).json()) as { thread: { id: string }; messages: { role: string }[] };
    expect(read.thread.id).toBe(threadId);
    expect(read.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  } finally {
    git("reset", "-q", "--hard", "HEAD~2");
    await rm(path.join(wiki, ".wiki-reader.json"), { force: true });
    __resetWikiCacheForTest();
  }
});

// Fix round 1 (H2): a trace thread has no page and Apply refuses its turns, so an
// edit block in a trace answer is no proposed edit and points at no page tab.
test("a trace turn whose answer holds an edit block: no proposed edit on the row or the done event, the answer stored without the page-tab marker", async () => {
  await Bun.write(path.join(wiki, "notes", "ferry.md"), "# Ferry note\n\nThe ferry case MEL-77 is open.\n");
  gitc("add", ".");
  gitc("commit", "-qm", "Ferry note names MEL-77");
  __resetWikiCacheForTest();
  try {
    const app = apps();
    answer = EDIT_ANSWER;
    const evs = await frames(await tracePost(app, { question: TRACE_SUMMARY_QUESTION }));
    const done = evs.find((e) => e.event === "done")!.data;
    expect(done.proposedEdit).toBeNull();
    const threadId = evs[0]!.data.threadId as string;
    const [row] = await settled(threadId, 1);
    expect(row!.proposedEdit).toBeNull();
    const stored = (await messagesOf(threadId)).find((m) => m.id === row!.assistantMessageId)!;
    expect(stored.content).not.toContain(STORED_EDIT_MARKER);
    expect(stored.content).toBe(EDIT_ANSWER);

    // A turn that fails after streaming the block stores what streamed, without the marker too.
    streamThenFail = true;
    const failed = await frames(await tracePost(app, { question: "Again?", discussionId: threadId }));
    expect(failed.some((e) => e.event === "app_error")).toBe(true);
    const rows = await settled(threadId, 2);
    expect(rows[1]!.endState).toBe("error");
    const partial = (await messagesOf(threadId)).find((m) => m.id === rows[1]!.assistantMessageId)!;
    expect(partial.content).not.toContain(STORED_EDIT_MARKER);
    expect(partial.content).toContain('"edits"');
  } finally {
    git("reset", "-q", "--hard", "HEAD~1");
    __resetWikiCacheForTest();
  }
});

test("a trace body is refused with a page, a selection or Edit, and a page discussion id is another key's", async () => {
  const app = apps();
  for (const [extra, msg] of [
    [{ relPath: "notes/harbour.md" }, "send relPath or traceKey, not both"],
    [{ selection: "x" }, "a trace turn takes no selection"],
    [{ mode: "edit" }, "a trace turn is an Explore turn: there is no page to edit"],
    [{ traceKey: "ab" }, "traceKey: key must be 3–80 characters"],
  ] as const) {
    const res = await tracePost(app, { question: "Q", ...extra });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(msg);
  }
  const page = (await frames(await pane(app, { question: "When?" })))[0]!.data.threadId as string;
  const other = await tracePost(app, { question: "Q", discussionId: page });
  expect(other.status).toBe(409);
  expect(((await other.json()) as { error: string }).error).toBe("that discussion is about another key");
});

// ── Fix round 1: a trace is refused before any thread, turn or mentions work ──

const traceRows = async (wikiName: string, key: string) => {
  const [t] = await getDb()`SELECT count(*)::int AS n FROM threads WHERE wiki = ${wikiName} AND trace_key = ${key}`;
  const [r] = await getDb()`SELECT count(*)::int AS n FROM wiki_discuss_turns WHERE wiki = ${wikiName} AND trace_key = ${key}`;
  return { threads: t!.n as number, turns: r!.n as number };
};

test("on an instance that authenticates, a trace turn and a trace thread read are refused: no thread, no turn, no mentions read", async () => {
  let mentionsCalls = 0;
  const app = apps(undefined, {
    authMode: () => "entra",
    mentions: async () => {
      mentionsCalls++;
      return { ok: false, error: "the mentions must not be read" };
    },
  });
  const res = await tracePost(app, { traceKey: "MEL-88", question: "Summarize MEL-88" });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Trace is not served on an instance that authenticates", reason: "trace-off" });
  const read = await app.request("/api/wiki/discuss/thread?wiki=harbour&traceKey=MEL-88");
  expect(read.status).toBe(404);
  expect(((await read.json()) as { reason: string }).reason).toBe("trace-off");
  expect(mentionsCalls).toBe(0);
  expect(calls).toHaveLength(0);
  expect(await traceRows("harbour", "MEL-88")).toEqual({ threads: 0, turns: 0 });
  // A page turn on the same instance is unchanged.
  const page = await frames(await pane(app, { question: "When?" }));
  expect(page.map((f) => f.event)).toContain("done");
});

test("a trace on a wiki that is no git work tree is refused before its thread exists", async () => {
  const dune = path.join(dir, "dune");
  await Bun.write(path.join(dune, WIKI_AGENT_RULES_FILE), RULES);
  await Bun.write(path.join(dune, "notes", "sand.md"), "# Sand\n\nMEL-89 is here.\n");
  __setWikiRegistryForTest([
    { name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" },
    { name: "dune", root: dune, source: "extra", synthesisBot: "ivar" },
  ]);
  try {
    const app = apps();
    const res = await tracePost(app, { wiki: "dune", traceKey: "MEL-89", question: "Summarize MEL-89" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe("no-snapshot");
    expect(calls).toHaveLength(0);
    expect(await traceRows("dune", "MEL-89")).toEqual({ threads: 0, turns: 0 });
  } finally {
    __setWikiRegistryForTest([{ name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" }]);
    __resetWikiCacheForTest();
  }
});

// Fix round 2: a repo before its first commit is a work tree, but the mentions'
// `git log` fails there; the trace is refused before its thread exists.
test("a trace on a git work tree with no commit yet is refused before its thread exists", async () => {
  const fresh = path.join(dir, "fresh");
  await Bun.write(path.join(fresh, WIKI_AGENT_RULES_FILE), RULES);
  await Bun.write(path.join(fresh, "notes", "sand.md"), "# Sand\n\nMEL-90 is here.\n");
  for (const args of [["init", "-q"], ["add", "."]]) {
    const r = Bun.spawnSync(["git", ...args], { cwd: fresh, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  __setWikiRegistryForTest([
    { name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" },
    { name: "fresh", root: fresh, source: "extra", synthesisBot: "ivar" },
  ]);
  try {
    const app = apps();
    const res = await tracePost(app, { wiki: "fresh", traceKey: "MEL-90", question: "Summarize MEL-90" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "a trace reads the wiki's history with git, and this wiki has no commit yet", reason: "no-snapshot" });
    expect(calls).toHaveLength(0);
    expect(await traceRows("fresh", "MEL-90")).toEqual({ threads: 0, turns: 0 });
  } finally {
    __setWikiRegistryForTest([{ name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" }]);
    __resetWikiCacheForTest();
  }
});

// Class check (sweep A, mutant M17): the pre-flight asks git each time
// (`mentionsGitState`), never the page route's answer kept 60 s per root
// (`mentionsWorkTree`), so a wiki's first commit is seen by the next trace.
test("the trace pre-flight reads the wiki's git state afresh: a first commit made after a page open's cached «no» is seen", async () => {
  const late = path.join(dir, "late");
  await Bun.write(path.join(late, WIKI_AGENT_RULES_FILE), RULES);
  await Bun.write(path.join(late, "notes", "sand.md"), "# Sand\n\nMEL-91 is here.\n");
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: late, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  run("init", "-q");
  run("add", ".");
  // A page open on this wiki now: the page route's check answers «no» and keeps it.
  expect(await mentionsWorkTree(late)).toBe(false);
  run("commit", "-qm", "first commit");
  __setWikiRegistryForTest([
    { name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" },
    { name: "late", root: late, source: "extra", synthesisBot: "ivar" },
  ]);
  try {
    expect(await mentionsWorkTree(late)).toBe(false); // still the kept answer
    const res = await tracePost(apps(), { wiki: "late", traceKey: "MEL-91", question: "Summarize MEL-91" });
    expect(res.status).toBe(200);
    const evs = await frames(res);
    expect(evs.map((e) => e.event)).toContain("done");
    expect(calls).toHaveLength(1);
    expect(await traceRows("late", "MEL-91")).toEqual({ threads: 1, turns: 1 });
  } finally {
    __setWikiRegistryForTest([{ name: "harbour", root: wiki, source: "extra", synthesisBot: "ivar" }]);
    __resetWikiCacheForTest();
  }
});

// Pane room PR 2: a page turn whose question (or selection) names a key gets
// that key's mentions in its prompt, so a «where else» needs no grep.
test("a page turn naming a key gets its mentions in the prompt, from the real mentions builder; a keyless one reads no mentions", async () => {
  await Bun.write(path.join(wiki, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }] }));
  await Bun.write(path.join(wiki, "notes", "berth.md"), "# Berth note\n\nThe berth case MEL-95 waits on the crane.\n");
  await Bun.write(path.join(wiki, "notes", "harbour.md"), NOTE + "\nThe crane for MEL-95 is late.\n");
  gitc("add", ".");
  gitc("commit", "-qm", "Berth note names MEL-95");
  __resetWikiCacheForTest();
  try {
    let mentionsCalls = 0;
    const spied = apps(undefined, {
      mentions: async () => {
        mentionsCalls++;
        return { ok: false, error: "a keyless question reads no mentions" };
      },
    });
    const plain = await frames(await pane(spied, { question: "When does the harbour open?" }));
    expect(plain.map((f) => f.event)).toContain("done");
    expect(mentionsCalls).toBe(0);
    expect(calls[0]!.prompt).not.toContain("## The key this question names");

    calls = [];
    const real = apps();
    const keyed = await frames(await pane(real, { question: "Where else is MEL-95?" }));
    expect(keyed.map((f) => f.event)).toContain("done");
    expect(keyed.some((f) => f.event === "status" && f.data.phase === "mentions")).toBe(true);
    const p = calls[0]!.prompt;
    expect(p).toContain("## The key this question names: MEL-95");
    expect(p).toContain("do not search the wiki for MEL-95 again");
    expect(p).toContain("- notes/berth.md");
    expect(p).toContain("The berth case MEL-95 waits on the crane.");
    expect(p).toContain("Berth note names MEL-95");
    // The block sits before the question, which stays last.
    expect(p.indexOf("## The key this question names")).toBeLessThan(p.indexOf("## Question"));
    expect(p.trimEnd().endsWith("Where else is MEL-95?")).toBe(true);

    // A key named only in the selection counts too (fix round 1, finding 7).
    calls = [];
    const sel = await frames(await pane(real, { question: "Where else?", selection: "The crane for MEL-95 is late." }));
    expect(sel.map((f) => f.event)).toContain("done");
    expect(calls[0]!.prompt).toContain("## The key this question names: MEL-95");

    // On an instance that authenticates, no mentions are read for a page turn either (fix round 1, finding 1).
    calls = [];
    let authedMentions = 0;
    const authed = apps(undefined, {
      authMode: () => "entra",
      mentions: async () => {
        authedMentions++;
        return { ok: false, error: "an authenticating instance reads no mentions" };
      },
    });
    const gated = await frames(await pane(authed, { question: "Where else is MEL-95?" }));
    expect(gated.map((f) => f.event)).toContain("done");
    expect(authedMentions).toBe(0);
    expect(calls[0]!.prompt).not.toContain("## The key this question names");

    // A key no tracked file names gets no block: nothing to answer from, and the tools stay the way.
    calls = [];
    const none = await frames(await pane(real, { question: "Where else is MEL-96?" }));
    expect(none.map((f) => f.event)).toContain("done");
    expect(calls[0]!.prompt).not.toContain("## The key this question names");
  } finally {
    git("reset", "-q", "--hard", "HEAD~1");
    await rm(path.join(wiki, ".wiki-reader.json"), { force: true });
    __resetWikiCacheForTest();
  }
});
