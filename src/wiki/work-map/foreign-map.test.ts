import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../../test/temp-dir.ts";
import { fixtureThemeMap } from "../../test/theme-map-fixture.ts";
import { runGit } from "../commit.ts";
import { FOREIGN_MAP_WARNING, mapIsForeign, mapWrittenElsewhere, warnForeignWorkMaps, workMapIsTracked, type ForeignMapDeps } from "./foreign-map.ts";
import { readMapFile } from "./map-file.ts";
import { WORK_MAP_VERSION, type WorkMap } from "./schema.ts";
import { fileStateStore } from "./state.ts";
import { WORK_MAP_FILE } from "./write.ts";

const STAMP = 1_763_900_000_000;

describe("mapWrittenElsewhere", () => {
  test.each([
    [false, null, null, false],
    [false, STAMP, null, false],
    [false, STAMP, STAMP, false],
    [false, STAMP, STAMP - 1, false],
    [true, null, null, false],
    [true, null, STAMP, false],
    [true, STAMP, STAMP, false],
    [true, STAMP, null, true],
    [true, STAMP, STAMP - 1, true],
    [true, STAMP, STAMP + 1, true],
  ] as const)("tracked=%p map=%p lastSuccess=%p → %p", (tracked, map, last, want) => {
    expect(mapWrittenElsewhere(tracked, map, last)).toBe(want);
  });
});

