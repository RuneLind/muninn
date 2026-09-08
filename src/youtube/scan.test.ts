/**
 * The dense-scan decision surface: the grid, the dedup, the cap, the sheet
 * layout, the manifest parse, the budget split and the kill switch.
 *
 * All of it pure — no ffmpeg, no video, no model. The signatures here are built
 * at the SHIPPED geometry (32×18 gray, 8×6 blocks) rather than at a convenient
 * one, because the block arithmetic is what the dedup is: a test over 4-byte
 * arrays would pass against a comparator that divides by the wrong number.
 *
 * The ffmpeg half is `scan-run.test.ts`; the two-pass job is
 * `summarizer.test.ts`.
 */
import { test, expect, describe } from "bun:test";
import {
  CONTACT_SHEET,
  CONTACT_SHEET_CELLS,
  CONTACT_SHEET_LABEL,
  SCAN_BLOCK_COLS,
  SCAN_BLOCK_DELTA,
  SCAN_BLOCK_ROWS,
  SCAN_CHANGE_THRESHOLD,
  SCAN_SIGNATURE_BYTES,
  SCAN_SIGNATURE_HEIGHT,
  SCAN_SIGNATURE_WIDTH,
  SELECTION_CATEGORIES,
  SELECTION_REASON_MAX_CHARS,
  YOUTUBE_CANDIDATE_CAP,
  YOUTUBE_FULL_READ_CAP,
  YOUTUBE_SCAN_INTERVAL_SEC,
  assertBlockGrid,
  assertLabelFits,
  blockChangeFraction,
  capScanCandidates,
  cellLabelText,
  contactSheetPlans,
  dedupeScanSamples,
  parseSelectionManifest,
  resolveFrameScanMode,
  scanSampleTimes,
  scanTimeoutFor,
  selectionLimitFor,
  selectionPrompt,
  selectionTimeoutFor,
  splitScanSignatures,
  splitTwoPassBudget,
  twoPassBudgetFor,
  type ScanCandidate,
} from "./scan.ts";
import { textBitmapWidth } from "./label.ts";
import { framesTimeoutFor } from "../summaries/frames.ts";
import { summarizeTimeoutFor } from "../video/media.ts";

// --- signature fixtures, at the shipped geometry ----------------------------

const BLOCK_W = SCAN_SIGNATURE_WIDTH / SCAN_BLOCK_COLS;
const BLOCK_H = SCAN_SIGNATURE_HEIGHT / SCAN_BLOCK_ROWS;

function flat(value: number): Uint8Array {
  return new Uint8Array(SCAN_SIGNATURE_BYTES).fill(value);
}

/** `base`, with the given blocks (row-major indices) set to `value`. */
function withBlocks(base: number, blocks: readonly number[], value: number): Uint8Array {
  const out = flat(base);
  for (const b of blocks) {
    const bx = b % SCAN_BLOCK_COLS;
    const by = Math.floor(b / SCAN_BLOCK_COLS);
    for (let y = 0; y < BLOCK_H; y++) {
      const row = (by * BLOCK_H + y) * SCAN_SIGNATURE_WIDTH + bx * BLOCK_W;
      for (let x = 0; x < BLOCK_W; x++) out[row + x] = value;
    }
  }
  return out;
}

const TOTAL_BLOCKS = SCAN_BLOCK_COLS * SCAN_BLOCK_ROWS;

// --- the grid ---------------------------------------------------------------

describe("scanSampleTimes", () => {
  test("slot i is second i x the interval", () => {
    expect(scanSampleTimes(5)).toEqual([0, 5, 10, 15, 20]);
    expect(scanSampleTimes(4)).toEqual([0, 5, 10, 15]);
    expect(scanSampleTimes(3, 2)).toEqual([0, 2, 4]);
  });

  test("no samples is no grid at all", () => {
    expect(scanSampleTimes(0)).toEqual([]);
    expect(scanSampleTimes(-5)).toEqual([]);
    expect(scanSampleTimes(Number.NaN)).toEqual([]);
  });

  test("the default interval is the shipped constant", () => {
    expect(scanSampleTimes(3)).toEqual(scanSampleTimes(3, YOUTUBE_SCAN_INTERVAL_SEC));
    expect(() => scanSampleTimes(12, 0)).toThrow(/positive integer/);
    expect(() => scanSampleTimes(12, 2.5)).toThrow(/positive integer/);
  });
});

