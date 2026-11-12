/**
 * The `.env` key-state reader: which keys are set, unset or unsure, when it
 * loses track of the file, and that no value can leave it. The differential
 * block loads the same text with Bun itself (a child `bun --env-file`, in a
 * temp dir, names and lengths only) and holds the reader to never claiming
 * more than Bun does. The real `.env` is never read here.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { envFileKeyStates } from "./env-names.ts";

const states = (text: string) => {
  const r = envFileKeyStates(text);
  const by = (s: string) => [...r.keys].filter(([, v]) => v === s).map(([k]) => k).sort();
  return { set: by("set"), unset: by("unset"), unsure: by("unsure"), lostTrack: r.lostTrack };
};
const clean = (set: string[], unset: string[] = [], unsure: string[] = []) => ({ set, unset, unsure, lostTrack: false });

describe("envFileKeyStates: simple lines read as before", () => {
  test("plain, exported, spaced and indented keys with values are set", () => {
    expect(states("A=1\nexport B=two\nC = three\n  D=4\nexport\tE=5\n")).toEqual(clean(["A", "B", "C", "D", "E"]));
  });
  test("comment lines and commented-out keys are no keys, quotes in them included", () => {
    expect(states('# A=1\n  # B=2\n#C=3\n# "open\nD=4')).toEqual(clean(["D"]));
  });
  test("an empty value, empty quotes and a comment-only value are unset", () => {
    expect(states("A=\nB=\"\"\nC=''\nD= # nothing\nE=   \nF=``\nG=#x")).toEqual(clean([], ["A", "B", "C", "D", "E", "F", "G"]));
  });
  test("an unquoted value ends at #, as Bun reads it", () => {
    expect(states("A=abc#c\nB=abc # c\nC=#\n")).toEqual(clean(["A", "B"], ["C"]));
  });
  test("KEY= followed by a line that is no assignment loses track: the reader owns only lines it reads exactly", () => {
    expect(states("A=\nsecret-on-its-own-line\nB=x")).toEqual({ set: [], unset: [], unsure: ["A"], lostTrack: true });
  });
  test("CRLF and a lone CR end lines; a BOM (part of the first key to Bun) loses track", () => {
    expect(states("A=1\r\nB=\r\nC=3\rD=4")).toEqual(clean(["A", "C", "D"], ["B"]));
    expect(states("﻿A=1\nB=2")).toEqual({ set: [], unset: [], unsure: [], lostTrack: true });
  });
  test("a value holding = and other quotes counts once, for its own key", () => {
    expect(states("A=postgres://u:p@h/db?x=1&y=2\nB=\"k=v\"\nC='a=b'\nD=\"it's\"\nE=a\"b\n")).toEqual(clean(["A", "B", "C", "D", "E"]));
  });
  test("a closed quote followed by a comment is quoted; a whitespace-only quoted value is unset", () => {
    expect(states('A="a" # c\nB=\'b\'   \nC="  "\n')).toEqual(clean(["A", "B"], ["C"]));
  });
  test("a later line for the same key wins", () => {
    expect(states("A=1\nA=\nB=\nB=2\nC=$X\nC=3\nD=4\nD=$X")).toEqual(clean(["B", "C"], ["A"], ["D"]));
  });
  test("a quoted value spanning lines hides the KEY= lines inside it", () => {
    expect(states('A="line one\nB=inside\nlast"\nC=1')).toEqual(clean(["A", "C"]));
    expect(states("A='\n'\nC=1")).toEqual(clean(["C"], ["A"]));
    // Bun accepts `-` and `.` in a key, so this one's quote spans lines too.
    expect(states('T-B="x\nHID=1\n"\nAFT=2')).toEqual(clean(["AFT", "T-B"]));
  });
  test("any non-blank, non-comment line that is no assignment the reader knows loses track", () => {
    for (const text of ["just text\nOK=1", "OK=1\nA/B=no", "=x\nOK=1", "export\nOK=1", "export OK\nOK=1"])
      expect([text, states(text).lostTrack, states(text).set]).toEqual([text, true, []]);
  });
});

describe("envFileKeyStates: what it does not read the way Bun does is unsure", () => {
  test("a $ anywhere in a value (Bun expands it, even in single quotes)", () => {
    expect(states("A=$UNSET\nB=${UNSET}\nC=\"$U\"\nD='$U'\nE=`$U`\nF=a$\nG=x # $c\n")).toEqual(clean(["G"], [], ["A", "B", "C", "D", "E", "F"]));
  });
  test("every colon form loses track: `K: v` sets K, `K:v` sets nothing, an empty `K:` takes the WHOLE next line (Bun 1.3.10)", () => {
    for (const line of ["K:", "K: v", "K:v", "export K:", "K :", "K:'", 'K:"', "export K : v", "K:\t"])
      expect([line, states(`A=1\nB=\n${line}\nZ=1\n`)]).toMatchObject([line, { set: [], unset: [], lostTrack: true }]);
  });
  test("the verify pass's repros: a colon line never lets the reader read the next line as its own", () => {
    // Bun takes `WIKI_FLAG=1` as OTHER_SETTING's value and sets no WIKI_FLAG from the file.
    expect(states("OTHER_SETTING:\nWIKI_FLAG=1\n").lostTrack).toBe(true);
    expect(states("OTHER_SETTING:\nWIKI_FLAG=1\n").set).toEqual([]);
    // Bun: AA=x stays (the `AA=` line is BB's value); the reader said AA unset.
    expect(states("AA=x\nBB:\nAA=\n")).toMatchObject({ unset: [], set: [], lostTrack: true });
    // Bun sets E (`x'`); the reader followed F's quote across lines and hid E.
    const fe = envFileKeyStates("F:'\nE=x'\n");
    expect(fe.lostTrack).toBe(true);
  });
  test("a closed quote with text after it loses track (Bun reads it raw, or runs on to a later quote)", () => {
    expect(states('A="a" junk\nC=1')).toEqual({ set: [], unset: [], unsure: ["A"], lostTrack: true });
    expect(states('B=""junk\nC=1\nD="x"')).toEqual({ set: [], unset: [], unsure: ["B"], lostTrack: true });
  });
  test("a backslash in a quoted value loses track of the rest of the file", () => {
    expect(states('A=1\nESC="a\\"\nINESC=fake\ntail"\nZ=1')).toEqual({ set: [], unset: [], unsure: ["A", "ESC"], lostTrack: true });
    expect(states("ESC='a\\'\nZ=1\n'")).toEqual({ set: [], unset: [], unsure: ["ESC"], lostTrack: true });
  });
  test("a quote that never closes loses track: Bun reads it raw and goes on", () => {
    expect(states('UNCLOSED="abc\nAFTER=after\n')).toEqual({ set: [], unset: [], unsure: ["UNCLOSED"], lostTrack: true });
  });
  test("the same quote again before the close loses track (Bun's close needs only spaces or # after it)", () => {
    expect(states("A='x' 'y'\nB=1")).toEqual({ set: [], unset: [], unsure: ["A"], lostTrack: true });
  });
  test("a line that is no assignment the reader knows but holds a quote loses track", () => {
    expect(states('A/B="x\nHID=1\n"\nC=1').lostTrack).toBe(true);
  });
  test("a backslash in an unquoted value is literal, as Bun reads it", () => {
    expect(states("A=x\\\nB=a\\nb\n")).toEqual(clean(["A", "B"]));
  });
});

describe("envFileKeyStates: no value leaves it", () => {
  test("no value substring appears anywhere in the result", () => {
    const values = ["s3cr3t-value", "postgres://user:pa55@host/db", "multi\nline-val", "k=v", "$HOME-x", "esc\\aped"];
    const text = `A=${values[0]}\nexport B="${values[1]}"\nC="${values[2]}"\nD='${values[3]}'\nE=${values[4]}\nF="${values[5]}"\n`;
    const out = JSON.stringify(states(text));
    for (const v of values) for (const part of v.split(/\n/)) expect(out).not.toContain(part);
  });
});

/**
 * One child Bun loads `text` from a temp `.env` with an emptied environment and
 * prints, per key, the length of its trimmed value: names and lengths only.
 */
