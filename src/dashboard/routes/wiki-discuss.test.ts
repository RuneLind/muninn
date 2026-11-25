/**
 * `POST /api/wiki/discuss` on temp wikis registered through the registry memo,
 * with an in-memory turn store, a fake one-shot and fake snapshots: the
 * preflight's JSON refusals and their order, the surface per connector, the
 * repos in reach, the card cache, and a turn that runs to its end after its
 * reader went away. The DB store is `src/db/wiki-discuss-turns.test.ts`.
 * Invented pages and repo names only (public repo).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { executeOneShot, OneShotOptions } from "../../ai/one-shot.ts";
import { __setClaudeCliVersionForTest, type ToolSurface } from "../../ai/tool-surface.ts";
import type { Snapshot } from "../../ai/snapshots.ts";
import type { DiscussTurn, DiscussTurnFinish, DiscussTurnStart } from "../../db/wiki-discuss-turns.ts";
import type { Thread } from "../../db/threads.ts";
import type { DiscussThreadStore } from "../../wiki/discuss-engine.ts";
import { DiscussTurnConflict } from "../../db/wiki-discuss-turns.ts";
import { realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import type { RunOutcome } from "../../wiki/plan-card-run.ts";
import { __setReadonlyWikiRootsForTest } from "../../wiki/readonly.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { DISCUSS_TURN_TIMEOUT_MS, NOT_IN_REACH, WIKI_AGENT_RULES_FILE, WIKI_AGENT_RULES_MAX_BYTES } from "../../wiki/discuss-agent.ts";
import { testTempDir, testTempDirSync } from "../../test/temp-dir.ts";
import { copilotNamedToolsSession } from "../../ai/connectors/copilot-sdk.ts";
import { COPILOT_DISCUSS_TOOLS, copilotDiscussReach, DISCUSS_CONNECTOR_GRACE_MS, DISCUSS_MAX_INFLIGHT, registerWikiDiscussRoute, WIKI_DISCUSS_CONTINUE_PATH, WIKI_DISCUSS_PATH, type DiscussRouteDeps, type DiscussStore } from "./wiki-discuss.ts";

// Whether this disk folds case (APFS default): the case-only rename test needs one.
const caseProbe = testTempDirSync(path.join(tmpdir(), "discuss-case-"));
writeFileSync(path.join(caseProbe, "CaseProbe"), "");
const caseInsensitiveDisk = existsSync(path.join(caseProbe, "caseprobe"));
rmSync(caseProbe, { recursive: true, force: true });

let dir = "";
let agent = ""; // a wiki with rules and discuss.repos
let bare = ""; // a wiki with rules, no reader config
let norules = ""; // a wiki without .wiki-agent.md
let alpha = ""; // a code checkout in reach
let navrepo = ""; // a checkout the variable resolves, not on the wiki's list

const PLAN = [
  "---",
  "title: Ferry timetable",
  "plan_status: in-flight",
  "repos: [alpha, navrepo]",
  "---",
  "",
  "# Ferry timetable",
  "",
  "## Brief",
  "",
  "Kari Nordmann keeps the **winter** timetable in `ferry.yaml`.",
  "",
  "## Design",
  "",
  "- The summer route adds a stop at Example Island.",
  "- The night route is unchanged.",
  "",
].join("\n");
const NOTE = "---\ntitle: Harbour note\n---\n\n# Harbour note\n\nThe harbour opens at six.\n";
const RULES = "# Rules\n\nAnswer the marked passage first.\n\ntools: Bash, Write\n";

class MemStore implements DiscussStore {
  rows: DiscussTurn[] = [];
  left: string[] = [];
  start = async (i: DiscussTurnStart) => {
    const seq = this.rows.filter((r) => r.discussionId === i.discussionId).length + 1;
    const row: DiscussTurn = {
      id: crypto.randomUUID(),
      discussionId: i.discussionId,
      seq,
      wiki: i.wiki,
      relPath: i.relPath,
      pageHash: i.pageHash,
      traceKey: null,
      threadId: i.threadId ?? null,
      userMessageId: i.userMessage ? crypto.randomUUID() : null,
      assistantMessageId: null,
      selection: i.selection,
      question: i.question,
      location: i.location,
      answer: "",
      endState: "running",
      error: null,
      readerLeft: false,
      botName: i.botName,
      connector: i.connector,
      model: i.model,
      surface: i.surface,
      card: null,
      toolCalls: [],
      proposedEdit: null,
      costUsd: null,
      durationMs: null,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      finishedAt: null,
      handedOverAt: null,
      editAppliedAt: null,
    };
    this.rows.push(row);
    if (i.userMessage) this.messages.push({ id: row.userMessageId!, role: "user", content: i.userMessage.content, threadId: i.threadId! });
    return { id: row.id, seq, userMessageId: row.userMessageId };
  };
  messages: { id: string; role: string; content: string; threadId: string }[] = [];
  assistant = async (turnId: string, content: string) => {
    const r = this.rows.find((x) => x.id === turnId);
    if (!r?.threadId) return null;
    const id = r.assistantMessageId ?? crypto.randomUUID();
    const old = this.messages.find((m) => m.id === id);
    if (old) old.content = content;
    else this.messages.push({ id, role: "assistant", content, threadId: r.threadId });
    r.assistantMessageId = id;
    return id;
  };
  finish = async (id: string, f: DiscussTurnFinish) => {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.endState !== "running") return false;
    Object.assign(r, { endState: f.endState, answer: f.answer, error: f.error ?? null, card: f.card ?? r.card, toolCalls: f.toolCalls ?? [], proposedEdit: f.proposedEdit ?? null, finishedAt: Date.now() });
    return true;
  };
  readerLeft = async (id: string) => {
    this.left.push(id);
    const r = this.rows.find((x) => x.id === id);
    if (r) r.readerLeft = true;
  };
  setCard = async (id: string, card: string) => {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.card = card;
  };
  list = async (discussionId: string) => this.rows.filter((r) => r.discussionId === discussionId).sort((a, b) => a.seq - b.seq);
  heartbeat = async (id: string) => {
    const r = this.rows.find((x) => x.id === id);
    if (r?.endState === "running") r.heartbeatAt = Date.now();
  };
  // The continue route's reads and write (P3).
  get = async (id: string) => this.rows.find((x) => x.id === id) ?? null;
  handedOver = async (id: string) => {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    r.handedOverAt ??= Date.now();
    return r;
  };
}

/** The wiki threads, in memory: one live thread per user, bot, wiki and page. */
class MemThreads implements DiscussThreadStore {
  rows: Thread[] = [];
  get = async (id: string) => this.rows.find((t) => t.id === id) ?? null;
  live = async (userId: string, botName: string, wiki: string, relPath: string) =>
    this.rows.find((t) => t.userId === userId && t.botName === botName && t.wiki === wiki && t.relPath === relPath && t.closedAt === undefined) ?? null;
  getOrCreate = async (userId: string, botName: string, wiki: string, relPath: string, nameFor: (suffix: string) => string) => {
    const hit = await this.live(userId, botName, wiki, relPath);
    if (hit) return hit;
    const t: Thread = { id: crypto.randomUUID(), userId, botName, name: nameFor(""), isActive: false, autoRespondPaused: false, createdAt: Date.now(), updatedAt: Date.now(), kind: "wiki", wiki, relPath };
    this.rows.push(t);
    return t;
  };
}