describe("scanTimeoutFor", () => {
  test("2 s per source minute, floored at 60 s", () => {
    expect(scanTimeoutFor(60)).toBe(60_000);
    expect(scanTimeoutFor(1767)).toBe(60_000);
    // The 3 h frames cap: 180 minutes × 2 s.
    expect(scanTimeoutFor(10_800)).toBe(360_000);
  });

  test("about nine times the measured rate, at a duration the floor does NOT bind", () => {
    // At 1767 s the 60 s floor is what answers, so the same assertion there
    // passed against any multiplier at all — including one ten times too small.
    // 6.7 s of wall for 1767 s of 720p H.264 is 227 ms per source minute.
    const measuredMsPerMinute = 6_700 / (1767 / 60);
    const threeHours = 10_800;
    const measuredMs = (threeHours / 60) * measuredMsPerMinute;
    expect(scanTimeoutFor(threeHours)).toBeGreaterThan(60_000);
    // Two-sided: a budget that is generous is the point, one that is unbounded
    // is not a budget.
    expect(scanTimeoutFor(threeHours)).toBeGreaterThan(measuredMs * 8);
    expect(scanTimeoutFor(threeHours)).toBeLessThan(measuredMs * 10);
  });
});

// --- signatures -------------------------------------------------------------

describe("splitScanSignatures", () => {
  test("splits a whole stream into planes of the shipped size", () => {
    const planes = splitScanSignatures(new Uint8Array(SCAN_SIGNATURE_BYTES * 3));
    expect(planes).toHaveLength(3);
    expect(planes[0]!.length).toBe(SCAN_SIGNATURE_BYTES);
  });

  test("a stream that is not a multiple of the plane size THROWS", () => {
    // Truncating instead would shift every later plane by a few bytes and turn
    // the whole dedup into noise, silently.
    expect(() => splitScanSignatures(new Uint8Array(SCAN_SIGNATURE_BYTES + 7))).toThrow(
      /not a multiple/,
    );
  });
});

describe("blockChangeFraction", () => {
  test("identical planes have changed nothing", () => {
    expect(blockChangeFraction(flat(100), flat(100))).toBe(0);
  });

  test("a whole-frame jump past the block delta changes every block", () => {
    expect(blockChangeFraction(flat(0), flat(SCAN_BLOCK_DELTA))).toBe(1);
  });

  test("a move UNDER the block delta changes nothing", () => {
    expect(blockChangeFraction(flat(0), flat(SCAN_BLOCK_DELTA - 1))).toBe(0);
  });

  test("one moved block is one block of the total, wherever it is", () => {
    const corner = blockChangeFraction(flat(100), withBlocks(100, [0], 250));
    const middle = blockChangeFraction(flat(100), withBlocks(100, [20], 250));
    expect(corner).toBeCloseTo(1 / TOTAL_BLOCKS, 10);
    // No block POSITION is given meaning — the corner and the middle count the
    // same, which is what "hardcode no region positions" means here.
    expect(middle).toBe(corner);
  });

  test("mismatched geometry throws rather than comparing nothing", () => {
    expect(() => blockChangeFraction(flat(0), new Uint8Array(10))).toThrow(/signature is/);
  });

  test("a block grid that does not DIVIDE the plane is refused at module load", () => {
    // A fractional block is not a smaller block: the inner loop indexes the
    // plane at a non-integer offset, every read is `undefined`, every difference
    // is NaN and every pair therefore scores 0 — the dedup silently off, with
    // the shipped constants still looking plausible. The assertion runs at
    // import, so the only way to reach it is with the numbers themselves.
    expect(() => assertBlockGrid(32, 18, 8, 6)).not.toThrow();
    expect(() => assertBlockGrid(32, 18, 8, 5)).toThrow(/divide/);
    expect(() => assertBlockGrid(32, 18, 7, 6)).toThrow(/divide/);
    // And the shipped geometry really is the one that divides.
    expect(SCAN_SIGNATURE_WIDTH % SCAN_BLOCK_COLS).toBe(0);
    expect(SCAN_SIGNATURE_HEIGHT % SCAN_BLOCK_ROWS).toBe(0);
  });
});

// --- the dedup --------------------------------------------------------------

