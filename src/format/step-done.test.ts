import { describe, expect, test } from "bun:test";
import { listYouSteps, stepDoneEdit, stepDoneLogLine, stepKey, youLaneRows, type StepDoneEdit } from "./step-done.ts";
import { countedNextMovesLanes, parseBlocks } from "./markdown-ast.ts";
import { formatWebHtml } from "../web/web-format.ts";

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
    expect(r.renumbered).toEqual([]);
    expect(r.laneRemoved).toBe(false);
  });

  test("a numbered first step: every later item counts down one", () => {
    const text = page(moves(you("1. One.\n2. Two.\n3. Three.")));
    const r = done(text, "One.");
    expect(r.content).toBe(page(moves(you("1. Two.\n2. Three."))));
    expect(r.renumbered).toEqual([
      { line: 10, before: "2. Two.", after: "1. Two." },
      { line: 11, before: "3. Three.", after: "2. Three." },
    ]);
    const html = parseBlocks(r.content.split("\n").slice(4).join("\n"));
    const lane = countedNextMovesLanes(html).lanes[0]!;
    const ol = lane.children.find((b) => b.type === "ol");
    expect(ol && ol.type === "ol" && ol.start).toBe(1);
  });

  test("a numbered middle step renumbers what follows; the last step renumbers nothing", () => {
    const text = page(moves(you("1. One.\n2. Two.\n3. Three.")));
    const mid = done(text, "Two.");
    expect(mid.content).toBe(page(moves(you("1. One.\n2. Three."))));
    expect(mid.renumbered).toEqual([{ line: 11, before: "3. Three.", after: "2. Three." }]);
    const last = done(text, "Three.");
    expect(last.content).toBe(page(moves(you("1. One.\n2. Two."))));
    expect(last.renumbered).toEqual([]);
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

/** The numbers the page formatter shows for each top-level item of the page's numbered lists. */
function shownNumbers(text: string): number[][] {
  const body = text.startsWith("---\n") ? text.slice(text.indexOf("\n---\n") + 5) : text;
  const html = formatWebHtml(body).replace(/<ul>[\s\S]*?<\/ul>/g, "");
  return [...html.matchAll(/<ol(?: start="(\d+)")?>([\s\S]*?)<\/ol>/g)].map((m) => {
    let n = m[1] ? Number(m[1]) : 1;
    return [...m[2]!.matchAll(/<li(?: value="(\d+)")?>/g)].map((li) => {
      if (li[1]) n = Number(li[1]);
      return n++;
    });
  });
}

describe("stepDoneEdit: a numbered list reads on without a gap (finding 1)", () => {
  const loose = page(moves(you("1. A.\n\n2. B.\n\n3. C.")));

  test("a loose list, first item done: the rest count down, file and render", () => {
    expect(shownNumbers(loose)).toEqual([[1, 2, 3]]);
    const r = done(loose, "A.");
    expect(r.content).toBe(page(moves(you("1. B.\n\n2. C."))));
    expect(shownNumbers(r.content)).toEqual([[1, 2]]);
  });

  test("a loose list, middle item done", () => {
    const r = done(loose, "B.");
    expect(r.content).toBe(page(moves(you("1. A.\n\n2. C."))));
    expect(shownNumbers(r.content)).toEqual([[1, 2]]);
    expect(r.renumbered).toEqual([{ line: 13, before: "3. C.", after: "2. C." }]);
  });

  test("a tight list with nested content after the gap", () => {
    const text = page(moves(you("1. A.\n2. B.\n3. C.\n   - child\n4. D.")));
    expect(shownNumbers(text)).toEqual([[1, 2, 3, 4]]);
    const r = done(text, "B.");
    expect(r.content).toBe(page(moves(you("1. A.\n2. C.\n   - child\n3. D."))));
    expect(shownNumbers(r.content)).toEqual([[1, 2, 3]]);
  });

  test("a list numbered 1. 1. 1. stays as written", () => {
    expect(done(page(moves(you("1. A.\n1. B.\n1. C."))), "B.").content).toBe(page(moves(you("1. A.\n1. C."))));
    const r = done(page(moves(you("1. A.\n\n1. B.\n\n1. C."))), "A.");
    expect(r.content).toBe(page(moves(you("1. B.\n\n1. C."))));
    expect(r.renumbered).toEqual([]);
  });

  test("marker width and indentation are kept", () => {
    const wide = done(page(moves(you("9. A.\n10. B.\n11. C."))), "A.");
    expect(wide.content).toBe(page(moves(you("9.  B.\n10. C."))));
    expect(shownNumbers(wide.content)).toEqual([[9, 10]]);
    const indented = done(page(moves(you("  1. A.\n  2. B.\n  3. C."))), "A.");
    expect(indented.content).toBe(page(moves(you("  1. B.\n  2. C."))));
  });

  test("a list whose render would not read on is refused", () => {
    // Tight 1. 3. 7. renders 1, 2, 3; counting each later item down gives 2. 6., which renders 2, 3.
    const text = page(moves(you("1. A.\n3. B.\n7. C.")));
    expect(stepDoneEdit(text, keyOf(text, "A."))).toMatchObject({ ok: false, code: "unplaceable" });
  });

  test("a list that starts at 5, loose: 5 stays the start", () => {
    const r = done(page(moves(you("5. A.\n\n6. B.\n\n7. C."))), "B.");
    expect(r.content).toBe(page(moves(you("5. A.\n\n6. C."))));
    expect(shownNumbers(r.content)).toEqual([[5, 6]]);
  });
});

describe("stepDoneEdit: each surviving line keeps its own ending (finding 2)", () => {
  const lf = page(moves(you("- A.\n- B.\n- C."), waiting("- W.")));

  test("an all-LF page", () => {
    expect(done(lf, "B.").content).toBe(page(moves(you("- A.\n- C."), waiting("- W."))));
  });

  test("an all-CRLF page", () => {
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(done(crlf, "B.").content).toBe(page(moves(you("- A.\n- C."), waiting("- W."))).replace(/\n/g, "\r\n"));
  });

  test("a mixed page: only the step's line goes", () => {
    const mixed = "---\ntitle: Fixture\n---\n\nIntro.\r\n<NextMoves>\n\n<Lane kind=\"you\">\n\n- A.\n- B.\r\n- C.\r\n\n</Lane>\n\n</NextMoves>\n";
    const r = done(mixed, "B.");
    expect(r.content).toBe("---\ntitle: Fixture\n---\n\nIntro.\r\n<NextMoves>\n\n<Lane kind=\"you\">\n\n- A.\n- C.\r\n\n</Lane>\n\n</NextMoves>\n");
  });

  test("a mixed page: a renumbered line keeps its own ending", () => {
    const mixed = "Intro.\n<NextMoves>\n<Lane kind=\"you\">\n1. A.\r\n2. B.\n3. C.\r\n</Lane>\n</NextMoves>\n";
    const r = done(mixed, "A.");
    expect(r.content).toBe("Intro.\n<NextMoves>\n<Lane kind=\"you\">\n1. B.\n2. C.\r\n</Lane>\n</NextMoves>\n");
    expect(shownNumbers(mixed)).toEqual([[1, 2, 3]]);
    expect(shownNumbers(r.content)).toEqual([[1, 2]]);
  });

  test("a mixed page losing its block keeps the other endings", () => {
    const mixed = "Intro.\r\n\r\n<NextMoves>\n\n<Lane kind=\"you\">\n\n- A.\n\n</Lane>\n\n</NextMoves>\n\nAfter.\nLast.\r\n";
    expect(done(mixed, "A.").content).toBe("Intro.\r\n\r\nAfter.\nLast.\r\n");
  });

  test("a page with no trailing newline keeps none", () => {
    expect(done("Intro.\n\n<NextMoves>\n<Lane kind=\"you\">\n- A.\n</Lane>\n</NextMoves>", "A.").content).toBe("Intro.");
    expect(done("Intro.\r\n<NextMoves>\r\n<Lane kind=\"you\">\r\n- A.\r\n- B.\r\n</Lane>\r\n</NextMoves>", "B.").content).toBe(
      "Intro.\r\n<NextMoves>\r\n<Lane kind=\"you\">\r\n- A.\r\n</Lane>\r\n</NextMoves>",
    );
  });
});

describe("stepDoneEdit: blank lines around the removed lines (finding 3)", () => {
  /** The visible paragraphs the formatter shows: a blank line between rendered lines ends one. */
  const paragraphs = (text: string) => formatWebHtml(text).split(/\n[ \t]*\n/);

  test("a block between two paragraphs leaves one blank line between them", () => {
    const text = 'Intro.\n<NextMoves>\n<Lane kind="you">\n- A.\n</Lane>\n</NextMoves>\nAfter.';
    const r = done(text, "A.");
    expect(r.content).toBe("Intro.\n\nAfter.");
    expect(formatWebHtml(text)).toMatch(/^Intro\.\n<section class="next-moves">[\s\S]*<\/section>\nAfter\.$/);
    expect(paragraphs(r.content)).toEqual(["Intro.", "After."]);
  });

  test("a list between prose above and below in a lane that stays", () => {
    const text = page(moves(you("Prose above.\n- A.\nProse below.")));
    const r = done(text, "A.");
    expect(r.content).toBe(page(moves(you("Prose above.\n\nProse below."))));
  });

  test("a lane between prose in its <NextMoves>", () => {
    const text = page('<NextMoves>\nNote.\n<Lane kind="you">\n- A.\n</Lane>\nMore.\n<Lane kind="waiting" who="X">\n- W.\n</Lane>\n</NextMoves>\n');
    expect(done(text, "A.").content).toBe(page('<NextMoves>\nNote.\n\nMore.\n<Lane kind="waiting" who="X">\n- W.\n</Lane>\n</NextMoves>\n'));
  });

  test("a lane between two tag lines leaves no blank line", () => {
    const text = page('<NextMoves>\n<Lane kind="you">\n- A.\n</Lane>\n<Lane kind="waiting" who="X">\n- W.\n</Lane>\n</NextMoves>\n');
    expect(done(text, "A.").content).toBe(page('<NextMoves>\n<Lane kind="waiting" who="X">\n- W.\n</Lane>\n</NextMoves>\n'));
  });

  test("a page that starts with the block keeps no leading blank line", () => {
    const text = '<NextMoves>\n\n<Lane kind="you">\n\n- A.\n\n</Lane>\n\n</NextMoves>\n\nBody.\n';
    expect(done(text, "A.").content).toBe("Body.\n");
  });

  test("a tight list's middle item leaves no blank line", () => {
    const text = page(moves(you("Prose above.\n- A.\n- B.\n- C.")));
    expect(done(text, "B.").content).toBe(page(moves(you("Prose above.\n- A.\n- C."))));
  });
});
