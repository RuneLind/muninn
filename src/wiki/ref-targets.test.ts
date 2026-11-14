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

describe("pageRefTargets — hover text is the item's own plain text", () => {
  const log = (...items: string[]) => ["# A", "", "<DecisionLog>", "", ...items, "", "</DecisionLog>"].join("\n");

  test("a DecisionLog item: strike, emphasis, code and links flattened; a bold opening does not end the sentence", () => {
    const t = targets(
      log(
        "- **S4** — ~~Is the widget shipped in 2024?~~ Closed 2026-10-07 (D1).",
        "- **D1** — **Bold** text with `code` here. Second.",
        "- **D2** — An *em* and _u_ word, see [[Page B|B]] and [docs](https://example.com).",
      ),
      ["S4", "D1", "D2"],
    );
    expect(t.S4!.text).toBe("Is the widget shipped in 2024?");
    expect(t.D1!.text).toBe("Bold text with code here.");
    expect(t.D2!.text).toBe("An em and u word, see B and docs.");
  });

  test("a reversed decision reads its new claim, not the struck one; a question keeps its struck text beside its state", () => {
    const t = targets(
      log(
        "- **S4** — ~~Is the widget shipped in 2024?~~ Closed 2026-10-07 (D9).",
        "- **D9** — ~~Case 7 gets a settlement for 2024.~~ Reversed in round 6: case 7 gets **no** settlement, the rule changed. More.",
        "- **D10** — ~~Struck whole, nothing after.~~",
        "- **D11** — Ship ~~on Friday~~ on Monday. Then rest.",
      ),
      ["S4", "D9", "D10", "D11"],
    );
    expect(t.S4).toMatchObject({ text: "Is the widget shipped in 2024?", state: "decided", decision: "D9" });
    expect(t.D9!.text).toBe("Reversed in round 6: case 7 gets no settlement, the rule changed.");
    expect(t.D10!.text).toBe("Struck whole, nothing after.");
    expect(t.D11!.text).toBe("Ship on Monday.");
  });

  test("display text keeps a leading `>`, number or `#`, and honours backslash escapes", () => {
    const t = targets(
      log(
        "- **D1** — > 5 cases are stopped. More.",
        "- **D2** — 3. juli ble det vedtatt. More.",
        "- **D3** — # 3 is chosen. More.",
        "- **D4** — See \\*not\\* this, and \\[x\\](y). More.",
        "- **D5** — 1) first. More.",
      ),
      ["D1", "D2", "D3", "D4", "D5"],
    );
    expect(t.D1!.text).toBe("> 5 cases are stopped.");
    expect(t.D2!.text).toBe("3. juli ble det vedtatt.");
    expect(t.D3!.text).toBe("# 3 is chosen.");
    expect(t.D4!.text).toBe("See *not* this, and [x](y).");
    expect(t.D5!.text).toBe("1) first.");
  });

  test("a Query card without a question or an answer never reads the next card's", () => {
    const md = [
      '<Query id="Q-1">',
      "",
      "Body one.",
      "",
      "</Query>",
      "",
      '<Query id="Q-2" question="Second question?" answer="Second answer.">',
      "",
      "Body two.",
      "",
      "</Query>",
    ].join("\n");
    const t = targets(md, ["Q-1", "Q-2"]);
    expect(t["Q-1"]).toEqual({ kind: "query", anchor: "q-1", text: "" });
    expect(t["Q-2"]).toMatchObject({ text: "Second question?", answer: "Second answer." });
  });

  test("a glossary term or a missing wikilink inside the question keeps the whole question, without the hidden definition", () => {
    const md = [
      '<Query id="Q-5" question="How many Hold cases per [[Nope]] month and theme?" answer="Twelve Holds in all months.">',
      "",
      "Body.",
      "",
      "</Query>",
      "",
      "<Glossary>",
      "",
      "- **Hold:** a case kept back secretdefinition",
      "",
      "</Glossary>",
    ].join("\n");
    const html = render(md);
    expect(html).toContain('class="gl-tip"');
    expect(html).toContain("wiki-link-missing");
    const t = pageRefTargets(html, md, ["Q-5"])["Q-5"]!;
    expect(t.text).toBe("How many Hold cases per Nope month and theme?");
    expect(t.answer).toBe("Twelve Holds in all months.");
  });

  test("a glossary term inside the answer reads without its hidden definition", () => {
    const md = [
      '<Query id="Q-6" question="How many?" answer="Twelve were Hold in all months.">',
      "",
      "Body.",
      "",
      "</Query>",
      "",
      "<Glossary>",
      "",
      "- **Hold:** a case kept back secretdefinition",
      "",
      "</Glossary>",
    ].join("\n");
    const html = render(md);
    // The tip sits inside the answer, so the assertion below reads a real one.
    expect(/<div class="query-answer">[\s\S]*class="gl-tip"/.test(html)).toBe(true);
    expect(pageRefTargets(html, md, ["Q-6"])["Q-6"]!.answer).toBe("Twelve were Hold in all months.");
  });

  test("an answer with a nested div is read whole", () => {
    const html =
      '<section class="query" id="q-8"><div class="query-head"><div class="query-title"><a class="query-id" href="#q-8">Q-8</a></div>' +
      '<div class="query-answer">Twelve <div class="x">nested</div> in all.</div></div></section>';
    expect(pageRefTargets(html, "", ["Q-8"])["Q-8"]!.answer).toBe("Twelve nested in all.");
  });

  test("an out-of-range character reference in a question does not throw", () => {
    const html =
      '<section class="query" id="q-9"><div class="query-head"><div class="query-title"><a class="query-id" href="#q-9">Q-9</a>' +
      '<span class="query-question">Big &#9999999; ref?</span></div></div></section>';
    expect(pageRefTargets(html, "", ["Q-9"])["Q-9"]!.text).toBe("Big � ref?");
  });
});
