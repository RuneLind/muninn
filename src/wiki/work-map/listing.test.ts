import { afterEach, describe, expect, test } from "bun:test";
import { rm, utimes, writeFile } from "node:fs/promises";
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

  test("an unchanged mtime and size answers from the cache", async () => {
    root = await testTempDir("muninn-wm-listing-");
    const file = path.join(root, ".work-map.json");
    await writeFile(file, mapText(1000));
    await utimes(file, 5, 5);
    expect(await workMapRunAt(root)).toBe(1000);
    // Same size, same mtime, different bytes: the cache is what answers.
    await writeFile(file, mapText(9000));
    await utimes(file, 5, 5);
    expect(await workMapRunAt(root)).toBe(1000);
  });

  test("an unreadable map: no field", async () => {
    root = await testTempDir("muninn-wm-listing-");
    await writeFile(path.join(root, ".work-map.json"), "{not json");
    expect(await workMapListingField(root)).toEqual({});
  });
});
