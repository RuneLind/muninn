/**
 * The port of huginn's `sanitize_filename`, checked against the interpreter.
 *
 * This is the rule the re-run's title round-trip guard rests on: a stem that is
 * not a FIXED POINT of it comes back as a different file name, and huginn's
 * ingest keys the path on that name — so a re-run of such a document writes a
 * SECOND file instead of replacing the one it re-ran. A port that drifts from
 * the original is therefore a silent fork, which is why the parity case below
 * runs the same fixtures through both implementations rather than asserting the
 * port's answers in prose.
 *
 * **The parity case SKIPS when huginn is not on disk**, which is every CI
 * runner: this repo is public and stands alone. The fixture cases beside it are
 * unconditional, so a change to the port is still caught there — what the
 * parity case adds is the evidence that those expectations are huginn's and not
 * ours.
 *
 * Every fixture is invented. This repo is public — including the underscore
 * case, which reproduces the SHAPE a live title has (a `:` sanitized to `_`)
 * with none of its text.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeFilenameLikeHuginn,
  HUGINN_FILENAME_MAX,
  HUGINN_FILENAME_FALLBACK,
} from "./huginn-filename.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const HUGINN_PY = join(REPO_ROOT, "..", "huginn", ".venv", "bin", "python");
const HUGINN_FILENAME_PY = join(REPO_ROOT, "..", "huginn", "main", "utils", "filename.py");

/**
 * Varied stems, each one a different way huginn's rule bites: the unsafe
 * class, the `[\s_]+` collapse (the half the first guard missed), the strip,
 * the 200-CODE-POINT truncation, and the five code points where Python's `\s`
 * and JavaScript's disagree.
 */
const FIXTURES: string[] = [
  "A perfectly ordinary stem",
  "Invented Talk_ Part Two",
  "Two  spaces in the middle",
  "trailing space ",
  " leading space",
  "trailing tab\t",
  "a/b slashed",
  'a quote " here',
  "angle <brackets> here",
  "pipe|and star*",
  "question?mark",
  "colon: here",
  "back\\slash",
  "",
  "     ",
  "___",
  "nbsp\u00a0here",
  "ideographic\u3000space",
  "nel\u0085here",
  "bom\ufeffhere",
  "fileseparator\u001chere",
  "unitseparator\u001fhere",
  "x".repeat(250),
  "\u{1F600}".repeat(HUGINN_FILENAME_MAX),
  "\u{1F600}".repeat(HUGINN_FILENAME_MAX + 1),
  "a\nnewline",
  "mixed _ \t spaces",
  `${"a".repeat(HUGINN_FILENAME_MAX - 1)} ${"b".repeat(50)}`,
  "Ærlig og øde på ånden",
  "party 🎉 title",
  "dot.name.here",
  "Untitled",
];