interface Calls {
  prompts: string[];
  opts: OneShotOptions[];
  bots: BotConfig[];
  codeSnaps: string[];
  wikiSnaps: string[];
  planCards: number;
  blocked: { connector: string | undefined; surface: ToolSurface }[];
}

const bot = (connector: BotConfig["connector"], name = "ivar"): BotConfig => ({
  name,
  dir: "/nonexistent",
  persona: "",
  telegramAllowedUserIds: [],
  slackAllowedUserIds: [],
  connector,
  model: "invented-model",
});

/** git as `findRepo`, the own-repo check and the snapshot preflight ask it: each checkout is its own top level, origin named after its folder; every wiki is a work tree that lists each file on disk. */
const fakeGit: GitRun = async (cwd, args) => {
  const real = await realpath(cwd).catch(() => cwd);
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, stdout: real + "\n", stderr: "", timedOut: false, capped: false } as never;
  if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { ok: true, stdout: "true\n", stderr: "", timedOut: false, capped: false } as never;
  if (args[0] === "ls-files") {
    // The whole tree, or the one path after `--`.
    const all = (await readdir(real, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(real, path.join(e.parentPath, e.name)));
    const dd = args.indexOf("--");
    const listed = dd >= 0 ? all.filter((p) => p === args[dd + 1]) : all;
    return { ok: true, stdout: listed.map((p) => `${p}\0`).join(""), stderr: "", timedOut: false, capped: false } as never;
  }
  if (args[0] === "remote" && args[2] === "origin") return { ok: true, stdout: `git@example.com:org/${path.basename(real)}.git\n`, stderr: "", timedOut: false, capped: false } as never;
  return { ok: false, stdout: "", stderr: "", timedOut: false, capped: false } as never;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The fake wiki snapshot's copy: each file of `from` whose bytes differ, one copy at a time, so concurrent turns never read a half-written file. */
let copying: Promise<void> = Promise.resolve();
function copyTree(from: string, to: string): Promise<void> {
  const run = copying.then(async () => {
    for (const e of await readdir(from, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const src = path.join(e.parentPath, e.name);
      const dst = path.join(to, path.relative(from, src));
      const text = await readFile(src);
      const old = await readFile(dst).catch(() => null);
      if (!old || !old.equals(text)) await Bun.write(dst, text);
    }
  });
  copying = run.catch(() => {});
  return run;
}

function setup(opts: { connector?: BotConfig["connector"]; oneShot?: typeof executeOneShot; store?: MemStore; threads?: MemThreads; deps?: Partial<DiscussRouteDeps>; role?: "user" | "admin" } = {}) {
  const calls: Calls = { prompts: [], opts: [], bots: [], codeSnaps: [], wikiSnaps: [], planCards: 0, blocked: [] };
  const store = opts.store ?? new MemStore();
  const threads = opts.threads ?? new MemThreads();
  const app = new Hono();
  if (opts.role) app.use(async (c, next) => { c.set("role" as never, opts.role as never); await next(); });
  const oneShot: typeof executeOneShot =
    opts.oneShot ??
    (async (prompt, _config, b, o) => {
      calls.prompts.push(prompt);
      calls.opts.push(o);
      calls.bots.push(b);
      o.onProgress?.({ type: "text_delta", text: "The summer route " });
      return { result: "The summer route stops at Example Island.\n\nRead: alpha/src/route.ts\nNot checked: nothing else", costUsd: 0.01, toolCalls: [{ id: "t1", name: "Read", displayName: "Read", durationMs: 1, startOffsetMs: 0, input: '{"file_path":"x"}' }] } as never;
    });
  registerWikiDiscussRoute(app, { profile: "default", dashboardPort: 4321, claudeModel: "fallback-model", decisionTriageRepoRoots: null } as unknown as Config, {
    store,
    threads,
    chatUsers: async () => [{ id: "kari", name: "Kari" }],
    defaultUser: async () => "kari",
    mirror: null,
    continueStore: store,
    bots: () => [bot(opts.connector ?? "claude-sdk")],
    oneShot,
    surfaceBlocker: async (connector, surface) => {
      calls.blocked.push({ connector, surface });
      return null;
    },
    wikiSnapshot: async (d) => {
      calls.wikiSnaps.push(d);
      const to = path.join(dir, "snaps", `wiki-${path.basename(d)}`);
      await copyTree(d, to);
      return { kind: "wiki", dir: to, key: "k", source: d } satisfies Snapshot;
    },
    codeSnapshot: async (d) => {
      calls.codeSnaps.push(d);
      return { kind: "code", dir: path.join(dir, "snaps", `code-${path.basename(d)}`), key: "k", source: d, commit: "0123456789abcdef", branch: "main" } satisfies Snapshot;
    },
    git: fakeGit,
    repoRoots: () => `alpha=${alpha},navrepo=${navrepo}`,
    planCardConfig: () => ({ bin: "/invented/plan-card.ts", roots: [agent, bare] }),
    planCard: async (): Promise<RunOutcome> => {
      calls.planCards++;
      return { ok: true, ms: 1, proc: { exitCode: 0, stdout: JSON.stringify({ text: `# Ferry card\npath: ${agent}/plans/ferry.mdx`, chars: 30, cuts: [] }), stderr: "" } as never };
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...opts.deps,
  });
  return { app, calls, store, threads };
}

const post = (app: Hono, body: unknown, init: RequestInit = {}, type = "application/json") =>
  app.request(WIKI_DISCUSS_PATH, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body), ...init });

/** The SSE frames of a finished response, as `{event, data}`. */
async function frames(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((f) => f.trim())
    .map((f) => ({ event: /^event: (.*)$/m.exec(f)?.[1] ?? "", data: JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? "{}") }));
}

const PASSAGE = {
  wiki: "agent",
  relPath: "plans/ferry.mdx",
  question: "Which stop does the summer route add?",
  selection: "The summer route adds a stop at Example Island.",
  before: "timetable in ferry.yaml. Design",
  after: "The night route is unchanged.",
  heading: "Design",
};

beforeAll(async () => {
  dir = await realpath(await testTempDir(path.join(tmpdir(), "muninn-discuss-agent-")));
  agent = path.join(dir, "agent");
  bare = path.join(dir, "bare");
  norules = path.join(dir, "norules");
  alpha = path.join(dir, "alpha");
  navrepo = path.join(dir, "navrepo");
  await mkdir(alpha, { recursive: true });
  await mkdir(navrepo, { recursive: true });
  await Bun.write(path.join(agent, ".wiki-reader.json"), JSON.stringify({ discuss: { handoff: true, repos: ["alpha"] } }));
  await Bun.write(path.join(agent, WIKI_AGENT_RULES_FILE), RULES);
  await Bun.write(path.join(agent, "plans", "ferry.mdx"), PLAN);
  await Bun.write(path.join(agent, "notes", "harbour.md"), NOTE);
  await Bun.write(path.join(bare, WIKI_AGENT_RULES_FILE), RULES);
  await Bun.write(path.join(bare, "plans", "ferry.mdx"), PLAN);
  await Bun.write(path.join(norules, "plans", "ferry.mdx"), PLAN);
  __setWikiRegistryForTest([
    { name: "agent", root: agent, source: "extra" },
    { name: "bare", root: bare, source: "extra" },
    { name: "norules", root: norules, source: "extra" },
  ]);
});

