/**
 * The `.env` key-state reader, held to Bun itself. Every Bun comparison loads
 * the same text with a child `bun --env-file=<temp file>` (one file per case,
 * many files per child: Bun parses each file on its own) and reads back key
 * NAMES and value LENGTHS only. Every key a case writes carries the prefix
 * `ZQ<case>_`, so the child's own environment never mixes in and each key is
 * charged to its case. The real `.env` is never read here.
 *
 * `spec` below restates the grammar as a hand-written scanner, apart from the
 * reader's regexes: a case's expected «keeps track» comes from it, Bun decides
 * set/unset. `ENV_NAMES_SWEEP=full` runs the one-off sizes (20,000 files each for
 * (c) and (d)).
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

// ── the grammar, restated ────────────────────────────────────────────────
const code = (ch: string) => (ch.length === 1 ? ch.charCodeAt(0) : -1);
const isPlain = (ch: string) => code(ch) >= 0x20 && code(ch) <= 0x7e;
const isSafe = (ch: string) => code(ch) >= 0x21 && code(ch) <= 0x7e && !"\"'`\\$#".includes(ch);
const isKeyStart = (ch: string) => /^[A-Za-z_]$/.test(ch);
const isKeyChar = (ch: string) => /^[A-Za-z0-9_]$/.test(ch);
/** One code point of a comment: tab, printable ASCII, or a scalar value at U+00A0 or above (a lone surrogate is none). */
const isCommentChar = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  return ch === "\t" || isPlain(ch) || (cp >= 0xa0 && (cp < 0xd800 || cp > 0xdfff));
};
function specLine(line: string): boolean {
  if (line === "") return true;
  if (line[0] === "#") return [...line.slice(1)].every(isCommentChar);
  const s = line.startsWith("export ") ? line.slice(7) : line;
  const eq = s.indexOf("=");
  if (eq < 1) return false;
  const key = s.slice(0, eq);
  if (!isKeyStart(key[0]!) || ![...key].every(isKeyChar)) return false;
  const v = s.slice(eq + 1);
  if (v === "") return true;
  if (v[0] === '"' || v[0] === "'") {
    if (v.length < 2 || v[v.length - 1] !== v[0]) return false;
    const body = [...v.slice(1, -1)];
    return body.every((c) => isSafe(c) || c === " ") && (body.length === 0 || body.some(isSafe));
  }
  return [...v].every(isSafe);
}
const spec = (text: string) => text.split("\n").every((l) => specLine(l.endsWith("\r") ? l.slice(0, -1) : l));

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
/** Per text, the keys Bun loads from it and each value's length. Text `i` must name its keys `ZQ<i>_…`. */
function bunLoads(texts: readonly string[]): Map<string, number>[] {
  const out = texts.map(() => new Map<string, number>());
  const dir = testTempDirSync(path.join(ROOT, `b${batch++}-`));
  for (let start = 0; start < texts.length; start += 1000) {
    const files: string[] = [];
    for (let i = start; i < Math.min(texts.length, start + 1000); i++) {
      const f = path.join(dir, `f${i}.env`);
      writeFileSync(f, texts[i]!);
      files.push(`--env-file=${f}`);
    }
    const proc = Bun.spawnSync([process.execPath, ...files, "-e", PRINT], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`bun exited ${proc.exitCode}`);
    for (const [k, len] of JSON.parse(proc.stdout.toString()) as [string, number][]) out[Number(/ZQ(\d+)_/.exec(k)![1])]?.set(k, len);
  }
  // Removed now, not at the run's end: the full sweep writes ~200,000 files, past the end hook's timeout.
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/** Where the reader keeps track: every claim it makes against Bun, and every non-empty Bun key it misses. */
function disagreements(text: string, bun: Map<string, number>): string[] {
  const ours = envFileKeyStates(text);
  if (ours.lostTrack) return [];
  const bad: string[] = [];
  for (const [k, s] of ours.keys) {
    const len = bun.get(k) ?? 0;
    if (s === "set" && len === 0) bad.push(`${JSON.stringify(text)}: ${k} reader set, Bun empty`);
    else if (s === "unset" && len > 0) bad.push(`${JSON.stringify(text)}: ${k} reader unset, Bun non-empty`);
    else if (s !== "set" && s !== "unset") bad.push(`${JSON.stringify(text)}: ${k} reader ${s} without losing track`);
  }
  for (const [k, len] of bun) if (len > 0 && !ours.keys.has(k)) bad.push(`${JSON.stringify(text)}: ${k} reader absent, Bun non-empty`);
  return bad;
}
/** Whether the reader keeps track exactly where the grammar says it should. */
const trackMismatch = (text: string) => (envFileKeyStates(text).lostTrack === spec(text) ? [`${JSON.stringify(text)}: reader lostTrack=${envFileKeyStates(text).lostTrack}, grammar ${spec(text) ? "in" : "out"}`] : []);

/** Builds one case's text from its key prefix, checks all, returns the failures. */
function sweep(makers: readonly ((p: string) => string)[]): { texts: string[]; bad: string[] } {
  const texts = makers.map((m, i) => m(`ZQ${i}_`));
  const bun = bunLoads(texts);
  const bad = texts.flatMap((t, i) => [...trackMismatch(t), ...disagreements(t, bun[i]!)]);
  return { texts, bad };
}

const PLAIN = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));
const EXTRA = ["\t", "\r", "\f", "\v", "\0", " ", "﻿", " ", "é"];

