import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { testTempDir, testTempDirSync } from "../../test/temp-dir.ts";
import type { WikiIndex } from "../store.ts";
import { readWikiReaderConfig } from "../store.ts";
import { dryRunDeps, parseSavedAnswer } from "./dry-run.ts";
import { readMapFile } from "./map-file.ts";
import { __resetWorkMapRunsForTest, startWorkMapRun, type ModelRequest } from "./run.ts";
import { WORK_MAP_VERSION } from "./schema.ts";
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

  test("the inside-the-root check is separator-aware and follows symlinks", async () => {
    const { root, out, base } = await setup();
    // A file named `..map.json` in the root is inside it.
    expect(() => dryRunDeps({ ...base, out: path.join(root, "..map.json") })).toThrow("inside the wiki root");
    expect(() => dryRunDeps({ ...base, out: path.join(path.dirname(root), "..x", "map.json") })).not.toThrow();
    // A symlink outside the root that points into it: inside, for an existing file and a path not made yet.
    await mkdir(path.join(root, "deep"), { recursive: true });
    const link = path.join(out, "link");
    await symlink(path.resolve(root, "deep"), link);
    await writeFile(path.join(root, "deep", "f.json"), "{}");
    expect(() => dryRunDeps({ ...base, saveAnswer: path.join(link, "f.json") })).toThrow("inside the wiki root");
    expect(() => dryRunDeps({ ...base, out: path.join(link, "map.json") })).toThrow("inside the wiki root");
    expect(() => dryRunDeps({ ...base, out: path.join(link, "new", "dir", "map.json") })).toThrow("inside the wiki root");
  });

  test("a symlink that dangles into the root is inside it: the final component, a chain, a middle component, a relative target", async () => {
    const { root: rootRel, out: outRel, base } = await setup();
    // Absolute: a relative link target is read from the link's own folder.
    const root = path.resolve(rootRel);
    const out = path.resolve(outRel);
    const planted = path.join(root, "planted.json");
    // The final component dangles into the root.
    await symlink(planted, path.join(out, "dangle.json"));
    expect(() => dryRunDeps({ ...base, out: path.join(out, "dangle.json") })).toThrow("inside the wiki root");
    expect(() => dryRunDeps({ ...base, saveAnswer: path.join(out, "dangle.json") })).toThrow("inside the wiki root");
    // A chain: l1 → l2 → the root.
    await symlink(planted, path.join(out, "l2.json"));
    await symlink(path.join(out, "l2.json"), path.join(out, "l1.json"));
    expect(() => dryRunDeps({ ...base, out: path.join(out, "l1.json") })).toThrow("inside the wiki root");
    // A middle component dangles into a folder of the root not made yet.
    await symlink(path.join(root, "newdir"), path.join(out, "dir"));
    expect(() => dryRunDeps({ ...base, out: path.join(out, "dir", "m.json") })).toThrow("inside the wiki root");
    // A relative target, with `..`, resolved from the link's own folder.
    await mkdir(path.join(out, "sub"));
    await symlink(path.relative(path.join(out, "sub"), planted), path.join(out, "sub", "rel.json"));
    expect(() => dryRunDeps({ ...base, out: path.join(out, "sub", "rel.json") })).toThrow("inside the wiki root");
    // A loop cannot be resolved: refused.
    await symlink(path.join(out, "loopB"), path.join(out, "loopA"));
    await symlink(path.join(out, "loopA"), path.join(out, "loopB"));
    expect(() => dryRunDeps({ ...base, out: path.join(out, "loopA") })).toThrow("could not be resolved");
    // Nothing was created in the root.
    expect(await Bun.file(planted).exists()).toBe(false);
    // A link dangling outside the root is allowed.
    await symlink(path.join(out, "elsewhere.json"), path.join(out, "fine.json"));
    expect(() => dryRunDeps({ ...base, out: path.join(out, "fine.json") })).not.toThrow();
  });

  test("a --previous that is missing, unparseable or another kind's map fails the run before the model call", async () => {
    const { out, base, models } = await setup();
    await writeFile(path.join(out, "bad.json"), "{ nope");
    const workMap = { version: WORK_MAP_VERSION, wiki: "kb", runAtMs: NOW, model: "m", coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] }, summary: "", needsYou: [], themes: [], efforts: [], loose: [] };
    await writeFile(path.join(out, "work.json"), JSON.stringify(workMap));
    for (const [file, msg] of [["missing.json", "could not be read"], ["bad.json", "is not a work map file"], ["work.json", "not a themes map"]] as const) {
      __resetWorkMapRunsForTest();
      const res = await startWorkMapRun("kb", dryRunDeps({ ...base, previous: path.join(out, file) })).promise;
      expect(res.outcome).toBe("refused");
      expect(res.outcome === "refused" && res.reason).toContain(msg);
    }
    expect(models).toHaveLength(0);
  });

  test("parseSavedAnswer refuses another shape", () => {
    expect(() => parseSavedAnswer('{"text":"x"}')).toThrow("not a --save-answer file");
  });
});

