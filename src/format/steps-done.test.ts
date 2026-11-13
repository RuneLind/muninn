import { describe, expect, test } from "bun:test";
import { listYouSteps, stepDoneEdit, stepsDoneEdit, stepsDoneLogLine, type StepsDoneEdit } from "./step-done.ts";

const page = (body: string) => `---\ntitle: Fixture\n---\n\n${body}`;
const moves = (...lanes: string[]) => `<NextMoves>\n\n${lanes.join("\n\n")}\n\n</NextMoves>\n`;
const you = (body: string) => `<Lane kind="you">\n\n${body}\n\n</Lane>`;
const waiting = (body: string) => `<Lane kind="waiting" who="Someone">\n\n${body}\n\n</Lane>`;

const keysOf = (text: string, ...texts: string[]) => {
  const steps = listYouSteps(text)!;
  return texts.map((t) => {
    const s = steps.find((x) => x.text === t);
    if (!s) throw new Error(`no step ${t}`);
    return s.key;
  });
};

function ok(r: StepsDoneEdit): Extract<StepsDoneEdit, { ok: true }> {
  if (!r.ok) throw new Error(r.reason);
  return r;
}

/** The same steps removed one at a time with the single edit, located by text after each removal, in `order`. */
function oneByOne(text: string, texts: string[], order: "high" | "low"): string {
  const orig = listYouSteps(text)!;
  const idx = texts.map((t) => orig.findIndex((s) => s.text === t)).sort((a, b) => (order === "high" ? b - a : a - b));
  let cur = text;
  let alive = orig.map((_, i) => i);
  for (const i of idx) {
    const now = listYouSteps(cur)!;
    const r = stepDoneEdit(cur, now[alive.indexOf(i)]!.key);
    if (!r.ok) throw new Error(r.reason);
    cur = r.content;
    alive = alive.filter((x) => x !== i);
  }
  return cur;
}

/** The list edit, checked against both one-at-a-time orders. */
function removeAll(text: string, ...texts: string[]) {
  const r = ok(stepsDoneEdit(text, keysOf(text, ...texts)));
  expect(r.content).toBe(oneByOne(text, texts, "high"));
  expect(r.content).toBe(oneByOne(text, texts, "low"));
  return r;
}