// ── (e) the historical repros ────────────────────────────────────────────
describe("envFileKeyStates: the historical repros", () => {
  const LOST: [string, (p: string) => string][] = [
    ["form feed before empty quotes (Bun loads empty)", (p) => `${p}K=\f''\n`],
    ["vertical tab before empty quotes (Bun loads empty)", (p) => `${p}K=\v""\n`],
    ["a value that is only U+00A0 (Bun keeps it)", (p) => `${p}K= \n`],
    ["a value that is one space", (p) => `${p}K= \n`],
    ["an empty colon form before the key", (p) => `${p}OTHER:\n${p}K=1\n`],
    ["a colon form with a value", (p) => `${p}K: v\n`],
    ["an escaped quote hiding the next line", (p) => `${p}ESC="a\\"\n${p}INESC=fake\ntail"\n`],
    ["$UNSET", (p) => `${p}K=$UNSET\n`],
    ["${UNSET}", (p) => `${p}K=\${UNSET}\n`],
    ["an unclosed quote", (p) => `${p}K="abc\n${p}AFTER=after\n`],
    ["a BOM", (p) => `﻿${p}K=1\n`],
    ["spaces around =", (p) => `${p}K = v\n`],
    ["an inline comment", (p) => `${p}K=v # c\n`],
  ];
  LOST.forEach(([what, make]) => {
    bunTest(`${what}: no claim against Bun, and the reader loses track`, () => {
      const text = make("ZQ0_");
      expect(disagreements(text, bunLoads([text])[0]!)).toEqual([]);
      expect(envFileKeyStates(text).lostTrack).toBe(true);
    });
  });
  bunTest("a CRLF file and a file without a final newline keep track and agree with Bun", () => {
    const crlf = "ZQ0_A=1\r\nZQ0_B=\r\nZQ0_C=\"x y\"\r\n";
    const noEol = "ZQ1_A=1\nZQ1_B='2'";
    const bun = bunLoads([crlf, noEol]);
    expect(states(crlf)).toEqual({ set: ["ZQ0_A", "ZQ0_C"], unset: ["ZQ0_B"], lostTrack: false });
    expect(states(noEol)).toEqual({ set: ["ZQ1_A", "ZQ1_B"], unset: [], lostTrack: false });
    expect([...disagreements(crlf, bun[0]!), ...disagreements(noEol, bun[1]!)]).toEqual([]);
  });
});

const states = (text: string) => {
  const r = envFileKeyStates(text);
  const by = (s: string) => [...r.keys].filter(([, v]) => v === s).map(([k]) => k).sort();
  return { set: by("set"), unset: by("unset"), lostTrack: r.lostTrack };
};

