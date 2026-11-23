/**
 * The pairing of the server's step list with the rendered rows, and the
 * preview's line for renumbered steps. DOM-free: the reader's own lane reorder
 * is pinned in `e2e/wiki-step-done.spec.ts`.
 */
import { expect, test } from "bun:test";
import { checkedKeysByLane, needsReload, pairStepRows, previewAllHtml, previewHtml, renumberAllLine, renumberLine, retryable, type RenderedLane } from "./wiki-step-done.ts";

const step = (key: string, lane: number, row: number | null, refusal: string | null = null) => ({ key, lane, row, refusal });

const list = {
  laneRows: [2, 2],
  steps: [step("a1", 0, 0), step("a2", 0, 1), step("b1", 1, 0), step("b2", 1, 1)],
};

const lane = (kind: string, group: number, order: number | null, rows: number): RenderedLane => ({ kind, group, order, rows });

test("lanes reordered on screen pair by their source order, not their DOM position", () => {
  // DOM order [utvikler (source 1), fag (source 0)], as applyLaneRoles leaves it.
  const lanes = [lane("you", 0, 1, 2), lane("you", 0, 0, 2)];
  expect(pairStepRows(lanes, list)).toEqual([
    { lane: 1, row: 0, key: "a1" },
    { lane: 1, row: 1, key: "a2" },
    { lane: 0, row: 0, key: "b1" },
    { lane: 0, row: 1, key: "b2" },
  ]);
});

test("without a source order the DOM order is the source order", () => {
  const lanes = [lane("you", 0, null, 2), lane("you", 0, null, 2)];
  expect(pairStepRows(lanes, list).map((p) => [p.lane, p.key])).toEqual([
    [0, "a1"],
    [0, "a2"],
    [1, "b1"],
    [1, "b2"],
  ]);
});

test("other kinds count for the order but get no steps; blocks keep their order; refused steps are skipped", () => {
  const lanes = [lane("waiting", 0, 0, 1), lane("you", 0, 1, 2), lane("you", 1, 0, 2)];
  const refused = { laneRows: [2, 2], steps: [...list.steps.slice(0, 3), step("b2", 1, null, "a <Checklist> row")] };
  expect(pairStepRows(lanes, refused)).toEqual([
    { lane: 1, row: 0, key: "a1" },
    { lane: 1, row: 1, key: "a2" },
    { lane: 2, row: 0, key: "b1" },
  ]);
  // A refused list step keeps its row and still gets nothing.
  const nested = { laneRows: [2, 2], steps: [step("a1", 0, 0), step("a2", 0, 1, "the step holds a nested list"), ...list.steps.slice(2)] };
  expect(pairStepRows(lanes, nested).map((p) => p.key)).toEqual(["a1", "b1", "b2"]);
});

test("a lane that renders another number of rows than the server counted gets nothing; the other lane keeps its pairs", () => {
  expect(pairStepRows([lane("you", 0, 0, 1), lane("you", 0, 1, 2)], list).map((p) => p.key)).toEqual(["b1", "b2"]);
  expect(pairStepRows([lane("you", 0, 0, 3), lane("you", 0, 1, 2)], list).map((p) => p.key)).toEqual(["b1", "b2"]);
  expect(pairStepRows([lane("you", 0, 0, 2), lane("you", 0, 1, 0)], list).map((p) => p.key)).toEqual(["a1", "a2"]);
});

test("another number of you lanes than the server counted pairs nothing", () => {
  expect(pairStepRows([lane("you", 0, 0, 2)], list)).toEqual([]);
  expect(pairStepRows([lane("you", 0, 0, 2), lane("you", 0, 1, 2), lane("you", 1, 0, 2)], list)).toEqual([]);
  expect(pairStepRows([lane("waiting", 0, 0, 2), lane("you", 0, 1, 2)], list)).toEqual([]);
});

test("a step whose row the lane does not hold pairs nothing in that lane", () => {
  const off = { laneRows: [2, 2], steps: [step("a1", 0, 0), step("a9", 0, 2), step("b1", 1, 0)] };
  expect(pairStepRows([lane("you", 0, 0, 2), lane("you", 0, 1, 2)], off).map((p) => p.key)).toEqual(["b1"]);
});

const preview = (renumbered: { line: number; before: string; after: string }[]) => ({
  removed: [{ line: 10, text: "1. First step, with a long sentence of its own." }],
  renumbered,
  laneRemoved: false,
  nextMovesRemoved: false,
  logEntry: "## [2026-11-10] step-done | Fixture\n- Step done: First step.",
  logNote: "log.md gets this entry.",
  previewHash: "h",
});
const later = (n: number, from = 2) =>
  Array.from({ length: n }, (_, k) => ({ line: 11 + k, before: `${from + k}. Later step ${k} <b>with</b> prose of its own.`, after: `${from + k - 1}. Later step ${k} <b>with</b> prose of its own.` }));

test("the renumbered steps take one line, however many they are", () => {
  expect(renumberLine(later(7))).toBe("The 7 steps after it take new numbers: 2–8 become 1–7.");
  expect(renumberLine(later(2))).toBe("The 2 steps after it take new numbers: 2–3 become 1–2.");
  expect(renumberLine(later(1, 6))).toBe("The step after it takes a new number: 6 becomes 5.");
  expect(renumberLine([])).toBe("");
  // Indented and padded markers read the same; a line with no readable marker leaves the numbers out.
  expect(renumberLine([{ line: 3, before: "  10. X", after: "  9.  X" }])).toBe("The step after it takes a new number: 10 becomes 9.");
  expect(renumberLine([{ line: 3, before: "X", after: "X" }])).toBe("The step after it takes a new number.");
  expect(renumberLine([...later(1), { line: 3, before: "X", after: "X" }])).toBe("The 2 steps after it take new numbers.");
});

