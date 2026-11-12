/**
 * The `.env` key-state reader, held to Bun itself. Every case is ONE byte
 * array: the harness writes exactly those bytes to the temp file a child
 * `bun --env-file=<temp file>` loads (one file per case, many files per child:
 * Bun parses each file on its own) and hands the same array to the reader. The
 * child reads back key NAMES and value LENGTHS only. Every key a case writes
 * carries the prefix `ZQ<case>_`, so the child's own environment never mixes
 * in and each key is charged to its case. The real `.env` is never read here.
 *
 * `spec` below restates the grammar as a hand-written scanner over bytes, with
 * its own hand-written UTF-8 decoder, apart from the reader's regexes and its
 * `TextDecoder`: a case's expected «keeps track» comes from it, Bun decides
 * set/unset. `ENV_NAMES_SWEEP=full` runs the one-off sizes (20,000 files each
 * for (c), (d) and (v), every second byte in (iv)).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { envFileKeyStates } from "./env-names.ts";
import { probeEnv, type ProbeDeps } from "./probes.ts";
import { readDotEnv } from "./real-deps.ts";

const FULL = process.env.ENV_NAMES_SWEEP === "full";

// ── bytes ────────────────────────────────────────────────────────────────
type Part = string | readonly number[] | Uint8Array;
const enc = (s: string) => new TextEncoder().encode(s);
/** One file's bytes: strings UTF-8-encoded, number arrays and byte arrays as they are. */
const bytesOf = (...parts: Part[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...enc(p)] : [...p])));
const BOM = [0xef, 0xbb, 0xbf];
/** A label for a failure message: printable ASCII as is, every other byte as `\xNN`. */
const show = (b: Uint8Array) => [...b].map((x) => (x >= 0x20 && x <= 0x7e && x !== 0x5c ? String.fromCharCode(x) : `\\x${x.toString(16).padStart(2, "0")}`)).join("");

/**
 * One line's bytes as code points, by hand: null on any ill-formed UTF-8 (a
 * stray continuation byte, a lead outside C2–F4, a missing continuation, an
 * overlong form, a surrogate, a value past U+10FFFF).
 */
function utf8CodePoints(b: Uint8Array): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < b.length; ) {
    const x = b[i]!;
    if (x < 0x80) {
      out.push(x);
      i++;
      continue;
    }
    let n: number, cp: number, min: number;
    if (x >= 0xc2 && x <= 0xdf) [n, cp, min] = [1, x & 0x1f, 0x80];
    else if (x >= 0xe0 && x <= 0xef) [n, cp, min] = [2, x & 0x0f, 0x800];
    else if (x >= 0xf0 && x <= 0xf4) [n, cp, min] = [3, x & 0x07, 0x10000];
    else return null;
    for (let k = 1; k <= n; k++) {
      const c = b[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out.push(cp);
    i += n + 1;
  }
  return out;
}

// ── the grammar, restated ────────────────────────────────────────────────
const isPlain = (c: number) => c >= 0x20 && c <= 0x7e;
const isSafe = (c: number) => c >= 0x21 && c <= 0x7e && !"\"'`\\$#".includes(String.fromCharCode(c));
const isKeyStart = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const isKeyChar = (c: number) => isKeyStart(c) || (c >= 0x30 && c <= 0x39);
/** One code point of a comment: tab, printable ASCII, or a scalar value at U+00A0 or above. */
const isCommentChar = (c: number) => c === 0x09 || isPlain(c) || c >= 0xa0;
const EXPORT = [..."export "].map((c) => c.charCodeAt(0));
function specLine(cps: readonly number[]): boolean {
  if (cps.length === 0) return true;
  if (cps[0] === 0x23) return cps.slice(1).every(isCommentChar);
  const s = EXPORT.every((c, i) => cps[i] === c) ? cps.slice(7) : cps;
  const eq = s.indexOf(0x3d);
  if (eq < 1) return false;
  const key = s.slice(0, eq);
  if (!isKeyStart(key[0]!) || !key.every(isKeyChar)) return false;
  const v = s.slice(eq + 1);
  if (v.length === 0) return true;
  if (v[0] === 0x22 || v[0] === 0x27) {
    if (v.length < 2 || v[v.length - 1] !== v[0]) return false;
    const body = v.slice(1, -1);
    return body.every((c) => isSafe(c) || c === 0x20) && (body.length === 0 || body.some(isSafe));
  }
  return v.every(isSafe);
}
/** In the grammar: every line (split on 0x0A, one trailing 0x0D dropped) well-formed UTF-8 and of a listed form. */
function spec(bytes: Uint8Array): boolean {
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x0a) continue;
    let end = i;
    if (end > start && bytes[end - 1] === 0x0d) end--;
    const cps = utf8CodePoints(bytes.subarray(start, end));
    if (!cps || !specLine(cps)) return false;
    start = i + 1;
  }
  return true;
}