describe("envFileKeyStates: the grammar, case by case", () => {
  test("empty values and empty quotes are unset, the last assignment decides, comments are no keys", () => {
    expect(states("A=\nB=\"\"\nC=''\n# D=1\n#\nE=1\nE=\nF=\nF=x\nexport G=y\n")).toEqual({ set: ["F", "G"], unset: ["A", "B", "C", "E"], lostTrack: false });
  });
  test("= : % ; { } inside a value are literal (measured), so they read as set", () => {
    expect(states("A==x\nB=a=b:c;d{e}f%g\nC=\"a=b :c\"\nD=postgres://u:p@h/db?x=1&y=2\n")).toEqual({ set: ["A", "B", "C", "D"], unset: [], lostTrack: false });
  });
  test("lost track reports the first line out of the grammar, 1-based, and no key", () => {
    const r = envFileKeyStates("A=1\n\nB=x y\nC=2\n");
    expect(r).toEqual({ keys: new Map(), lostTrack: true, lostLine: 3 });
  });
  test("each construct just outside the grammar loses track", () => {
    for (const text of ["export  A=1", "export\tA=1", " A=1", "A=1 ", "A =1", "1A=1", "A-B=1", "A.B=1", "A", "=1", 'A="  "', "A='x'y", "A=\"x\" ", "A=`x`", "A=\"a'b\"", " #c", "\t#c", "#\0c", "#\vc", "#\fc", "#\rc", "#c\r\r", "#\x7fc", "#\x80c", "#\x85c", "#\x9fc", "#\ud800c", "#c\udfff", "A=x\r\r", "A=x\rB=y"])
      expect([text, envFileKeyStates(text).lostTrack]).toEqual([text, true]);
  });
  test("non-ASCII in a key, an unquoted value or a quoted value loses track", () => {
    for (const text of ["Aé=1\n", "A=é\n", "A=x—y\n", 'A="é"\n', "A='x y—'\n", "A=\u00a0\n", "A=x\u2028\n", "A=x#é\n", "A=x # —\n", 'A="x" # é\n'])
      expect([text, envFileKeyStates(text)]).toEqual([text, { keys: new Map(), lostTrack: true, lostLine: 1 }]);
  });
  test("the line number of a lost line counts every line before it, comments included", () => {
    expect(envFileKeyStates("# — a\r\n\nA=1\n#\tb\nB=é\n")).toEqual({ keys: new Map(), lostTrack: true, lostLine: 5 });
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
      const text = make("ZQ0_");
      expect(spec(text)).toBe(true);
      expect(envFileKeyStates(text).lostTrack).toBe(false);
      expect(disagreements(text, bunLoads([text])[0]!)).toEqual([]);
    });
  });
  bunTest("non-ASCII in a key, an unquoted value or a quoted value: lost track, no claim against Bun", () => {
    const texts = ["ZQ0_Aé=1\nZQ0_B=1\n", "ZQ1_A=é\n", 'ZQ2_A="é"\n', "ZQ3_A='—'\n"];
    const bun = bunLoads(texts);
    texts.forEach((t, i) => {
      expect([t, envFileKeyStates(t).lostTrack]).toEqual([t, true]);
      expect(disagreements(t, bun[i]!)).toEqual([]);
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
    const makers = cps.flatMap((c) => {
      const ch = String.fromCodePoint(c);
      return [(p: string) => `${p}A=1\n#x${ch}y\n${p}B=1\n`, (p: string) => `${p}A=1\n#x${ch}\n${p}B=1\n`];
    });
    const texts = makers.map((m, i) => m(`ZQ${i}_`));
    const bun = bunLoads(texts);
    const bad: string[] = [];
    let kept = 0;
    texts.forEach((t, i) => {
      const lost = envFileKeyStates(t).lostTrack;
      if (lost === spec(t)) bad.push(`U+${cps[i >> 1]!.toString(16)}: reader lostTrack=${lost}, grammar ${spec(t) ? "in" : "out"}`);
      if (lost) return;
      kept++;
      const m = bun[i]!;
      if (m.get(`ZQ${i}_A`) !== 1 || m.get(`ZQ${i}_B`) !== 1 || m.size !== 2) bad.push(`U+${cps[i >> 1]!.toString(16)} form ${i & 1}: Bun loaded ${JSON.stringify([...m])}`);
    });
    expect(bad).toEqual([]);
    expect(kept).toBeGreaterThan(texts.length / 2);
    expect(kept).toBeLessThan(texts.length);
    if (FULL) console.info(`code points: ${texts.length} cases, ${kept} in the grammar, ${bad.length} disagreements, ${Math.round(performance.now() - started)} ms`);
  }, 120_000);

  bunTest("malformed UTF-8 in a comment: readDotEnv decodes it to U+FFFD with the newlines intact, the reader keeps track, and Bun still loads the next key", async () => {
    const SEQS: number[][] = [[0xe2, 0x80], [0xc3], [0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x9f], [0xf8, 0x88, 0x80, 0x80, 0x80]];
    for (let b = 0x80; b <= 0xff; b++) SEQS.push([b]);
    const utf8 = (s: string) => [...new TextEncoder().encode(s)];
    const dirs: string[] = [];
    const files: Uint8Array[] = [];
    SEQS.forEach((seq, j) => {
      for (const [eol, mid] of [["\n", "y"], ["\n", ""], ["\r\n", ""]]) {
        const p = `ZQ${files.length}_`;
        files.push(Uint8Array.from([...utf8(`${p}A=1${eol}#x`), ...seq, ...utf8(`${mid}${eol}${p}B=1${eol}`)]));
        dirs.push(testTempDirSync(path.join(ROOT, `raw${j}-`)));
      }
    });
    files.forEach((bytes, i) => writeFileSync(path.join(dirs[i]!, ".env"), bytes));
    const proc = Bun.spawnSync([process.execPath, ...dirs.map((d) => `--env-file=${path.join(d, ".env")}`), "-e", PRINT], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    const loaded = new Map(JSON.parse(proc.stdout.toString()) as [string, number][]);
    const bad: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const read = await readDotEnv(dirs[i]!);
      if (!("text" in read)) {
        bad.push(`${i}: not read`);
        continue;
      }
      const lines = read.text.split("\n");
      if (lines.length !== 4 || !lines[1]!.includes("\ufffd")) bad.push(`${i}: decoded to ${lines.length} lines, U+FFFD ${lines[1]!.includes("\ufffd")}`);
      if (envFileKeyStates(read.text).lostTrack || !spec(read.text)) bad.push(`${i}: reader or grammar out`);
      if (loaded.get(`ZQ${i}_A`) !== 1 || loaded.get(`ZQ${i}_B`) !== 1) bad.push(`${i}: Bun A=${loaded.get(`ZQ${i}_A`)} B=${loaded.get(`ZQ${i}_B`)}`);
    }
    expect(bad).toEqual([]);
    expect(files.length).toBe(SEQS.length * 3);
  });
});