test("the preview shows that line once and none of the renumbered steps' text", () => {
  const html = previewHtml(preview(later(7)));
  expect(html.split("take new numbers").length - 1).toBe(1);
  expect(html).toContain(`<div class="wiki-step-done-sub">The 7 steps after it take new numbers: 2–8 become 1–7.</div>`);
  expect(html).not.toContain("Later step");
  expect(html).toContain("1. First step, with a long sentence of its own.");
  const none = previewHtml(preview([]));
  expect(none).not.toContain("new number");
  expect(none.split("wiki-step-done-sub").length - 1).toBe(1);
});

// What each answer to the write, other than `ok`, leaves the reader to do.
// The first block is the route's refusals in `routes/wiki-step-done.ts`, each
// with its status, its flag and an `error` text as the route sends them; the
// second is what can come back when the route did not answer.
const e = "why, as the route words it";
const REFUSALS: [name: string, status: number, data: Record<string, unknown>, retry: boolean, reload: boolean][] = [
  ["the page changed", 409, { error: e, stale: true }, false, true],
  ["the preview no longer fits", 409, { error: e, changed: true }, false, true],
  ["a session is writing to the wiki", 409, { error: e, locked: true }, true, false],
  ["the Gardener's cards could not be read", 503, { error: e }, true, false],
  ["a Gardener card holds the page", 409, { error: e, held: true }, false, false],
  ["the page has uncommitted edits", 409, { error: e, dirty: true }, false, false],
  ["the step cannot be removed", 409, { error: e, refused: true, code: "nested" }, false, false],
  ["the page cannot be read", 409, { error: e }, false, false],
  ["a field is missing", 400, { error: e }, false, false],
  ["the request is not JSON", 415, { error: e }, false, false],
  ["the wiki is read-only", 403, { error: e, readonly: true }, false, false],
  ["no Done on this wiki", 404, { error: e }, false, false],

  ["the answer never came", 0, { error: e }, false, true],
  ["the route failed", 500, { error: e }, false, true],
  ["a gateway timed out, with a page of its own", 504, {}, false, true],
  ["a bad gateway", 502, {}, false, true],
  ["a gateway's 404 that is not JSON", 404, {}, false, true],
  ["a gateway's 503 that is not JSON", 503, {}, true, true],
  ["a JSON body with no error text", 409, { message: "x" }, false, true],
  ["a 200 that does not say ok", 200, {}, false, true],
  ["a 200 that does not say ok, with an error text", 200, { error: e }, false, true],
];

for (const [name, status, data, retry, reload] of REFUSALS) {
  test(`refusal, ${name}: Remove ${retry ? "stays on" : "goes off"}, Reload ${reload ? "shows" : "stays hidden"}`, () => {
    expect(retryable(status, data)).toBe(retry);
    expect(needsReload(status, data)).toBe(reload);
  });
}

test("«Remove N checked» collects exactly the ok steps, per lane, in row order", () => {
  const pairs = [
    { lane: 1, row: 1, key: "b2" },
    { lane: 0, row: 2, key: "a3" },
    { lane: 0, row: 0, key: "a1" },
    { lane: 0, row: 1, key: "a2" },
    { lane: 1, row: 0, key: "b1" },
    { lane: 2, row: 0, key: "c1" },
  ];
  const byKey = new Map<string, { state: unknown }>([
    ["a1", { state: "ok" }],
    ["a2", { state: "not-yet" }],
    ["a3", { state: "ok" }],
    ["b1", { state: "unknown" }],
    ["b2", { state: "OK" }],
    // c1 has no <Check>: the route did not answer it.
  ]);
  expect([...checkedKeysByLane(pairs, byKey)]).toEqual([[0, ["a1", "a3"]]]);
  expect([...checkedKeysByLane(pairs, new Map())]).toEqual([]);
});

test("the list preview names every step, every removed line and every renumbering", () => {
  const html = previewAllHtml({
    steps: [
      { key: "k0", lead: "Run <b>migration</b> 088.", text: "" },
      { key: "k2", lead: "Restart.", text: "" },
    ],
    removed: [
      { line: 9, text: "1. Run migration 088." },
      { line: 11, text: "3. Restart." },
    ],
    renumbered: [
      { line: 10, before: "2. Read.", after: "1. Read." },
      { line: 12, before: "4. Last.", after: "2. Last." },
    ],
    laneRemoved: false,
    nextMovesRemoved: false,
    lanesRemoved: 0,
    blocksRemoved: 0,
    logEntry: "## [d] step-done | T\n- Steps done (2): …",
    logNote: "note",
    previewHash: "h",
  });
  expect(html).toContain("these 2 checked steps");
  expect(html).toContain("<li>Run &lt;b&gt;migration&lt;/b&gt; 088.</li><li>Restart.</li>");
  expect(html).toContain('<span class="wiki-step-done-ln">9</span> 1. Run migration 088.\n<span class="wiki-step-done-ln">11</span> 3. Restart.');
  expect(html).toContain("2 steps take new numbers: 2 becomes 1, 4 becomes 2.");
  expect(html).toContain("data-step-done-all-confirm>Remove all 2</button>");
  expect(renumberAllLine([])).toBe("");
});
