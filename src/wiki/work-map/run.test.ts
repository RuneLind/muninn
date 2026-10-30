import { afterEach, describe, expect, test } from "bun:test";
import type { WikiIndex, WikiPageMeta } from "../store.ts";
import type { WarmInputDeps } from "./inputs.ts";
import {
  __resetWorkMapRunsForTest,
  abortWorkMapRuns,
  startWorkMapRun,
  workMapOrganizable,
  workMapRunInFlight,
  type ModelRequest,
  type WorkMapRunDeps,
} from "./run.ts";
import { parseWorkMap } from "./schema.ts";
import type { WorkMapAttempt, WorkMapState, WorkMapStateStore } from "./state.ts";
import type { WorkMapWriteOptions } from "./write.ts";
import { fileStateStore } from "./state.ts";
import { workMapDue } from "./loop.ts";
import { writeFileSync } from "node:fs";
import { testTempDirSync } from "../../test/temp-dir.ts";
import path from "node:path";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

afterEach(() => __resetWorkMapRunsForTest());

function memStore(): WorkMapStateStore & { attempts: WorkMapAttempt[] } {
  const attempts: WorkMapAttempt[] = [];
  return {
    attempts,
    async read(wiki): Promise<WorkMapState | null> {
      return attempts.length ? { wiki, attempts: [...attempts].reverse() } : null;
    },
    async record(wiki, a) {
      attempts.push(a);
      return { wiki, attempts };
    },
  };
}

const pages = [
  { relPath: "plans/a.mdx", title: "A", type: "plan", workedMs: NOW - DAY, aliases: [] },
  { relPath: "plans/b.mdx", title: "B", type: "plan", workedMs: NOW - 2 * DAY, aliases: [] },
] as unknown as WikiPageMeta[];

const fakeIndex = {
  pages,
  outgoing: new Map(),
  resolve: () => undefined,
  work: { asOfMs: NOW, sinceMs: NOW - 8 * DAY, threads: [] },
  workedCoverage: { matched: 2, total: 2, returned: 2, asOfMs: NOW },
  gitTouches: new Map(),
  gitMetadataFilter: { degraded: false },
} as unknown as WikiIndex;

const warm: WarmInputDeps = {
  urlConfigured: true,
  ledger: async () => ({ ok: true, memo: {} as never }),
  sessions: async () => ({ memo: { asOfMs: NOW } as never, timedOut: false }),
  rebuildIndex: async () => fakeIndex,
};

const goodAnswer = JSON.stringify({
  summary: "Work on ⟨p1⟩.",
  needsYou: [],
  themes: [],
  efforts: [{ id: "alpha", name: "Alpha", oneLine: "", state: "active", pages: [{ id: "p1", role: "plan" }, { id: "p2", role: "plan" }], why: "", confidence: 0.9, next: "", related: [] }],
  loose: [],
});

function deps(over: Partial<WorkMapRunDeps> = {}) {
  const models: ModelRequest[] = [];
  const writes: WorkMapWriteOptions[] = [];
  const state = memStore();
  const d: WorkMapRunDeps = {
    config: { workMapWikis: ["mimir"], workMapModel: "claude-opus-5-5", schedulerEnabled: true, profile: "default" },
    now: () => NOW,
    registry: () => [{ name: "mimir", root: "/wiki/mimir", source: "extra" } as never],
    isReadonly: () => false,
    isReadonlyRoot: () => false,
    inputs: warm,
    readText: async () => null,
    model: async (req) => {
      models.push(req);
      return { text: goodAnswer, costUsd: 0.5 };
    },
    write: async (opts) => {
      writes.push(opts);
      return { outcome: "written" };
    },
    state,
    ...over,
  };
  return { d, models, writes, state };
}

