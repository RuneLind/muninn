import { describe, test, expect } from "bun:test";
import {
  chooseAnswer,
  errorKindOf,
  headingIdentities,
  initialPanelState,
  parseDonePayload,
  walkthroughPanelHtml,
} from "./wiki-walkthrough-view.ts";

const DONE = {
  heading: "Setup",
  steps: [{ title: "Install", text: "Explains <b>it</b>.", quote: "Run bun install." }],
  quiz: [{ question: "Which tool?", choices: ["npm", "bun"], answer: 1, quote: "Run bun install." }],
  dropped: [{ kind: "step", reason: "quote_not_in_section" }],
};

describe("headingIdentities", () => {
  test("ordinal counts per normalized text; count is that text's total", () => {
    expect(headingIdentities(["Setup", "Usage", " Setup  ", ""])).toEqual([
      { heading: "Setup", ordinal: 0, count: 2 },
      { heading: "Usage", ordinal: 0, count: 1 },
      { heading: "Setup", ordinal: 1, count: 2 },
      null,
    ]);
  });
});

describe("the panel state", () => {
  test("a quiz answer locks on the first choice", () => {
    const s = initialPanelState("a.md", { heading: "Setup", ordinal: 0, count: 1 });
    s.phase = "ready";
    s.result = parseDonePayload(DONE)!;
    expect(chooseAnswer(s, 0, 0)).toBe(true);
    expect(chooseAnswer(s, 0, 1)).toBe(false);
    expect(s.chosen[0]).toBe(0);
    const html = walkthroughPanelHtml(s);
    expect(html).toContain("Not quite");
    expect(html).toContain("is-wrong");
    expect(html).toContain("is-right");
    expect(html).toContain("disabled");
  });

  test("ready renders the steps escaped, with the quote and the dropped note", () => {
    const s = initialPanelState("a.md", { heading: "Setup", ordinal: 0, count: 1 });
    s.phase = "ready";
    s.result = parseDonePayload(DONE)!;
    const html = walkthroughPanelHtml(s);
    expect(html).toContain("Explains &lt;b&gt;it&lt;/b&gt;.");
    expect(html).toContain('<blockquote class="wiki-wt-quote">Run bun install.</blockquote>');
    expect(html).toContain("1 item was left out");
    expect(html).toContain("Check yourself");
  });

  test("loading and error states render no step", () => {
    const s = initialPanelState("a.md", { heading: "Setup", ordinal: 0, count: 1 });
    expect(walkthroughPanelHtml(s)).toContain("Writing a walkthrough");
    s.phase = "error";
    s.error = "boom";
    s.errorKind = "all_dropped";
    const html = walkthroughPanelHtml(s);
    expect(html).toContain("boom");
    expect(html).toContain("is-dropped");
    expect(html).not.toContain("wiki-wt-step");
  });

  test("parseDonePayload refuses a partial or empty payload", () => {
    expect(parseDonePayload({ ...DONE, steps: [] })).toBeNull();
    expect(parseDonePayload({ ...DONE, quiz: [{ ...DONE.quiz[0], answer: 5 }] })).toBeNull();
    expect(parseDonePayload(null)).toBeNull();
  });

  test("errorKindOf maps the two codes and defaults to model", () => {
    expect(errorKindOf("all_dropped")).toBe("all_dropped");
    expect(errorKindOf("parse_failed")).toBe("parse");
    expect(errorKindOf(undefined)).toBe("model");
  });
});
