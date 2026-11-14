import { test, expect, describe } from "bun:test";
import type { PageFileResult } from "../format/query-block.ts";
import { renderWikiHtml } from "./render.ts";
import { pageRefTargets } from "./ref-targets.ts";

/** The page route's render options that move an anchor or a chip. */
const render = (md: string, files: Record<string, PageFileResult> = {}) =>
  renderWikiHtml(md, () => undefined, {
    views: true,
    readerShapes: true,
    files: new Map(Object.entries(files)),
    idLabels: { D: { one: "decision", other: "decisions" } },
  });
const targets = (md: string, ids: string[], files?: Record<string, PageFileResult>) => pageRefTargets(render(md, files), md, ids);

const LOG = [
  "# A",
  "",
  "<DecisionLog>",
  "",
  "- **O1** — Should we ship the widget? More words follow here.",
  "- **D1** — We ship it. Second sentence.",
  "- **D2** — Ship on Friday 2026-10-02.",
  "",
  "</DecisionLog>",
].join("\n");

describe("pageRefTargets — DecisionLog items", () => {
  test("first sentence, an open question's state, a decision's date; unknown ids left out", () => {
    const t = targets(LOG, ["O1", "D1", "D2", "X9"]);
    expect(Object.keys(t).sort()).toEqual(["D1", "D2", "O1"]);
    expect(t.O1).toEqual({ kind: "decision", anchor: "o1", text: "Should we ship the widget?", state: "open" });
    // A D item carries no question state.
    expect(t.D1).toEqual({ kind: "decision", anchor: "d1", text: "We ship it." });
    expect(t.D2!.date).toBe("2026-10-02");
  });

  test("a closed question reads Closed → the decision", () => {
    const md = LOG.replace("More words follow here.", "Closed 2026-10-01 (D2).");
    const t = targets(md, ["O1"]);
    expect(t.O1).toMatchObject({ state: "decided", decision: "D2", date: "2026-10-01" });
  });

  test("the anchor is the render's: a `-2` when another element holds the slug first", () => {
    // `<Query id="o5">` takes `o5`; the DecisionLog's `O5` (another chip text) gets `o5-2`.
    const md = [
      '<Query id="o5" question="Lower-case query?" answer="Yes.">',
      "",
      "Body.",
      "",
      "</Query>",
      "",
      "<DecisionLog>",
      "",
      "- **O5** — The upper-case item.",
      "",
      "</DecisionLog>",
    ].join("\n");
    const t = targets(md, ["O5", "o5"]);
    expect(t.O5).toMatchObject({ kind: "decision", anchor: "o5-2", text: "The upper-case item." });
    expect(t.o5).toMatchObject({ kind: "query", anchor: "o5" });
  });

  test("an id two kinds define names no target, as on the page itself (`refTargets`)", () => {
    const md = [
      '<Query id="O2" question="Q?" answer="A.">',
      "",
      "Body.",
      "",
      "</Query>",
      "",
      "<DecisionLog>",
      "",
      "- **O2** — Twice.",
      "- **D3** — Once.",
      "",
      "</DecisionLog>",
    ].join("\n");
    const t = targets(md, ["O2", "D3"]);
    expect(Object.keys(t)).toEqual(["D3"]);
  });
});

describe("pageRefTargets — Query cards and CaseBoard rows", () => {
  test("a Query card: its question and answer", () => {
    const md = '<Query id="Q-3" question="How many **cases**?" answer="Twelve &amp; more.">\n\nBody.\n\n</Query>';
    const t = targets(md, ["Q-3"])["Q-3"]!;
    expect(t.kind).toBe("query");
    expect(t.anchor).toBe("q-3");
    expect(t.text).toBe("How many cases?");
    expect(t.answer).toBeDefined();
  });

  test("a CaseBoard row: status, owner and note", () => {
    const yaml = ["- id: C7", "  status: hold", "  owner: Fag", "  note: Held **out** for now", "  refs: [D1]"].join("\n");
    const t = targets('<CaseBoard src="cases.yaml" />', ["C7"], { "cases.yaml": { ok: true, text: yaml } });
    expect(t.C7!.kind).toBe("case");
    expect(t.C7!.anchor).toBe("case-c7");
    expect(t.C7!.text).toContain("Fag");
    expect(t.C7!.text).toContain("Held out for now");
  });
});