describe("envFileKeyStates: no value leaves it", () => {
  test("no marker substring in the result, the probe's answers or a thrown error, and the module logs nothing", async () => {
    const markers = ["MARKERone", "MARKERtwo", "MARKERthree", "MARKERfour", "MARKERfive", "MARKERsix", "MARKERseven"];
    const texts = [
      `A=${markers[0]}\nB="${markers[1]} x"\nC='${markers[2]}'\n`,
      `A=${markers[3]} broken\nB=${markers[0]}\n`,
      `# ${markers[4]} — é\nA=1\n#\t${markers[5]}\n`,
      `# ${markers[4]} —\nA=${markers[6]}é\n`,
      `A=1\n#${markers[5]}\v${markers[6]}\nB=2\n`,
    ];
    const seen: string[] = [];
    for (const text of texts) {
      try {
        seen.push(JSON.stringify(states(text)), JSON.stringify(envFileKeyStates(text)));
      } catch (e) {
        seen.push(String(e));
      }
      for (const key of ["A", "B", "C", "NOPE"])
        for (const has of [true, false]) seen.push(JSON.stringify(await probeEnv(key, envDeps(text, has))));
    }
    expect(seen.length).toBe(texts.length * (2 + 8));
    // Both answers are exercised: a kept file and a lost one.
    expect(seen.some((s) => s.includes('"state":"ok"'))).toBe(true);
    expect(seen.some((s) => s.includes(".env line 2 is not"))).toBe(true);
    for (const m of markers) for (const s of seen) expect(s).not.toContain(m);
    // Nothing to log with: the reader imports nothing.
    expect(readFileSync(path.join(import.meta.dir, "env-names.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
  });
});

function envDeps(text: string, processHas: boolean): ProbeDeps {
  return { readEnvFile: async () => ({ text }), processHasEnv: () => processHas } as unknown as ProbeDeps;
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
    const { texts, bad } = sweep(makers);
    expect(bad).toEqual([]);
    // Both kinds are present: the sweep is not all lost or all kept.
    expect(texts.filter(spec).length).toBeGreaterThan(400);
    expect(texts.filter((t) => !spec(t)).length).toBeGreaterThan(100);
    if (FULL) console.info(`(a) ${texts.length} files, ${texts.filter(spec).length} in the grammar`);
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
    const { texts, bad } = sweep(makers);
    expect(bad).toEqual([]);
    expect(texts.length).toBe(95 * 95 * 3);
    if (FULL) console.info(`(b) ${texts.length} values, ${texts.filter(spec).length} in the grammar`);
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
const SAFE = PLAIN.filter(isSafe);
/** What a seeded comment is drawn from: ASCII, tab, and non-ASCII from every UTF-8 length, the separators and the specials. */
const COMMENT_CHARS = [...PLAIN, "\t", "\t", ..."é—–→\u00a0\u2028\u2029\u200b\u202e\ufeff\ufffd\ufffe\uffff\ue000ø漢✓", "\u{1f600}", "\u{10ffff}", "\u{10000}"];
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
        value = q + ([...body].some(isSafe) || body === "" ? body : body + "x") + q;
      }
      line = (r() < 0.2 ? "export " : "") + pick(r, keys) + "=" + value;
    }
    lines.push(line + (r() < 0.2 ? "\r" : ""));
  }
  return lines.join("\n") + (r() < 0.7 ? "\n" : "");
}

