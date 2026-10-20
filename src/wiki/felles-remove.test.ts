/**
 * `felles-remove.ts`: which data files a felles Remove sends with the page
 * (the decision table's TARGET SET in `src/wiki/CLAUDE.md`), and how a
 * `--fjern` run's output reads (`fellesFjernVerdict`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, rm, symlink } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fellesObjectPathRefusal, fellesRemoveDataFiles } from "./felles-remove.ts";
// Read off the namespace, so each test fails on its own against a tree without it.
import * as felles from "./felles-remove.ts";
import { testTempDir } from "../test/temp-dir.ts";
import {
  FAKE_BUCKET,
  fakeFjernRun,
  fakeGcloudRm,
  GCLOUD_LOGGED_OUT,
  GCLOUD_NETWORK,
} from "../test/felles-fjern-fake.ts";

const NFC = "Måling.csv";
const NFD = NFC.normalize("NFD");

// Publish's per-file decision runs `lstat`, then an `O_NOFOLLOW` open and
// `fstat`. Each filesystem is simulated through the probe seam, so both run on
// every CI runner: macOS APFS matches names case- and normalization-
// insensitively, Linux ext4 byte for byte.
type Entry = { kind: "file" | "dir" | "symlink" | "other"; open?: { error: string } | { isFile: boolean; size: number } };
const F = (size = 10): Entry => ({ kind: "file", open: { isFile: true, size } });
const DIR: Entry = { kind: "dir", open: { isFile: false, size: 0 } };
const LINK: Entry = { kind: "symlink", open: { error: "ELOOP" } };
const FIFO: Entry = { kind: "other", open: { isFile: false, size: 0 } };
const apfs = (s: string) => s.normalize("NFC").toLowerCase();
const ext4 = (s: string) => s;
function probe(entries: Record<string, Entry>, key: (s: string) => string) {
  const find = (abs: string) => {
    const hit = Object.keys(entries).find((p) => key(p) === key(abs));
    return hit === undefined ? null : entries[hit]!;
  };
  return {
    // A folder holding a listed entry exists, as on disk.
    lstat: (abs: string) => find(abs)?.kind ?? (Object.keys(entries).some((p) => key(p).startsWith(key(abs) + "/")) ? "dir" : null),
    open: (abs: string) => find(abs)?.open ?? { error: "ENOENT" },
  };
}
const refs = (...srcs: string[]) => srcs.map((s) => `<DeltaTable src="${s}" />\n\n`).join("");
const pageAt = (body: string) => async (abs: string) => (abs === "/w/p/page.mdx" ? body : null);

// One row per publish outcome: the refs on the page, the tree, the filesystem,
// and the object names remove targets (`dataFiles`) and lists as refused.
const TARGET_SET: [string, string, Record<string, Entry>, (s: string) => string, string[], string[]][] = [
  ["OK: a regular file publish uploads", refs("d.csv"), { "/w/p/d.csv": F() }, ext4, ["p/d.csv"], []],
  ["missing: publish names nothing", refs("d.csv"), {}, ext4, [], []],
  ["a symlink in the path: relUnder refuses it", refs("l/d.csv"), { "/w/p/l": LINK, "/w/p/l/d.csv": F() }, ext4, [], []],
  ["a symlink as the file: the O_NOFOLLOW open refuses it", refs("d.csv"), { "/w/p/d.csv": LINK }, ext4, [], []],
  ["not a regular file: a folder", refs("d.csv"), { "/w/p/d.csv": DIR }, ext4, [], []],
  ["not a regular file: a FIFO", refs("d.csv"), { "/w/p/d.csv": FIFO }, ext4, [], []],
  ["unreadable: the open fails with EACCES", refs("d.csv"), { "/w/p/d.csv": { kind: "file", open: { error: "EACCES" } } }, ext4, [], []],
  ["the size cap: one byte over 1 MiB is refused", refs("d.csv"), { "/w/p/d.csv": F(1024 * 1024 + 1) }, ext4, [], []],
  ["the size cap: exactly 1 MiB is uploaded", refs("d.csv"), { "/w/p/d.csv": F(1024 * 1024) }, ext4, ["p/d.csv"], []],
  ["a name sjekkStiform refuses: never uploaded, listed as refused", refs("b[1].csv"), { "/w/p/b[1].csv": F() }, ext4, [], ["p/b[1].csv"]],
  ["collision on APFS: Data.csv and data.csv both resolve, both refused", refs("Data.csv", "data.csv"), { "/w/p/data.csv": F() }, apfs, [], []],
  ["collision on ext4: only data.csv resolves, so no collision", refs("Data.csv", "data.csv"), { "/w/p/data.csv": F() }, ext4, ["p/data.csv"], []],
  // Publish's collision pass counts every file it names, refused ones too.
  ["collision on ext4 with a refused spelling: Data.csv a symlink, data.csv a file, neither", refs("Data.csv", "data.csv"), { "/w/p/Data.csv": LINK, "/w/p/data.csv": F() }, ext4, [], []],
  ["case variant alone on APFS: Data.CSV finds data.csv, object Data.CSV", refs("Data.CSV"), { "/w/p/data.csv": F() }, apfs, ["p/Data.CSV"], []],
  ["case variant alone on ext4: nothing found", refs("Data.CSV"), { "/w/p/data.csv": F() }, ext4, [], []],
  ["two refs, one NFC name, APFS: one object", refs(NFC, NFD), { [`/w/p/${NFD}`]: F() }, apfs, [`p/${NFC}`], []],
  ["two refs, one NFC name, ext4, NFC ref first: the NFD ref finds the file", refs(NFC, NFD), { [`/w/p/${NFD}`]: F() }, ext4, [`p/${NFC}`], []],
  ["two refs, one NFC name, ext4, NFD ref first", refs(NFD, NFC), { [`/w/p/${NFD}`]: F() }, ext4, [`p/${NFC}`], []],
  ["an NFC ref to an NFD file on ext4 alone: not found", refs(NFC), { [`/w/p/${NFD}`]: F() }, ext4, [], []],
  // Not mirrored: the scanner. Its refusal is invisible here, so the file is
  // targeted; its delete then answers «not in the bucket», which is success.
  ["the scanner: not mirrored, so a file it refused is targeted", refs("fnr.csv"), { "/w/p/fnr.csv": F() }, ext4, ["p/fnr.csv"], []],
];

describe("TARGET SET: remove targets what publish uploads for the page as it stands", () => {
  test.each(TARGET_SET)("%s", async (_name, md, entries, key, dataFiles, refused) => {
    const got = await fellesRemoveDataFiles("/w", "p/page.mdx", ["p/page.mdx"], pageAt(md), probe(entries, key));
    expect({ dataFiles: got.dataFiles, refused: got.refused }).toEqual({ dataFiles, refused });
  });

  test("a data file another local page reads is kept, also across NFC and NFD spellings", async () => {
    const read = async (abs: string) =>
      abs === "/w/p/page.mdx" ? refs("d.csv", NFC) : abs === "/w/q/other.md" ? refs(`../p/${NFD}`) : null;
    const got = await fellesRemoveDataFiles("/w", "p/page.mdx", ["p/page.mdx", "q/other.md"], read, probe({ "/w/p/d.csv": F(), [`/w/p/${NFC}`]: F() }, apfs));
    expect(got).toEqual({ dataFiles: ["p/d.csv"], shared: [`p/${NFC}`], refused: [] });
  });
});

describe("TARGET SET on this disk", () => {
  let root = "";
  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "muninn-felles-remove-"));
    await Bun.write(
      path.join(root, "p", "page.mdx"),
      "# P\n\n" + refs(NFC, NFD, "b[1].csv", "Data.csv", "data.csv", "via/x.csv", "big.csv", "locked.csv", "ok.csv"),
    );
    await Bun.write(path.join(root, "p", NFD), "a\n1\n");
    await Bun.write(path.join(root, "p", "b[1].csv"), "a\n1\n");
    await Bun.write(path.join(root, "p", "data.csv"), "a\n1\n");
    await Bun.write(path.join(root, "p", "big.csv"), "x".repeat(1024 * 1024 + 1));
    await Bun.write(path.join(root, "p", "locked.csv"), "a\n1\n");
    await chmod(path.join(root, "p", "locked.csv"), 0o000);
    await Bun.write(path.join(root, "p", "ok.csv"), "a\n1\n");
    await Bun.write(path.join(root, "real", "x.csv"), "a\n1\n");
    await symlink(path.join(root, "real"), path.join(root, "p", "via"));
  });
  afterAll(async () => {
    await chmod(path.join(root, "p", "locked.csv"), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  test("answers as publish would on this filesystem", async () => {
    // The oracle is the filesystem's own lstat: APFS (macOS default) finds
    // Data.csv and the NFC spelling for the files stored data.csv and NFD.
    const finds = (name: string) => {
      try {
        lstatSync(path.join(root, "p", name));
        return true;
      } catch {
        return false;
      }
    };
    const insensitive = finds("Data.csv");
    if (process.platform === "darwin") expect([insensitive, finds(NFC)]).toEqual([true, true]);
    // root can read a mode-000 file; publish then uploads it.
    const lockedReadable = process.getuid?.() === 0;
    const got = await fellesRemoveDataFiles(root, "p/page.mdx", ["p/page.mdx"]);
    expect(got).toEqual({
      // NFC first or not, the NFD file is one object in NFC. Data.csv and
      // data.csv collide where both resolve; via/ is a symlinked folder;
      // big.csv is over the cap; locked.csv cannot be opened.
      dataFiles: [`p/${NFC}`, ...(insensitive ? [] : ["p/data.csv"]), ...(lockedReadable ? ["p/locked.csv"] : []), "p/ok.csv"],
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
    [`plans/${String.fromCharCode(0x202e)}x.csv`],
    [`plans/${String.fromCharCode(7)}x.csv`],
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

// The real script's lines (the empirical pass compares this fake with the
// script's own `kjør` byte for byte).
const PAGE = "plans/case.mdx";
const DATA = ["plans/case.yaml", "plans/runs.csv", `plans/${NFC}`];
const run = (objects: string[], inBucket: string[], fail?: (o: string) => string | null) =>
  fakeFjernRun(objects, fakeGcloudRm(new Set(inBucket), fail));

const VERDICTS: [string, { exitCode: number; stdout: string; stderr: string } | null, number, string][] = [
  ["exit 0: deleted", run([PAGE], [PAGE]), 1, "deleted"],
  ["the page not in the bucket: missing", run([PAGE], []), 1, "missing"],
  ["a logged-out gcloud: failed", run([PAGE], [PAGE], () => GCLOUD_LOGGED_OUT), 1, "failed"],
  ["a network error: failed", run([PAGE], [PAGE], () => GCLOUD_NETWORK), 1, "failed"],
  ["one data file never uploaded, the rest deleted: missing", run(DATA, DATA.slice(0, 2)), 3, "missing"],
  ["every data file already gone: missing", run(DATA, []), 3, "missing"],
  ["one missing and one logged out: failed", run(DATA, DATA.slice(1), (o) => (o === DATA[2] ? GCLOUD_LOGGED_OUT : null)), 3, "failed"],
  ["exit 1: error", { exitCode: 1, stdout: "AVVIST  x\n", stderr: "" }, 1, "error"],
  ["exit 2: error", { exitCode: 2, stdout: "", stderr: "Feil: finner ikke gcloud på PATH — ingenting er slettet\n" }, 1, "error"],
  ["no result: timeout", null, 1, "timeout"],
  ["exit 3 without the summary line: failed", { exitCode: 3, stdout: "", stderr: run([PAGE], []).stderr }, 1, "failed"],
  ["exit 3 whose summary counts another number of objects: failed", run([PAGE], []), 2, "failed"],
  [
    "a masked detail is not read as «not in the bucket»",
    { ...run([PAGE], []), stderr: `Feil: sletting av gs://${FAKE_BUCKET}/${PAGE} feilet (exit 1): [feilmeldingen er skjult: inneholder e-post]\n` },
    1,
    "failed",
  ],
  [
    "a detail that only starts with the URL (another object) is not «not in the bucket»",
    { ...run([PAGE], []), stderr: `Feil: sletting av gs://${FAKE_BUCKET}/${PAGE} feilet (exit 1): gs://${FAKE_BUCKET}/${PAGE}.bak\n` },
    1,
    "failed",
  ],
  [
    "a detail naming another object is not «not in the bucket»",
    { ...run([PAGE], []), stderr: `Feil: sletting av gs://${FAKE_BUCKET}/${PAGE} feilet (exit 1): gs://${FAKE_BUCKET}/plans/other.mdx\n` },
    1,
    "failed",
  ],
  [
    "a masked name whose detail is the same masked URL is «not in the bucket»",
    {
      exitCode: 3,
      stdout: "\nOppsummering: 0 slettet, 1 feilet. Poden fjerner sidene ved neste poll (~2 min).\n",
      stderr: `Feil: sletting av gs://${FAKE_BUCKET}/[skjult sti nr. 1: inneholder e-post] feilet (exit 1): gs://${FAKE_BUCKET}/[skjult sti nr. 1: inneholder e-post]\n`,
    },
    1,
    "missing",
  ],
];

describe("fellesFjernVerdict reads the script's --fjern lines", () => {
  test.each(VERDICTS)("%s", (_name, r, targets, want) => {
    expect(felles.fellesFjernVerdict(r, targets)).toBe(want as felles.FellesFjernVerdict);
  });
});
