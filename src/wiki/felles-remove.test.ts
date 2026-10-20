/**
 * `felles-remove.ts`: which data files a felles Remove sends with the page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fellesObjectPathRefusal, fellesRemoveDataFiles, type Lstat } from "./felles-remove.ts";
// Read off the namespace, so each test fails on its own against a tree without it.
import * as felles from "./felles-remove.ts";
import { testTempDir } from "../test/temp-dir.ts";

const NFC = "Måling.csv";
const NFD = "Måling.csv";

// Publish decides whether a page's data file exists with `lstat` on the page's
// spelling: case- and normalization-insensitive on macOS APFS, byte for byte
// on Linux ext4. Remove must target exactly what publish uploaded, so it asks
// the same question. Each filesystem is simulated through the `lstat` seam so
// both run on every CI runner.
const file = { isFile: () => true, isSymbolicLink: () => false };
const dir = { isFile: () => false, isSymbolicLink: () => false };
const link = { isFile: () => false, isSymbolicLink: () => true };
/** An lstat over `entries` (absolute path → kind) that matches names through `key`. */
const fakeLstat =
  (entries: Record<string, typeof file>, key: (s: string) => string): Lstat =>
  (abs) => {
    const hit = Object.keys(entries).find((p) => key(p) === key(abs));
    return hit === undefined ? null : entries[hit]!;
  };
const apfs = (s: string) => s.normalize("NFC").toLowerCase();
const ext4 = (s: string) => s;
const page = (body: string) => async (abs: string) => (abs === "/w/p/page.mdx" ? body : null);

describe("remove finds a data file exactly when publish's lstat does", () => {
  const tree = { "/w/p": dir, "/w/p/data.csv": file, [`/w/p/${NFD}`]: file };

  test("macOS: a ref spelled Data.CSV finds data.csv, as publish's lstat does", async () => {
    const got = await fellesRemoveDataFiles("/w", "p/page.mdx", ["p/page.mdx"], page('<DeltaTable src="Data.CSV" />\n'), fakeLstat(tree, apfs));
    expect(got.dataFiles).toEqual(["p/Data.CSV"]);
  });

  test("Linux: the same ref finds nothing, since publish's lstat finds nothing", async () => {
    const got = await fellesRemoveDataFiles("/w", "p/page.mdx", ["p/page.mdx"], page('<DeltaTable src="Data.CSV" />\n'), fakeLstat(tree, ext4));
    expect(got.dataFiles).toEqual([]);
  });

  test("an NFC ref to a file stored NFD: found on macOS, not on Linux; the object name is NFC", async () => {
    const md = page(`<DeltaTable src="${NFC}" />\n`);
    expect((await fellesRemoveDataFiles("/w", "p/page.mdx", ["p/page.mdx"], md, fakeLstat(tree, apfs))).dataFiles).toEqual([`p/${NFC}`]);
    expect((await fellesRemoveDataFiles("/w", "p/page.mdx", ["p/page.mdx"], md, fakeLstat(tree, ext4))).dataFiles).toEqual([]);
  });

  test("an NFD ref to a file stored NFD is found on Linux too, and sent in NFC", async () => {
    const md = page(`<DeltaTable src="${NFD}" />\n`);
    expect((await fellesRemoveDataFiles("/w", "p/page.mdx", ["p/page.mdx"], md, fakeLstat(tree, ext4))).dataFiles).toEqual([`p/${NFC}`]);
  });

  test("a symlinked folder or a symlinked file is not uploaded, so it is not removed", () => {
    expect(felles.publishUploadsDataFile("/w", "l/x.csv", fakeLstat({ "/w/l": link, "/w/l/x.csv": file }, ext4))).toBe(false);
    expect(felles.publishUploadsDataFile("/w", "x.csv", fakeLstat({ "/w/x.csv": link }, ext4))).toBe(false);
    expect(felles.publishUploadsDataFile("/w", "x.csv", fakeLstat({ "/w/x.csv": dir }, ext4))).toBe(false);
  });
});

describe("fellesRemoveDataFiles on disk", () => {
  let root = "";
  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "muninn-felles-remove-"));
    await Bun.write(
      path.join(root, "p", "page.mdx"),
      `# P\n\n<DeltaTable src="${NFD}" />\n\n<DeltaTable src="b[1].csv" />\n\n<DeltaTable src="Data.CSV" />\n\n<DeltaTable src="via/x.csv" />\n`,
    );
    await Bun.write(path.join(root, "p", NFD), "a\n1\n");
    await Bun.write(path.join(root, "p", "b[1].csv"), "a\n1\n");
    await Bun.write(path.join(root, "p", "data.csv"), "a\n1\n");
    await Bun.write(path.join(root, "real", "x.csv"), "a\n1\n");
    await symlink(path.join(root, "real"), path.join(root, "p", "via"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("sends the NFC object name, keeps a name the script refuses, and agrees with this filesystem's lstat", async () => {
    // The oracle is publish's own call. On macOS (APFS, case-insensitive by
    // default) it finds data.csv for Data.CSV; on Linux it does not.
    let caseInsensitive = true;
    try {
      lstatSync(path.join(root, "p", "Data.CSV"));
    } catch {
      caseInsensitive = false;
    }
    if (process.platform === "darwin") expect(caseInsensitive).toBe(true);
    expect(await fellesRemoveDataFiles(root, "p/page.mdx", ["p/page.mdx"])).toEqual({
      dataFiles: [`p/${NFC}`, ...(caseInsensitive ? ["p/Data.CSV"] : [])],
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