const ODD_PARTS = ["v", " ", "\t", "\f", "\v", " ", "﻿", "é", " ", "\r", '"', "'", "`", "\\", "$", "${X}", "#", " #c", "=", ":", "\\n", "x y", "''", '""'];
const ODD_SEPS = ["=", "=", " = ", "\t=", "=\f", "=\v", ":", ": ", " :", ":'", ':"', ""];
const ODD_LINES = ["", "   ", "\t", "# c", '# "q', " # x", "text", "just 'text", "=x", "export", "export ", '"', "'", "﻿", "\f", " "];
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
    const { texts, bad } = sweep(Array.from({ length: FILES }, () => (p: string) => inGrammarText(r, p)));
    expect(texts.every(spec)).toBe(true);
    expect(bad).toEqual([]);
    if (FULL) console.info(`(c) ${texts.length} files, ${texts.reduce((n, t) => n + envFileKeyStates(t).keys.size, 0)} keys`);
  }, 120_000);
  bunTest(`(d) ${FILES} arbitrary files: lost track exactly off the grammar, no false set, unset or absence where it keeps track`, () => {
    const r = rng(8481);
    const { texts, bad } = sweep(Array.from({ length: FILES }, () => (p: string) => oddText(r, p)));
    expect(bad).toEqual([]);
    const kept = texts.filter((t) => !envFileKeyStates(t).lostTrack).length;
    // Both sides are exercised.
    expect(kept).toBeGreaterThan(FILES / 20);
    expect(kept).toBeLessThan(FILES);
    if (FULL) console.info(`(d) kept track on ${kept} of ${FILES}`);
  }, 120_000);
});