describe("dedupeScanSamples", () => {
  test("a STATIC run keeps only its first sample", () => {
    const sigs = [flat(100), flat(100), flat(100), flat(100)];
    const kept = dedupeScanSamples(sigs, [0, 5, 10, 15]);
    expect(kept.map((c) => c.tSeconds)).toEqual([0]);
  });

  test("a CUT is kept", () => {
    const sigs = [flat(10), flat(10), flat(220), flat(220)];
    const kept = dedupeScanSamples(sigs, [0, 5, 10, 15]);
    expect(kept.map((c) => c.tSeconds)).toEqual([0, 10]);
    expect(kept[1]!.change).toBe(1);
  });

  test("a TALKING HEAD in the corner is not a new frame", () => {
    // One block of 48 moving, over and over: 1/48 is far under the threshold, so
    // an inset presenter never produces a candidate on its own.
    const sigs = [
      flat(100),
      withBlocks(100, [0], 250),
      flat(100),
      withBlocks(100, [0], 250),
      withBlocks(100, [8], 250),
    ];
    expect(dedupeScanSamples(sigs, [0, 5, 10, 15, 20]).map((c) => c.tSeconds)).toEqual([0]);
    expect(1 / TOTAL_BLOCKS).toBeLessThan(SCAN_CHANGE_THRESHOLD);
  });

  test("a SLOW SCROLL is kept once its accumulated change crosses, not once its step does", () => {
    // Each step moves every block by 4 — under the 12-per-block delta, so no
    // consecutive PAIR changes anything. The comparison is against the previous
    // KEPT sample, so the third step (12 from the last kept one) crosses.
    const sigs = [flat(0), flat(4), flat(8), flat(12), flat(16), flat(20), flat(24)];
    const times = [0, 5, 10, 15, 20, 25, 30];
    expect(dedupeScanSamples(sigs, times).map((c) => c.tSeconds)).toEqual([0, 15, 30]);
    // Compared against the PREVIOUS SAMPLE instead, the page would never produce
    // a candidate at all — the property this pins.
    for (let i = 1; i < sigs.length; i++) {
      expect(blockChangeFraction(sigs[i - 1]!, sigs[i]!)).toBe(0);
    }
  });

  test("the first sample is always a candidate, and reports change 1", () => {
    const kept = dedupeScanSamples([flat(50)], [0]);
    expect(kept).toEqual([{ index: 0, tSeconds: 0, change: 1 }]);
  });

  test("no samples, no candidates", () => {
    expect(dedupeScanSamples([], [])).toEqual([]);
  });

  test("a shorter time list bounds the walk (a scan that emitted fewer frames)", () => {
    const sigs = [flat(0), flat(200), flat(0)];
    expect(dedupeScanSamples(sigs, [0, 5]).map((c) => c.tSeconds)).toEqual([0, 5]);
  });
});

// --- the cap ----------------------------------------------------------------

function candidate(index: number, change: number): ScanCandidate {
  return { index, tSeconds: index * YOUTUBE_SCAN_INTERVAL_SEC, change };
}

