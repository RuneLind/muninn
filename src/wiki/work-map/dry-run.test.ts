import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { testTempDir } from "../../test/temp-dir.ts";
import type { WikiIndex } from "../store.ts";
import { readWikiReaderConfig } from "../store.ts";
import { dryRunDeps, parseSavedAnswer } from "./dry-run.ts";
import { readMapFile } from "./map-file.ts";
import { __resetWorkMapRunsForTest, startWorkMapRun, type ModelRequest } from "./run.ts";
import { THEME_MAP_VERSION, type ThemeMap } from "./theme-schema.ts";

const NOW = Date.parse("2026-10-31T10:00:00Z");
let dirs: string[] = [];
beforeEach(() => __resetWorkMapRunsForTest());
afterEach(async () => {
  __resetWorkMapRunsForTest();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

function index(): WikiIndex {
  const pages = [
    { relPath: "sources/a.md", name: "a", title: "a", type: "source", domain: "ai", tags: [], created: "2026-10-30", aliases: [] },
    { relPath: "concepts/H.md", name: "H", title: "H", type: "concept", domain: "ai", tags: [], updated: "2026-01-01", aliases: [] },
  ];
  return { pages, outgoing: new Map([["sources/a.md", ["concepts/h.md"]]]), resolve: () => undefined, gitTouches: new Map() } as unknown as WikiIndex;
}

async function setup() {
  const root = await testTempDir("muninn-wm-dry-root-");
  const out = await testTempDir("muninn-wm-dry-out-");
  dirs.push(root, out);
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ workMap: { kind: "themes" } }));
  // A map at the wiki root the dry run must never read.
  await writeFile(path.join(root, ".work-map.json"), "{ not the previous map");
  const models: ModelRequest[] = [];
  const base = {
    entry: { name: "kb", root, source: "extra" as const },
    model: "m",
    profile: "default" as const,
    out: path.join(out, "map.json"),
    now: () => NOW,
    inputs: { urlConfigured: false, ledger: async () => ({ ok: false as const, reason: "x" }), sessions: async () => ({ memo: null, timedOut: true }), rebuildIndex: async () => index() },
    callModel: async (req: ModelRequest) => {
      models.push(req);
      return { text: JSON.stringify({ summary: "s", themes: [{ id: "t", name: "T", sources: ["p1"] }] }), costUsd: 0.1 };
    },
  };
  return { root, out, base, models };
}

describe("dryRunDeps", () => {
  test("writes only to --out, reads the previous map from --previous, needs no WORK_MAP_WIKIS entry, and saves a replayable answer", async () => {
    const { root, out, base, models } = await setup();
    const previous: ThemeMap = {
      version: THEME_MAP_VERSION,
      kind: "themes",
      wiki: "kb",
      runAtMs: NOW - 86_400_000,
      model: "m",
      coverage: { activeSources: 1, hubs: 0, driftHubs: 0, placed: 1, digestChars: 0, windowDays: 28, warnings: [] },
      summary: "",
      needsYou: [],
      themes: [],
      efforts: [],
      retired: [{ id: "old", name: "Old", lastActive: NOW - 5 * 86_400_000, weekly: [] }],
      loose: [],
    };
    await writeFile(path.join(out, "prev.json"), JSON.stringify(previous));
    const saved = path.join(out, "answer.json");
    const deps = dryRunDeps({ ...base, previous: path.join(out, "prev.json"), saveAnswer: saved });
    expect(deps.commit).toBeNull();
    const res = await startWorkMapRun("kb", deps).promise;
    expect(res.outcome).toBe("ok");
    expect(models[0]!.prompt).toContain("old: Old");
    const map = readMapFile(await readFile(base.out, "utf8"))!.map as ThemeMap;
    expect(map.efforts.map((e) => e.id)).toEqual(["t"]);
    expect(map.retired.map((r) => r.id)).toEqual(["old"]);
    expect(await readFile(path.join(root, ".work-map.json"), "utf8")).toBe("{ not the previous map");
    expect((await deps.state.read("kb"))?.attempts.map((a) => a.outcome)).toEqual(["ok"]);

    // Replay: no model call, the saved clock, the same map.
    const answer = parseSavedAnswer(await readFile(saved, "utf8"));
    expect(answer.nowMs).toBe(NOW);
    const replayOut = path.join(out, "replay.json");
    const replay = dryRunDeps({ ...base, now: () => 0, out: replayOut, previous: path.join(out, "prev.json"), answer });
    expect((await startWorkMapRun("kb", replay).promise).outcome).toBe("ok");
    expect(models).toHaveLength(1);
    const replayed = JSON.parse(await readFile(replayOut, "utf8"));
    expect({ ...replayed, usage: undefined }).toEqual({ ...JSON.parse(await readFile(base.out, "utf8")), usage: undefined });

    // A digest that moved refuses the replay.
    __resetWorkMapRunsForTest();
    const moved = dryRunDeps({ ...base, out: path.join(out, "moved.json"), answer });
    const r = await startWorkMapRun("kb", moved).promise;
    expect(r.outcome).toBe("failed");
    expect(r.outcome === "failed" && r.reason).toContain("differs from the saved prompt");
  });

  test("refuses an --out or --save-answer inside the wiki root", async () => {
    const { root, base } = await setup();
    expect(() => dryRunDeps({ ...base, out: path.join(root, "x.json") })).toThrow("inside the wiki root");
    expect(() => dryRunDeps({ ...base, saveAnswer: path.join(root, "sub", "a.json") })).toThrow("inside the wiki root");
  });

  test("parseSavedAnswer refuses another shape", () => {
    expect(() => parseSavedAnswer('{"text":"x"}')).toThrow("not a --save-answer file");
  });
});

describe(".wiki-reader.json workMap key", () => {
  test("parsed onto the reader config; absent ⇒ work; a bad kind ⇒ work", async () => {
    const root = await testTempDir("muninn-wm-kind-");
    dirs.push(root);
    const file = path.join(root, ".wiki-reader.json");
    await writeFile(file, JSON.stringify({ workMap: { kind: "themes" } }));
    expect((await readWikiReaderConfig(root))?.workMap).toEqual({ kind: "themes" });
    await writeFile(file, JSON.stringify({}));
    expect((await readWikiReaderConfig(root))?.workMap).toEqual({ kind: "work" });
    await writeFile(file, JSON.stringify({ workMap: { kind: 7 } }));
    expect((await readWikiReaderConfig(root))?.workMap).toEqual({ kind: "work" });
  });
});