// Every shape the --out guard has to judge, one row each. A row builds its
// own root (under `parent`) when the shape needs a particular root name; the
// verdict is the only thing asserted, so a row never depends on the spelling.
type GuardRow = {
  name: string;
  expect: "refused" | "accepted";
  needs?: "case-insensitive" | "normalization-insensitive";
  make: (t: { parent: string; root: string; out: string }) => Promise<{ target: string; root?: string }>;
};
const GUARD_ROWS: GuardRow[] = [
  { name: "plain inside", expect: "refused", make: async ({ root }) => ({ target: path.join(root, "x.json") }) },
  { name: "plain outside (a scratch dir)", expect: "accepted", make: async ({ out }) => ({ target: path.join(out, "map.json") }) },
  { name: "a `..x` child of the root", expect: "refused", make: async ({ root }) => ({ target: path.join(root, "..map.json") }) },
  { name: "a `..x` sibling of the root", expect: "accepted", make: async ({ root }) => ({ target: path.join(path.dirname(root), "..x", "map.json") }) },
  {
    name: "a symlinked dir into the root",
    expect: "refused",
    make: async ({ root, out }) => {
      await mkdir(path.join(root, "deep"));
      await symlink(path.join(root, "deep"), path.join(out, "link"));
      return { target: path.join(out, "link", "map.json") };
    },
  },
  {
    name: "a symlinked file into the root",
    expect: "refused",
    make: async ({ root, out }) => {
      await writeFile(path.join(root, "f.json"), "{}");
      await symlink(path.join(root, "f.json"), path.join(out, "f.json"));
      return { target: path.join(out, "f.json") };
    },
  },
  {
    name: "a dangling link into the root",
    expect: "refused",
    make: async ({ root, out }) => {
      await symlink(path.join(root, "planted.json"), path.join(out, "dangle.json"));
      return { target: path.join(out, "dangle.json") };
    },
  },
  {
    name: "a chain of links into the root",
    expect: "refused",
    make: async ({ root, out }) => {
      await symlink(path.join(root, "planted.json"), path.join(out, "l2.json"));
      await symlink(path.join(out, "l2.json"), path.join(out, "l1.json"));
      return { target: path.join(out, "l1.json") };
    },
  },
  {
    name: "a relative link target",
    expect: "refused",
    make: async ({ root, out }) => {
      await mkdir(path.join(out, "sub"));
      await symlink(path.relative(path.join(out, "sub"), path.join(root, "planted.json")), path.join(out, "sub", "rel.json"));
      return { target: path.join(out, "sub", "rel.json") };
    },
  },
  {
    name: "a link loop",
    expect: "refused",
    make: async ({ out }) => {
      await symlink(path.join(out, "loopB"), path.join(out, "loopA"));
      await symlink(path.join(out, "loopA"), path.join(out, "loopB"));
      return { target: path.join(out, "loopA") };
    },
  },
  {
    name: "a case variant of the root",
    expect: "refused",
    needs: "case-insensitive",
    make: async ({ parent }) => {
      await mkdir(path.join(parent, "wiki"));
      return { root: path.join(parent, "wiki"), target: path.join(parent, "WIKI", "map.json") };
    },
  },
  {
    name: "an NFD spelling of an NFC root name",
    expect: "refused",
    needs: "normalization-insensitive",
    make: async ({ parent }) => {
      await mkdir(path.join(parent, "caf\u00e9"));
      return { root: path.join(parent, "caf\u00e9"), target: path.join(parent, "cafe\u0301", "map.json") };
    },
  },
  {
    name: "a path through a file (ENOTDIR)",
    expect: "refused",
    make: async ({ out }) => {
      await writeFile(path.join(out, "file.txt"), "");
      return { target: path.join(out, "file.txt", "x.json") };
    },
  },
  { name: "a nested dir under the root not made yet", expect: "refused", make: async ({ root }) => ({ target: path.join(root, "new", "dir", "map.json") }) },
  {
    name: "a dangling link to a case variant of the root",
    expect: "refused",
    needs: "case-insensitive",
    make: async ({ parent, out }) => {
      await mkdir(path.join(parent, "wiki"));
      await symlink(path.join(parent, "WIKI", "planted.json"), path.join(out, "dl.json"));
      return { root: path.join(parent, "wiki"), target: path.join(out, "dl.json") };
    },
  },
];

// What the volume the temp dirs land on folds, probed once: a row that needs a
// fold the volume lacks is skipped, and its name says why.
const probeDir = path.resolve(testTempDirSync("muninn-wm-probe-"));
mkdirSync(path.join(probeDir, "CaseProbe"));
mkdirSync(path.join(probeDir, "n\u00e9"));
const VOLUME: Record<NonNullable<GuardRow["needs"]>, boolean> = {
  "case-insensitive": existsSync(path.join(probeDir, "caseprobe")),
  "normalization-insensitive": existsSync(path.join(probeDir, "ne\u0301")),
};
rmSync(probeDir, { recursive: true, force: true });

describe("the dry run's --out guard (filesystem identity)", () => {
  for (const row of GUARD_ROWS) {
    const skip = row.needs !== undefined && !VOLUME[row.needs];
    test.skipIf(skip)(`${row.expect}: ${row.name}${skip ? ` (skipped: the test volume is not ${row.needs})` : ""}`, async () => {
      const { root, out, base } = await setup();
      const parent = path.resolve(await testTempDir("muninn-wm-guard-"));
      dirs.push(parent);
      const made = await row.make({ parent, root: path.resolve(root), out: path.resolve(out) });
      const entry = made.root ? { ...base.entry, root: made.root } : base.entry;
      const run = () => dryRunDeps({ ...base, entry, out: made.target });
      if (row.expect === "refused") expect(run).toThrow("inside the wiki root");
      else expect(run).not.toThrow();
    });
  }
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
