/**
 * The confirm loop's retry and rebuild bounds (fix round 2 batch 2 of PR 2a):
 * a key whose answer keeps failing backs off instead of being called every
 * run, failed keys go oldest failure first, and one hung wiki rebuild takes a
 * bounded share of the run and goes last next time, so every other wiki still
 * gets its calls. Temp wikis, a fake model and an in-memory store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotConfig } from "../bots/config.ts";
import { testTempDir } from "../test/temp-dir.ts";
import type { WikiRegistryEntry } from "./registry.ts";
import { CONFIRM_INTERVAL_MS, memoryStaleVerdictStore, runStaleConfirm, type ConfirmDeps, type StaleModel } from "./stale-confirm.ts";
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "./store.ts";

const BOT = { name: "fakebot", connector: "claude-cli" } as unknown as BotConfig;
const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

async function tempWiki(prefix: string, hub: string): Promise<string> {
  const root = await testTempDir(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, "plans/p.md"), page("P", "Body.", "plan_status: shipped\n"));
  await writeFile(path.join(root, "hub.md"), page("Hub", hub));
  return root;
}

const roots: string[] = [];
afterAll(async () => {
  __resetWikiCacheForTest();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const baseDeps = (registry: WikiRegistryEntry[], over: Partial<ConfirmDeps> = {}): ConfirmDeps => {
  const store = memoryStaleVerdictStore();
  return {
    registry: () => registry,
    bots: () => [BOT],
    index: (r) => getWikiIndex({ root: r, refresh: true }),
    store: () => store,
    model: () => async () => '{"verdict":"stale","reason":"shipped"}',
    now: Date.now,
    span: () => {},
    tracer: () => null,
    failures: new Map(),
    rebuildFailures: new Map(),
    ...over,
  };
};

describe("a key whose answer keeps failing backs off (fix round 2 batch 2)", () => {
  let entry: WikiRegistryEntry;
  beforeAll(async () => {
    const root = await tempWiki("stale-backoff-", "- [[p]] is in-flight (x)\n- [[p]] is in-flight (y)");
    roots.push(root);
    entry = { name: "bw", root, source: "extra" } as WikiRegistryEntry;
  });

  test("an always-unreadable answer is called on runs 1, 2, 4 and 8 of 10, five minutes apart", async () => {
    let t = Date.UTC(2026, 9, 28, 8);
    const asked: string[] = [];
    const spans: unknown[] = [];
    const model: StaleModel = async (prompt) => (asked.push(/\((x|y)\)/.exec(prompt)![1]!), "Sorry, the answer was cut at max_tokens");
    const deps = baseDeps([entry], { model: () => model, now: () => t, span: (a) => void spans.push(a) });
    const perRun: number[] = [];
    for (let run = 0; run < 10; run++) {
      const before = asked.filter((k) => k === "x").length;
      await runStaleConfirm(["bw"], deps);
      perRun.push(asked.filter((k) => k === "x").length - before);
      t += CONFIRM_INTERVAL_MS;
    }
    expect(perRun).toEqual([1, 1, 0, 1, 0, 0, 0, 1, 0, 0]);
    expect(asked.filter((k) => k === "y")).toHaveLength(4);
    // A run whose keys all wait makes no call and writes no trace.
    expect(spans).toHaveLength(4);
  });

  test("a key in its backoff is counted as waiting, not left, and a success clears it", async () => {
    let t = Date.UTC(2026, 9, 28, 8);
    let ok = false;
    const model: StaleModel = async () => (ok ? '{"verdict":"stale","reason":"shipped"}' : "not json");
    const deps = baseDeps([entry], { model: () => model, now: () => t });
    await runStaleConfirm(["bw"], deps);
    t += CONFIRM_INTERVAL_MS;
    await runStaleConfirm(["bw"], deps);
    t += CONFIRM_INTERVAL_MS;
    const waiting = await runStaleConfirm(["bw"], deps);
    expect(waiting.wikis[0]).toMatchObject({ calls: 0, left: 0, backoff: 2 });
    t += CONFIRM_INTERVAL_MS;
    ok = true;
    const r = await runStaleConfirm(["bw"], deps);
    expect(r.wikis[0]).toMatchObject({ calls: 2, errors: 0, backoff: 0 });
    expect(deps.failures!.size).toBe(0);
  });

  test("failed keys go oldest failure first", async () => {
    let t = Date.UTC(2026, 9, 28, 8);
    const asked: string[] = [];
    const model: StaleModel = async (prompt) => {
      asked.push(/\((x|y)\)/.exec(prompt)![1]!);
      throw new Error("backend down");
    };
    const deps = baseDeps([entry], { model: () => model, now: () => t, limits: { maxCalls: 1 } });
    for (let run = 0; run < 3; run++) {
      await runStaleConfirm(["bw"], deps);
      t += CONFIRM_INTERVAL_MS;
    }
    // Run 1 fails x; run 2 calls the never-failed y; run 3 calls x, which failed first.
    expect(asked).toEqual(["x", "y", "x"]);
  });
});

describe("one hung wiki rebuild starves no other wiki (fix round 2 batch 2)", () => {
  const entries: WikiRegistryEntry[] = [];
  beforeAll(async () => {
    for (const n of ["w1", "w2", "w3"]) {
      const root = await tempWiki(`stale-rebuild-${n}-`, `- [[p]] is in-flight (${n})`);
      roots.push(root);
      entries.push({ name: n, root, source: "extra" } as WikiRegistryEntry);
    }
  });
  const limits = { budgetMs: 2_000, startCutoffMs: 1_500, callMaxMs: 300, rebuildMaxMs: 200 };
  const hungAt = (root: string) => (r: string) => (r === root ? new Promise<WikiIndex | null>(() => {}) : getWikiIndex({ root: r, refresh: true }));

  test("1, 2 and 3 wikis with any one hung: every other wiki gets its call", async () => {
    const seen: string[] = [];
    for (const n of [1, 2, 3]) {
      for (let hung = 0; hung < n; hung++) {
        const reg = entries.slice(0, n);
        const deps = baseDeps(reg, { index: hungAt(reg[hung]!.root), limits });
        const t0 = Date.now();
        const r = await runStaleConfirm(reg.map((e) => e.name), deps);
        const rows = r.wikis.map((w) => [w.wiki, w.calls, w.errors]);
        seen.push(`${n}/${hung}: ${JSON.stringify(rows)} in ${Date.now() - t0 < limits.budgetMs + 300 ? "budget" : "overrun"}`);
      }
    }
    const want: string[] = [];
    for (const n of [1, 2, 3]) {
      for (let hung = 0; hung < n; hung++) {
        const rows = entries.slice(0, n).map((e, i) => [e.name, i === hung ? 0 : 1, i === hung ? 1 : 0]);
        want.push(`${n}/${hung}: ${JSON.stringify(rows)} in budget`);
      }
    }
    expect(seen).toEqual(want);
  }, 30_000);

  test("a wiki whose rebuild failed is rebuilt last next run", async () => {
    const order: string[][] = [];
    let run: string[] = [];
    let hang = true;
    const index = (r: string) => {
      const name = entries.find((e) => e.root === r)!.name;
      run.push(name);
      return name === "w1" && hang ? new Promise<WikiIndex | null>(() => {}) : getWikiIndex({ root: r, refresh: true });
    };
    const deps = baseDeps(entries, { index, limits });
    for (let i = 0; i < 3; i++) {
      run = [];
      if (i === 2) hang = false;
      await runStaleConfirm(["w1", "w2", "w3"], deps);
      order.push(run);
    }
    // Run 3's rebuild of w1 succeeds, so run 4 would put it back in registry order.
    expect(order).toEqual([
      ["w1", "w2", "w3"],
      ["w2", "w3", "w1"],
      ["w2", "w3", "w1"],
    ]);
    run = [];
    await runStaleConfirm(["w1", "w2", "w3"], deps);
    expect(run).toEqual(["w1", "w2", "w3"]);
  }, 30_000);
});
