/**
 * The pairing of the server's step list with the rendered rows (fix round 1
 * batch 3, finding 1). DOM-free: the reader's own lane reorder is pinned in
 * `e2e/wiki-step-done.spec.ts`.
 */
import { expect, test } from "bun:test";
import { needsReload, pairStepRows, renderedMatchText, retryable, sourceMatchText, type RenderedLane } from "./wiki-step-done.ts";

const step = (key: string, lane: number, row: number | null, text: string, refusal: string | null = null) => ({ key, lane, row, text, refusal });

const list = {
  laneRows: [2, 2],
  steps: [step("a1", 0, 0, "Alpha one."), step("a2", 0, 1, "**Alpha** two."), step("b1", 1, 0, "Beta one."), step("b2", 1, 1, "Beta two.")],
};

const lane = (kind: string, group: number, order: number | null, rows: string[]): RenderedLane => ({ kind, group, order, rows });

test("source text matches its rendered row: emphasis, links, autolinks, tags and entities", () => {
  expect(sourceMatchText("**Water the plants:** the ferns first.")).toBe(renderedMatchText("Water the plants: the ferns first."));
  expect(sourceMatchText("Read [the guide](https://example.invalid/g) & `run it`")).toBe(renderedMatchText("Read the guide & run it"));
  expect(sourceMatchText("See <https://example.invalid/x> &amp; <Kbd>Enter</Kbd>")).toBe(renderedMatchText("See https://example.invalid/x & Enter"));
  expect(sourceMatchText("Alpha one.")).not.toBe(renderedMatchText("Beta one."));
});

test("lanes reordered on screen pair by their source order, not their DOM position", () => {
  // DOM order [utvikler (source 1), fag (source 0)], as applyLaneRoles leaves it.
  const lanes = [lane("you", 0, 1, ["Beta one.", "Beta two."]), lane("you", 0, 0, ["Alpha one.", "Alpha two."])];
  expect(pairStepRows(lanes, list)).toEqual([
    { lane: 1, row: 0, key: "a1" },
    { lane: 1, row: 1, key: "a2" },
    { lane: 0, row: 0, key: "b1" },
    { lane: 0, row: 1, key: "b2" },
  ]);
});

test("a lane whose rows do not all match their steps gets nothing; the other lane keeps its pairs", () => {
  const lanes = [lane("you", 0, 0, ["Alpha one.", "Polish the brass knob."]), lane("you", 0, 1, ["Beta one.", "Beta two."])];
  expect(pairStepRows(lanes, list).map((p) => p.key)).toEqual(["b1", "b2"]);
});

test("without a source order the DOM order is the guess, and the text check refuses a wrong guess", () => {
  const lanes = [lane("you", 0, null, ["Beta one.", "Beta two."]), lane("you", 0, null, ["Alpha one.", "Alpha two."])];
  expect(pairStepRows(lanes, list)).toEqual([]);
});

test("other kinds count for the order but get no steps; blocks keep their order; refused steps are skipped", () => {
  const lanes = [
    lane("waiting", 0, 0, ["Parcel."]),
    lane("you", 0, 1, ["Alpha one.", "Alpha two."]),
    lane("you", 1, 0, ["Beta one.", "Beta two."]),
  ];
  const refused = { laneRows: [2, 2], steps: [...list.steps.slice(0, 3), step("b2", 1, null, "Beta two.", "a <Checklist> row")] };
  expect(pairStepRows(lanes, refused).map((p) => p.key)).toEqual(["a1", "a2", "b1"]);
});

test("a row-count or lane-count mismatch pairs nothing in that scope", () => {
  expect(pairStepRows([lane("you", 0, 0, ["Alpha one.", "Alpha two."])], list)).toEqual([]);
  const short = [lane("you", 0, 0, ["Alpha one."]), lane("you", 0, 1, ["Beta one.", "Beta two."])];
  expect(pairStepRows(short, list).map((p) => p.key)).toEqual(["b1", "b2"]);
  // Every step's row still matches, but the lane renders a row the server did not count.
  const extra = [lane("you", 0, 0, ["Alpha one.", "Alpha two.", "A row from elsewhere."]), lane("you", 0, 1, ["Beta one.", "Beta two."])];
  expect(pairStepRows(extra, list).map((p) => p.key)).toEqual(["b1", "b2"]);
});

test("empty match text never pairs", () => {
  const lanes = [lane("you", 0, 0, [""])];
  expect(pairStepRows(lanes, { laneRows: [1], steps: [step("x", 0, 0, "![](img.png)")] })).toEqual([]);
});

// What each refusal of the write leaves the reader to do (fix round 1 batch 4).
// The shapes are the route's own answers in `routes/wiki-step-done.ts`.
const REFUSALS: [name: string, status: number, data: Record<string, unknown>, retry: boolean, reload: boolean][] = [
  ["the page changed", 409, { stale: true }, false, true],
  ["the preview no longer fits", 409, { changed: true }, false, true],
  ["the answer never came", 0, {}, false, true],
  ["the route failed", 500, {}, false, true],
  ["a session is writing to the wiki", 409, { locked: true }, true, false],
  ["the Gardener's cards could not be read", 503, {}, true, false],
  ["a Gardener card holds the page", 409, { held: true }, false, false],
  ["the page has uncommitted edits", 409, { dirty: true }, false, false],
  ["the step cannot be removed", 409, { refused: true, code: "nested" }, false, false],
  ["the wiki is read-only", 403, { readonly: true }, false, false],
  ["no Done on this wiki", 404, {}, false, false],
];

for (const [name, status, data, retry, reload] of REFUSALS) {
  test(`refusal, ${name}: Remove ${retry ? "stays on" : "goes off"}, Reload ${reload ? "shows" : "stays hidden"}`, () => {
    expect(retryable(status, data)).toBe(retry);
    expect(needsReload(status, data)).toBe(reload);
  });
}