function bunLoads(text: string, dir: string, i: number): Map<string, number> {
  const file = path.join(dir, `case-${i}.env`);
  writeFileSync(file, text);
  const proc = Bun.spawnSync(
    [process.execPath, `--env-file=${file}`, "-e", "for (const [k, v] of Object.entries(process.env)) if (/^1?Q/.test(k)) console.log(k + '\\t' + (v ?? '').trim().length)"],
    { cwd: dir, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) throw new Error(`bun exited ${proc.exitCode}`);
  const out = new Map<string, number>();
  for (const line of proc.stdout.toString().split("\n").filter(Boolean)) {
    const [k, n] = line.split("\t");
    out.set(k!, Number(n));
  }
  return out;
}

/** Every key in these cases starts with Q, so the child's own environment never mixes in. */
const CASES = [
  "QA=1\nexport QB=two\nQC = three\n  QD=4\nexport\tQE=5\nQF\t=6",
  "QA=\nQB=\"\"\nQC=''\nQD= # nothing\nQE=   \nQF=``\nQG=#x\nQH=abc#c\nQI=abc # c",
  "QA=\nsecret-on-its-own-line\nQB=x",
  "QA=1\r\nQB=\r\nQC=3\rQD=4\r\nQE=\"x\ry\"",
  "﻿QA=1\nQB=2",
  "QA=postgres://u:p@h/db?x=1&y=2\nQB=\"k=v\"\nQC='a=b'\nQD=\"it's\"\nQE=a\"b\nQF=a'b\nQG=a`b",
  "QA=\"a\" # c\nQB='b'   \nQC=\"  \"\nQD='\n'\nQE=\"a\"#c",
  "QA=1\nQA=\nQB=\nQB=2\nQC=$X\nQC=3",
  "QA=\"line one\nQB=inside\nlast\"\nQC=1\nQ-B=\"x\nQHID=1\n\"\nQAFT=2\nQ.C=\"y\nQHID2=2\n\"",
  "just text\nQ/B=no\n=x\nQOK=1\njust \"text\nQAFTER=1\n# \"c\nQC2=1\n#\"",
  "QA=$UNSET\nQB=${UNSET}\nQC=\"$U\"\nQD='$U'\nQE=`$U`\nQF=a$\nQG=x # $c\nQH=$QA\nQI=${QG}",
  "QA: v\nQB : w\nexport QC: x\nQD=1\nQ:E=5",
  "QA=\"a\" junk\nQB=\"\"junk\nQC=1\nQD=\"a\"x\nQE=\"a'\nQF=1\n\"",
  "QA=1\nQESC=\"a\\\"\nQINESC=fake\ntail\"\nQZ=1",
  "QESC='a\\'\nQZ=1\n'\nQY=2",
  "QUNCLOSED=\"abc\nQAFTER=after\n",
  "QPRE=1\nQUNCLOSED='abc\nQPRE=\nQAFTER=after",
  "QA='x' 'y'\nQB=1\nQC='x''y'\nQD=2",
  "Q-B=\"x\nQHID=1\n\"\nQAFT=2\nQ/B=\"y\nQHID2=1\n\"\nQAFT2=2",
  "QA=x\\\nQB=a\\nb\nQC=\"a\\nb\"\nQD=1",
  "QA= \"spaced open\"\nQB=\t'tab open'\nQC= \"\"",
  "export QA=\"multi\n\nline\"\nexport QB : \"q\"\nQC=`back\ntick`\nQD=1",
];

describe("envFileKeyStates against Bun's own loader (differential)", () => {
  const dir = testTempDirSync(path.join(tmpdir(), "env-names-diff-"));
  CASES.forEach((text, i) => {
    test(`case ${i}: no false set, no false unset`, () => {
      const bun = bunLoads(text, dir, i);
      const ours = envFileKeyStates(text);
      const disagree: string[] = [];
      for (const [k, s] of ours.keys) {
        if (!k.startsWith("Q")) continue;
        const len = bun.get(k) ?? 0;
        if (s === "set" && len === 0) disagree.push(`${k}: reader set, Bun empty`);
        if (s === "unset" && len > 0) disagree.push(`${k}: reader unset, Bun non-empty`);
      }
      // A key the reader does not list at all is a claim of «not in .env»; it may not be wrong either.
      if (!ours.lostTrack) for (const [k, len] of bun) if (len > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !ours.keys.has(k)) disagree.push(`${k}: reader absent, Bun non-empty`);
      expect(disagree).toEqual([]);
    });
  });
});

// The fuzz grammar: the same text as the scratch harness that ran 5,000+ files per seed (PR #848, fix round 2).
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
const FUZZ_KEYS = ["QA", "QB", "QC", "QD", "Q_E", "Q-B", "Q.C", "1Q"];
const FUZZ_SEPS = ["=", "=", "=", " = ", "\t=", ":", ": ", " :", " : ", ":'", ':"', ""];
const FUZZ_VALUE_PARTS = ["v", "val", " ", "\t", '"', "'", "`", "\\", "$", "$QA", "${QB}", "#", " #c", "x y", "=", "\\n", "é"];
const FUZZ_RAW_LINES = ["", "   ", "# c", '# "q', "  # x=1", "text", "just 'text", "=x", "Q/B=1", "export", "export QA", '"', "'"];
const FUZZ_EOLS = ["\n", "\n", "\n", "\r\n", "\r"];
/** One `.env` text from a grammar of what a hand-written file holds and what Bun reads oddly. */
function fuzzEnvText(r: () => number): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const eol = pick(FUZZ_EOLS);
  const lines: string[] = [];
  const n = 1 + Math.floor(r() * 7);
  for (let i = 0; i < n; i++) {
    if (r() < 0.12) {
      lines.push(pick(FUZZ_RAW_LINES));
      continue;
    }
    let value = "";
    const parts = Math.floor(r() * 4);
    for (let p = 0; p < parts; p++) value += pick(FUZZ_VALUE_PARTS);
    if (r() < 0.25) {
      const q = pick(['"', "'", "`"]);
      value = q + value + (r() < 0.8 ? q : "") + (r() < 0.2 ? pick([" #c", " x", "", "\t"]) : "");
    }
    // Mostly plain separators, so the reader claims something in most files.
    const sep = r() < 0.75 ? "=" : pick(FUZZ_SEPS);
    lines.push((r() < 0.15 ? "export " : "") + (r() < 0.08 ? "  " : "") + pick(FUZZ_KEYS) + sep + value);
  }
  return (r() < 0.04 ? "﻿" : "") + lines.join(eol) + (r() < 0.7 ? eol : "");
}