describe("stepsDoneEdit", () => {
  const bullets = page(moves(you("- One.\n- Two.\n- Three.\n- Four."), waiting("- W.")));
  const numbered = page(moves(you("1. One.\n2. Two.\n3. Three.\n4. Four.\n5. Five."), waiting("- W.")));

  test("first, middle and last of a bulleted list", () => {
    expect(removeAll(bullets, "One.").content).toBe(page(moves(you("- Two.\n- Three.\n- Four."), waiting("- W."))));
    expect(removeAll(bullets, "Two.", "Three.").content).toBe(page(moves(you("- One.\n- Four."), waiting("- W."))));
    expect(removeAll(bullets, "Four.").content).toBe(page(moves(you("- One.\n- Two.\n- Three."), waiting("- W."))));
  });

  test("non-adjacent numbered steps: one renumbering against the original lines", () => {
    const r = removeAll(numbered, "Two.", "Four.");
    expect(r.content).toBe(page(moves(you("1. One.\n2. Three.\n3. Five."), waiting("- W."))));
    expect(r.renumbered).toEqual([
      { line: 11, before: "3. Three.", after: "2. Three." },
      { line: 13, before: "5. Five.", after: "3. Five." },
    ]);
    expect(r.removed).toEqual([
      { line: 10, text: "2. Two." },
      { line: 12, text: "4. Four." },
    ]);
    expect(r.steps.map((s) => s.text)).toEqual(["Two.", "Four."]);
  });

  test("the order keys are given in does not matter", () => {
    const a = ok(stepsDoneEdit(numbered, keysOf(numbered, "Four.", "One.", "Two.")));
    const b = ok(stepsDoneEdit(numbered, keysOf(numbered, "One.", "Two.", "Four.")));
    expect(a).toEqual(b);
    expect(a.steps.map((s) => s.text)).toEqual(["One.", "Two.", "Four."]);
  });

  test("a numbered list whose items all carry one number stays as written", () => {
    const text = page(moves(you("1. A.\n1. B.\n1. C.")));
    const r = removeAll(text, "A.", "C.");
    expect(r.content).toBe(page(moves(you("1. B."))));
    expect(r.renumbered).toEqual([]);
  });

  test("every step of a lane: the lane goes, the other lane stays", () => {
    const r = removeAll(bullets, "One.", "Two.", "Three.", "Four.");
    expect(r.content).toBe(page(moves(waiting("- W."))));
    expect(r.lanesRemoved).toBe(1);
    expect(r.blocksRemoved).toBe(0);
  });

  test("every step on the page: the <NextMoves> block goes", () => {
    const text = page(`Intro.\n\n${moves(you("- A.\n- B."), you("1. C.\n2. D."))}\nAfter.\n`);
    const r = removeAll(text, "A.", "B.", "C.", "D.");
    expect(r.content).toBe(page("Intro.\n\nAfter.\n"));
    expect(r.lanesRemoved).toBe(2);
    expect(r.blocksRemoved).toBe(1);
  });

  test("steps across two lanes and two blocks", () => {
    const text = page(`${moves(you("- A1.\n- A2."))}\nMiddle.\n\n${moves(you("- B1."), waiting("- W."))}`);
    const r = removeAll(text, "A2.", "B1.");
    expect(r.content).toBe(page(`${moves(you("- A1."))}\nMiddle.\n\n${moves(waiting("- W."))}`));
    expect(r.lanesRemoved).toBe(1);
  });

  test("a loose list and a step that wraps", () => {
    const text = page(moves(you("- One\n  wraps.\n\n- Two.\n\n- Three.\n\n- Four.")));
    expect(removeAll(text, "One\nwraps.", "Three.").content).toBe(page(moves(you("- Two.\n\n- Four."))));
  });

  test("steps with and without a trailing <Check>", () => {
    const text = page(moves(you('1. Run migration 088. <Check migration="088" />\n2. Read the page.\n3. Restart. <Check restart="muninn" />')));
    const r = removeAll(text, 'Run migration 088. <Check migration="088" />', 'Restart. <Check restart="muninn" />');
    expect(r.content).toBe(page(moves(you("1. Read the page."))));
    expect(stepsDoneLogLine(r)).toBe("Steps done (2): Run migration 088.; Restart.");
  });

  test("[x] rows stay, and keep the lane", () => {
    const text = page(moves(you("- [x] Done.\n- [ ] Open one.\n- [ ] Open two.")));
    const r = removeAll(text, "Open one.", "Open two.");
    expect(r.content).toBe(page(moves(you("- [x] Done."))));
    expect(r.lanesRemoved).toBe(0);
  });

  test("empty, duplicate and too many keys refuse", () => {
    const [a] = keysOf(bullets, "One.");
    expect(stepsDoneEdit(bullets, [])).toMatchObject({ ok: false, code: "empty" });
    expect(stepsDoneEdit(bullets, [a!, a!])).toMatchObject({ ok: false, code: "duplicate", key: a });
    const all = listYouSteps(bullets)!.map((s) => s.key);
    expect(stepsDoneEdit(bullets, [...all, "x.99"])).toMatchObject({ ok: false, code: "too-many" });
  });

  test("a key of another page hash refuses the lot", () => {
    const other = page(moves(you("- One.\n- Two.")));
    const [foreign] = keysOf(other, "One.");
    const [mine] = keysOf(bullets, "Two.");
    expect(foreign).not.toBe(keysOf(bullets, "One.")[0]);
    expect(stepsDoneEdit(bullets, [mine!, foreign!])).toMatchObject({ ok: false, code: "no-step", key: foreign });
  });

  test("a valid step and a refused one: nothing goes, and the refusal names the step", () => {
    const text = page(moves(you("- Parent step.\n  - child one\n- Plain.\n\n<Checklist>\n- [ ] Tick me.\n</Checklist>")));
    const [parent, plain, tick] = keysOf(text, "Parent step.", "Plain.", "Tick me.");
    const nested = stepsDoneEdit(text, [plain!, parent!]);
    expect(nested).toMatchObject({ ok: false, code: "nested", key: parent });
    expect(!nested.ok && nested.reason).toContain("«Parent step.»");
    expect(stepsDoneEdit(text, [plain!, tick!])).toMatchObject({ ok: false, code: "checklist", key: tick });
  });

  test("a step the single edit refuses refuses the list", () => {
    // A list numbered 1, 3, 4 renders 1, 2, 3: removing its first item would
    // render 2, 3, so the single edit's postcondition refuses it.
    const text = page(moves(you("1. A.\n3. B.\n4. C.")));
    const [a, b, c] = keysOf(text, "A.", "B.", "C.");
    expect(stepDoneEdit(text, a!)).toMatchObject({ ok: false, code: "unplaceable" });
    expect(stepDoneEdit(text, c!).ok).toBe(true);
    const r = stepsDoneEdit(text, [c!, a!]);
    expect(r).toMatchObject({ ok: false, code: "unplaceable", key: a });
    expect(!r.ok && r.reason).toContain("«A.»");
    expect(ok(stepsDoneEdit(text, [b!, c!])).content).toBe(page(moves(you("1. A."))));
  });

  test("the log line is bounded: long leads cut, more than eight steps counted", () => {
    const long = "x".repeat(300);
    const steps = Array.from({ length: 11 }, (_, i) => ({ lead: i === 0 ? long : `Step ${i}.` }));
    const line = stepsDoneLogLine({ steps });
    expect(line.startsWith("Steps done (11): ")).toBe(true);
    expect(line).toContain("…; Step 1.");
    expect(line.endsWith("; Step 7.; and 3 more")).toBe(true);
    expect(line.length).toBeLessThan(220);
  });

  test("a sweep: every subset of a mixed page equals one-at-a-time removal", () => {
    const text = page(
      `${moves(you("1. A.\n2. B.\n\n3. C.\n4. D."), waiting("- W."), you("- E.\n- F.\n- [x] G.\n- [ ] H."))}\nBetween.\n\n${moves(you("- I.\n\n- J."))}`,
    );
    const texts = listYouSteps(text)!.map((s) => s.text);
    expect(texts).toEqual(["A.", "B.", "C.", "D.", "E.", "F.", "H.", "I.", "J."]);
    let n = 0;
    for (let mask = 1; mask < 1 << texts.length; mask++) {
      const set = texts.filter((_, i) => mask & (1 << i));
      const r = ok(stepsDoneEdit(text, keysOf(text, ...set)));
      expect(r.content).toBe(oneByOne(text, set, "low"));
      n++;
    }
    expect(n).toBe(511);
  });
});