describe("capScanCandidates", () => {
  test("under the cap, nothing moves", () => {
    const cands = [candidate(0, 1), candidate(3, 0.4)];
    expect(capScanCandidates(cands, 10)).toEqual(cands);
  });

  test("over the cap, the answer is exactly `cap` long and in TIME order", () => {
    const cands = Array.from({ length: 300 }, (_, i) => candidate(i, (i % 7) / 10));
    const capped = capScanCandidates(cands, YOUTUBE_CANDIDATE_CAP);
    expect(capped).toHaveLength(YOUTUBE_CANDIDATE_CAP);
    expect(capped.map((c) => c.tSeconds)).toEqual([...capped.map((c) => c.tSeconds)].sort((a, b) => a - b));
  });

  test("chronological coverage is RESERVED before change is ranked", () => {
    // Every high-change candidate is in the first tenth; ranking by change alone
    // would return nothing from the rest of the video.
    const cands = Array.from({ length: 300 }, (_, i) => candidate(i, i < 30 ? 1 : 0.2));
    const capped = capScanCandidates(cands, 60);
    const lastIndex = cands[cands.length - 1]!.index;
    expect(capped.at(-1)!.index).toBe(lastIndex);
    // The second half of the video is represented, not swamped.
    expect(capped.filter((c) => c.index >= 150).length).toBeGreaterThanOrEqual(9);
  });

  test("the reserve is spread over TIME, not over candidate index", () => {
    // The shape the dedup really produces: a busy opening (a title animation, a
    // demo recording) that survives as one candidate a second, then a long
    // screen-share that moves once a minute. Uniform over INDEX, the reserve
    // follows the candidates rather than the video — 90% of the anchors land in
    // the first five minutes because that is where 90% of the candidates are,
    // and the half-hour tail arrives at the selection pass almost unrepresented.
    const head = Array.from({ length: 300 }, (_, i) => ({ index: i, tSeconds: i, change: 1 }));
    const tail = Array.from({ length: 30 }, (_, i) => ({
      index: 300 + i,
      tSeconds: 300 + i * 60,
      change: 0.2,
    }));
    const capped = capScanCandidates([...head, ...tail], 120);

    expect(capped).toHaveLength(120);
    // Every one of the 30 minutes after the opening is represented.
    expect(capped.filter((c) => c.tSeconds >= 300)).toHaveLength(30);
    expect(capped.map((c) => c.tSeconds)).toEqual(
      [...capped.map((c) => c.tSeconds)].sort((a, b) => a - b),
    );
  });

  test("the anchors cover the whole sequence end to end", () => {
    const cands = Array.from({ length: 500 }, (_, i) => candidate(i, 0.2));
    const capped = capScanCandidates(cands, 12);
    expect(capped[0]!.index).toBe(0);
    expect(capped.at(-1)!.index).toBe(499);
  });

  test("deterministic: the same input twice gives the same answer", () => {
    const cands = Array.from({ length: 200 }, (_, i) => candidate(i, ((i * 37) % 11) / 10));
    expect(capScanCandidates(cands, 40)).toEqual(capScanCandidates(cands, 40));
  });

  test("a cap of zero keeps nothing", () => {
    expect(capScanCandidates([candidate(0, 1)], 0)).toEqual([]);
  });
});

// --- the sheets -------------------------------------------------------------

describe("the cell label", () => {
  test("`#<cell> HH:MM:SS`, the cell 1-based within its sheet", () => {
    expect(cellLabelText(1, 0)).toBe("#1 00:00:00");
    expect(cellLabelText(9, 130)).toBe("#9 00:02:10");
    expect(cellLabelText(12, 3661)).toBe("#12 01:01:01");
  });

  test("the widest label this geometry can produce FITS the cell", () => {
    // A label that overflows throws out of `renderLabelStrip`, which on a real
    // capture is a `sheets_failed` fallback to the cadence sampler caused by a
    // constant. The module runs this at load; running it here is what makes it
    // a test rather than a comment.
    expect(() => assertLabelFits()).not.toThrow();
    // Both directions, the `assertBlockGrid` shape: an assertion that only ever
    // sees values it accepts cannot tell a check from a removed check.
    expect(() => assertLabelFits(CONTACT_SHEET_LABEL, 120)).toThrow(/the cell is 120px wide/);
    expect(() => assertLabelFits({ height: 29, scale: 3, padX: 6 })).toThrow(/must be even/);
    expect(() => assertLabelFits({ height: 12, scale: 3, padX: 6 })).toThrow(/at least 21px tall/);
    // And the strip is even-height. NOT because an encoder refuses an odd one —
    // measured on ffmpeg 8.0.1 through the shipped `contactSheetArgs`, strip
    // heights 21/29/30/31 all encode — but so the stacked cell height is one
    // deterministic number rather than one a build may round.
    expect(CONTACT_SHEET_LABEL.height % 2).toBe(0);
  });

  test("it is the WIDEST label that is checked, not the first one", () => {
    // The widest label this geometry can produce is the last cell of a sheet at
    // a two-digit hour, and the check is vacuous the moment it measures a
    // narrower one: `#1 00:00:00` is 207px at the shipped scale and inset,
    // `#12 99:59:59` is 225px, so a 216px cell is exactly the band where only
    // the real argument overflows. Measured, not derived from the formula the
    // function itself uses.
    const { scale, padX } = CONTACT_SHEET_LABEL;
    expect(textBitmapWidth(cellLabelText(1, 0), scale) + 2 * padX).toBe(207);
    expect(textBitmapWidth(cellLabelText(CONTACT_SHEET_CELLS, 99 * 3600 + 59 * 60 + 59), scale) + 2 * padX).toBe(225);
    expect(() => assertLabelFits(CONTACT_SHEET_LABEL, 216)).toThrow(/needs 225px and the cell is 216px wide/);
    // …and a cell exactly as wide as that label fits it, so the throw above is
    // the width check answering about THIS label and not a blanket refusal.
    expect(() => assertLabelFits(CONTACT_SHEET_LABEL, 225)).not.toThrow();
  });
});