/** Whether this host can spawn a child Bun at all; the fuzz skips cleanly when it cannot. */
const canSpawnBun = (() => {
  try {
    return Bun.spawnSync([process.execPath, "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
})();

describe("envFileKeyStates against Bun's own loader: a seeded fuzz", () => {
  const FILES = 400;
  test.skipIf(!canSpawnBun)(`${FILES} generated files (colon forms, quotes, backslashes, $, #, CRLF, BOM): no false set, unset or absent where the reader keeps track`, () => {
    const dir = testTempDirSync(path.join(tmpdir(), "env-names-fuzz-"));
    const r = rng(848);
    const bad: string[] = [];
    let lost = 0;
    for (let i = 0; i < FILES; i++) {
      const text = fuzzEnvText(r);
      const ours = envFileKeyStates(text);
      if (ours.lostTrack) {
        lost++;
        continue;
      }
      const bun = bunLoads(text, dir, i);
      for (const [k, s] of ours.keys) {
        const len = bun.get(k) ?? 0;
        if (s === "set" && len === 0) bad.push(`${JSON.stringify(text)}: ${k} reader set, Bun empty`);
        if (s === "unset" && len > 0) bad.push(`${JSON.stringify(text)}: ${k} reader unset, Bun non-empty`);
      }
      for (const [k, len] of bun) if (len > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !ours.keys.has(k)) bad.push(`${JSON.stringify(text)}: ${k} reader absent, Bun non-empty`);
    }
    expect(bad).toEqual([]);
    // The fuzz must still test claims: most files keep track.
    expect(lost).toBeLessThan(FILES);
  }, 30_000);
});
