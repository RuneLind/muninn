import { afterEach, describe, expect, test } from "bun:test";
import { rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { __resetWorkMapListingCacheForTest, workMapListingField, workMapRunAt } from "./listing.ts";
import { WORK_MAP_VERSION } from "./schema.ts";
import { testTempDir } from "../../test/temp-dir.ts";

function mapText(runAtMs: number): string {
  return JSON.stringify({
    version: WORK_MAP_VERSION,
    wiki: "w",
    runAtMs,
    model: "m",
    coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
    summary: "",
    needsYou: [],
    themes: [],
    efforts: [],
    loose: [],
  });
}

let root = "";
afterEach(async () => {
  __resetWorkMapListingCacheForTest();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("workMapRunAt", () => {
  test("absent file: no field", async () => {
    root = await testTempDir("muninn-wm-listing-");
    expect(await workMapListingField(root)).toEqual({});
  });

  test("a valid map: its runAt; a rewrite with a new mtime shows at once", async () => {
    root = await testTempDir("muninn-wm-listing-");
    const file = path.join(root, ".work-map.json");
    await writeFile(file, mapText(1000));
    await utimes(file, 1, 1);
    expect(await workMapListingField(root)).toEqual({ workMap: { runAt: 1000 } });
    await writeFile(file, mapText(2000));
    await utimes(file, 2, 2);
    expect(await workMapRunAt(root)).toBe(2000);
  });

  test("an unchanged stat answers from the cache", async () => {
    root = await testTempDir("muninn-wm-listing-");
    const file = path.join(root, ".work-map.json");
    await writeFile(file, mapText(1000));
    expect(await workMapRunAt(root)).toBe(1000);
    expect(await workMapRunAt(root)).toBe(1000);
  });

  test("a same-size rewrite with a preserved mtime still shows (in place, and renamed over)", async () => {
    root = await testTempDir("muninn-wm-listing-");
    const file = path.join(root, ".work-map.json");
    await writeFile(file, mapText(1000));
    await utimes(file, 5, 5);
    expect(await workMapRunAt(root)).toBe(1000);
    await Bun.sleep(5);
    await writeFile(file, mapText(9000));
    await utimes(file, 5, 5);
    expect(await workMapRunAt(root)).toBe(9000);
    const tmp = path.join(root, "next.json");
    await writeFile(tmp, mapText(7000));
    await utimes(tmp, 5, 5);
    await rename(tmp, file);
    expect(await workMapRunAt(root)).toBe(7000);
  });

  test("an unreadable map: no field", async () => {
    root = await testTempDir("muninn-wm-listing-");
    await writeFile(path.join(root, ".work-map.json"), "{not json");
    expect(await workMapListingField(root)).toEqual({});
  });

  test("a themes map advertises its runAt; a work map still parses unchanged", async () => {
    root = await testTempDir("muninn-wm-listing-");
    const file = path.join(root, ".work-map.json");
    const themes = {
      version: 1,
      kind: "themes",
      wiki: "kb",
      runAtMs: 4242,
      model: "m",
      coverage: { activeSources: 0, hubs: 0, driftHubs: 0, placed: 0, digestChars: 0, windowDays: 28, warnings: [] },
      summary: "",
      needsYou: [],
      themes: [],
      efforts: [],
      retired: [],
      loose: [],
    };
    await writeFile(file, JSON.stringify(themes));
    expect(await workMapListingField(root)).toEqual({ workMap: { runAt: 4242 } });
    await writeFile(file, JSON.stringify({ ...themes, kind: "other" }));
    await utimes(file, 9, 9);
    expect(await workMapRunAt(root)).toBeNull();
    await writeFile(file, mapText(5151));
    await utimes(file, 11, 11);
    expect(await workMapRunAt(root)).toBe(5151);
  });
});
