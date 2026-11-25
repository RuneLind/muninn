/**
 * `POST /api/research/chat` (the Jira extension's "send to analysis") against
 * the REAL test database, when a wiki page's Discuss thread (Discuss v2, D7)
 * holds the thread name: the route never hands that thread back, so /chat never
 * opens it. A name held by a chat thread keeps today's `threadExists` 409.
 *
 * Own `bun test` link (`test:db`): `setupTestDb` truncates the tables. The bot
 * roster is a throwaway `MUNINN_BOTS_DIR`; invented users and bots only.
 */
import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { ensureUser } from "../../db/users.ts";
import { createThread, ensureDefaultThread, getOrCreateWikiThread, getThreadById } from "../../db/threads.ts";
import { getDb } from "../../db/client.ts";
import { registerResearchRoutes } from "./research-routes.ts";
import type { Config } from "../../config.ts";

setupTestDb();

const BOT = "jiraowl";
const USER = "user-kari";
let root = "";
const priorBotsDir = process.env.MUNINN_BOTS_DIR;

beforeAll(() => {
  root = testTempDirSync(join(tmpdir(), "muninn-research-chat-"));
  mkdirSync(join(root, BOT), { recursive: true });
  writeFileSync(join(root, BOT, "CLAUDE.md"), "Persona for jiraowl");
  process.env.MUNINN_BOTS_DIR = root;
});

afterAll(() => {
  setSystemTime();
  if (priorBotsDir === undefined) delete process.env.MUNINN_BOTS_DIR;
  else process.env.MUNINN_BOTS_DIR = priorBotsDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  setSystemTime();
  await ensureUser({ id: USER, username: "kari", platform: "web" });
  await ensureDefaultThread(USER, BOT);
});

function app() {
  const a = new Hono();
  registerResearchRoutes(a, { knowledgeApiUrl: "http://127.0.0.1:1" } as unknown as Config);
  return a;
}

const post = (body: Record<string, unknown>) =>
  app().request("/api/research/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bot: BOT, text: "Analyse this task.", ...body }),
  });

const wikiThread = (name: string) =>
  getOrCreateWikiThread(USER, BOT, "mimir", `plans/${name}.mdx`, (s) => `${name}${s}`);

const threadNames = async () =>
  (await getDb()`SELECT name, kind FROM threads WHERE user_id = ${USER} AND bot_name = ${BOT} ORDER BY name`)
    .map((r) => `${r.kind}:${r.name}`);

/** The route's own `forceNew` suffix for the frozen clock (local time, as the route builds it). */
function suffixAt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

test("a name a wiki thread holds: 409 nameTaken with an error, never the thread's id, and no thread created", async () => {
  const wt = await wikiThread("melo-1");
  const res = await post({ title: "MELO-1" });
  expect(res.status).toBe(409);
  const body = await res.json() as Record<string, unknown>;
  expect(body.nameTaken).toBe(true);
  expect(typeof body.error).toBe("string");
  expect("threadExists" in body).toBe(false);
  expect("existingThreadId" in body).toBe(false);
  expect(JSON.stringify(body)).not.toContain(wt.id);
  expect(await threadNames()).toEqual(["chat:main", "wiki:melo-1"]);
});

test("forceNew past a wiki-held name: a suffixed CHAT thread, the wiki thread untouched", async () => {
  const wt = await wikiThread("melo-2");
  const res = await post({ title: "MELO-2", forceNew: true });
  expect(res.status).toBe(200);
  const body = await res.json() as { threadId: string; chatUrl: string };
  const t = (await getThreadById(body.threadId))!;
  expect(t.kind).toBe("chat");
  expect(t.name).toMatch(/^melo-2-\d{4}-\d{2}-\d{2}-\d{4}$/);
  expect(await getThreadById(wt.id)).toEqual(wt);
});

test("forceNew whose suffixed name a wiki thread holds: createThread's refusal is a 409, not a 500", async () => {
  const now = new Date(2026, 10, 25, 10, 15, 0);
  setSystemTime(now);
  await createThread(USER, BOT, "melo-3");
  const wt = await wikiThread(`melo-3${suffixAt(now)}`);
  const res = await post({ title: "MELO-3", forceNew: true });
  expect(res.status).toBe(409);
  const body = await res.json() as Record<string, unknown>;
  expect(body.nameTaken).toBe(true);
  expect("existingThreadId" in body).toBe(false);
  expect(JSON.stringify(body)).not.toContain(wt.id);
});

test("a name a CHAT thread holds keeps today's threadExists 409 with its id", async () => {
  const t = await createThread(USER, BOT, "melo-4");
  const res = await post({ title: "MELO-4" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    threadExists: true,
    existingThreadId: t.id,
    existingThreadName: "melo-4",
    userId: USER,
    botName: BOT,
  });
});