async function git(dir: string, ...args: string[]): Promise<void> {
  const r = await runGit(dir, ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A stored work map that parses, stamped `runAtMs`. */
function mapText(runAtMs: number): string {
  const map: WorkMap = {
    version: WORK_MAP_VERSION,
    wiki: "mimir",
    runAtMs,
    model: "m",
    coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 14, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
    summary: "",
    needsYou: [],
    themes: [],
    efforts: [],
    loose: [],
  };
  return `${JSON.stringify(map, null, 1)}\n`;
}
const themesText = (runAtMs: number) => `${JSON.stringify(fixtureThemeMap({ wiki: "mimir", runAtMs }), null, 1)}\n`;

/** A wiki root in a fresh git repo holding a map stamped `stamp`, committed when `tracked`. */
async function wikiRepo(opts: { tracked: boolean; stamp?: number; text?: string }): Promise<string> {
  const dir = await testTempDir(path.join(tmpdir(), "work-map-foreign-"));
  await git(dir, "init", "-q");
  writeFileSync(path.join(dir, "index.md"), "# w\n");
  writeFileSync(path.join(dir, WORK_MAP_FILE), opts.text ?? mapText(opts.stamp ?? STAMP));
  await git(dir, "add", opts.tracked ? "-A" : "index.md");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Real deps: git through `runGit`, the map through Bun.file, state through a real `fileStateStore`. */
async function realDeps(lastSuccessAt?: number): Promise<ForeignMapDeps> {
  const store = fileStateStore(await testTempDir(path.join(tmpdir(), "work-map-foreign-state-")));
  if (lastSuccessAt !== undefined) await store.record("mimir", { at: lastSuccessAt, outcome: "ok" });
  return {
    isTracked: workMapIsTracked,
    readText: async (abs) => {
      try {
        return await Bun.file(abs).text();
      } catch {
        return null;
      }
    },
    readState: (w) => store.read(w),
  };
}

function sink() {
  const said: { message: string; wiki: string }[] = [];
  return { said, warn: (message: string, props: { wiki: string }) => void said.push({ message, ...props }) };
}

describe("the second-organizer check on real repos", () => {
  test("a tracked map with another instance's stamp: one warning for that wiki", async () => {
    const root = await wikiRepo({ tracked: true, stamp: STAMP });
    const { said, warn } = sink();
    expect(await warnForeignWorkMaps(["MIMIR"], [{ name: "mimir", root }], await realDeps(STAMP - 60_000), warn)).toEqual(["mimir"]);
    expect(said).toEqual([{ message: FOREIGN_MAP_WARNING, wiki: "mimir" }]);
  });

  test("a tracked map with this machine's own stamp: silent", async () => {
    const root = await wikiRepo({ tracked: true, stamp: STAMP });
    const { said, warn } = sink();
    expect(await warnForeignWorkMaps(["mimir"], [{ name: "mimir", root }], await realDeps(STAMP), warn)).toEqual([]);
    expect(said).toEqual([]);
  });

  test("a tracked map and no state on this machine: warns", async () => {
    const root = await wikiRepo({ tracked: true });
    expect(await mapIsForeign({ name: "mimir", root }, await realDeps())).toBe(true);
  });

  test("a themes map: the same comparison, by its own stamp", async () => {
    expect(readMapFile(themesText(STAMP))?.kind).toBe("themes");
    expect(readMapFile(mapText(STAMP))?.kind).toBe("work");
    const root = await wikiRepo({ tracked: true, text: themesText(STAMP) });
    expect(await mapIsForeign({ name: "mimir", root }, await realDeps(STAMP))).toBe(false);
    expect(await mapIsForeign({ name: "mimir", root }, await realDeps(STAMP - 1))).toBe(true);
  });

  test("an untracked map with a foreign stamp: silent", async () => {
    const root = await wikiRepo({ tracked: false });
    expect(await workMapIsTracked(root)).toBe(false);
    expect(await mapIsForeign({ name: "mimir", root }, await realDeps())).toBe(false);
  });

  test("no repo, no root, an unreadable map: silent and no rejection", async () => {
    const plain = await testTempDir(path.join(tmpdir(), "work-map-foreign-nogit-"));
    writeFileSync(path.join(plain, WORK_MAP_FILE), mapText(STAMP));
    const deps = await realDeps();
    expect(await workMapIsTracked(plain)).toBe(false);
    expect(await mapIsForeign({ name: "mimir", root: plain }, deps)).toBe(false);
    expect(await workMapIsTracked(path.join(plain, "missing"))).toBe(false);
    expect(await mapIsForeign({ name: "mimir", root: path.join(plain, "missing") }, deps)).toBe(false);

    const garbled = await wikiRepo({ tracked: true, text: "{not json" });
    expect(await workMapIsTracked(garbled)).toBe(true);
    expect(await mapIsForeign({ name: "mimir", root: garbled }, deps)).toBe(false);

    const locked = await wikiRepo({ tracked: true });
    chmodSync(path.join(locked, WORK_MAP_FILE), 0o000);
    try {
      expect(await mapIsForeign({ name: "mimir", root: locked }, deps)).toBe(false);
    } finally {
      chmodSync(path.join(locked, WORK_MAP_FILE), 0o644);
    }
  });

  test("a throwing git, map read or state read: silent, never rejects", async () => {
    const root = await wikiRepo({ tracked: true });
    const base = await realDeps();
    const boom = () => {
      throw new Error("boom");
    };
    const { said, warn } = sink();
    const registry = [{ name: "a", root }, { name: "b", root }, { name: "c", root }];
    expect(await warnForeignWorkMaps(["a"], registry, { ...base, isTracked: boom }, warn)).toEqual([]);
    expect(await warnForeignWorkMaps(["b"], registry, { ...base, readText: () => Promise.reject(new Error("eio")) }, warn)).toEqual([]);
    expect(await warnForeignWorkMaps(["c"], registry, { ...base, readState: () => Promise.reject(new Error("eio")) }, warn)).toEqual([]);
    expect(said).toEqual([]);
  });

  test("checks run independently: a hung check does not hold another wiki's warning", async () => {
    const root = await wikiRepo({ tracked: true });
    const base = await realDeps();
    const { said, warn } = sink();
    const deps: ForeignMapDeps = { ...base, isTracked: (r) => (r === "/hung" ? new Promise(() => {}) : base.isTracked(r)) };
    void warnForeignWorkMaps(["hung", "mimir"], [{ name: "hung", root: "/hung" }, { name: "mimir", root }], deps, warn);
    for (let i = 0; i < 200 && said.length === 0; i++) await Bun.sleep(5);
    expect(said.map((s) => s.wiki)).toEqual(["mimir"]);
  });

  test("the line names the consequence and the remedy, and no path", () => {
    expect(FOREIGN_MAP_WARNING).toContain("written by another instance");
    expect(FOREIGN_MAP_WARNING).toContain("configured to organize {wiki} too");
    expect(FOREIGN_MAP_WARNING).toContain("push will be rejected");
    expect(FOREIGN_MAP_WARNING).toContain("report blocked");
    expect(FOREIGN_MAP_WARNING).toContain("remove it from WORK_MAP_WIKIS on the others");
    expect(FOREIGN_MAP_WARNING).not.toContain("{root}");
  });
});
