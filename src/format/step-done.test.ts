import { describe, expect, test } from "bun:test";
import { listYouSteps, stepDoneEdit, stepDoneLogLine, stepKey, youLaneRows, type StepDoneEdit } from "./step-done.ts";
import { countedNextMovesLanes, parseBlocks } from "./markdown-ast.ts";

const page = (body: string) => `---\ntitle: Fixture\n---\n\n${body}`;
const moves = (...lanes: string[]) => `<NextMoves>\n\n${lanes.join("\n\n")}\n\n</NextMoves>\n`;
const you = (body: string) => `<Lane kind="you">\n\n${body}\n\n</Lane>`;
const waiting = (body: string) => `<Lane kind="waiting" who="Someone">\n\n${body}\n\n</Lane>`;

function keyOf(text: string, stepText: string, n = 0): string {
  const steps = listYouSteps(text)!.filter((s) => s.text === stepText);
  expect(steps.length).toBeGreaterThan(n);
  return steps[n]!.key;
}

function done(text: string, stepText: string, n = 0): Extract<StepDoneEdit, { ok: true }> {
  const r = stepDoneEdit(text, keyOf(text, stepText, n));
  if (!r.ok) throw new Error(r.reason);
  return r;
}

const youItems = (text: string) =>
  countedNextMovesLanes(parseBlocks(text.split("\n").slice(4).join("\n"))).lanes.filter((l) => l.kind === "you").map((l) => l.items);