describe("contactSheetPlans", () => {
  test("the shipped cap is exactly ten sheets", () => {
    const cands = Array.from({ length: YOUTUBE_CANDIDATE_CAP }, (_, i) => candidate(i, 1));
    const plans = contactSheetPlans(cands);
    expect(CONTACT_SHEET_CELLS).toBe(CONTACT_SHEET.cols * CONTACT_SHEET.rows);
    expect(plans).toHaveLength(YOUTUBE_CANDIDATE_CAP / CONTACT_SHEET_CELLS);
    expect(plans).toHaveLength(10);
    // Ten reads for the selection pass, forty for the synthesis pass: both under
    // the cap, which is the arithmetic `YOUTUBE_FULL_READ_CAP` documents.
    expect(plans.length).toBeLessThanOrEqual(YOUTUBE_FULL_READ_CAP);
  });

  test("cells are in time order and every candidate lands in exactly one", () => {
    const cands = Array.from({ length: 29 }, (_, i) => candidate(i, 1));
    const plans = contactSheetPlans(cands);
    expect(plans.map((p) => p.cells.length)).toEqual([12, 12, 5]);
    expect(plans.flatMap((p) => p.cells.map((c) => c.tSeconds))).toEqual(
      cands.map((c) => c.tSeconds),
    );
  });

  test("file names are 1-based and zero-padded", () => {
    const plans = contactSheetPlans(Array.from({ length: 13 }, (_, i) => candidate(i, 1)));
    expect(plans.map((p) => p.fileName)).toEqual(["sheet-01.jpg", "sheet-02.jpg"]);
    expect(plans.map((p) => p.number)).toEqual([1, 2]);
  });

  test("no candidates, no sheets", () => {
    expect(contactSheetPlans([])).toEqual([]);
  });
});

// --- the selection manifest -------------------------------------------------