describe("sanitizeFilenameLikeHuginn", () => {
  test("the unsafe class becomes `_`, which the collapse then turns into a space", () => {
    expect(sanitizeFilenameLikeHuginn("a/b")).toBe("a b");
    expect(sanitizeFilenameLikeHuginn('x:"y"')).toBe("x y");
  });

  test("a literal underscore is NOT a fixed point — the half a symptom check misses", () => {
    expect(sanitizeFilenameLikeHuginn("Invented Talk_ Part Two")).toBe("Invented Talk Part Two");
    expect(sanitizeFilenameLikeHuginn("Two  spaces in the middle")).toBe("Two spaces in the middle");
  });

  test("the strip runs AFTER the collapse, so a trailing tab and a trailing space both go", () => {
    expect(sanitizeFilenameLikeHuginn("trailing tab\t")).toBe("trailing tab");
    expect(sanitizeFilenameLikeHuginn(" leading space")).toBe("leading space");
  });

  test("truncation counts CODE POINTS, not UTF-16 units", () => {
    const astral = "\u{1F600}".repeat(HUGINN_FILENAME_MAX);
    // 200 code points, 400 units: a `String.length` port would cut this in half.
    expect(astral.length).toBe(HUGINN_FILENAME_MAX * 2);
    expect(sanitizeFilenameLikeHuginn(astral)).toBe(astral);
    const over = astral + "\u{1F600}";
    expect(Array.from(sanitizeFilenameLikeHuginn(over))).toHaveLength(HUGINN_FILENAME_MAX);
  });

  test("a name that sanitizes to nothing is huginn's own fallback", () => {
    expect(sanitizeFilenameLikeHuginn("")).toBe(HUGINN_FILENAME_FALLBACK);
    expect(sanitizeFilenameLikeHuginn("   ")).toBe(HUGINN_FILENAME_FALLBACK);
    expect(sanitizeFilenameLikeHuginn("___")).toBe(HUGINN_FILENAME_FALLBACK);
  });

  test("the whitespace class is PYTHON's — NEL collapses, a BOM does not", () => {
    // `\x85` is in Python's `\s` and not in JavaScript's: a bare `\s` port
    // would call this stem a fixed point that huginn then renames.
    expect(sanitizeFilenameLikeHuginn("nel\u0085here")).toBe("nel here");
    expect(sanitizeFilenameLikeHuginn("fileseparator\u001chere")).toBe("fileseparator here");
    // `\ufeff` is the mirror image — JavaScript's `\s` and `String.trim()` eat
    // it, Python leaves it alone, so the port must leave it alone too.
    expect(sanitizeFilenameLikeHuginn("bom\ufeffhere")).toBe("bom\ufeffhere");
    expect(sanitizeFilenameLikeHuginn("\ufeffleading")).toBe("\ufeffleading");
  });
});

/** Run the fixtures through huginn's own module, or `null` when it is absent. */
function pythonAnswers(): string[] | null {
  if (!existsSync(HUGINN_PY) || !existsSync(HUGINN_FILENAME_PY)) return null;
  const dir = mkdtempSync(join(tmpdir(), "muninn-huginn-filename-"));
  const input = join(dir, "stems.json");
  writeFileSync(input, JSON.stringify(FIXTURES));
  // The module is loaded BY PATH rather than imported as `main.utils.filename`,
  // so nothing in huginn's package `__init__` has to run for this to work.
  const script =
    "import importlib.util,json,sys\n" +
    "spec=importlib.util.spec_from_file_location('hf',sys.argv[1])\n" +
    "m=importlib.util.module_from_spec(spec)\n" +
    "spec.loader.exec_module(m)\n" +
    "stems=json.load(open(sys.argv[2],encoding='utf-8'))\n" +
    "sys.stdout.write(json.dumps([m.sanitize_filename(s) for s in stems]))\n";
  const proc = Bun.spawnSync([HUGINN_PY, "-c", script, HUGINN_FILENAME_PY, input], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`huginn's interpreter failed: ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString()) as string[];
}

const answers = pythonAnswers();

describe("parity with huginn's own sanitize_filename", () => {
  test.skipIf(answers === null)(
    `${FIXTURES.length} stems answer identically in both implementations`,
    () => {
      const theirs = answers!;
      const ours = FIXTURES.map(sanitizeFilenameLikeHuginn);
      expect(theirs).toHaveLength(FIXTURES.length);
      // Compared as a LIST of pairs rather than in a loop: a mismatch then
      // names the stem it happened on instead of failing on an index.
      expect(FIXTURES.map((stem, i) => [stem, ours[i]])).toEqual(
        FIXTURES.map((stem, i) => [stem, theirs[i]!]),
      );
    },
  );

  test("the fixture set covers every rule the port implements", () => {
    // A guard on the guard: this list is the parity case's whole evidence, so a
    // future edit that trims it to the easy cases is a red test rather than a
    // quieter one.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
    expect(FIXTURES.some((f) => /[<>:"/\\|?*]/.test(f))).toBe(true);
    expect(FIXTURES.some((f) => f.includes("_"))).toBe(true);
    expect(FIXTURES.some((f) => Array.from(f).length > HUGINN_FILENAME_MAX)).toBe(true);
    expect(FIXTURES.some((f) => f.includes("\u0085"))).toBe(true);
    expect(FIXTURES.some((f) => f.includes("\ufeff"))).toBe(true);
  });
});
