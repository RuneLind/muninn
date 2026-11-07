import { describe, expect, test } from "bun:test";
import { parseQuestionChoices, splitQuestionLine } from "./question-choices.ts";

const LETTERED = [
  "**Which layout for the Decisions section?**",
  "",
  "Today every lane prints, empty or not.",
  "",
  "- **A — lanes, empty folded:** the four lanes stay; empty ones fold.",
  "- **B — one list:** every card in one list.",
  "",
  "**Recommendation: A.** It fixes both faults.",
].join("\n");

describe("splitQuestionLine", () => {
  test("drops code-span backticks from the question, which prints as plain text", () => {
    expect(splitQuestionLine("**How many snapshots should `make backup` keep?**\n\nmore").question).toBe("How many snapshots should make backup keep?");
  });

  test("a lone bold first line is the question and leaves the body", () => {
    const { question, rest } = splitQuestionLine(LETTERED);
    expect(question).toBe("Which layout for the Decisions section?");
    expect(rest.startsWith("Today every lane")).toBe(true);
  });
  test("no bold line: the first line, stripped, and the whole body", () => {
    expect(splitQuestionLine("Which `one`?\n\nmore")).toEqual({ question: "Which one?", rest: "Which `one`?\n\nmore" });
  });
  test("a bold lead with prose after it is not a question line", () => {
    expect(splitQuestionLine("**Note:** this one").question).toBe("Note: this one");
  });
});

describe("parseQuestionChoices", () => {
  test("the lettered shape", () => {
    expect(parseQuestionChoices(LETTERED, ["A", "B"])).toEqual({
      context: "Today every lane prints, empty or not.",
      rows: [
        { letter: "A", label: "lanes, empty folded", why: "the four lanes stay; empty ones fold." },
        { letter: "B", label: "one list", why: "every card in one list." },
      ],
      recommendation: { letter: "A", why: "It fixes both faults." },
    });
  });

  test("Anbefaling, with or without the period", () => {
    const body = "**Hvilken?**\n\n- **A — en:** x\n- **B — to:** y\n\n**Anbefaling: B** fordi.";
    expect(parseQuestionChoices(body, ["A", "B"])!.recommendation).toEqual({ letter: "B", why: "fordi." });
    expect(parseQuestionChoices(body.replace("B**", "B.**"), ["A", "B"])!.recommendation).toEqual({ letter: "B", why: "fordi." });
  });

  test.each([["—"], ["–"], ["-"]])("dash %s", (dash) => {
    const body = `**Q?**\n\n- **A ${dash} one:** x\n- **B ${dash} two:** y`;
    expect(parseQuestionChoices(body, ["A", "B"])!.rows.map((r) => r.label)).toEqual(["one", "two"]);
  });

  test("label-less rows, and the colon outside the bold", () => {
    const r = parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B**: y", ["A", "B"])!;
    expect(r.rows).toEqual([{ letter: "A", label: "", why: "x" }, { letter: "B", label: "", why: "y" }]);
    expect(r.context).toBe("");
  });

  test("rows that differ from the choices are null, in set or in order", () => {
    expect(parseQuestionChoices(LETTERED, ["A", "B", "C"])).toBeNull();
    expect(parseQuestionChoices(LETTERED, ["B", "A"])).toBeNull();
    expect(parseQuestionChoices(LETTERED, [])).toBeNull();
  });

  test("no rows is null", () => {
    expect(parseQuestionChoices("**Q?**\n\nA or B?\n\n**Recommendation: A.** x", ["A", "B"])).toBeNull();
  });

  test("no recommendation line: recommendation null", () => {
    expect(parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B:** y", ["A", "B"])!.recommendation).toBeNull();
  });

  test("a recommendation that opens with no choice refuses the shape, so its text is not dropped", () => {
    expect(parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B:** y\n\n**Recommendation: C.** z", ["A", "B"])).toBeNull();
    expect(parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B:** y\n\n**Recommendation: decide later.** z", ["A", "B"])).toBeNull();
    expect(parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B:** y\n\n**Recommendation: Always A.** z", ["A", "B"])).toBeNull();
  });

  test("a qualified recommendation takes its leading choice and keeps the qualifier in the why", () => {
    const r = parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B:** y\n\n**Recommendation: A, with B meanwhile.** z", ["A", "B"])!;
    expect(r.recommendation).toEqual({ letter: "A", why: "with B meanwhile. z" });
  });

  test("the letter follows the card's own recommendation rule: a quoted choice counts", () => {
    const r = parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B:** y\n\n**Recommendation: «B».** z", ["A", "B"])!;
    expect(r.recommendation).toEqual({ letter: "B", why: "z" });
  });

  test("prose after the rows, before the recommendation, refuses the shape", () => {
    expect(parseQuestionChoices("**Q?**\n\n- **A:** x\n- **B:** y\n\nSince Monday, both start later.\n\n**Recommendation: A.** z", ["A", "B"])).toBeNull();
  });

  test("prose between the rows would be dropped, so the shape is refused", () => {
    expect(parseQuestionChoices("**Q?**\n\n- **A:** x\n\nAn aside.\n\n- **B:** y", ["A", "B"])).toBeNull();
  });

  test("an indented line continues its row; text after the recommendation is its why", () => {
    const r = parseQuestionChoices("**Q?**\n\n- **A:** x\n  and more\n- **B:** y\n\n**Recommendation: A.** one\n\ntwo", ["A", "B"])!;
    expect(r.rows[0]!.why).toBe("x and more");
    expect(r.recommendation!.why).toBe("one\n\ntwo");
  });
});