// ── Bun ──────────────────────────────────────────────────────────────────
const canSpawnBun = (() => {
  try {
    return Bun.spawnSync([process.execPath, "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
})();
const bunTest = test.skipIf(!canSpawnBun);

const ROOT = canSpawnBun ? testTempDirSync(path.join(tmpdir(), "env-names-bun-")) : "";
let batch = 0;
const PRINT = "const o=[];for(const[k,v]of Object.entries(process.env))if(/ZQ\\d+_/.test(k))o.push([k,(v??'').length]);process.stdout.write(JSON.stringify(o))";
/** Per file, the keys Bun loads from exactly these bytes and each value's length. File `i` must name its keys `ZQ<i>_…`. */
function bunLoads(files: readonly Uint8Array[]): Map<string, number>[] {
  const out = files.map(() => new Map<string, number>());
  const dir = testTempDirSync(path.join(ROOT, `b${batch++}-`));
  for (let start = 0; start < files.length; start += 1000) {
    const flags: string[] = [];
    for (let i = start; i < Math.min(files.length, start + 1000); i++) {
      const f = path.join(dir, `f${i}.env`);
      writeFileSync(f, files[i]!);
      flags.push(`--env-file=${f}`);
    }
    const proc = Bun.spawnSync([process.execPath, ...flags, "-e", PRINT], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`bun exited ${proc.exitCode}`);
    for (const [k, len] of JSON.parse(proc.stdout.toString()) as [string, number][]) out[Number(/ZQ(\d+)_/.exec(k)![1])]?.set(k, len);
  }
  // Removed now, not at the run's end: the full sweep writes ~250,000 files, past the end hook's timeout.
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Where the reader keeps track: every claim it makes against Bun, and every non-empty Bun key it misses. */
function disagreements(bytes: Uint8Array, bun: Map<string, number>): string[] {
  const ours = envFileKeyStates(bytes);
  if (ours.lostTrack) return [];
  const bad: string[] = [];
  for (const [k, s] of ours.keys) {
    const len = bun.get(k) ?? 0;
    if (s === "set" && len === 0) bad.push(`${show(bytes)}: ${k} reader set, Bun empty`);
    else if (s === "unset" && len > 0) bad.push(`${show(bytes)}: ${k} reader unset, Bun non-empty`);
    else if (s !== "set" && s !== "unset") bad.push(`${show(bytes)}: ${k} reader ${s} without losing track`);
  }
  for (const [k, len] of bun) if (len > 0 && !ours.keys.has(k)) bad.push(`${show(bytes)}: ${k} reader absent, Bun non-empty`);
  return bad;
}
/** Whether the reader keeps track exactly where the grammar says it should. */
const trackMismatch = (bytes: Uint8Array) => (envFileKeyStates(bytes).lostTrack === spec(bytes) ? [`${show(bytes)}: reader lostTrack=${envFileKeyStates(bytes).lostTrack}, grammar ${spec(bytes) ? "in" : "out"}`] : []);

/** Builds one case's bytes from its key prefix, hands that one array to Bun and to the reader, returns the failures. */
function sweep(makers: readonly ((p: string) => Part)[]): { files: Uint8Array[]; bad: string[] } {
  const files = makers.map((m, i) => bytesOf(m(`ZQ${i}_`)));
  const bun = bunLoads(files);
  const bad = files.flatMap((b, i) => [...trackMismatch(b), ...disagreements(b, bun[i]!)]);
  return { files, bad };
}
const keptCount = (files: readonly Uint8Array[]) => files.filter((b) => !envFileKeyStates(b).lostTrack).length;

const PLAIN = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));
const EXTRA = ["\t", "\r", "\f", "\v", "\0", " ", "﻿", " ", "é"];

const states = (x: Part) => {
  const r = envFileKeyStates(bytesOf(x));
  const by = (s: string) => [...r.keys].filter(([, v]) => v === s).map(([k]) => k).sort();
  return { set: by("set"), unset: by("unset"), lostTrack: r.lostTrack };
};
const keyStates = (x: Part) => envFileKeyStates(bytesOf(x));

// ── (e) the historical repros ────────────────────────────────────────────
describe("envFileKeyStates: the historical repros", () => {
  const LOST: [string, (p: string) => Part][] = [
    ["form feed before empty quotes (Bun loads empty)", (p) => `${p}K=\f''\n`],
    ["vertical tab before empty quotes (Bun loads empty)", (p) => `${p}K=\v""\n`],
    ["a value that is only U+00A0 (Bun keeps it)", (p) => `${p}K= \n`],
    ["a value that is one space", (p) => `${p}K= \n`],
    ["an empty colon form before the key", (p) => `${p}OTHER:\n${p}K=1\n`],
    ["a colon form with a value", (p) => `${p}K: v\n`],
    ["an escaped quote hiding the next line", (p) => `${p}ESC="a\\"\n${p}INESC=fake\ntail"\n`],
    ["$UNSET", (p) => `${p}K=$UNSET\n`],
    ["${UNSET}", (p) => `${p}K=\${UNSET}\n`],
    ["an unclosed quote", (p) => `${p}K="abc\n${p}AFTER=after\n`],
    ["a BOM", (p) => `﻿${p}K=1\n`],
    ["a BOM before two keys (Bun loads only the second)", (p) => bytesOf(BOM, `${p}FOO=1\n${p}BAR=2\n`)],
    ["a UTF-16LE file with a BOM (Bun loads nothing)", (p) => Uint8Array.from([0xff, 0xfe, ...[...`${p}FOO=1\n${p}BAR=2\n`].flatMap((c) => [c.charCodeAt(0), 0])])],
    ["spaces around =", (p) => `${p}K = v\n`],
    ["an inline comment", (p) => `${p}K=v # c\n`],
  ];
  LOST.forEach(([what, make]) => {
    bunTest(`${what}: no claim against Bun, and the reader loses track`, () => {
      const bytes = bytesOf(make("ZQ0_"));
      expect(disagreements(bytes, bunLoads([bytes])[0]!)).toEqual([]);
      expect(envFileKeyStates(bytes).lostTrack).toBe(true);
    });
  });
  bunTest("a CRLF file and a file without a final newline keep track and agree with Bun", () => {
    const crlf = bytesOf("ZQ0_A=1\r\nZQ0_B=\r\nZQ0_C=\"x y\"\r\n");
    const noEol = bytesOf("ZQ1_A=1\nZQ1_B='2'");
    const bun = bunLoads([crlf, noEol]);
    expect(states(crlf)).toEqual({ set: ["ZQ0_A", "ZQ0_C"], unset: ["ZQ0_B"], lostTrack: false });
    expect(states(noEol)).toEqual({ set: ["ZQ1_A", "ZQ1_B"], unset: [], lostTrack: false });
    expect([...disagreements(crlf, bun[0]!), ...disagreements(noEol, bun[1]!)]).toEqual([]);
  });
});

describe("envFileKeyStates: the grammar, case by case", () => {
  test("empty values and empty quotes are unset, the last assignment decides, comments are no keys", () => {
    expect(states("A=\nB=\"\"\nC=''\n# D=1\n#\nE=1\nE=\nF=\nF=x\nexport G=y\n")).toEqual({ set: ["F", "G"], unset: ["A", "B", "C", "E"], lostTrack: false });
  });
  test("= : % ; { } inside a value are literal (measured), so they read as set", () => {
    expect(states("A==x\nB=a=b:c;d{e}f%g\nC=\"a=b :c\"\nD=postgres://u:p@h/db?x=1&y=2\n")).toEqual({ set: ["A", "B", "C", "D"], unset: [], lostTrack: false });
  });
  test("lost track reports the first line out of the grammar, 1-based, and no key", () => {
    expect(keyStates("A=1\n\nB=x y\nC=2\n")).toEqual({ keys: new Map(), lostTrack: true, lostLine: 3 });
  });
  test("each construct just outside the grammar loses track", () => {
    const cases: Part[] = ["export  A=1", "export\tA=1", " A=1", "A=1 ", "A =1", "1A=1", "A-B=1", "A.B=1", "A", "=1", 'A="  "', "A='x'y", "A=\"x\" ", "A=`x`", "A=\"a'b\"", " #c", "\t#c", "#\0c", "#\vc", "#\fc", "#\rc", "#c\r\r", "#\x7fc", "#\x80c", "#\x85c", "#\x9fc", bytesOf("#", [0xed, 0xa0, 0x80], "c"), bytesOf("#c", [0xed, 0xbf, 0xbf]), "A=x\r\r", "A=x\rB=y"];
    for (const c of cases) expect([show(bytesOf(c)), keyStates(c).lostTrack]).toEqual([show(bytesOf(c)), true]);
  });
  test("non-ASCII in a key, an unquoted value or a quoted value loses track", () => {
    for (const text of ["Aé=1\n", "A=é\n", "A=x—y\n", 'A="é"\n', "A='x y—'\n", "A= \n", "A=x \n", "A=x#é\n", "A=x # —\n", 'A="x" # é\n'])
      expect([text, keyStates(text)]).toEqual([text, { keys: new Map(), lostTrack: true, lostLine: 1 }]);
  });
  test("the line number of a lost line counts every line before it, comments included", () => {
    expect(keyStates("# — a\r\n\nA=1\n#\tb\nB=é\n")).toEqual({ keys: new Map(), lostTrack: true, lostLine: 5 });
  });
  test("ill-formed UTF-8 loses track at the line of its first bad byte; an earlier line out of the grammar wins", () => {
    expect(keyStates(bytesOf("A=1\n# ok\n#x", [0xff], "y\nB=1\n"))).toEqual({ keys: new Map(), lostTrack: true, lostLine: 3 });
    expect(keyStates(bytesOf("A=1\r\n#\r\n#x", [0xe2, 0x80], "\r\nB=1\r\n"))).toEqual({ keys: new Map(), lostTrack: true, lostLine: 3 });
    expect(keyStates(bytesOf("A=1\nB=x y\n#x", [0xc3], "\n"))).toEqual({ keys: new Map(), lostTrack: true, lostLine: 2 });
    expect(keyStates(bytesOf([0x80], "A=1\n"))).toEqual({ keys: new Map(), lostTrack: true, lostLine: 1 });
  });
  test("a BOM loses track on line 1 whatever follows it; U+FFFD only as its own three bytes, in a comment", () => {
    for (const body of ["A=1\n", "# c\nA=1\n", "\nA=1\n", "#\n", ""]) expect([body, keyStates(bytesOf(BOM, body))]).toEqual([body, { keys: new Map(), lostTrack: true, lostLine: 1 }]);
    expect(keyStates(bytesOf("A=1\n", BOM, "B=1\n"))).toEqual({ keys: new Map(), lostTrack: true, lostLine: 2 });
    expect(states(bytesOf("A=1\n#x", [0xef, 0xbf, 0xbd], "\n"))).toEqual({ set: ["A"], unset: [], lostTrack: false });
    expect(states(bytesOf("A=1\n#x", BOM, "y\n"))).toEqual({ set: ["A"], unset: [], lostTrack: false });
  });
});

describe("envFileKeyStates against Bun: comments beyond ASCII", () => {
  const DIRECT: [string, (p: string) => string][] = [
    ["an em dash comment", (p) => `${p}A=1\n# a — b\n${p}B=2\n`],
    ["an en dash comment", (p) => `${p}A=1\n# 2026–11\n${p}B=2\n`],
    ["# é", (p) => `${p}A=1\n# é\n${p}B=\n`],
    ["a comment with a tab", (p) => `${p}A=1\n#\tx\t\n${p}B=2\n`],
    ["a comment of only #", (p) => `${p}A=1\n#\n${p}B=2\n`],
    ["CRLF after a non-ASCII comment", (p) => `${p}A=1\r\n# → é —\r\n${p}B=2\r\n`],
    ["a non-ASCII comment as the last line, no newline", (p) => `${p}A=1\n# ✓ done`],
  ];
  DIRECT.forEach(([what, make]) => {
    bunTest(`${what}: keeps track and agrees with Bun`, () => {
      const bytes = bytesOf(make("ZQ0_"));
      expect(spec(bytes)).toBe(true);
      expect(envFileKeyStates(bytes).lostTrack).toBe(false);
      expect(disagreements(bytes, bunLoads([bytes])[0]!)).toEqual([]);
    });
  });
  bunTest("non-ASCII in a key, an unquoted value or a quoted value: lost track, no claim against Bun", () => {
    const files = ["ZQ0_Aé=1\nZQ0_B=1\n", "ZQ1_A=é\n", 'ZQ2_A="é"\n', "ZQ3_A='—'\n"].map((t) => bytesOf(t));
    const bun = bunLoads(files);
    files.forEach((b, i) => {
      expect([show(b), envFileKeyStates(b).lostTrack]).toEqual([show(b), true]);
      expect(disagreements(b, bun[i]!)).toEqual([]);
    });
  });

  /** The code points one comment character is tried with; the committed run is a fixed slice, `ENV_NAMES_SWEEP=full` the whole set. */
  function sweepCodePoints(): number[] {
    const out: number[] = [];
    const take = (c: number) => (c < 0xd800 || c > 0xdfff) && out.push(c);
    for (let c = 0; c <= 0xffff; c++) if (FULL || c <= 0x7ff || c % 17 === 0) take(c);
    for (let c = 0x10000; c <= 0x10ffff; c += FULL ? 251 : 4096) take(c);
    for (const c of [0x10ffff, 0xe000, 0xfffd, 0xfffe, 0xffff, 0x2028, 0x2029, 0x0085, 0x200b, 0x202e, 0xfeff]) take(c);
    return out;
  }
  bunTest("every code point in a comment, mid-comment and last: kept exactly where the grammar says, and then the comment swallows and hides nothing", () => {
    const started = performance.now();
    const cps = sweepCodePoints();
    const files = cps.flatMap((c, j) => {
      const ch = String.fromCodePoint(c);
      const [p, q] = [`ZQ${2 * j}_`, `ZQ${2 * j + 1}_`];
      return [bytesOf(`${p}A=1\n#x${ch}y\n${p}B=1\n`), bytesOf(`${q}A=1\n#x${ch}\n${q}B=1\n`)];
    });
    const bun = bunLoads(files);
    const bad: string[] = [];
    let kept = 0;
    files.forEach((b, i) => {
      const lost = envFileKeyStates(b).lostTrack;
      if (lost === spec(b)) bad.push(`U+${cps[i >> 1]!.toString(16)}: reader lostTrack=${lost}, grammar ${spec(b) ? "in" : "out"}`);
      if (lost) return;
      kept++;
      const m = bun[i]!;
      if (m.get(`ZQ${i}_A`) !== 1 || m.get(`ZQ${i}_B`) !== 1 || m.size !== 2) bad.push(`U+${cps[i >> 1]!.toString(16)} form ${i & 1}: Bun loaded ${JSON.stringify([...m])}`);
    });
    expect(bad).toEqual([]);
    expect(kept).toBeGreaterThan(files.length / 2);
    expect(kept).toBeLessThan(files.length);
    if (FULL) console.info(`code points: ${files.length} cases, ${kept} in the grammar, ${bad.length} disagreements, ${Math.round(performance.now() - started)} ms`);
  }, 120_000);
});

// ── the production read path ─────────────────────────────────────────────
describe("readDotEnv + probeEnv on the raw bytes", () => {
  /** One `.env` of exactly `bytes` in its own temp dir. */
  const dotEnvDir = (bytes: Uint8Array) => {
    const dir = testTempDirSync(path.join(tmpdir(), "env-names-read-"));
    writeFileSync(path.join(dir, ".env"), bytes);
    return dir;
  };
  const realDeps = (dir: string): ProbeDeps => ({ readEnvFile: () => readDotEnv(dir), processHasEnv: () => true }) as unknown as ProbeDeps;
  const UNKNOWN1 = { state: "unknown" as const, why: ".env line 1 is not a form muninn can read the way Bun does" };
  test("a UTF-8 BOM before FOO: Bun does not load FOO, so a shell-exported FOO is unknown, never ok", async () => {
    const dir = dotEnvDir(bytesOf(BOM, "FOO=1\nBAR=2\n"));
    expect(await probeEnv("FOO", realDeps(dir))).toEqual(UNKNOWN1);
    expect(await probeEnv("BAR", realDeps(dir))).toEqual(UNKNOWN1);
  });
  test("a UTF-16LE file with a BOM: Bun loads nothing, so every key is unknown, never ok", async () => {
    const dir = dotEnvDir(Uint8Array.from([0xff, 0xfe, ...[..."FOO=1\nBAR=2\n"].flatMap((c) => [c.charCodeAt(0), 0])]));
    expect(await probeEnv("FOO", realDeps(dir))).toEqual(UNKNOWN1);
    expect(await probeEnv("BAR", realDeps(dir))).toEqual(UNKNOWN1);
  });
  test("readDotEnv hands back the file's exact bytes; a missing file is no .env", async () => {
    const raw = bytesOf(BOM, "A=1\n#", [0xff, 0xfe, 0x00], "\r\n");
    const read = await readDotEnv(dotEnvDir(raw));
    expect("bytes" in read && [...read.bytes]).toEqual([...raw]);
    expect(await readDotEnv(testTempDirSync(path.join(tmpdir(), "env-names-none-")))).toEqual({ missing: true });
  });
  test("a plain file through the same path still answers ok", async () => {
    expect(await probeEnv("FOO", realDeps(dotEnvDir(bytesOf("FOO=1\nBAR=2\n"))))).toEqual({ state: "ok", why: "FOO is set in .env and in the running process" });
  });
  bunTest("ill-formed UTF-8 in a comment, read through readDotEnv: the reader loses track at that line, though Bun loads the next key", async () => {
    const SEQS: number[][] = [[0xe2, 0x80], [0xc3], [0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x9f], [0xf8, 0x88, 0x80, 0x80, 0x80]];
    for (let b = 0x80; b <= 0xff; b++) SEQS.push([b]);
    const dirs: string[] = [];
    const files: Uint8Array[] = [];
    for (const seq of SEQS)
      for (const [eol, mid] of [["\n", "y"], ["\n", ""], ["\r\n", ""]]) {
        const p = `ZQ${files.length}_`;
        const bytes = bytesOf(`${p}A=1${eol}#x`, seq, `${mid}${eol}${p}B=1${eol}`);
        files.push(bytes);
        dirs.push(dotEnvDir(bytes));
      }
    const loaded = bunLoads(files);
    const bad: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const read = await readDotEnv(dirs[i]!);
      if (!("bytes" in read)) {
        bad.push(`${i}: not read`);
        continue;
      }
      const r = envFileKeyStates(read.bytes);
      if (!r.lostTrack || r.lostLine !== 2 || spec(read.bytes)) bad.push(`${show(files[i]!)}: reader ${JSON.stringify(r.lostTrack && r.lostLine)}, grammar ${spec(read.bytes)}`);
      if (loaded[i]!.get(`ZQ${i}_A`) !== 1 || loaded[i]!.get(`ZQ${i}_B`) !== 1) bad.push(`${i}: Bun A=${loaded[i]!.get(`ZQ${i}_A`)} B=${loaded[i]!.get(`ZQ${i}_B`)}`);
    }
    expect(bad).toEqual([]);
    expect(files.length).toBe(SEQS.length * 3);
  });
});

describe("envFileKeyStates: no value leaves it", () => {
  test("no marker substring in the result, the probe's answers or a thrown error, and the module logs nothing", async () => {
    const markers = ["MARKERone", "MARKERtwo", "MARKERthree", "MARKERfour", "MARKERfive", "MARKERsix", "MARKERseven"];
    const files = [
      `A=${markers[0]}\nB="${markers[1]} x"\nC='${markers[2]}'\n`,
      `A=${markers[3]} broken\nB=${markers[0]}\n`,
      `# ${markers[4]} — é\nA=1\n#\t${markers[5]}\n`,
      `# ${markers[4]} —\nA=${markers[6]}é\n`,
      `A=1\n#${markers[5]}\v${markers[6]}\nB=2\n`,
      bytesOf(`A=${markers[0]}\n#${markers[1]}`, [0xff], `${markers[2]}\nB=1\n`),
      bytesOf(BOM, `A=${markers[3]}\n`),
    ].map((p) => bytesOf(p));
    const seen: string[] = [];
    for (const bytes of files) {
      try {
        seen.push(JSON.stringify(states(bytes)), JSON.stringify(envFileKeyStates(bytes)));
      } catch (e) {
        seen.push(String(e));
      }
      for (const key of ["A", "B", "C", "NOPE"])
        for (const has of [true, false]) seen.push(JSON.stringify(await probeEnv(key, envDeps(bytes, has))));
    }
    expect(seen.length).toBe(files.length * (2 + 8));
    // Every answer kind is exercised: a kept file, a lost line, a lost bad byte, a lost BOM.
    expect(seen.some((s) => s.includes('"state":"ok"'))).toBe(true);
    expect(seen.some((s) => s.includes(".env line 2 is not"))).toBe(true);
    expect(seen.some((s) => s.includes(".env line 1 is not"))).toBe(true);
    for (const m of markers) for (const s of seen) expect(s).not.toContain(m);
    // Nothing to log with: the reader imports nothing.
    expect(readFileSync(path.join(import.meta.dir, "env-names.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
  });
});

function envDeps(x: Part, processHas: boolean): ProbeDeps {
  const bytes = bytesOf(x);
  return { readEnvFile: async () => ({ bytes }), processHasEnv: () => processHas } as unknown as ProbeDeps;
}

describe("probeEnv over the reader", () => {
  test("lost track answers unknown for every key, even one assigned before the broken line and held by the process", async () => {
    for (const key of ["EARLY", "LATE", "NOPE"])
      expect(await probeEnv(key, envDeps("EARLY=1\nBAD LINE\nLATE=2\n", true))).toEqual({ state: "unknown", why: ".env line 2 is not a form muninn can read the way Bun does" });
  });
});

// ── (a) every character in every position ────────────────────────────────
describe("envFileKeyStates against Bun: every character in every position", () => {
  bunTest(`(a) ${PLAIN.length + EXTRA.length} characters × 8 positions`, () => {
    const makers = [...PLAIN, ...EXTRA].flatMap((c) => [
      (p: string) => `${p}K=${c}\n`,
      (p: string) => `${p}K=x${c}\n`,
      (p: string) => `${p}K=${c}x\n`,
      (p: string) => `${p}K="${c}"\n`,
      (p: string) => `${p}K='${c}'\n`,
      (p: string) => `${p}K="x${c}"\n`,
      (p: string) => `${p}K=x\n${c}${p}K2=y\n`,
      (p: string) => `export ${p}K=${c}\n`,
    ]);
    const { files, bad } = sweep(makers);
    expect(bad).toEqual([]);
    // Both kinds are present: the sweep is not all lost or all kept.
    expect(files.filter(spec).length).toBeGreaterThan(400);
    expect(files.filter((b) => !spec(b)).length).toBeGreaterThan(100);
    if (FULL) console.info(`(a) ${files.length} files, ${files.filter(spec).length} in the grammar`);
  });
});

// ── (b) every two-character value ────────────────────────────────────────
describe("envFileKeyStates against Bun: every two-character value", () => {
  bunTest(`(b) 95² values × unquoted, "…", '…'`, () => {
    const makers: ((p: string) => string)[] = [];
    for (const a of PLAIN)
      for (const b of PLAIN)
        for (const wrap of [(v: string) => v, (v: string) => `"${v}"`, (v: string) => `'${v}'`])
          makers.push((p) => `${p}K=${wrap(a + b)}\n`);
    const { files, bad } = sweep(makers);
    expect(bad).toEqual([]);
    expect(files.length).toBe(95 * 95 * 3);
    if (FULL) console.info(`(b) ${files.length} values, ${files.filter(spec).length} in the grammar`);
  }, 60_000);
});

// ── (c) and (d) seeded files ─────────────────────────────────────────────
/** mulberry32: a fixed seed gives the same files every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const pick = <T,>(r: R, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const SAFE = PLAIN.filter((c) => isSafe(c.charCodeAt(0)));
/** What a seeded comment is drawn from: ASCII, tab, and non-ASCII from every UTF-8 length, the separators and the specials. */
const COMMENT_CHARS = [...PLAIN, "\t", "\t", ..."é—–→   ​‮﻿�￾￿ø漢✓", "\u{1f600}", "\u{10ffff}", "\u{10000}"];
const str = (r: R, alphabet: readonly string[], min: number, max: number) => Array.from({ length: min + Math.floor(r() * (max - min + 1)) }, () => pick(r, alphabet)).join("");

/** One in-grammar `.env` text whose keys all carry prefix `p`. */
function inGrammarText(r: R, p: string): string {
  const keys = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, ["", "_", "x", "export", "export_"]) + p + str(r, ["A", "b", "_", "9"], 0, 3));
  const lines: string[] = [];
  for (let i = 0, n = 1 + Math.floor(r() * 8); i < n; i++) {
    const roll = r();
    let line: string;
    if (roll < 0.08) line = "";
    else if (roll < 0.16) line = "#" + str(r, COMMENT_CHARS, 0, 12);
    else {
      const v = r();
      let value: string;
      if (v < 0.15) value = "";
      else if (v < 0.55) value = str(r, SAFE, 1, 10);
      else {
        const q = pick(r, ['"', "'"]);
        const body = r() < 0.1 ? "" : str(r, [...SAFE, " ", " "], 0, 8);
        value = q + ([...body].some((c) => isSafe(c.charCodeAt(0))) || body === "" ? body : body + "x") + q;
      }
      line = (r() < 0.2 ? "export " : "") + pick(r, keys) + "=" + value;
    }
    lines.push(line + (r() < 0.2 ? "\r" : ""));
  }
  return lines.join("\n") + (r() < 0.7 ? "\n" : "");
}

const ODD_PARTS = ["v", " ", "\t", "\f", "\v", " ", "﻿", "é", " ", "\r", '"', "'", "`", "\\", "$", "${X}", "#", " #c", "=", ":", "\\n", "x y", "''", '""'];
const ODD_SEPS = ["=", "=", " = ", "\t=", "=\f", "=\v", ":", ": ", " :", ":'", ':"', ""];
const ODD_LINES = ["", "   ", "\t", "# c", '# "q', " # x", "text", "just 'text", "=x", "export", "export ", '"', "'", "﻿", "\f", " "];
/** One `.env` text from what a hand-written file holds and what Bun reads oddly; keys carry prefix `p`. */
function oddText(r: R, p: string): string {
  const lines: string[] = [];
  for (let i = 0, n = 1 + Math.floor(r() * 7); i < n; i++) {
    if (r() < 0.12) {
      lines.push(pick(r, ODD_LINES));
      continue;
    }
    if (r() < 0.35) {
      lines.push(inGrammarText(r, p).split("\n")[0]!);
      continue;
    }
    let value = Array.from({ length: Math.floor(r() * 4) }, () => pick(r, ODD_PARTS)).join("");
    if (r() < 0.25) {
      const q = pick(r, ['"', "'", "`"]);
      value = pick(r, ["", "", " ", "\f", "\v", "\t"]) + q + value + (r() < 0.8 ? q : "") + (r() < 0.2 ? pick(r, [" #c", " x", "", "\t", " "]) : "");
    }
    const sep = r() < 0.6 ? "=" : pick(r, ODD_SEPS);
    lines.push(pick(r, ["", "", "", "export ", "export  ", "export\t", " ", "\t"]) + pick(r, ["", "", "x", "-", "1"]) + p + pick(r, ["A", "B", "C", "-D", ".E"]) + sep + value);
  }
  return (r() < 0.04 ? "﻿" : "") + lines.join(pick(r, ["\n", "\n", "\r\n", "\r"])) + (r() < 0.7 ? "\n" : "");
}

describe("envFileKeyStates against Bun: seeded files", () => {
  const FILES = FULL ? 20_000 : 400;
  bunTest(`(c) ${FILES} in-grammar files: the reader never loses track and agrees with Bun on every key`, () => {
    const r = rng(8480);
    const { files, bad } = sweep(Array.from({ length: FILES }, () => (p: string) => inGrammarText(r, p)));
    expect(files.every(spec)).toBe(true);
    expect(bad).toEqual([]);
    if (FULL) console.info(`(c) ${files.length} files, ${files.reduce((n, b) => n + envFileKeyStates(b).keys.size, 0)} keys`);
  }, 120_000);
  bunTest(`(d) ${FILES} arbitrary files: lost track exactly off the grammar, no false set, unset or absence where it keeps track`, () => {
    const r = rng(8481);
    const { files, bad } = sweep(Array.from({ length: FILES }, () => (p: string) => oddText(r, p)));
    expect(bad).toEqual([]);
    const kept = keptCount(files);
    // Both sides are exercised.
    expect(kept).toBeGreaterThan(FILES / 20);
    expect(kept).toBeLessThan(FILES);
    if (FULL) console.info(`(d) kept track on ${kept} of ${FILES}`);
  }, 120_000);
});

// ── (i)–(v) the byte layer ───────────────────────────────────────────────
const utf16 = (s: string, le: boolean) => [...s].flatMap((c) => (le ? [c.charCodeAt(0), 0] : [0, c.charCodeAt(0)]));
const BODIES: [string, (p: string) => string][] = [
  ["K=1 L=2", (p) => `${p}K=1\n${p}L=2\n`],
  ["# c, K=1", (p) => `# c\n${p}K=1\n`],
  ["empty line, K=1", (p) => `\n${p}K=1\n`],
];

describe("envFileKeyStates against Bun: (i) byte-order marks and their places", () => {
  /** Each place: its bytes around a body, and whether it puts a mark at the very start of the file. */
  const PLACES: [string, (body: string, p: string) => Part, boolean][] = [
    ["none", (b) => b, false],
    ["UTF-8 BOM", (b) => bytesOf(BOM, b), true],
    ["UTF-16LE BOM", (b) => bytesOf([0xff, 0xfe], b), true],
    ["UTF-16BE BOM", (b) => bytesOf([0xfe, 0xff], b), true],
    ["UTF-32LE BOM", (b) => bytesOf([0xff, 0xfe, 0, 0], b), true],
    ["UTF-32BE BOM", (b) => bytesOf([0, 0, 0xfe, 0xff], b), true],
    ["two BOMs", (b) => bytesOf(BOM, BOM, b), true],
    ["BOM after a leading newline", (b) => bytesOf("\n", BOM, b), false],
    ["BOM at the start of line 2", (b) => bytesOf(b.slice(0, b.indexOf("\n") + 1), BOM, b.slice(b.indexOf("\n") + 1)), false],
    ["BOM inside a comment", (b, p) => bytesOf(`${p}A=1\n#x`, BOM, "y\n", b), false],
    ["BOM inside a quoted value", (b, p) => bytesOf(`${p}Q="a`, BOM, 'b"\n', b), false],
    ["BOM at the end of the file", (b) => bytesOf(b, BOM), false],
  ];
  bunTest(`(i) ${PLACES.length} places × ${BODIES.length} bodies`, () => {
    const makers = PLACES.flatMap(([, place]) => BODIES.map(([, body]) => (p: string) => place(body(p), p)));
    const { files, bad } = sweep(makers);
    expect(bad).toEqual([]);
    PLACES.forEach(([what, , atStart], i) =>
      BODIES.forEach(([body], j) => {
        const r = envFileKeyStates(files[i * BODIES.length + j]!);
        if (atStart) expect([what, body, r.lostTrack && r.lostLine]).toEqual([what, body, 1]);
      }),
    );
    // A mark inside a comment is comment content to Bun and to the reader.
    expect(PLACES.map(([w], i) => [w, BODIES.map((_, j) => !envFileKeyStates(files[i * BODIES.length + j]!).lostTrack)])).toEqual(
      PLACES.map(([w]) => [w, BODIES.map(() => w === "none" || w === "BOM inside a comment")]),
    );
  });
});

describe("envFileKeyStates against Bun: (ii) other encodings", () => {
  bunTest("(ii) whole files in UTF-16LE/BE with and without a BOM, and Latin-1 bytes 0x80–0xFF in a comment, a value and a key", () => {
    const makers: ((p: string) => Part)[] = [];
    for (const [, body] of BODIES)
      for (const le of [true, false])
        for (const bom of [true, false]) makers.push((p) => Uint8Array.from([...(bom ? (le ? [0xff, 0xfe] : [0xfe, 0xff]) : []), ...utf16(body(p), le)]));
    const encodings = makers.length;
    for (let b = 0x80; b <= 0xff; b++)
      makers.push((p) => bytesOf(`${p}A=1\n# caf`, [b], `\n${p}B=1\n`), (p) => bytesOf(`${p}A=caf`, [b], `\n${p}B=1\n`), (p) => bytesOf(`${p}A`, [b], `=1\n${p}B=1\n`));
    const { files, bad } = sweep(makers);
    expect(bad).toEqual([]);
    // No UTF-16 file and no lone Latin-1 byte is in the grammar.
    expect(keptCount(files)).toBe(0);
    expect(files.length).toBe(encodings + 128 * 3);
  });
});

describe("envFileKeyStates against Bun: (iii) every byte in seven places", () => {
  const PLACES: ((p: string, b: number) => Part)[] = [
    (p, b) => bytesOf([b], `${p}K=1\n${p}L=2\n`),
    (p, b) => bytesOf(`${p}A=1\n#x`, [b], `y\n${p}B=1\n`),
    (p, b) => bytesOf(`${p}A=1\n#x`, [b], `\n${p}B=1\n`),
    (p, b) => bytesOf(`${p}K=x`, [b], `y\n${p}B=1\n`),
    (p, b) => bytesOf(`${p}K="x`, [b], `y"\n${p}B=1\n`),
    (p, b) => bytesOf(`${p}K`, [b], `K=1\n${p}B=1\n`),
    (p, b) => bytesOf(`${p}A=1\r`, [b], `\n${p}B=1\n`),
  ];
  bunTest("(iii) 256 bytes × 7 places", () => {
    const makers = Array.from({ length: 256 }, (_, b) => PLACES.map((place) => (p: string) => place(p, b))).flat();
    const { files, bad } = sweep(makers);
    expect(bad).toEqual([]);
    expect(files.length).toBe(256 * 7);
    const kept = keptCount(files);
    expect(kept).toBeGreaterThan(300);
    expect(kept).toBeLessThan(files.length);
    // Every byte from 0x80 up is ill-formed alone: lost in every place.
    expect(files.slice(0x80 * 7).filter((b) => !envFileKeyStates(b).lostTrack).length).toBe(0);
  }, 60_000);
});

describe("envFileKeyStates against Bun: (iv) two-byte sequences and malformed UTF-8", () => {
  bunTest(`(iv) leads 0xC0–0xFF × ${FULL ? "every" : "every continuation and every 5th other"} second byte, mid-comment and before the newline, plus the classic malformed set`, () => {
    const started = performance.now();
    const seqs: number[][] = [];
    for (let lead = 0xc0; lead <= 0xff; lead++) for (let b = 0; b <= 0xff; b++) if (FULL || (b >= 0x80 && b <= 0xbf) || b % 5 === 0) seqs.push([lead, b]);
    const pairs = seqs.length;
    seqs.push(
      [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf], [0xf0, 0x80, 0x80, 0x80], [0xf0, 0x8f, 0xbf, 0xbf],
      [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xed, 0x9f, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf],
      [0xe2, 0x80], [0xe2], [0xf0, 0x9f, 0x98], [0xf0, 0x9f], [0xf0], [0xef, 0xbf, 0xbd], [0xef, 0xbb, 0xbf],
      [0xf8, 0x88, 0x80, 0x80, 0x80], [0xfc, 0x84, 0x80, 0x80, 0x80, 0x80], [0xfe], [0xff], [0xff, 0xfe],
    );
    const makers = seqs.flatMap((s, j) => {
      const forms = [(p: string) => bytesOf(`${p}A=1\n#x`, s, `y\n${p}B=1\n`), (p: string) => bytesOf(`${p}A=1\n#x`, s, `\n${p}B=1\n`)];
      if (j >= pairs) forms.push((p) => bytesOf(`${p}A=1\r\n#x`, s, `\r\n${p}B=1\r\n`), (p) => bytesOf(`${p}A=1\n${p}V=x`, s, `\n${p}B=1\n`));
      return forms;
    });
    const { files, bad } = sweep(makers);
    expect(bad).toEqual([]);
    const kept = keptCount(files);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(files.length);
    if (FULL) console.info(`(iv) ${files.length} cases, ${kept} kept track, ${bad.length} disagreements, ${Math.round(performance.now() - started)} ms`);
  }, 120_000);
});

describe("envFileKeyStates against Bun: (v) seeded byte files", () => {
  const FILES = FULL ? 20_000 : 400;
  /** One file of byte fragments around prefix-`p` keys: in-grammar lines, BOMs, stray and well-formed multi-byte sequences, controls and raw bytes. */
  function byteFile(r: R, p: string): Uint8Array {
    const FRAG: (() => Part)[] = [
      () => inGrammarText(r, p),
      () => `${p}${pick(r, ["A", "B", "C"])}=`,
      () => pick(r, ["x", "1", '"', "'", "#", " ", "\t", "\r", "\n", "\r\n", "=", "$", "\\"]),
      () => BOM,
      () => [pick(r, [0xff, 0xfe, 0xc0, 0xc3, 0xe2, 0xed, 0xf0, 0xf4, 0xf8, 0x80, 0xbf])],
      () => [Math.floor(r() * 256)],
      () => [0xc3, 0xa9],
      () => [0xe2, 0x80, pick(r, [0x94, 0xa8, 0xa9, 0x8b])],
      () => [0xf0, 0x9f, 0x98, 0x80],
      () => [0xef, 0xbf, 0xbd],
      () => [0],
      () => `#${str(r, COMMENT_CHARS, 0, 6)}`,
    ];
    const parts: Part[] = [];
    for (let i = 0, n = 1 + Math.floor(r() * 10); i < n; i++) parts.push(r() < 0.35 ? FRAG[0]!() : pick(r, FRAG)());
    return bytesOf(...parts);
  }
  bunTest(`(v) ${FILES} seeded byte files: lost track exactly off the grammar, no false set, unset or absence where it keeps track`, () => {
    const started = performance.now();
    const r = rng(8482);
    const { files, bad } = sweep(Array.from({ length: FILES }, () => (p: string) => byteFile(r, p)));
    expect(bad).toEqual([]);
    const kept = keptCount(files);
    expect(kept).toBeGreaterThan(FILES / 20);
    expect(kept).toBeLessThan(FILES);
    if (FULL) console.info(`(v) kept track on ${kept} of ${FILES}, ${bad.length} disagreements, ${Math.round(performance.now() - started)} ms`);
  }, 120_000);
});