afterEach(() => {
  __setReadonlyWikiRootsForTest();
  __setClaudeCliVersionForTest(undefined);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

describe("preflight refusals, as JSON before the stream", () => {
  test("a non-admin viewer gets 403 and no turn is stored", async () => {
    const { app, store, calls } = setup({ role: "user" });
    const res = await post(app, PASSAGE);
    expect(res.status).toBe(403);
    expect(store.rows).toHaveLength(0);
    expect(calls.blocked).toHaveLength(0);
  });
  test("a non-JSON POST gets 415", async () => {
    const { app } = setup();
    expect((await post(app, JSON.stringify(PASSAGE), {}, "text/plain")).status).toBe(415);
  });
  test("a malformed discussionId gets 400", async () => {
    const { app } = setup();
    const res = await post(app, { ...PASSAGE, discussionId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });
  test("a wiki without .wiki-agent.md keeps today's Discuss: 404 no-agent, no bot resolved, nothing stored", async () => {
    const { app, store, calls } = setup();
    const res = await post(app, { ...PASSAGE, wiki: "norules" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe("no-agent");
    expect(store.rows).toHaveLength(0);
    expect(calls.blocked).toHaveLength(0);
  });
  test("a read-only wiki is refused by the egress check, before its rules file is read", async () => {
    __setReadonlyWikiRootsForTest([norules, agent]);
    const { app, store } = setup();
    // norules has no rules file: a 403 rather than its 404 proves the egress check runs first.
    for (const wiki of ["norules", "agent"]) {
      const res = await post(app, { ...PASSAGE, wiki });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { readonly: boolean }).readonly).toBe(true);
    }
    expect(store.rows).toHaveLength(0);
  });
  test("a rules file over the bound is refused, never cut", async () => {
    const big = path.join(dir, "big");
    await Bun.write(path.join(big, WIKI_AGENT_RULES_FILE), "x".repeat(WIKI_AGENT_RULES_MAX_BYTES + 1));
    await Bun.write(path.join(big, "a.md"), NOTE);
    __setWikiRegistryForTest([
      { name: "agent", root: agent, source: "extra" },
      { name: "big", root: big, source: "extra" },
    ]);
    try {
      const { app } = setup();
      const res = await post(app, { wiki: "big", relPath: "a.md", question: "q" });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { reason: string }).reason).toBe("rules-too-large");
    } finally {
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra" },
        { name: "bare", root: bare, source: "extra" },
        { name: "norules", root: norules, source: "extra" },
      ]);
      __resetWikiCacheForTest();
    }
  });
  test("a rules file that is a symlink is refused", async () => {
    const linked = path.join(dir, "linked");
    await mkdir(linked, { recursive: true });
    await writeFile(path.join(dir, "outside.md"), RULES);
    await symlink(path.join(dir, "outside.md"), path.join(linked, WIKI_AGENT_RULES_FILE));
    await Bun.write(path.join(linked, "a.md"), NOTE);
    __setWikiRegistryForTest([{ name: "linked", root: linked, source: "extra" }]);
    try {
      const { app } = setup();
      const res = await post(app, { wiki: "linked", relPath: "a.md", question: "q" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { reason: string }).reason).toBe("rules-unreadable");
    } finally {
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra" },
        { name: "bare", root: bare, source: "extra" },
        { name: "norules", root: norules, source: "extra" },
      ]);
      __resetWikiCacheForTest();
    }
  });
  test("an unknown page gets 404", async () => {
    const { app } = setup();
    expect((await post(app, { ...PASSAGE, relPath: "plans/none.mdx" })).status).toBe(404);
  });
  test("a wiki pinned to a bot that is not configured is refused, never run on the fallback bot", async () => {
    __setWikiRegistryForTest([{ name: "pinned", root: bare, source: "extra", synthesisBot: "melosys" }]);
    try {
      const { app, calls, store } = setup({ deps: { bots: () => [bot("claude-sdk", "ivar")] } });
      const res = await post(app, { ...PASSAGE, wiki: "pinned" });
      expect(res.status).toBe(503);
      const j = (await res.json()) as { reason: string; error: string };
      expect(j.reason).toBe("no-bot");
      expect(j.error).toContain("melosys");
      expect(calls.blocked).toHaveLength(0);
      expect(calls.wikiSnaps).toHaveLength(0);
      expect(calls.opts).toHaveLength(0);
      expect(store.rows).toHaveLength(0);
      // The pinned bot, when it is there, is the one that answers.
      const ok = setup({ deps: { bots: () => [bot("claude-sdk", "ivar"), bot("copilot-sdk", "melosys")] } });
      await (await post(ok.app, { ...PASSAGE, wiki: "pinned" })).text();
      expect(ok.calls.bots.map((b) => b.name)).toEqual(["melosys"]);
    } finally {
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra" },
        { name: "bare", root: bare, source: "extra" },
        { name: "norules", root: norules, source: "extra" },
      ]);
      __resetWikiCacheForTest();
    }
  });
  test("a connector the table does not cover is refused, before any surface check", async () => {
    const { app, calls, store } = setup({ connector: "openai-compat" });
    const res = await post(app, PASSAGE);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { reason: string }).reason).toBe("connector");
    expect(calls.blocked).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });
  test("a surface toolSurfaceBlocker refuses is a 503 before any snapshot or turn", async () => {
    const { app, calls, store } = setup({ deps: { surfaceBlocker: async () => "the installed CLI is too old" } });
    const res = await post(app, PASSAGE);
    expect(res.status).toBe(503);
    const j = (await res.json()) as { reason: string; error: string };
    expect(j.reason).toBe("surface");
    expect(j.error).toContain("too old");
    expect(calls.wikiSnaps).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });
  test("the real toolSurfaceBlocker is the default: a claude-cli without --restricted is refused", async () => {
    __setClaudeCliVersionForTest("2.0.0");
    const { app, store } = setup({ connector: "claude-cli", deps: { surfaceBlocker: undefined } });
    const res = await post(app, PASSAGE);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe("surface");
    expect(store.rows).toHaveLength(0);
  });
  test("the pre-flight checks the surface the connector gets: read-and-search on Claude, the named tools on Copilot", async () => {
    const claude = setup({ connector: "claude-sdk" });
    await (await post(claude.app, PASSAGE)).text();
    expect("readSearch" in (claude.calls.blocked[0]!.surface as object)).toBe(true);
    const copilot = setup({ connector: "copilot-sdk" });
    await (await post(copilot.app, PASSAGE)).text();
    expect(copilot.calls.blocked[0]!.surface).toEqual({ mcpTools: COPILOT_DISCUSS_TOOLS });
  });
});

