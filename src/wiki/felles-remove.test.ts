/**
 * `felles-remove.ts`: which data files a felles Remove sends with the page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fellesObjectPathRefusal, fellesRemoveDataFiles, localSpelling } from "./felles-remove.ts";
import { testTempDir } from "../test/temp-dir.ts";

const NFC = "Måling.csv";
const NFD = "Måling.csv";

// Linux compares names byte for byte, so a ref in one normalization form
// misses a file whose on-disk name is in the other (the CI failure on ubuntu;
// macOS APFS hides it). The lookup walks the directory listing instead.
describe("localSpelling finds a name in either normalization form", () => {
  const listing = (dirs: Record<string, string[]>) => async (abs: string) => dirs[abs] ?? null;

  test("a ref in NFC finds the file stored in NFD, and answers the stored name", async () => {
    const listDir = listing({ "/w": ["plans"], "/w/plans": [NFD] });
    expect(await localSpelling("/w", `plans/${NFC}`, listDir)).toBe(`plans/${NFD}`);
  });

  test("a ref in NFD finds the file stored in NFC", async () => {
    const listDir = listing({ "/w": ["plåns"], "/w/plåns": [NFC] });
    expect(await localSpelling("/w", `plåns/${NFD}`, listDir)).toBe(`plåns/${NFC}`);
  });

  test("an exact match wins over one equal only after NFC", async () => {
    const listDir = listing({ "/w": [NFD, NFC] });
    expect(await localSpelling("/w", NFC, listDir)).toBe(NFC);
    expect(await localSpelling("/w", NFD, listDir)).toBe(NFD);
  });

  test("a missing segment is null", async () => {
    expect(await localSpelling("/w", "plans/x.csv", listing({ "/w": ["plans"], "/w/plans": [] }))).toBeNull();
    expect(await localSpelling("/w", "nope/x.csv", listing({ "/w": ["plans"] }))).toBeNull();
  });
});

describe("fellesRemoveDataFiles on disk", () => {
  let root = "";
  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "muninn-felles-remove-"));
    await Bun.write(path.join(root, "p", "page.mdx"), `# P\n\n<DeltaTable src="${NFC}" />\n\n<DeltaTable src="b[1].csv" />\n`);
    await Bun.write(path.join(root, "p", NFD), "a\n1\n");
    await Bun.write(path.join(root, "p", "b[1].csv"), "a\n1\n");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("sends the NFC object name for a file stored in NFD, and keeps a name the script refuses", async () => {
    expect(await fellesRemoveDataFiles(root, "p/page.mdx", ["p/page.mdx"])).toEqual({
      dataFiles: [`p/${NFC}`],
      shared: [],
      refused: ["p/b[1].csv"],
    });
  });
});

describe("fellesObjectPathRefusal mirrors the script's sjekkStiform", () => {
  test("accepts an ordinary object name, including non-ASCII", () => {
    expect(fellesObjectPathRefusal(`plans/${NFC}`)).toBeNull();
    expect(fellesObjectPathRefusal("plans/q-2.sql")).toBeNull();
    expect(fellesObjectPathRefusal("a".repeat(211))).toBeNull();
  });

  test.each([
    ["plans/a[1].csv"],
    ["plans/a].csv"],
    ["plans/a*.csv"],
    ["plans/a?.csv"],
    ["plans/a#12"],
    ["plans/‮x.csv"],
    ["plans/\u0007x.csv"],
    ["a".repeat(212)],
    ["å".repeat(106)],
    [""],
    ["/abs.csv"],
    ["a\\b.csv"],
    ["a//b.csv"],
    ["a/../b.csv"],
  ])("refuses %p", (rel) => {
    expect(fellesObjectPathRefusal(rel)).not.toBeNull();
  });
});