describe("parseSelectionManifest", () => {
  const available = [0, 5, 130, 150, 165];

  test("a fenced JSON array is read, and the answer is held to the candidates", () => {
    const answer =
      "Here is my pick.\n\n```json\n" +
      JSON.stringify([
        { tSeconds: 130, category: "chart", reason: "the growth chart" },
        { tSeconds: 999, category: "chart", reason: "never sampled" },
        { tSeconds: 165, category: "code", duplicateGroup: "velocity", reason: "the velocity chart" },
      ]) +
      "\n```\n";
    const manifest = parseSelectionManifest(answer, available, 40)!;
    expect(manifest.entries.map((e) => e.tSeconds)).toEqual([130, 165]);
    expect(manifest.dropped).toEqual([999]);
    expect(manifest.entries[1]!.duplicateGroup).toBe("velocity");
  });

  test("a bare array with prose around it still parses", () => {
    const manifest = parseSelectionManifest(
      'Sure — [{"tSeconds": 5, "category": "diagram", "reason": "x"}] is my answer.',
      available,
      40,
    )!;
    expect(manifest.entries.map((e) => e.tSeconds)).toEqual([5]);
  });

  test("nothing parseable is NULL, which is a failed pass rather than an empty one", () => {
    expect(parseSelectionManifest("I could not read the sheets.", available, 40)).toBeNull();
    expect(parseSelectionManifest("```json\n{not json}\n```", available, 40)).toBeNull();
    // An empty array IS an answer: the pass looked and found nothing.
    expect(parseSelectionManifest("[]", available, 40)).toEqual({
      entries: [],
      dropped: [],
      droppedOverCap: 0,
    });
  });

  test("EVERY fenced block is considered, not just the first", () => {
    // A pass that restates the schema before answering — or opens with a fenced
    // list of the sheets it read — used to have that first block taken as the
    // answer, so a whole paid selection call was reported as "found nothing".
    const answer =
      "The schema I am following:\n\n```json\n[130, 165]\n```\n\nAnd my picks:\n\n```json\n" +
      JSON.stringify([{ tSeconds: 150, category: "chart", reason: "the second chart" }]) +
      "\n```\n";
    const manifest = parseSelectionManifest(answer, available, 40)!;
    expect(manifest.entries.map((e) => e.tSeconds)).toEqual([150]);
  });

  test("prose carrying its own brackets does not swallow the array", () => {
    // First-`[`-to-last-`]` is not a parser: one bracketed phrase anywhere in
    // the answer made the whole slice unparseable, which is a failed pass and a
    // cadence fallback over a sentence.
    const manifest = parseSelectionManifest(
      'Looking at [sheet 1]: [{"tSeconds": 130, "category": "chart", "reason": "x"}] — that was [sheet 2].',
      available,
      40,
    )!;
    expect(manifest.entries.map((e) => e.tSeconds)).toEqual([130]);
  });

  test("an array with no OBJECT entries is a failed pass, not an empty manifest", () => {
    // `[130, 145]` is a pass that answered in the wrong shape — there is no
    // category and no reason in it — and reading it as "looked, found nothing"
    // silently ships a slides capture with no slides. Only `[]` means that.
    expect(parseSelectionManifest("[130, 145]", available, 40)).toBeNull();
    expect(parseSelectionManifest("[null, null]", available, 40)).toBeNull();
    expect(parseSelectionManifest('["130"]', available, 40)).toBeNull();
  });

  test("a fractional second snaps to the candidate grid", () => {
    // The sheets only ever offered multiples of the scan interval, so a second
    // read off a cell and written with a decimal is a candidate this capture
    // CAN serve — rounding it to the nearest whole second and then dropping it
    // spent a sheet read for nothing.
    const manifest = parseSelectionManifest(
      '[{"tSeconds": 131.2, "category": "chart", "reason": "x"},' +
        ' {"tSeconds": 148.5, "category": "chart", "reason": "y"}]',
      available,
      40,
    )!;
    expect(manifest.entries.map((e) => e.tSeconds)).toEqual([130, 150]);
    expect(manifest.dropped).toEqual([]);
  });

  test("HH:MM:SS and MM:SS spellings resolve to the same second", () => {
    const manifest = parseSelectionManifest(
      '[{"tSeconds": "00:02:10", "category": "chart", "reason": "a"}, {"tSeconds": "2:30", "category": "chart", "reason": "b"}]',
      available,
      40,
    )!;
    expect(manifest.entries.map((e) => e.tSeconds)).toEqual([130, 150]);
  });

  test("a repeat is one slot, not two", () => {
    const manifest = parseSelectionManifest(
      '[{"tSeconds":130,"category":"chart","reason":"a"},{"tSeconds":130,"category":"chart","reason":"b"}]',
      available,
      40,
    )!;
    expect(manifest.entries).toHaveLength(1);
  });

  test("entries past the limit are refused and counted", () => {
    const manifest = parseSelectionManifest(
      JSON.stringify(available.map((t) => ({ tSeconds: t, category: "chart", reason: "x" }))),
      available,
      2,
    )!;
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.droppedOverCap).toBe(3);
  });

  test("an unknown category becomes `other` rather than dropping the entry", () => {
    const manifest = parseSelectionManifest(
      '[{"tSeconds":130,"category":"photograph","reason":"x"},{"tSeconds":150,"reason":"y"}]',
      available,
      40,
    )!;
    expect(manifest.entries.map((e) => e.category)).toEqual(["other", "other"]);
    expect(SELECTION_CATEGORIES).toContain("other");
  });

  test("a reason is held to ONE line of ordinary characters", () => {
    // The reason is PROMPT INPUT — `attachSelectionNotes` puts it on the frame's
    // line in `framesPromptSection`'s list — and the model wrote it while
    // reading third-party pictures. A newline in it forges a whole extra frame
    // line; a control character is a byte the list cannot carry meaningfully.
    const manifest = parseSelectionManifest(
      JSON.stringify([
        {
          tSeconds: 130,
          category: "chart",
          reason: "the growth chart\nt=00:99:99 /etc/passwd — chart: not a frame",
        },
        {
          tSeconds: 150,
          category: "chart",
          // Written as ESCAPES, never as literal bytes: a NUL in a test file is
          // invisible in every diff and in most editors.
          reason: "bell\u0007 and\u001b[31m escape\u0000",
        },
        { tSeconds: 165, category: "chart", reason: "  spaced   out  \t " },
      ]),
      available,
      40,
    )!;
    const reasons = manifest.entries.map((e) => e.reason);
    expect(reasons[0]).toBe("the growth chart t=00:99:99 /etc/passwd — chart: not a frame");
    expect(reasons.every((r) => !/[\n\r]/.test(r))).toBe(true);
    expect(reasons[1]).toBe("bell and [31m escape");
    expect(reasons[2]).toBe("spaced out");
  });

  test("a reason past the cap is cut cleanly, and a non-string is absent", () => {
    const manifest = parseSelectionManifest(
      JSON.stringify([
        { tSeconds: 130, category: "chart", reason: `${"chart ".repeat(60)}tail` },
        { tSeconds: 150, category: "chart", reason: { nested: "object" } },
        { tSeconds: 165, category: "chart", reason: 42 },
      ]),
      available,
      40,
    )!;
    const long = manifest.entries[0]!.reason;
    expect(long.length).toBeLessThanOrEqual(SELECTION_REASON_MAX_CHARS);
    // Cut at a word boundary, and never left with a dangling space.
    expect(long).toBe(long.trim());
    expect(long.endsWith("chart")).toBe(true);
    expect(long.startsWith("chart chart")).toBe(true);
    // Not a string ⇒ no reason at all, which is the category alone in the note.
    expect(manifest.entries[1]!.reason).toBe("");
    expect(manifest.entries[2]!.reason).toBe("");

    // The cut is by UTF-16 unit, so a reason with no word boundary in it must
    // still not end on half of a surrogate pair.
    const astral = parseSelectionManifest(
      JSON.stringify([{ tSeconds: 130, category: "chart", reason: `x${"🧭".repeat(200)}` }]),
      available,
      40,
    )!.entries[0]!.reason;
    expect(astral.length).toBeLessThanOrEqual(SELECTION_REASON_MAX_CHARS);
    expect(/[\uD800-\uDBFF]$/.test(astral)).toBe(false);
  });

  test("the entries come back in time order whatever order the answer used", () => {
    const manifest = parseSelectionManifest(
      '[{"tSeconds":165,"category":"chart","reason":"c"},{"tSeconds":5,"category":"chart","reason":"a"}]',
      available,
      40,
    )!;
    expect(manifest.entries.map((e) => e.tSeconds)).toEqual([5, 165]);
  });
});