describe("a turn", () => {
  test("runs one one-shot with the rules, the pack and the 5-minute timeout, on read-and-search over the snapshots", async () => {
    const { app, calls, store } = setup();
    const res = await post(app, PASSAGE);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const evs = await frames(res);
    expect(evs.map((e) => e.event)).toEqual(["turn", "status", "status", "status", "delta", "done", "end"]);
    expect(calls.opts).toHaveLength(1);
    const o = calls.opts[0]!;
    // The connector's own timeout is cleanup past the route's deadline.
    expect(o.timeoutMs).toBe(DISCUSS_TURN_TIMEOUT_MS + DISCUSS_CONNECTOR_GRACE_MS);
    // The rules file is prose in the system prompt; what it says about tools changes nothing.
    expect(o.systemPrompt).toContain("Answer the marked passage first.");
    expect(o.toolSurface).toEqual({ readSearch: [path.join(dir, "snaps", "wiki-agent"), path.join(dir, "snaps", "code-alpha")] });
    // The pack: the page's path inside the snapshot, never the live path; the passage's lines.
    const prompt = calls.prompts[0]!;
    expect(prompt).toContain(`Page file: ${path.join(dir, "snaps", "wiki-agent", "plans", "ferry.mdx")}`);
    expect(prompt).not.toContain(path.join(agent, "plans", "ferry.mdx"));
    expect(prompt).toContain("## The marked passage (line 15, Ferry timetable › Design)");
    expect(prompt).toContain("15: - The summer route adds a stop at Example Island.");
    expect(prompt.trimEnd().endsWith("Which stop does the summer route add?")).toBe(true);
    const row = store.rows[0]!;
    expect(row.endState).toBe("done");
    expect(row.toolCalls).toEqual([{ name: "Read", input: '{"file_path":"x"}' }]);
    expect(row.location).toMatchObject({ found: "exact", fromLine: 15, toLine: 15 });
    expect(evs.find((e) => e.event === "done")!.data.turnId).toBe(row.id);
  });
  test("a page whose repos: names a repo outside discuss.repos gets no snapshot of it, and the pack says so", async () => {
    const { app, calls } = setup();
    await (await post(app, PASSAGE)).text();
    expect(calls.codeSnaps).toEqual([alpha]);
    const prompt = calls.prompts[0]!;
    expect(prompt).toContain(`- navrepo: ${NOT_IN_REACH}`);
    expect(prompt).toContain(`- alpha: ${path.join(dir, "snaps", "code-alpha")}`);
    expect(prompt).not.toContain(navrepo);
  });
  test("a wiki whose reader config names no repos puts none in reach", async () => {
    const { app, calls } = setup();
    await (await post(app, { ...PASSAGE, wiki: "bare" })).text();
    expect(calls.codeSnaps).toEqual([]);
    const prompt = calls.prompts[0]!;
    expect(prompt).toContain("No repo in reach");
    expect(prompt).toContain(`- alpha: ${NOT_IN_REACH}`);
    expect(prompt).toContain(`- navrepo: ${NOT_IN_REACH}`);
  });
  test("Copilot gets the named tools and no snapshot; the pack names the page by its path in the wiki", async () => {
    const { app, calls } = setup({ connector: "copilot-sdk" });
    await (await post(app, { wiki: "agent", relPath: "notes/harbour.md", question: "When does the harbour open?" })).text();
    expect(calls.opts[0]!.toolSurface).toEqual({ mcpTools: COPILOT_DISCUSS_TOOLS });
    expect(calls.wikiSnaps).toHaveLength(0);
    expect(calls.codeSnaps).toHaveLength(0);
    const prompt = calls.prompts[0]!;
    expect(prompt).toContain("## The question is about the whole page");
    expect(prompt).toContain("yggdrasil-search");
    expect(prompt).not.toContain(agent);
  });
  test("Copilot on a bot whose .mcp.json declares research gets the wiki read tools, and the read section names the page's wiki; without it, neither", async () => {
    const botDir = path.join(dir, "bots", "ivar");
    await Bun.write(path.join(botDir, ".mcp.json"), JSON.stringify({ mcpServers: {
      knowledge: { type: "http", url: "http://127.0.0.1:1/k" },
      yggdrasil: { type: "http", url: "http://127.0.0.1:1/y" },
      research: { type: "http", url: "http://127.0.0.1:1/mcp/ivar" },
    } }));
    const withResearch = (): BotConfig => ({ ...bot("copilot-sdk"), dir: botDir });
    try {
      // The page's wiki is pinned to the bot (the pin matched ignoring case), asked for in another case.
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra", synthesisBot: "IVAR" },
        { name: "bare", root: bare, source: "extra" },
      ]);
      const pinned = setup({ connector: "copilot-sdk", deps: { bots: () => [withResearch()], researchWikiTools: () => true } });
      await (await post(pinned.app, { wiki: "AGENT", relPath: "notes/harbour.md", question: "Where else?" })).text();
      const tools = { ...COPILOT_DISCUSS_TOOLS, research: ["wiki_grep", "wiki_read", "wiki_history"] };
      expect(pinned.calls.blocked[0]!.surface).toEqual({ mcpTools: tools });
      expect(pinned.calls.opts[0]!.toolSurface).toEqual({ mcpTools: tools });
      // The real session builder takes this surface for this bot.
      expect(copilotNamedToolsSession(withResearch(), { mcpTools: tools }).availableTools).toContain("mcp:research-wiki_grep");
      expect(pinned.calls.prompts[0]).toContain('research-wiki_grep for an exact key, id or a "where else" question');
      expect(pinned.calls.prompts[0]).toContain('Pass wiki: "agent" to each.');

      // A wiki not in the bot's list (the research-bot fallback reaches it): the tools, but no wiki named.
      const unpinned = setup({ connector: "copilot-sdk", deps: { bots: () => [withResearch()], researchWikiTools: () => true } });
      await (await post(unpinned.app, { wiki: "bare", relPath: "plans/ferry.mdx", question: "Where else?" })).text();
      expect(unpinned.calls.opts[0]!.toolSurface).toEqual({ mcpTools: tools });
      expect(unpinned.calls.prompts[0]).not.toContain("Pass wiki:");

      // No research server in .mcp.json: the surface is unchanged, which the real session builder needs.
      const plain = setup({ connector: "copilot-sdk" });
      await (await post(plain.app, { wiki: "agent", relPath: "notes/harbour.md", question: "Where else?" })).text();
      expect(plain.calls.opts[0]!.toolSurface).toEqual({ mcpTools: COPILOT_DISCUSS_TOOLS });
      expect(plain.calls.prompts[0]).not.toContain("research-wiki_grep");
      expect(() => copilotNamedToolsSession(bot("copilot-sdk"), { mcpTools: tools })).toThrow(/does not hold/);
    } finally {
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra" },
        { name: "bare", root: bare, source: "extra" },
        { name: "norules", root: norules, source: "extra" },
      ]);
      __resetWikiCacheForTest();
    }
  });
  /** A Copilot turn on a bot whose `.mcp.json` declares research, its page's wiki pinned to it: the surface it ran on, its prompt, and the bot names the research gate was asked about. */
  async function researchTurn(excludedTools: string[] | undefined, serves: boolean) {
    const botDir = path.join(dir, "bots", "ivar-gate");
    await Bun.write(path.join(botDir, ".mcp.json"), JSON.stringify({ mcpServers: {
      knowledge: { type: "http", url: "http://127.0.0.1:1/k" },
      yggdrasil: { type: "http", url: "http://127.0.0.1:1/y" },
      research: { type: "http", url: "http://127.0.0.1:1/mcp/ivar" },
    } }));
    const b: BotConfig = { ...bot("copilot-sdk"), dir: botDir, ...(excludedTools ? { excludedTools } : {}) };
    const asked: string[] = [];
    __setWikiRegistryForTest([
      { name: "agent", root: agent, source: "extra", synthesisBot: "ivar" },
      { name: "bare", root: bare, source: "extra" },
    ]);
    try {
      const s = setup({ connector: "copilot-sdk", deps: { bots: () => [b], researchWikiTools: (name: string) => (asked.push(name), serves) } });
      await (await post(s.app, { wiki: "agent", relPath: "notes/harbour.md", question: "Where else?" })).text();
      const surface = s.calls.opts[0]!.toolSurface as { mcpTools: Record<string, string[]> };
      expect(s.calls.blocked[0]!.surface).toEqual(surface);
      return { bot: b, surface, prompt: s.calls.prompts[0]!, asked };
    } finally {
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra" },
        { name: "bare", root: bare, source: "extra" },
        { name: "norules", root: norules, source: "extra" },
      ]);
      __resetWikiCacheForTest();
    }
  }
  test.each([[["mcp__research"]], [["research-*"]], [["mcp:research-wiki_history"]], [["mcp__research__wiki_grep"]]])(
    "Copilot on a bot whose config.json excludes the research server or one wiki tool (%p): no research entry, and the real session builder takes the surface",
    async (excludedTools) => {
      const t = await researchTurn(excludedTools, true);
      // Before the fix the builder threw here ("which ivar's config.json excludes"): every turn refused.
      expect(() => copilotNamedToolsSession(t.bot, t.surface)).not.toThrow();
      expect(t.surface).toEqual({ mcpTools: COPILOT_DISCUSS_TOOLS });
      expect(t.prompt).not.toContain("research-wiki");
    },
  );
  test("Copilot on a bot whose .mcp.json declares research while this process's research server does not serve its wiki tools: no research entry", async () => {
    const off = await researchTurn(undefined, false);
    expect(off.surface).toEqual({ mcpTools: COPILOT_DISCUSS_TOOLS });
    expect(off.asked).toEqual(["ivar"]);
    expect(() => copilotNamedToolsSession(off.bot, off.surface)).not.toThrow();
    expect(off.prompt).not.toContain("research-wiki");
    // Serving, and nothing excluded: the three tools.
    const on = await researchTurn(undefined, true);
    expect(on.surface).toEqual({ mcpTools: { ...COPILOT_DISCUSS_TOOLS, research: ["wiki_grep", "wiki_read", "wiki_history"] } });
    expect(copilotNamedToolsSession(on.bot, on.surface).availableTools).toContain("mcp:research-wiki_history");
  });
  test("the card is built once per discussion and cached by the page hash", async () => {
    const store = new MemStore();
    const { app, calls } = setup({ store });
    const first = await frames(await post(app, PASSAGE));
    const discussionId = first[0]!.data.discussionId as string;
    expect(calls.planCards).toBe(1);
    // Its paths point into the snapshot.
    expect(calls.prompts[0]).toContain(`path: ${path.join(dir, "snaps", "wiki-agent")}/plans/ferry.mdx`);
    await (await post(app, { ...PASSAGE, discussionId, question: "And the night route?" })).text();
    expect(calls.planCards).toBe(1);
    expect(calls.prompts[1]).toContain("# Ferry card");
    // The earlier turn is in the second prompt.
    expect(calls.prompts[1]).toContain("Question about «The summer route adds a stop at Example Island.»: Which stop does the summer route add?");
    expect(store.rows.map((r) => r.seq)).toEqual([1, 2]);
    // A changed page is another hash: the card is built again.
    await Bun.write(path.join(agent, "plans", "ferry.mdx"), PLAN + "\nA new line.\n");
    __resetWikiCacheForTest();
    try {
      await (await post(app, { ...PASSAGE, discussionId, question: "Again?" })).text();
      expect(calls.planCards).toBe(2);
    } finally {
      await Bun.write(path.join(agent, "plans", "ferry.mdx"), PLAN);
      __resetWikiCacheForTest();
    }
  });
  test("a discussion is refused when unknown, about another page, or still running", async () => {
    const store = new MemStore();
    const { app } = setup({ store });
    expect((await post(app, { ...PASSAGE, discussionId: crypto.randomUUID() })).status).toBe(404);
    const first = await frames(await post(app, PASSAGE));
    const discussionId = first[0]!.data.discussionId as string;
    const other = await post(app, { wiki: "agent", relPath: "notes/harbour.md", question: "q", discussionId });
    expect(other.status).toBe(409);
    // Running and beating, though it started longer ago than any turn timeout.
    store.rows[0]!.endState = "running";
    store.rows[0]!.createdAt = Date.now() - 8 * 60 * 1000;
    const busy = await post(app, { ...PASSAGE, discussionId });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { reason: string }).reason).toBe("busy");
  });
  test("a turn insert that loses a race is a 409", async () => {
    const store = new MemStore();
    store.start = async (i) => {
      throw new DiscussTurnConflict(i.discussionId);
    };
    const { app } = setup({ store });
    expect((await post(app, PASSAGE)).status).toBe(409);
  });
  test("requests that arrive together cannot pass the per-process cap", async () => {
    const store = new MemStore();
    const realStart = store.start;
    store.start = async (i) => {
      await Bun.sleep(20);
      return realStart(i);
    };
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app } = setup({
      store,
      oneShot: async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return { result: "An answer.", costUsd: 0, toolCalls: [] } as never;
      },
    });
    const n = DISCUSS_MAX_INFLIGHT + 2;
    const responses = await Promise.all(Array.from({ length: n }, (_, i) => post(app, { wiki: "agent", relPath: "notes/harbour.md", question: `Q${i}` })));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(statuses.filter((s) => s === 200)).toHaveLength(DISCUSS_MAX_INFLIGHT);
    for (let i = 0; i < 100 && active < DISCUSS_MAX_INFLIGHT; i++) await Bun.sleep(10);
    expect(peak).toBe(DISCUSS_MAX_INFLIGHT);
    release();
    await Promise.all(responses.map((r) => r.text()));
    // The finished turns gave their slots back.
    expect((await post(app, { wiki: "agent", relPath: "notes/harbour.md", question: "After?" })).status).toBe(200);
  });
  test("a turn insert that throws gives its slot back", async () => {
    const store = new MemStore();
    const realStart = store.start;
    let failures = 0;
    store.start = async (i) => {
      failures++;
      // Every other failure is a lost race, the rest a database error.
      if (failures % 2) throw new DiscussTurnConflict(i.discussionId);
      throw new Error("connection reset");
    };
    const { app } = setup({ store });
    const statuses: number[] = [];
    for (let i = 0; i < DISCUSS_MAX_INFLIGHT + 1; i++) statuses.push((await post(app, PASSAGE)).status);
    expect(statuses).toEqual([409, 500, 409, 500, 409]);
    store.start = realStart;
    expect((await post(app, PASSAGE)).status).toBe(200);
  });
  test("a model call past the route's deadline is stored as timeout and reported in the stream, whatever the connector does", async () => {
    const { app, store } = setup({
      deps: { timeoutMs: 50 },
      oneShot: async () => {
        await Bun.sleep(400);
        return { result: "Too late.", costUsd: 0, toolCalls: [] } as never;
      },
    });
    const evs = await frames(await post(app, PASSAGE));
    const err = evs.find((e) => e.event === "app_error")!;
    expect(err.data.endState).toBe("timeout");
    expect(store.rows[0]!.endState).toBe("timeout");
    expect(store.rows[0]!.answer).toBe("");
    expect(evs.at(-1)!.event).toBe("end");
  });
  test("an error whose message says «timed out after» is an error, not a timeout: a snapshot's git call, a relayed tool timeout", async () => {
    const snap = setup({
      deps: {
        wikiSnapshot: async () => {
          throw new Error("snapshot: git ls-files timed out after 10000 ms");
        },
      },
    });
    const evs = await frames(await post(snap.app, PASSAGE));
    expect(evs.find((e) => e.event === "app_error")!.data.endState).toBe("error");
    expect(snap.store.rows[0]).toMatchObject({ endState: "error", error: "snapshot: git ls-files timed out after 10000 ms" });
    expect(snap.calls.opts).toHaveLength(0);
    const relayed = setup({
      oneShot: async () => {
        throw new Error("search_knowledge: search timed out after 30000ms");
      },
    });
    const evs2 = await frames(await post(relayed.app, PASSAGE));
    const err = evs2.find((e) => e.event === "app_error")!;
    expect(err.data.endState).toBe("error");
    expect(err.data.message).toContain("search timed out after 30000ms");
    expect(relayed.store.rows[0]!.endState).toBe("error");
  });
  test("a turn that fails after streaming stores the text and the tool calls its reader was shown", async () => {
    const { app, store } = setup({
      deps: { timeoutMs: 50 },
      oneShot: async (_p, _c, _b, o) => {
        o.onProgress?.({ type: "text_delta", text: "Half an " });
        o.onProgress?.({ type: "tool_start", id: "t1", name: "Grep", displayName: "Grep", input: '{"pattern":"ferry"}' });
        o.onProgress?.({ type: "tool_end", id: "t1", name: "Grep", displayName: "Grep" });
        o.onProgress?.({ type: "text_delta", text: "answer" });
        await Bun.sleep(300);
        // Past the deadline: the run the route left behind streams on, and none of it is stored.
        o.onProgress?.({ type: "text_delta", text: " and more" });
        throw new Error("Claude Agent SDK timed out after 300000ms");
      },
    });
    const evs = await frames(await post(app, PASSAGE));
    expect(evs.find((e) => e.event === "app_error")!.data.endState).toBe("timeout");
    expect(evs.filter((e) => e.event === "delta").map((e) => e.data.text)).toEqual(["Half an ", "answer"]);
    expect(store.rows[0]).toMatchObject({ endState: "timeout", answer: "Half an answer", toolCalls: [{ name: "Grep", input: '{"pattern":"ferry"}' }] });
  });
  test("events after the deadline reach neither the stream nor the row, however long the row's finish takes", async () => {
    const store = new MemStore();
    const realFinish = store.finish;
    store.finish = async (id, f) => {
      await Bun.sleep(150);
      return realFinish(id, f);
    };
    const { app } = setup({
      store,
      deps: { timeoutMs: 50 },
      oneShot: async (_p, _c, _b, o) => {
        o.onProgress?.({ type: "text_delta", text: "early " });
        await Bun.sleep(100);
        // Past the deadline, before the slow finish resolves.
        o.onProgress?.({ type: "text_delta", text: "LATE" });
        o.onProgress?.({ type: "tool_start", id: "t9", name: "Read", displayName: "Read", input: '{"file_path":"late"}' });
        await Bun.sleep(300);
        return { result: "Too late.", costUsd: 0, toolCalls: [] } as never;
      },
    });
    const evs = await frames(await post(app, PASSAGE));
    expect(evs.filter((e) => e.event === "delta").map((e) => e.data.text)).toEqual(["early "]);
    expect(evs.filter((e) => e.event === "tool")).toEqual([]);
    expect(evs.find((e) => e.event === "app_error")!.data.endState).toBe("timeout");
    expect(store.rows[0]).toMatchObject({ endState: "timeout", answer: "early ", toolCalls: [] });
  });
  test("a done turn stores the final answer and the result's tool calls, not the streamed text", async () => {
    const { app, store } = setup({
      oneShot: async (_p, _c, _b, o) => {
        o.onProgress?.({ type: "text_delta", text: "Let me look. " });
        o.onProgress?.({ type: "tool_start", id: "t1", name: "Grep", displayName: "Grep", input: "{}" });
        return { result: "Example Island.", costUsd: 0, toolCalls: [{ id: "t1", name: "Read", displayName: "Read", durationMs: 1, startOffsetMs: 0, input: "{}" }] } as never;
      },
    });
    await frames(await post(app, PASSAGE));
    expect(store.rows[0]).toMatchObject({ endState: "done", answer: "Example Island.", toolCalls: [{ name: "Read", input: "{}" }] });
  });
  test("a turn whose reader went away runs to its end and is stored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const store = new MemStore();
    const { app } = setup({
      store,
      oneShot: async () => {
        await gate;
        finished = true;
        return { result: "The answer, written after the reader left.", costUsd: 0, toolCalls: [] } as never;
      },
    });
    const ctrl = new AbortController();
    const res = await post(app, PASSAGE, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toContain("event: turn");
    ctrl.abort();
    await reader.cancel().catch(() => {});
    release();
    for (let i = 0; i < 100 && store.rows[0]?.endState === "running"; i++) await Bun.sleep(10);
    expect(finished).toBe(true);
    expect(store.rows[0]!.endState).toBe("done");
    expect(store.rows[0]!.answer).toBe("The answer, written after the reader left.");
    expect(store.rows[0]!.readerLeft).toBe(true);
  });
  test("a proposed edit in the answer is read with parseEditList and stored", async () => {
    const answer = [
      "The page says six; the code says seven.",
      "",
      "```json",
      '{"edits": [{"claimIndex": 1, "verdict": "❌", "old": "The harbour opens at six.", "new": "The harbour opens at seven.", "reason": "harbour.ts:3 opens at 07:00"}]}',
      "```",
    ].join("\n");
    const { app, store } = setup({ oneShot: async () => ({ result: answer, costUsd: 0, toolCalls: [] }) as never });
    const evs = await frames(await post(app, { wiki: "agent", relPath: "notes/harbour.md", question: "Is six right?" }));
    const edit = store.rows[0]!.proposedEdit as { edits: { old: string; new: string }[]; overLimit: boolean };
    expect(edit.edits).toEqual([expect.objectContaining({ old: "The harbour opens at six.", new: "The harbour opens at seven." })]);
    expect(edit.overLimit).toBe(false);
    expect(evs.find((e) => e.event === "done")!.data.proposedEdit).toEqual(edit);
  });
});