describe("workMapOrganizable", () => {
  test("every gate refuses with its reason", () => {
    const { d } = deps();
    expect(workMapOrganizable("mimir", d).ok).toBe(true);
    expect(workMapOrganizable("MIMIR", d).ok).toBe(true);
    const cases: [Partial<WorkMapRunDeps>, string][] = [
      [{ config: { ...d.config, profile: "nais" } }, "nais"],
      [{ config: { ...d.config, workMapWikis: [] } }, "WORK_MAP_WIKIS"],
      [{ config: { ...d.config, schedulerEnabled: false } }, "SCHEDULER_ENABLED"],
      [{ isReadonly: () => true }, "wiki-readonly"],
      [{ isReadonlyRoot: () => true }, "readonly root"],
      [{ registry: () => [] }, "not a registered wiki"],
    ];
    for (const [over, reason] of cases) {
      const r = workMapOrganizable("mimir", { ...d, ...over });
      expect(r.ok === false && r.reason).toContain(reason);
    }
  });
});

describe("startWorkMapRun", () => {
  test("a good answer is normalized and written; the model gets the system prompt and no effort", async () => {
    const { d, models, writes, state } = deps();
    const res = await startWorkMapRun("mimir", d).promise;
    expect(res.outcome).toBe("ok");
    expect(models).toHaveLength(1);
    expect(models[0]!.systemPrompt).toContain("Answer with ONE JSON object");
    expect(models[0]!.effort).toBeUndefined();
    expect(models[0]!.model).toBe("claude-opus-5-5");
    expect(writes).toHaveLength(1);
    const map = parseWorkMap(writes[0]!.content)!;
    expect(map.efforts[0]!.pages.map((p) => p.id)).toEqual(["plans/a.mdx", "plans/b.mdx"]);
    expect(map.summary).toBe("Work on ⟦plans/a.mdx⟧.");
    expect(map.coverage).toMatchObject({ activePages: 2, threads: 0, metadataFilter: { degraded: false }, warnings: [] });
    expect(map.usage?.costUsd).toBe(0.5);
    expect(state.attempts.map((a) => a.outcome)).toEqual(["ok"]);
  });

  test("daily sessions dedupe one session across an effort's pages by the evidence's session id", async () => {
    const t = NOW - 2 * DAY;
    const withWork = pages.map((p, i) => ({ ...p, work: { sinceMs: NOW - 8 * DAY, state: "F", events: [[t + i * 60_000, 2, "focus"]] } }));
    const rows = [
      ["claude-code:s1", "plans/a.mdx", "plans/a.mdx", "focus", 2, t - 1, t],
      ["claude-code:s1", "plans/b.mdx", "plans/a.mdx", "focus", 2, t - 1, t + 60_000],
    ];
    const index = { ...fakeIndex, pages: withWork, work: { ...fakeIndex.work, evidence: { contributions: { complete: true, reasons: [], cut: [], rows } } } } as unknown as WikiIndex;
    const { d, writes } = deps({ inputs: { ...warm, rebuildIndex: async () => index } });
    expect((await startWorkMapRun("mimir", d).promise).outcome).toBe("ok");
    expect(parseWorkMap(writes[0]!.content)!.efforts[0]!.daily).toEqual([{ day: "2026-10-18", commits: 0, sessions: 1 }]);
  });

  test("WORK_MAP_EFFORT reaches the model request when set", async () => {
    const { d, models } = deps();
    await startWorkMapRun("mimir", { ...d, config: { ...d.config, workMapEffort: "high" } }).promise;
    expect(models[0]!.effort).toBe("high");
  });

  test("a zod mismatch keeps the previous map: no write, a `failed` attempt", async () => {
    const { d, writes, state } = deps({ model: async () => ({ text: JSON.stringify({ summary: "s", efforts: "nope" }) }) });
    const res = await startWorkMapRun("mimir", d).promise;
    expect(res.outcome).toBe("failed");
    expect(res.outcome === "failed" && res.reason).toContain("did not match the schema");
    expect(writes).toHaveLength(0);
    expect(state.attempts.map((a) => a.outcome)).toEqual(["failed"]);
  });

  test("invalid JSON and a thrown model call are `failed`, not written", async () => {
    for (const model of [async () => ({ text: "Sorry, I cannot." }), async () => Promise.reject(new Error("Claude timed out after 300000ms"))]) {
      const { d, writes, state } = deps({ model });
      const res = await startWorkMapRun("mimir", d).promise;
      expect(res.outcome).toBe("failed");
      expect(writes).toHaveLength(0);
      expect(state.attempts[0]!.outcome).toBe("failed");
    }
  });

  test("cold inputs refuse before any model call", async () => {
    const { d, models, state } = deps({ inputs: { ...warm, urlConfigured: false } });
    const res = await startWorkMapRun("mimir", d).promise;
    expect(res).toEqual({ outcome: "refused", reason: "claude-usage not configured (CLAUDE_USAGE_URL is unset)" });
    expect(models).toHaveLength(0);
    expect(state.attempts[0]).toMatchObject({ outcome: "refused" });
  });

  test("a readonly root refuses before the inputs and the model (egress)", async () => {
    let asked = 0;
    const { d, models } = deps({ isReadonlyRoot: () => true, inputs: { ...warm, ledger: async () => (asked++, { ok: true, memo: {} as never }) } });
    const res = await startWorkMapRun("mimir", d).promise;
    expect(res.outcome).toBe("refused");
    expect(asked).toBe(0);
    expect(models).toHaveLength(0);
  });

  test("one run per wiki: a second start joins the first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { d } = deps({
      model: async () => {
        calls++;
        await gate;
        return { text: goodAnswer };
      },
    });
    const first = startWorkMapRun("mimir", d);
    const second = startWorkMapRun("Mimir", d);
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    expect(second.promise).toBe(first.promise);
    expect(workMapRunInFlight("mimir")).toEqual({ startedAt: NOW });
    await Bun.sleep(5);
    release();
    await first.promise;
    expect(calls).toBe(1);
    expect(workMapRunInFlight("mimir")).toBeNull();
  });

  test("the stop hook fired during the model call: nothing is written or recorded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d, writes, state } = deps({
      model: async () => {
        await gate;
        return { text: goodAnswer };
      },
    });
    const run = startWorkMapRun("mimir", d);
    await Bun.sleep(5);
    expect(abortWorkMapRuns()).toEqual([]);
    release();
    expect(await run.promise).toEqual({ outcome: "aborted" });
    expect(writes).toHaveLength(0);
    expect(state.attempts).toHaveLength(0);
  });

  test("a throw while the stop hook fires records no attempt, before or after the model call", async () => {
    const stopThenThrow = async (): Promise<never> => {
      abortWorkMapRuns();
      throw new Error("EIO");
    };
    const pre = deps({ inputs: { ...warm, rebuildIndex: stopThenThrow } });
    expect(await startWorkMapRun("mimir", pre.d).promise).toEqual({ outcome: "aborted" });
    expect(pre.models).toHaveLength(0);
    expect(pre.state.attempts).toHaveLength(0);
    __resetWorkMapRunsForTest();
    const post = deps({ write: stopThenThrow });
    expect(await startWorkMapRun("mimir", post.d).promise).toEqual({ outcome: "aborted" });
    expect(post.models).toHaveLength(1);
    expect(post.state.attempts).toHaveLength(0);
  });

  test("a sharp drop in active pages is a coverage warning, not a refusal", async () => {
    const prevMap = {
      version: 1,
      wiki: "mimir",
      runAtMs: NOW - DAY,
      model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 10, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
      summary: "",
      needsYou: [],
      themes: [],
      efforts: [],
      loose: [],
    };
    const { d, writes } = deps({ readText: async (p) => (p.endsWith(".work-map.json") ? JSON.stringify(prevMap) : null) });
    const res = await startWorkMapRun("mimir", d).promise;
    expect(res.outcome).toBe("ok");
    expect(parseWorkMap(writes[0]!.content)!.coverage.warnings).toEqual(["Active pages fell from 10 to 2 since the previous run."]);
  });

  test("a throw after the model call is recorded as `failed` and counts toward the day's gate", async () => {
    const { d, models, state } = deps({ write: async () => Promise.reject(new Error("ENOTDIR: not a directory, open '.wiki-write.lock'")) });
    const first = await startWorkMapRun("mimir", d).promise;
    expect(first.outcome).toBe("failed");
    expect(models).toHaveLength(1);
    expect(state.attempts).toEqual([{ at: NOW, outcome: "failed", error: expect.stringContaining("ENOTDIR") }]);
    await startWorkMapRun("mimir", d).promise;
    expect(workMapDue(await state.read("mimir"), NOW + 3_600_000, 5)).toEqual({ due: false, why: "failed twice after the model call today" });
  });

  test("a throw before the model call is recorded as `refused`", async () => {
    const { d, models, state } = deps({ inputs: { ...warm, rebuildIndex: async () => Promise.reject(new Error("EIO")) } });
    const res = await startWorkMapRun("mimir", d).promise;
    expect(res.outcome).toBe("refused");
    expect(models).toHaveLength(0);
    expect(state.attempts).toEqual([{ at: NOW, outcome: "refused", error: expect.stringContaining("EIO") }]);
  });

  test("an unwritable state dir: a success still gates the next hourly check", async () => {
    const blocker = path.join(testTempDirSync("work-map-state-"), "file");
    writeFileSync(blocker, "x");
    const store = fileStateStore(path.join(blocker, "sub"));
    const { d, models } = deps({ state: store });
    expect((await startWorkMapRun("mimir", d).promise).outcome).toBe("ok");
    expect(models).toHaveLength(1);
    const st = await store.read("mimir");
    expect(st?.lastSuccessAt).toBe(NOW);
    expect(workMapDue(st, NOW + 3_600_000, 5).due).toBe(false);
  });
});