describe("selectionLimitFor", () => {
  test("twice the policy's total, bounded by the read cap", () => {
    expect(selectionLimitFor(8)).toBe(16);
    expect(selectionLimitFor(20)).toBe(40);
    expect(selectionLimitFor(80)).toBe(YOUTUBE_FULL_READ_CAP);
  });
});

describe("selectionPrompt", () => {
  const sheets = contactSheetPlans([candidate(0, 1), candidate(1, 1), candidate(26, 1)]);

  test("names every cell's second, in row-major order, per sheet", () => {
    const prompt = selectionPrompt({
      title: "A talk",
      durationSec: 200,
      sheets,
      sheetDir: "/tmp/select",
      limit: 16,
    });
    expect(prompt).toContain("/tmp/select/sheet-01.jpg — 3 cell(s):");
    // The prose list is spelled EXACTLY like the label burned under the cell,
    // so the model compares two channels by reading rather than by translating.
    expect(prompt).toContain(`${cellLabelText(1, 0)} (0)`);
    expect(prompt).toContain(`${cellLabelText(3, 130)} (130)`);
    expect(prompt).toContain("#1 00:00:00 (0)");
    expect(prompt).toContain("#3 00:02:10 (130)");
    expect(prompt).toContain("at most 16 frames");
  });

  test("says the burned-in label is authoritative, and prose is the cross-check", () => {
    // The prose list was the ONLY channel through fix round 1, and the model
    // could not apply it — four cells of one sheet named wrong on both runs.
    // What this pins is that the prompt sends the model to the label instead.
    const prompt = selectionPrompt({
      title: "A talk",
      durationSec: 200,
      sheets,
      sheetDir: "/tmp/select",
      limit: 16,
    });
    expect(prompt).toContain("label burned in under the picture");
    expect(prompt).toContain("That label is authoritative");
    expect(prompt).toContain("Do not count cells");
    expect(prompt).toContain("the label under the cell wins");
    expect(prompt).toContain("`tSeconds` is the second the cell's OWN label shows");
  });

  test("says the layout is row-major and that padding cells have no second", () => {
    const prompt = selectionPrompt({
      title: "A talk",
      durationSec: 200,
      sheets,
      sheetDir: "/tmp/select",
      limit: 16,
    });
    expect(prompt).toContain("ROW-MAJOR");
    expect(prompt).toContain(`${CONTACT_SHEET.cols}×${CONTACT_SHEET.rows}`);
    // Padding is where the two channels genuinely differ: `tile` fills a short
    // sheet with black cells that carry no caption at all.
    expect(prompt).toContain("they carry no label and they have no second");
  });
});