describe("stepDoneEdit", () => {
  test("a bulleted step: its line goes, the rest stays", () => {
    const text = page(moves(you("- First step.\n- Second step.\n- Third step."), waiting("- Waiting on O1.")));
    const r = done(text, "Second step.");
    expect(r.content).toBe(page(moves(you("- First step.\n- Third step."), waiting("- Waiting on O1."))));
    expect(r.removed).toEqual([{ line: 10, text: "- Second step." }]);
    expect(r.renumbered).toBeNull();
    expect(r.laneRemoved).toBe(false);
  });

  test("a numbered first step: the next item takes its number", () => {
    const text = page(moves(you("1. One.\n2. Two.\n3. Three.")));
    const r = done(text, "One.");
    expect(r.content).toBe(page(moves(you("1. Two.\n3. Three."))));
    expect(r.renumbered).toEqual({ line: 10, before: "2. Two.", after: "1. Two." });
    const html = parseBlocks(r.content.split("\n").slice(4).join("\n"));
    const lane = countedNextMovesLanes(html).lanes[0]!;
    const ol = lane.children.find((b) => b.type === "ol");
    expect(ol && ol.type === "ol" && ol.start).toBe(1);
  });

  test("a numbered middle and last step: no renumbering", () => {
    const text = page(moves(you("1. One.\n2. Two.\n3. Three.")));
    const mid = done(text, "Two.");
    expect(mid.content).toBe(page(moves(you("1. One.\n3. Three."))));
    expect(mid.renumbered).toBeNull();
    const last = done(text, "Three.");
    expect(last.content).toBe(page(moves(you("1. One.\n2. Two."))));
    expect(last.renumbered).toBeNull();
  });

  test("a numbered first step starting at 5 hands 5 on", () => {
    const text = page(moves(you("5. Five.\n6. Six.")));
    expect(done(text, "Five.").content).toBe(page(moves(you("5. Six."))));
  });

  test("a continuation line goes with its step", () => {
    const text = page(moves(you("- First step\n  wraps here.\n- Second step.")));
    const r = done(text, "First step\nwraps here.");
    expect(r.content).toBe(page(moves(you("- Second step."))));
    expect(r.removed.map((x) => x.text)).toEqual(["- First step", "  wraps here."]);
  });

  test("a step with a nested list is refused", () => {
    const text = page(moves(you("- Parent step.\n  - child one\n- Other.")));
    const r = stepDoneEdit(text, keyOf(text, "Parent step."));
    expect(r).toMatchObject({ ok: false, code: "nested" });
  });

  test("a <Checklist> row and a <RunChecklist> row are refused", () => {
    const text = page(moves(you("- Plain step.\n\n<Checklist>\n- [ ] Tick me.\n</Checklist>\n\n<RunChecklist>\n- [ ] Run me.\n</RunChecklist>")));
    const steps = listYouSteps(text)!;
    expect(steps.map((s) => s.text)).toEqual(["Plain step.", "Tick me.", "Run me."]);
    for (const t of ["Tick me.", "Run me."]) {
      expect(stepDoneEdit(text, keyOf(text, t))).toMatchObject({ ok: false, code: "checklist" });
    }
    expect(steps.find((s) => s.text === "Tick me.")!.row).toBeNull();
  });

  test("two identical steps: the ordinal picks the right one", () => {
    const text = page(moves(you("- **Do:** the same thing.\n- Between.\n- **Do:** the same thing."), you("- **Do:** the same thing.")));
    const keys = listYouSteps(text)!.filter((s) => s.text === "**Do:** the same thing.").map((s) => s.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    // The second identical step in the first lane, not the first or the other lane's.
    const r = done(text, "**Do:** the same thing.", 1);
    expect(r.content).toBe(page(moves(you("- **Do:** the same thing.\n- Between."), you("- **Do:** the same thing."))));
    const third = done(text, "**Do:** the same thing.", 2);
    expect(third.laneRemoved).toBe(true);
    expect(youItems(third.content)).toEqual([["**Do:** the same thing.", "Between.", "**Do:** the same thing."]]);
  });

  test("[x] rows before the target: the row index counts them, the delete hits the target", () => {
    const text = page(moves(you("- [x] Done already.\n- [ ]\n- [ ] Open one.\n- [ ] Open two.")));
    const steps = listYouSteps(text)!;
    expect(steps.map((s) => [s.text, s.row])).toEqual([
      ["Open one.", 2],
      ["Open two.", 3],
    ]);
    expect(youLaneRows(text)).toEqual([4]);
    const r = done(text, "Open two.");
    expect(r.content).toBe(page(moves(you("- [x] Done already.\n- [ ]\n- [ ] Open one."))));
  });

  test("the last step: the list and the lane go, the other lane stays", () => {
    const text = page(moves(you("- Only step."), waiting("- Waiting on O1.")));
    const r = done(text, "Only step.");
    expect(r.laneRemoved).toBe(true);
    expect(r.nextMovesRemoved).toBe(false);
    expect(r.content).toBe(page(moves(waiting("- Waiting on O1."))));
    expect(r.removed.map((x) => x.text)).toEqual(['<Lane kind="you">', "- Only step.", "</Lane>"]);
  });

  test("a lane that holds prose stays when its last step goes", () => {
    const text = page(moves(you("Ingen andre åpne steg.\n\n- Only step."), waiting("- W.")));
    const r = done(text, "Only step.");
    expect(r.laneRemoved).toBe(false);
    expect(r.content).toBe(page(moves(you("Ingen andre åpne steg."), waiting("- W."))));
    expect(youItems(r.content)).toEqual([[]]);
  });

  test("the last lane: <NextMoves> goes too", () => {
    const text = page(`Intro.\n\n${moves(you("- Only step."))}\nAfter.\n`);
    const r = done(text, "Only step.");
    expect(r.nextMovesRemoved).toBe(true);
    expect(r.content).toBe(page("Intro.\n\nAfter.\n"));
    expect(r.removed.map((x) => x.text)).toEqual(["<NextMoves>", '<Lane kind="you">', "- Only step.", "</Lane>", "</NextMoves>"]);
  });

  test("a page with two <NextMoves> blocks: the right block is edited", () => {
    const text = page(`${moves(you("- A step."))}\nMiddle.\n\n${moves(you("- B step."), waiting("- W."))}`);
    const r = done(text, "B step.");
    expect(r.content).toBe(page(`${moves(you("- A step."))}\nMiddle.\n\n${moves(waiting("- W."))}`));
    expect(youItems(r.content)).toEqual([["A step."]]);
  });

  test("a lane inside a <Fold>", () => {
    const text = page(`<Fold title="Next">\n\n${moves(you("- Folded one.\n- Folded two."))}\n</Fold>\n`);
    const r = done(text, "Folded one.");
    expect(r.content).toBe(page(`<Fold title="Next">\n\n${moves(you("- Folded two."))}\n</Fold>\n`));
  });

  test("a loose list drops one blank line with the step", () => {
    const text = page(moves(you("- One.\n\n- Two.\n\n- Three.")));
    expect(done(text, "Two.").content).toBe(page(moves(you("- One.\n\n- Three."))));
  });

  test("a waiting lane has no steps to mark done, and a settled block counts nowhere", () => {
    const text = page(`${moves(waiting("- W."))}\n<Historic since="2026-01-01">\n\n${moves(you("- Old."))}\n</Historic>\n`);
    expect(listYouSteps(text)).toEqual([]);
  });

  test("an unknown key is refused; a key is hash plus ordinal", () => {
    const text = page(moves(you("- A.")));
    expect(stepDoneEdit(text, stepKey("- A.", 1))).toMatchObject({ ok: false, code: "no-step" });
    expect(listYouSteps(text)![0]!.key).toBe(stepKey("- A.", 0));
  });

  test("the log line carries the bold label and the lead sentence", () => {
    const text = page(moves(you("- **Restart 3010:** so the bundle is fresh. Then look.")));
    const r = done(text, "**Restart 3010:** so the bundle is fresh. Then look.");
    expect(stepDoneLogLine(r)).toBe("Step done: Restart 3010 — so the bundle is fresh.");
    const plain = done(page(moves(you("- Read the page. Twice."))), "Read the page. Twice.");
    expect(stepDoneLogLine(plain)).toBe("Step done: Read the page.");
  });
});