describe("one page text per turn: the snapshot's copy is the page the row describes", () => {
  test("a page edited between the preflight and the snapshot is refused, never answered from the other version", async () => {
    const page = path.join(agent, "notes", "harbour.md");
    const edited = NOTE.replace("six", "seven");
    const { app, store, calls } = setup({
      deps: {
        wikiSnapshot: async (d) => {
          // The owner saves the page while the turn starts: the copy is H2.
          await Bun.write(page, edited);
          const to = path.join(dir, "snaps", "wiki-edited");
          await copyTree(d, to);
          return { kind: "wiki", dir: to, key: "k", source: d } satisfies Snapshot;
        },
      },
    });
    try {
      const evs = await frames(await post(app, { wiki: "agent", relPath: "notes/harbour.md", question: "When does it open?" }));
      const row = store.rows[0]!;
      const copy = await readFile(path.join(dir, "snaps", "wiki-edited", "notes", "harbour.md"), "utf8");
      expect(copy).toBe(edited);
      // Either the row describes the copy, or the turn was refused; here it is refused.
      expect(row.pageHash).toBe(sha(NOTE));
      expect(row.pageHash).not.toBe(sha(copy));
      expect(row.endState).toBe("error");
      expect(row.error).toContain("the page changed on disk while the turn started");
      expect(calls.opts).toHaveLength(0);
      expect(evs.find((e) => e.event === "app_error")!.data.endState).toBe("error");
    } finally {
      await Bun.write(page, NOTE);
      __resetWikiCacheForTest();
    }
  });
  test("an unchanged page: the stored hash is the snapshot copy's, and the pack's section is its text", async () => {
    const { app, store, calls } = setup();
    await (await post(app, PASSAGE)).text();
    const copy = await readFile(path.join(dir, "snaps", "wiki-agent", "plans", "ferry.mdx"), "utf8");
    expect(store.rows[0]!.pageHash).toBe(sha(copy));
    expect(calls.prompts[0]).toContain("15: - The summer route adds a stop at Example Island.");
  });
  test("a page that starts with a UTF-8 BOM: the copy is read as the reader reads the page, and the turn ends done", async () => {
    const page = path.join(agent, "notes", "bom.md");
    await Bun.write(page, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(NOTE)]));
    __resetWikiCacheForTest();
    try {
      const { app, store, calls } = setup();
      const evs = await frames(await post(app, { wiki: "agent", relPath: "notes/bom.md", question: "When does it open?" }));
      const copy = await readFile(path.join(dir, "snaps", "wiki-agent", "notes", "bom.md"));
      expect(copy[0]).toBe(0xef);
      expect(store.rows[0]).toMatchObject({ endState: "done", error: null, pageHash: sha(NOTE) });
      expect(calls.opts).toHaveLength(1);
      expect(evs.find((e) => e.event === "done")).toBeDefined();
    } finally {
      await rm(page, { force: true });
      __resetWikiCacheForTest();
    }
  });
  test("a snapshot without the page fails the turn naming the cause, before any model call", async () => {
    const { app, store, calls } = setup({
      deps: {
        wikiSnapshot: async (d) => {
          const to = path.join(dir, "snaps", "wiki-empty");
          await mkdir(to, { recursive: true });
          return { kind: "wiki", dir: to, key: "k", source: d } satisfies Snapshot;
        },
      },
    });
    const evs = await frames(await post(app, PASSAGE));
    expect(store.rows[0]!.endState).toBe("error");
    expect(store.rows[0]!.error).toContain("the page is not in the wiki's snapshot");
    expect(calls.opts).toHaveLength(0);
    expect(evs.find((e) => e.event === "app_error")!.data.message).toContain("not in the wiki's snapshot");
  });
  test("with real git: a page git ignores is refused in the preflight, and a wiki that is no work tree too", async () => {
    const repo = path.join(dir, "gitwiki");
    await Bun.write(path.join(repo, WIKI_AGENT_RULES_FILE), RULES);
    await Bun.write(path.join(repo, ".gitignore"), "drafts/\n");
    await Bun.write(path.join(repo, "notes", "open.md"), NOTE);
    await Bun.write(path.join(repo, "drafts", "hidden.md"), NOTE);
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    expect(init.exitCode).toBe(0);
    __setWikiRegistryForTest([
      { name: "gitwiki", root: repo, source: "extra" },
      { name: "agent", root: agent, source: "extra" },
    ]);
    try {
      const { app, store, calls } = setup({ deps: { git: realGit } });
      const ignored = await post(app, { wiki: "gitwiki", relPath: "drafts/hidden.md", question: "q" });
      expect(ignored.status).toBe(422);
      const j = (await ignored.json()) as { reason: string; error: string };
      expect(j.reason).toBe("page-not-in-snapshot");
      expect(j.error).not.toContain(repo);
      // The listed page passes the same check.
      const open = await post(app, { wiki: "gitwiki", relPath: "notes/open.md", question: "q" });
      expect(open.status).toBe(200);
      await open.text();
      // The agent wiki is a plain folder: no snapshot can be built of it.
      const plain = await post(app, PASSAGE);
      expect(plain.status).toBe(503);
      expect(((await plain.json()) as { reason: string }).reason).toBe("no-snapshot");
      expect(store.rows.map((r) => r.relPath)).toEqual(["notes/open.md"]);
      expect(calls.wikiSnaps).toEqual([repo]);
    } finally {
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra" },
        { name: "bare", root: bare, source: "extra" },
        { name: "norules", root: norules, source: "extra" },
      ]);
      __resetWikiCacheForTest();
    }
  });
  test.skipIf(!caseInsensitiveDisk)("with real git: a page renamed in case only, without git mv, passes the preflight and is answered", async () => {
    const repo = path.join(dir, "casewiki");
    await Bun.write(path.join(repo, WIKI_AGENT_RULES_FILE), RULES);
    await Bun.write(path.join(repo, "notes", "Page.md"), NOTE);
    const run = (...args: string[]) => {
      const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
      expect(p.exitCode).toBe(0);
    };
    run("init", "-q");
    run("add", ".");
    run("commit", "-qm", "init");
    // A case-only rename the plain way: git still tracks notes/Page.md.
    await rename(path.join(repo, "notes", "Page.md"), path.join(repo, "notes", "page.md"));
    __setWikiRegistryForTest([{ name: "casewiki", root: repo, source: "extra" }]);
    __resetWikiCacheForTest();
    try {
      const { app, store } = setup({ deps: { git: realGit } });
      const res = await post(app, { wiki: "casewiki", relPath: "notes/page.md", question: "q" });
      expect(res.status).toBe(200);
      await res.text();
      expect(store.rows[0]).toMatchObject({ relPath: "notes/page.md", endState: "done" });
    } finally {
      __setWikiRegistryForTest([
        { name: "agent", root: agent, source: "extra" },
        { name: "bare", root: bare, source: "extra" },
        { name: "norules", root: norules, source: "extra" },
      ]);
      __resetWikiCacheForTest();
    }
  });
  test("Copilot has no snapshot: no git preflight, and the hash is the live read's", async () => {
    const { app, store, calls } = setup({ connector: "copilot-sdk", deps: { git: realGit } });
    await (await post(app, { wiki: "agent", relPath: "notes/harbour.md", question: "q" })).text();
    expect(store.rows[0]!.endState).toBe("done");
    expect(store.rows[0]!.pageHash).toBe(sha(NOTE));
    expect(calls.wikiSnaps).toHaveLength(0);
  });
});