// --- the budget -------------------------------------------------------------

describe("the two-pass budget", () => {
  const FLOOR = 600_000;

  test("selectionTimeoutFor: 300 s plus 30 s a sheet", () => {
    expect(selectionTimeoutFor(0)).toBe(300_000);
    expect(selectionTimeoutFor(10)).toBe(600_000);
  });

  test("the whole budget covers the selection call, the re-grab and a full summary call", () => {
    // 10 sheets ⇒ 600 s of selection; 40 frames ⇒ 30 s + 40 × 3 s of re-grab and
    // 600 s + 10 × 24 s of summary. The re-grab is bounded work this job does
    // between the two calls, so a budget naming only the model calls is one the
    // job cannot honour.
    expect(twoPassBudgetFor(10, 40, FLOOR)).toBe(600_000 + 150_000 + 840_000);
    expect(twoPassBudgetFor(10, 40, FLOOR)).toBe(
      selectionTimeoutFor(10) + framesTimeoutFor(40) + summarizeTimeoutFor(40, FLOOR),
    );
  });

  test("a fast selection pass does NOT hand the summary call the whole remainder", () => {
    const split = splitTwoPassBudget({
      wholeMs: twoPassBudgetFor(10, 40, FLOOR),
      selectionElapsedMs: 120_000,
      frameCount: 40,
      floorMs: FLOOR,
    });
    expect(split.launch).toBe(true);
    expect(split.remainingMs).toBe(1_470_000);
    // The single-pass path's own number for the same 40 frames, and nothing
    // more: a second model call must not buy the first one a longer hang.
    expect(split.synthesisTimeoutMs).toBe(summarizeTimeoutFor(40, FLOOR));
    expect(split.synthesisTimeoutMs).toBeLessThan(split.remainingMs);
  });

  test("a selection pass that ate the budget REFUSES the second call", () => {
    const whole = twoPassBudgetFor(10, 40, FLOOR);
    const split = splitTwoPassBudget({
      wholeMs: whole,
      selectionElapsedMs: whole - 60_000,
      frameCount: 40,
      floorMs: FLOOR,
    });
    expect(split.launch).toBe(false);
    expect(split.remainingMs).toBe(60_000);
  });

  test("the gate is exactly the summary call's own floor", () => {
    const whole = twoPassBudgetFor(10, 40, FLOOR);
    const floor = 600_000 + 10 * 24_000;
    expect(
      splitTwoPassBudget({ wholeMs: whole, selectionElapsedMs: whole - floor, frameCount: 40, floorMs: FLOOR })
        .launch,
    ).toBe(true);
    expect(
      splitTwoPassBudget({ wholeMs: whole, selectionElapsedMs: whole - floor + 1, frameCount: 40, floorMs: FLOOR })
        .launch,
    ).toBe(false);
  });

  test("an overrun never reports a negative remainder", () => {
    const split = splitTwoPassBudget({
      wholeMs: 100,
      selectionElapsedMs: 5_000,
      frameCount: 3,
      floorMs: FLOOR,
    });
    expect(split.remainingMs).toBe(0);
    expect(split.launch).toBe(false);
  });
});

// --- the switch -------------------------------------------------------------

describe("resolveFrameScanMode", () => {
  test("unset is dense — the default this PR ships", () => {
    expect(resolveFrameScanMode({})).toEqual({ mode: "dense", unrecognized: null });
    expect(resolveFrameScanMode({ YOUTUBE_FRAME_SCAN: "  " })).toEqual({ mode: "dense", unrecognized: null });
  });

  test("both modes are recognised, case and padding insensitively", () => {
    expect(resolveFrameScanMode({ YOUTUBE_FRAME_SCAN: "cadence" }).mode).toBe("cadence");
    expect(resolveFrameScanMode({ YOUTUBE_FRAME_SCAN: " DENSE " }).mode).toBe("dense");
  });

  test("an UNRECOGNISED value is cadence, and says so", () => {
    // The direction matters: this variable exists to turn the dense path OFF, so
    // a typo that left it on would be the switch failing at its only job.
    expect(resolveFrameScanMode({ YOUTUBE_FRAME_SCAN: "cadance" })).toEqual({
      mode: "cadence",
      unrecognized: "cadance",
    });
  });
});
