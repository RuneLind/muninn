/**
 * The Stale check's confirm loop lifecycle and two call-input rules (fix
 * round 1, batch 6 of PR 2a): stop cuts a run in flight and leaves one timer
 * chain (A8); the start logs every wiki it cannot cover and stays off under
 * `MUNINN_PROFILE=nais` (A13); a target with uncommitted edits is reported as
 * uncommitted, and an unreadable changed page gets no verdict key (A14).
 * Temp wikis, a fake model and an in-memory store — no database, no model.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import type { BotConfig } from "../bots/config.ts";
import { testTempDir } from "../test/temp-dir.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "./readonly.ts";
import type { WikiRegistryEntry } from "./registry.ts";
import {
  memoryStaleVerdictStore,
  passageVerdictKey,
  passageVerdicts,
  runStaleCheck,
  runStaleConfirm,
  startStaleConfirmLoop,
  statusLineCallInput,
  stopStaleConfirmLoop,
  type ConfirmDeps,
  type FailureMark,
  type StaleModel,
} from "./stale-confirm.ts";
import { linkingBuckets } from "./stale.ts";
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "./store.ts";
import type { Tracer } from "../tracing/tracer.ts";

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const BOT = { name: "fakebot", connector: "claude-cli" } as unknown as BotConfig;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=f@example.com", "-c", "user.name=f", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

async function writeIn(root: string, rel: string, text: string) {
  await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

describe("the confirm loop's start and stop (A8, A13)", () => {
  let root = "";
  let entry: WikiRegistryEntry;
  const records: LogRecord[] = [];

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "stale-loop-"));
    await writeIn(root, "plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
    await writeIn(root, "hub.md", page("Hub", "- [[p]] is in-flight\n- [[p]] is a draft of the lock\n- [[p]] is proposed"));
    entry = { name: "cw", root, source: "extra" } as WikiRegistryEntry;
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
  });
  afterAll(async () => {
    await reset();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });
  afterEach(async () => {
    await stopStaleConfirmLoop(50);
    __setReadonlyWikiRootsForTest();
    __setWikiReadonlyForTest();
    records.length = 0;
  });

  const ON = { schedulerEnabled: true, wikiStaleConfirmWikis: ["cw"], profile: "default" as const };

  /** Deps whose model waits `ms` per call (never resolves when `ms` is null). */
  const slowDeps = (ms: number | null, over: Partial<ConfirmDeps> = {}) => {
    const started: number[] = [];
    const indexCalls: number[] = [];
    const store = memoryStaleVerdictStore();
    const model: StaleModel = (prompt) => {
      started.push(Date.now());
      return ms === null ? new Promise<string>(() => {}) : Bun.sleep(ms).then(() => '{"verdict":"stale","reason":"r"}');
    };
    const deps: ConfirmDeps = {
      registry: () => [entry],
      bots: () => [BOT],
      index: (r) => (indexCalls.push(Date.now()), getWikiIndex({ root: r, refresh: true })),
      store: () => store,
      model: () => model,
      now: Date.now,
      span: () => {},
      tracer: () => null,
      failures: new Map(),
      // A hung run still ends, so no test leaves a run in flight for the next.
      limits: { budgetMs: 600, startCutoffMs: 500, callMaxMs: 600 },
      ...over,
    };
    return { deps, started, indexCalls, store };
  };

  const waitFor = async (cond: () => boolean, ms = 3_000) => {
    for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms; ) await Bun.sleep(5);
    if (!cond()) throw new Error("condition never held");
  };

  test("A8: no call starts after stop, and stop returns without waiting out the run", async () => {
    const { deps, started, store } = slowDeps(300);
    expect(startStaleConfirmLoop(ON, { deps, firstDelayMs: 1, intervalMs: 60_000 })).toEqual(["cw"]);
    await waitFor(() => started.length === 1);
    const stopAt = Date.now();
    await stopStaleConfirmLoop(5_000);
    const stopMs = Date.now() - stopAt;
    await Bun.sleep(700);
    // Under the old stop the run went on: its second call started 300 ms later.
    expect(started).toHaveLength(1);
    expect(stopMs).toBeLessThan(250);
    // The answer that arrived after stop is not written.
    expect(store.rows.size).toBe(0);
  });

  test("A8: a hung call does not hold shutdown for the whole wait", async () => {
    const { deps, started } = slowDeps(null);
    startStaleConfirmLoop(ON, { deps, firstDelayMs: 1, intervalMs: 60_000 });
    await waitFor(() => started.length === 1);
    const t0 = Date.now();
    await stopStaleConfirmLoop(2_000);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  test("A8: stop then start leaves one timer chain, and a final stop leaves none", async () => {
    const { deps, started, indexCalls } = slowDeps(null);
    startStaleConfirmLoop(ON, { deps, firstDelayMs: 1, intervalMs: 30 });
    await waitFor(() => started.length === 1);
    // Start again before the stopped run has settled: its end must not schedule a tick.
    const stopping = stopStaleConfirmLoop(1);
    expect(startStaleConfirmLoop(ON, { deps, firstDelayMs: 60_000, intervalMs: 30 })).toEqual(["cw"]);
    await stopping;
    // A second start while running is a no-op.
    expect(startStaleConfirmLoop(ON, { deps, firstDelayMs: 1, intervalMs: 30 })).toEqual([]);
    // Past the old run's 600 ms bound, so a chain it left would have ticked.
    await Bun.sleep(1_000);
    // The old chain scheduled nothing: the only rebuild is the first run's.
    expect(indexCalls).toHaveLength(1);
    await stopStaleConfirmLoop(50);
    await Bun.sleep(200);
    expect(indexCalls).toHaveLength(1);
  });

  const warnings = () => records.filter((r) => r.level === "warning").map((r) => r.message.map(String).join(""));

  test("A13: an unknown wiki name, a wiki with no routing bot and a readonly root each log once at start", async () => {
    const other = { name: "nobot", root: path.join(root, "nobot"), source: "bot", botName: "ghost", synthesisBot: "ghost" } as unknown as WikiRegistryEntry;
    const ro = { name: "ro", root: path.join(root, "ro"), source: "extra" } as WikiRegistryEntry;
    __setReadonlyWikiRootsForTest([ro.root]);
    const { deps } = slowDeps(10, { registry: () => [entry, other, ro], bots: () => [] });
    const covered = startStaleConfirmLoop({ ...ON, wikiStaleConfirmWikis: ["cw", "kode-wiki-typo", "nobot", "ro"] }, { deps, firstDelayMs: 60_000 });
    const w = warnings();
    expect(w.filter((m) => m.includes("kode-wiki-typo"))).toHaveLength(1);
    expect(w.filter((m) => m.includes("nobot") && m.includes("routing bot"))).toHaveLength(1);
    expect(w.filter((m) => m.includes("ro") && m.includes("readonly"))).toHaveLength(1);
    // With no bot at all, cw has no routing bot either; nothing is covered.
    expect(w.filter((m) => m.includes("cw") && m.includes("routing bot"))).toHaveLength(1);
    expect(covered).toEqual([]);
  });

  test("A13: the covered list drops the wikis it warned about", async () => {
    const ro = { name: "ro", root: path.join(root, "ro"), source: "extra" } as WikiRegistryEntry;
    __setReadonlyWikiRootsForTest([ro.root]);
    const { deps } = slowDeps(10, { registry: () => [entry, ro] });
    expect(startStaleConfirmLoop({ ...ON, wikiStaleConfirmWikis: ["cw", "ro", "typo"] }, { deps, firstDelayMs: 60_000 })).toEqual(["cw"]);
    expect(warnings()).toHaveLength(2);
  });

  test("A13: the loop does not start under MUNINN_PROFILE=nais, and says so", async () => {
    const { deps, indexCalls } = slowDeps(10);
    expect(startStaleConfirmLoop({ ...ON, profile: "nais" }, { deps, firstDelayMs: 1 })).toEqual([]);
    await Bun.sleep(100);
    expect(indexCalls).toHaveLength(0);
    expect(warnings().some((m) => m.includes("nais"))).toBe(true);
  });

  // ── Every exit path of a run (fix round 2) ──
  /** A tracer that records its finishes, and a span that finishes the tracer it gets. */
  const traced = () => {
    const finishes: string[] = [];
    const tracer = { finish: (status: string) => void finishes.push(status) } as unknown as Tracer;
    const spans: { attrs: Record<string, unknown>; tracer: Tracer | null }[] = [];
    const span = (attrs: Record<string, unknown>, t: Tracer | null) => {
      spans.push({ attrs, tracer: t });
      t?.finish(attrs.errors ? "error" : "ok", attrs);
    };
    return { finishes, tracer, spans, span };
  };

  test("a run whose only call was cut by stop still finishes the trace it opened", async () => {
    const t = traced();
    const { deps, started } = slowDeps(null, { tracer: () => t.tracer, span: t.span });
    const ac = new AbortController();
    const run = runStaleConfirm(["cw"], deps, ac.signal);
    await waitFor(() => started.length === 1);
    ac.abort();
    const out = await run;
    expect(out.calls).toBe(0);
    expect(out.left).toBe(3);
    // Under the old run the span never ran: calls and errors were both 0.
    expect(t.spans).toHaveLength(1);
    expect(t.spans[0]!.tracer).toBe(t.tracer);
    expect(t.spans[0]!.attrs).toMatchObject({ calls: 0, errors: 0, stopped: 1 });
    expect(t.finishes).toEqual(["ok"]);
  });

  test("a verdict write that stop catches in flight lands, counts as written and clears its failure", async () => {
    const t = traced();
    const failures = new Map<string, FailureMark>();
    // A first run whose calls all fail, so every hit has a failure on record.
    const failing = slowDeps(0, { failures, model: () => async () => Promise.reject(new Error("backend down")) });
    expect((await runStaleConfirm(["cw"], failing.deps)).errors).toBe(3);
    expect(failures.size).toBe(3);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => (releaseWrite = r));
    const inner = memoryStaleVerdictStore();
    let writes = 0;
    const store = {
      get: inner.get,
      upsert: async (v: Parameters<typeof inner.upsert>[0]) => {
        writes++;
        await writeGate;
        return inner.upsert(v);
      },
    };
    const { deps } = slowDeps(0, { failures, store: () => store, tracer: () => t.tracer, span: t.span });
    const ac = new AbortController();
    const run = runStaleConfirm(["cw"], deps, ac.signal);
    await waitFor(() => writes === 1);
    ac.abort();
    await Bun.sleep(50);
    releaseWrite();
    const out = await run;
    expect(inner.rows.size).toBe(1);
    // Under the old run this write landed yet was reported as left, its failure kept.
    expect(out.calls).toBe(1);
    expect(out.wikis[0]).toMatchObject({ calls: 1, stale: 1, left: 2 });
    expect(failures.size).toBe(2);
    expect(t.finishes).toEqual(["ok"]);
  });

  test("after stop, no remaining hit builds its call input (no git log spawn per hit)", async () => {
    let lookupsAfterAbort = 0;
    const ac = new AbortController();
    const counting = (index: WikiIndex): WikiIndex =>
      new Proxy(index, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (prop !== "resolveRelPath" || typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (ac.signal.aborted) lookupsAfterAbort++;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { deps, started } = slowDeps(null, { index: async (r) => counting((await getWikiIndex({ root: r, refresh: true }))!) });
    const run = runStaleConfirm(["cw"], deps, ac.signal);
    await waitFor(() => started.length === 1);
    ac.abort();
    const out = await run;
    expect(out.left).toBe(3);
    // `statusLineCallInput` resolves the hit's target first, then spawns git log.
    expect(lookupsAfterAbort).toBe(0);
  });

  test("shutdown waits for a verdict write the run's bound abandoned", async () => {
    let landed = 0;
    const inner = memoryStaleVerdictStore();
    const store = {
      get: inner.get,
      upsert: async (v: Parameters<typeof inner.upsert>[0]) => {
        await Bun.sleep(700);
        landed++;
        return inner.upsert(v);
      },
    };
    let runs = 0;
    const { deps } = slowDeps(0, {
      store: () => store,
      limits: { budgetMs: 200, startCutoffMs: 200, callMaxMs: 200 },
      span: () => void runs++,
    });
    startStaleConfirmLoop(ON, { deps, firstDelayMs: 1, intervalMs: 60_000 });
    // The run gives up on the write at its 200 ms bound and ends.
    await waitFor(() => runs === 1);
    expect(landed).toBe(0);
    await stopStaleConfirmLoop(5_000);
    expect(landed).toBe(1);
  });
});

describe("the call inputs on a git wiki (A14)", () => {
  let root = "";
  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "stale-a14-"));
    await git(root, "init", "-q", "-b", "main");
    await writeIn(root, "plans/p.md", page("P", "Body.", "plan_status: in-flight\n"));
    await writeIn(root, "hub.md", page("Hub", "- [[p]] is in-flight"));
    await writeIn(root, "notes/old.md", page("Old", "The pin in [[hub]] landed on 23.05."));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-05-01T10:00:00Z", "-m", "seed");
    await writeIn(root, "hub.md", page("Hub", "- [[p]] is in-flight\n\nMore."));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-06-10T10:00:00Z", "-m", "hub: the pin moves");
    await writeIn(root, "plans/p.md", page("P", "Body: the last PR merged.", "plan_status: shipped\n"));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-06-18T10:00:00Z", "-m", "p: ship it");
  }, 30_000);
  afterAll(async () => {
    await chmod(path.join(root, "hub.md"), 0o644).catch(() => {});
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("A14: a target with uncommitted edits AND newer commits is reported as uncommitted", async () => {
    await writeIn(root, "plans/p.md", page("P", "Body, edited.", "plan_status: shipped\nstatus_note: edited, not committed\n"));
    try {
      __resetWikiCacheForTest();
      const index = (await getWikiIndex({ root, refresh: true }))!;
      const p = index.resolveRelPath("plans/p.md")!;
      const hub = index.resolveRelPath("hub.md")!;
      expect(p.gitDirty).toBe(true);
      // The target has a commit newer than the hub's last change, too.
      const hit = (index.statusLineHits?.get("hub.md") ?? [])[0]!;
      expect(hit).toBeDefined();
      expect(p.gitTouchedMs!).toBeGreaterThan(hub.gitTouchedMs!);
      const input = await statusLineCallInput(index, hub, hit);
      expect(input.commits).toBeNull();
    } finally {
      await git(root, "checkout", "-q", "--", "plans/p.md");
    }
  });

  test("A14: an unreadable changed page gets no verdict key: Check refuses, the GET shows none", async () => {
    __resetWikiCacheForTest();
    const index = (await getWikiIndex({ root, refresh: true }))!;
    const asOfMs = Date.parse("2026-06-20T00:00:00Z");
    const buckets = (await linkingBuckets(index, "hub.md", { asOfMs }))!;
    const toCheck = buckets.linking.filter((l) => l.bucket === "toCheck");
    expect(toCheck.map((l) => l.relPath)).toEqual(["notes/old.md"]);
    const store = memoryStaleVerdictStore();
    // A row under the old shared sentinel must not surface as this page's verdict.
    await store.upsert({ wiki: "w", kind: "passage", page: "notes/old.md", keyHash: await passageVerdictKey(index, "hub.md", "unreadable", toCheck[0]!, asOfMs), verdict: "stale", reason: "another page's", edit: null, checkedBy: "model:x" });
    let calls = 0;
    const model: StaleModel = async () => (calls++, '{"verdict":"true","reason":"ok"}');
    await chmod(path.join(root, "hub.md"), 0o000);
    try {
      expect((await passageVerdicts("w", index, "hub.md", buckets.linking, { asOfMs, store })).size).toBe(0);
      const events: unknown[] = [];
      const run = runStaleCheck({ wiki: "w", index, relPath: "hub.md", asOfMs, bot: BOT, store, model, onEvent: (e) => void events.push(e) });
      await expect(run).rejects.toThrow(/cannot be read/);
      expect(calls).toBe(0);
      expect(events).toEqual([]);
      expect(store.rows.size).toBe(1);
    } finally {
      await chmod(path.join(root, "hub.md"), 0o644);
    }
  });
});