const postContinue = (app: Hono, body: unknown) =>
  app.request(WIKI_DISCUSS_CONTINUE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("«Continue in Claude Code» (P3)", () => {
  test("a finished turn: the prompt carries the discussion up to it, and the turn alone is marked handed over", async () => {
    const { app, store } = setup();
    const first = await frames(await post(app, PASSAGE));
    const discussionId = first.find((f) => f.event === "turn")!.data.discussionId as string;
    await frames(await post(app, { ...PASSAGE, discussionId, question: "And the night route?" }));
    expect(store.rows.map((r) => r.seq)).toEqual([1, 2]);
    const res = await postContinue(app, { turnId: store.rows[0]!.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt: string; handedOverAt: number | null };
    expect(body.prompt).toContain(`Page: ${path.join(agent, "plans/ferry.mdx")}`);
    expect(body.prompt).toContain("Question: Which stop does the summer route add?");
    expect(body.prompt).toContain("The summer route stops at Example Island.");
    // Up to the turn handed over: the later turn stays out.
    expect(body.prompt).not.toContain("And the night route?");
    expect(body.handedOverAt).toBeNumber();
    expect(store.rows[0]!.handedOverAt).toBe(body.handedOverAt);
    expect(store.rows[1]!.handedOverAt).toBeNull();
  });
  // The stored lines were placed against the page as it was then (`page_hash`):
  // after an edit they would name another line of the file the prompt points at.
  test("a page edited after the turn: the prompt flags the change and leaves out the stored lines; an unchanged page keeps them", async () => {
    const rel = "plans/pier.mdx";
    const file = path.join(agent, rel);
    await Bun.write(file, PLAN);
    __resetWikiCacheForTest();
    try {
      const { app, store } = setup();
      await frames(await post(app, { ...PASSAGE, relPath: rel }));
      const id = store.rows[0]!.id;
      expect(store.rows[0]!.location).toMatchObject({ found: "exact", fromLine: 15, toLine: 15 });
      const unchanged = ((await (await postContinue(app, { turnId: id })).json()) as { prompt: string }).prompt;
      expect(unchanged).toContain("Turn 1 (passage, line 15):");
      expect(unchanged).not.toContain("changed since");
      // Two lines above the passage: line 15 is now the Design heading's blank.
      await Bun.write(file, PLAN.replace("## Brief\n", "## Brief\n\nA new first line.\n"));
      const changed = ((await (await postContinue(app, { turnId: id })).json()) as { prompt: string }).prompt;
      expect(changed).not.toContain("line 15");
      expect(changed).toContain("Turn 1 (passage, lines not given: the page has changed since this turn):");
      expect(changed).toContain("> The summer route adds a stop at Example Island.");
      // A page gone since the turn is a change too.
      await rm(file, { force: true });
      const gone = ((await (await postContinue(app, { turnId: id })).json()) as { prompt: string }).prompt;
      expect(gone).not.toContain("line 15");
      expect(gone).toContain("lines not given: the page has changed since this turn");
    } finally {
      await rm(file, { force: true });
      __resetWikiCacheForTest();
    }
  });
  // Each turn is checked against its own `page_hash`, not the handed-over turn's.
  test("two turns across an edit: each turn's lines are kept or left out by its own page version", async () => {
    const rel = "plans/quay.mdx";
    const file = path.join(agent, rel);
    await Bun.write(file, PLAN);
    __resetWikiCacheForTest();
    try {
      const { app, store } = setup();
      const first = await frames(await post(app, { ...PASSAGE, relPath: rel }));
      const discussionId = first.find((f) => f.event === "turn")!.data.discussionId as string;
      expect(store.rows[0]!.location).toMatchObject({ found: "exact", fromLine: 15, toLine: 15 });
      // Version B: two lines above the passage, so it now sits on line 17.
      await Bun.write(file, PLAN.replace("## Brief\n", "## Brief\n\nA new first line.\n"));
      __resetWikiCacheForTest();
      await frames(await post(app, { ...PASSAGE, relPath: rel, discussionId, question: "And the night route?" }));
      expect(store.rows.map((r) => r.seq)).toEqual([1, 2]);
      expect(store.rows[1]!.endState).toBe("done");
      expect(store.rows[1]!.location).toMatchObject({ found: "exact", fromLine: 17, toLine: 17 });
      const viaSecond = ((await (await postContinue(app, { turnId: store.rows[1]!.id })).json()) as { prompt: string }).prompt;
      expect(viaSecond).toContain("Turn 1 (passage, lines not given: the page has changed since this turn):");
      expect(viaSecond).toContain("Turn 2 (passage, line 17):");
      expect(viaSecond).not.toContain("line 15");
      const viaFirst = ((await (await postContinue(app, { turnId: store.rows[0]!.id })).json()) as { prompt: string }).prompt;
      expect(viaFirst).toContain("Turn 1 (passage, lines not given: the page has changed since this turn):");
      expect(viaFirst).not.toContain("Turn 2");
    } finally {
      await rm(file, { force: true });
      __resetWikiCacheForTest();
    }
  });
  test("refusals: not admin, a malformed or unknown turn, a running turn, a read-only wiki; none marks the row", async () => {
    const { app, store } = setup();
    await frames(await post(app, PASSAGE));
    const id = store.rows[0]!.id;
    const { app: userApp } = setup({ role: "user", store });
    expect((await postContinue(userApp, { turnId: id })).status).toBe(403);
    expect((await postContinue(app, { turnId: "nope" })).status).toBe(400);
    expect((await postContinue(app, { turnId: crypto.randomUUID() })).status).toBe(404);
    store.rows[0]!.endState = "running";
    expect((await postContinue(app, { turnId: id })).status).toBe(409);
    store.rows[0]!.endState = "done";
    __setReadonlyWikiRootsForTest([agent]);
    const ro = await postContinue(app, { turnId: id });
    expect(ro.status).toBe(403);
    expect(((await ro.json()) as { readonly: boolean }).readonly).toBe(true);
    expect(store.rows[0]!.handedOverAt).toBeNull();
  });
});

describe("copilotDiscussReach", () => {
  const wikis = [{ name: "melosys", root: "/w/a" }, { name: "melosys-kode-wiki", root: "/w/b" }];
  const withTools = { ...COPILOT_DISCUSS_TOOLS, research: ["wiki_grep", "wiki_read", "wiki_history"] };
  const on = { authOff: true, researchServes: true, excludedTools: undefined };
  test("research declared and served, auth off, a wiki, nothing excluded: the three tools, and the page's wiki by its registered name", () => {
    expect(copilotDiscussReach({ ...on, mcpServers: ["knowledge", "yggdrasil", "research"], botWikis: wikis, pageWiki: "Melosys-Kode-Wiki" })).toEqual({ tools: withTools, wikiToolsWiki: "melosys-kode-wiki" });
    expect(copilotDiscussReach({ ...on, mcpServers: ["research"], botWikis: wikis, pageWiki: "mimir" })).toEqual({ tools: withTools });
    expect(copilotDiscussReach({ ...on, mcpServers: ["research"], botWikis: wikis, pageWiki: "mimir", excludedTools: ["mcp__yggdrasil", "research_knowledge"] })).toEqual({ tools: withTools });
  });
  test("no research server, an authenticating instance, no wiki, a research server this process does not serve, or an excluded wiki tool: the surface as before", () => {
    expect(copilotDiscussReach({ ...on, mcpServers: ["knowledge", "yggdrasil"], botWikis: wikis, pageWiki: "melosys" })).toEqual({ tools: COPILOT_DISCUSS_TOOLS });
    expect(copilotDiscussReach({ ...on, mcpServers: ["research"], botWikis: wikis, pageWiki: "melosys", authOff: false })).toEqual({ tools: COPILOT_DISCUSS_TOOLS });
    expect(copilotDiscussReach({ ...on, mcpServers: ["research"], botWikis: [], pageWiki: "melosys" })).toEqual({ tools: COPILOT_DISCUSS_TOOLS });
    expect(copilotDiscussReach({ ...on, mcpServers: ["research"], botWikis: wikis, pageWiki: "melosys", researchServes: false })).toEqual({ tools: COPILOT_DISCUSS_TOOLS });
    for (const excludedTools of [["mcp__research"], ["research-*"], ["mcp:*"], ["research-wiki_read"], ["mcp__research__wiki_*"]]) {
      expect({ excludedTools, r: copilotDiscussReach({ ...on, mcpServers: ["research"], botWikis: wikis, pageWiki: "melosys", excludedTools }) }).toEqual({ excludedTools, r: { tools: COPILOT_DISCUSS_TOOLS } });
    }
  });
});