describe("declared efforts through the run (P6)", () => {
  test("the run reads `effort:` off the index: a declared page leaves the model's effort, a dropped declared effort restores, an inactive one retires", async () => {
    const declaredPages = [
      { relPath: "plans/a.mdx", title: "A", type: "plan", workedMs: NOW - DAY, aliases: [] },
      { relPath: "plans/b.mdx", title: "B", type: "plan", workedMs: NOW - 2 * DAY, aliases: [], effort: "beta" },
      { relPath: "plans/old.mdx", title: "Old", type: "plan", workedMs: NOW - 90 * DAY, gitTouchedMs: NOW - 80 * DAY, aliases: [], effort: "gamma" },
      { relPath: "plans/typo.mdx", title: "Typo", type: "plan", workedMs: NOW - 90 * DAY, aliases: [], effort: "Not A Slug" },
    ] as unknown as WikiPageMeta[];
    const index = { ...fakeIndex, pages: declaredPages } as unknown as WikiIndex;
    const previous = {
      version: 1,
      wiki: "mimir",
      runAtMs: NOW - DAY,
      model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 2, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
      summary: "",
      needsYou: [],
      themes: [],
      efforts: ["beta", "gamma"].map((id) => ({ id, name: `${id} name`, aliases: [], oneLine: "", state: "active", pages: [], why: "", confidence: 1, next: "", related: [], daily: [] })),
      loose: [],
    };
    const { d, models } = deps({
      inputs: { ...warm, rebuildIndex: async () => index },
      readText: async (p) => (p.endsWith(".work-map.json") ? JSON.stringify(previous) : null),
    });
    const res = await startWorkMapRun("mimir", d).promise;
    expect(res.outcome).toBe("ok");
    const map = res.outcome === "ok" ? res.map : null;
    expect(map!.efforts.map((e) => [e.id, e.state, e.pages.map((p) => p.id)])).toEqual([
      ["alpha", "active", ["plans/a.mdx"]],
      ["beta", "quiet", ["plans/b.mdx"]],
    ]);
    expect(map!.retired).toEqual([{ id: "gamma", name: "gamma name", lastActive: NOW - 80 * DAY }]);
    expect(models[0]!.prompt).toContain("effort=beta (declared, fixed)");
    // The written JSON round-trips through the stored schema.
    expect(parseWorkMap(JSON.stringify(map))?.retired?.length).toBe(1);
  });
});
