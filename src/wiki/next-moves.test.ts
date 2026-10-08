import { describe, expect, test } from "bun:test";
import { extractNextMoves, leadSentence, MOVES_STEP_CHARS, MOVES_STEPS_MAX } from "./next-moves.ts";
import { laneFromAttrs, normalizeLaneKind, parseBlocks, parseLaneSince } from "../format/markdown-ast.ts";
import { renderWikiHtml } from "./render.ts";

const BLOCK = [
  "<NextMoves>",
  "",
  '<Lane kind="you" who="Du">',
  "",
  "1. **Send Slack-utkastet fra runde 4.** Blokkerer Å3 og Å4.",
  "   - a nested note that is not a step",
  "2. **Opprett oppgave 3 i Jira.**",
  "",
  "</Lane>",
  "",
  '<Lane kind="waiting" who="Venter på fag" since="2026-09-30">',
  "",
  "- Å1 — henlegge? (sendt 30.09)",
  "",
  "</Lane>",
  "",
  '<Lane kind="draft" since="2026-09-30">',
  "",
  "- Å3 — MEL-368918",
  "- 826477",
  "",
  "</Lane>",
  "",
  '<Lane kind="blocked">',
  "",
  "- Person 1404",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
].join("\n");

describe("extractNextMoves", () => {
  test("counts top-level items per lane kind; nested items are not steps", () => {
    const m = extractNextMoves(`---\ntitle: x\n---\n\n# X\n\n${BLOCK}\n`)!;
    expect(m.counts).toEqual({ you: 2, waiting: 1, draft: 2, blocked: 1 });
    expect(m.youSteps).toEqual(["Send Slack-utkastet fra runde 4.", "Opprett oppgave 3 i Jira."]);
  });

  test("no block ⇒ null; a block with no lanes ⇒ zero counts", () => {
    expect(extractNextMoves("# plain page\n\n- a list\n")).toBeNull();
    expect(extractNextMoves("<NextMoves>\n\n- loose item\n\n</NextMoves>")!.counts).toEqual({
      you: 0,
      waiting: 0,
      draft: 0,
      blocked: 0,
    });
  });

  test("a block inside a code fence is not a block", () => {
    expect(extractNextMoves("```mdx\n" + BLOCK + "\n```\n")).toBeNull();
  });

  test("a block quoted in the frontmatter is not a block", () => {
    // A block scalar: the component parser trims each line, so without the
    // frontmatter strip these indented lines WOULD open a block.
    const fm = [
      "---",
      "example: |",
      "  <NextMoves>",
      '  <Lane kind="you">',
      "  - x",
      "  </Lane>",
      "  </NextMoves>",
      "---",
      "",
      "Body.",
    ].join("\n");
    expect(extractNextMoves(fm)).toBeNull();
  });

  test("a block inside a Fold still counts; lanes in two blocks are summed", () => {
    const folded = `<Fold title="Status">\n\n${BLOCK}\n\n</Fold>\n\n${BLOCK}`;
    expect(extractNextMoves(folded)!.counts.you).toBe(4);
  });

  test("a stray Lane outside NextMoves counts nothing", () => {
    expect(extractNextMoves('<Lane kind="you">\n\n- x\n\n</Lane>\n\n<NextMoves>\n\n</NextMoves>')!.counts.you).toBe(0);
  });

  test("an unknown kind reads as waiting", () => {
    const m = extractNextMoves('<NextMoves>\n\n<Lane kind="someday">\n\n- x\n\n</Lane>\n\n</NextMoves>')!;
    expect(m.counts).toEqual({ you: 0, waiting: 1, draft: 0, blocked: 0 });
  });

  test("a lane of prose alone counts nothing: an empty-state line is not a step", () => {
    const m = extractNextMoves('<NextMoves>\n\n<Lane kind="you">\n\nIngenting å gjøre nå.\n\n</Lane>\n\n</NextMoves>')!;
    expect(m.counts.you).toBe(0);
    expect(m.youSteps).toEqual([]);
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(extractNextMoves(`<NextMoves>\n\n<Lane kind="you">\n\n${table}\n\n</Lane>\n\n</NextMoves>`)!.counts.you).toBe(0);
  });

  test("[x] items are done and do not count; [ ] items count with the marker stripped", () => {
    const m = extractNextMoves(
      '<NextMoves>\n\n<Lane kind="you">\n\n- [x] Sent the draft.\n- [ ] **Open the task.** Then wait.\n- [X] Also done\n- Plain step.\n\n</Lane>\n\n</NextMoves>',
    )!;
    expect(m.counts.you).toBe(2);
    expect(m.youSteps).toEqual(["Open the task.", "Plain step."]);
  });

  test("a Checklist inside a lane counts its open rows", () => {
    const m = extractNextMoves(
      '<NextMoves>\n\n<Lane kind="you">\n\n<Checklist>\n- [x] done\n- [ ] Open one.\n- [ ] Open two.\n</Checklist>\n\n</Lane>\n\n</NextMoves>',
    )!;
    expect(m.counts.you).toBe(2);
    expect(m.youSteps).toEqual(["Open one.", "Open two."]);
  });

  test("lanes inside a Historic or a resolved Callout count nothing; an open Callout still counts", () => {
    expect(extractNextMoves(`<Historic since="x">\n\n${BLOCK}\n\n</Historic>`)!.counts).toEqual({ you: 0, waiting: 0, draft: 0, blocked: 0 });
    expect(extractNextMoves(`<Fold title="F">\n\n<Callout resolved="2026-09-01">\n\n${BLOCK}\n\n</Callout>\n\n</Fold>`)!.counts.you).toBe(0);
    expect(extractNextMoves(`<Callout tone="warn">\n\n${BLOCK}\n\n</Callout>`)!.counts.you).toBe(2);
    // A typo'd resolved date is an open callout, as the renderer reads it.
    expect(extractNextMoves(`<Callout resolved="2026-02-31">\n\n${BLOCK}\n\n</Callout>`)!.counts.you).toBe(2);
  });

  test("two enclosing components plus one inside the lane still count", () => {
    const lane = '<NextMoves>\n\n<Lane kind="you">\n\n<Checklist>\n- [ ] Deep step.\n</Checklist>\n\n</Lane>\n\n</NextMoves>';
    expect(extractNextMoves(`<Fold title="F">\n\n<Callout>\n\n${lane}\n\n</Callout>\n\n</Fold>`)!.counts.you).toBe(1);
  });

  test("the frontmatter split is the renderer's: a `----` closing fence", () => {
    const page = ["---", "title: x", "----", "", BLOCK, "", "---", "", "after"].join("\n");
    expect(extractNextMoves(page)!.counts.you).toBe(2);
    const html = renderWikiHtml(page, () => undefined);
    expect(html.match(/data-kind="you" data-count="2"/g)?.length).toBe(1);
  });

  test("steps are capped at MOVES_STEPS_MAX while the count is not", () => {
    const items = Array.from({ length: 8 }, (_, i) => `- **Step ${i + 1}.**`).join("\n");
    const m = extractNextMoves(`<NextMoves>\n\n<Lane kind="you">\n\n${items}\n\n</Lane>\n\n</NextMoves>`)!;
    expect(m.counts.you).toBe(8);
    expect(m.youSteps.length).toBe(MOVES_STEPS_MAX);
  });

  // A `<NextMoves>` inside another (in a lane, at any depth) is not a block: its
  // tag lines are literal text and its lanes stray lanes, so the reader's pill
  // (the rendered `data-count`s) and the index agree.
  const NESTED = [
    "<NextMoves>",
    "",
    '<Lane kind="you">',
    "",
    "- **Outer step.**",
    "",
    "<NextMoves>",
    "",
    '<Lane kind="you">',
    "",
    "- Inner one.",
    "- Inner two.",
    "",
    "</Lane>",
    "",
    "</NextMoves>",
    "",
    "</Lane>",
    "",
    "</NextMoves>",
  ].join("\n");
  const renderedYou = (html: string) =>
    [...html.matchAll(/class="nm-lane [^"]*" data-kind="you" data-count="(\d+)"/g)].reduce((n, m) => n + Number(m[1]), 0);

  for (const [name, page] of [
    ["NextMoves > Lane > NextMoves > Lane", NESTED],
    ["the same inside a Fold", `<Fold title="F">\n\n${NESTED}\n\n</Fold>`],
  ] as const) {
    test(`a nested NextMoves is not a block; index and reader agree: ${name}`, () => {
      const html = renderWikiHtml(page, () => undefined);
      expect(extractNextMoves(page)!.counts.you).toBe(1);
      expect(renderedYou(html)).toBe(1);
      expect(html.match(/class="next-moves"/g)?.length).toBe(1);
      expect(html).toContain("&lt;NextMoves&gt;");
    });
  }

  test("an empty task item is not a step: not counted, not on the card", () => {
    const m = extractNextMoves(
      '<NextMoves>\n\n<Lane kind="you">\n\n- [ ]\n- [ ] Real step.\n\n<Checklist>\n- [ ]\n- [ ] Row step.\n</Checklist>\n\n</Lane>\n\n</NextMoves>',
    )!;
    expect(m.counts.you).toBe(2);
    expect(m.youSteps).toEqual(["Real step.", "Row step."]);
  });
});

describe("leadSentence", () => {
  test("the bold run wins; else the first sentence; markup flattened", () => {
    expect(leadSentence("**Send it.** Then wait.")).toBe("Send it.");
    expect(leadSentence("Run `skarp 8045` with [the lists](x.md). Then report.")).toBe("Run skarp 8045 with the lists.");
    expect(leadSentence("See [[plans/x|the plan]] now")).toBe("See the plan now");
    expect(leadSentence("first line\nsecond")).toBe("first line");
  });

  test("a bold label ending in a colon names who; the step after it is the sentence", () => {
    expect(leadSentence("**Rune:** send the draft. Then wait.")).toBe("send the draft.");
    expect(leadSentence("**Rune**: send the draft")).toBe("send the draft");
    expect(leadSentence("**Rune:** **Send it.** Later.")).toBe("Send it.");
  });

  test("an abbreviation's dot is not a sentence end", () => {
    expect(leadSentence("Use a tool, e.g. ripgrep, here. Then more.")).toBe("Use a tool, e.g. ripgrep, here.");
    expect(leadSentence("Kjør f.eks. skarp og bl.a. tørr. Så mer.")).toBe("Kjør f.eks. skarp og bl.a. tørr.");
  });

  test("a word ending a sentence is not an abbreviation; kl. is", () => {
    expect(leadSentence("Say no. Then go.")).toBe("Say no.");
    expect(leadSentence("Møt kl. 10 i morgen. Så mer.")).toBe("Møt kl. 10 i morgen.");
  });

  test("the abbreviation set is the one the reader's first sentence reads", () => {
    expect(leadSentence("Ring dr. Hansen i dag. Så mer.")).toBe("Ring dr. Hansen i dag.");
    expect(leadSentence("Betal 5 kr pr. dag nå. Så mer.")).toBe("Betal 5 kr pr. dag nå.");
    expect(leadSentence("Gjelder t.o.m. fredag. Så mer.")).toBe("Gjelder t.o.m. fredag.");
    expect(leadSentence("Open a publish PR. Then wait.")).toBe("Open a publish PR.");
  });

  test("an abbreviation after an opening paren is still one", () => {
    expect(leadSentence("Use a tool (e.g. ripgrep) here. Then more.")).toBe("Use a tool (e.g. ripgrep) here.");
  });

  test("a label is the FIRST bold run at the start of the item, never a later one", () => {
    expect(leadSentence("**Send** the draft to **Rune:** now.")).toBe("Send");
  });

  test("component tags and a task marker are stripped", () => {
    expect(leadSentence('<Pill tone="warn">Haster</Pill> Send it. More.')).toBe("Haster Send it.");
    expect(leadSentence("[ ] Open the task. Then.")).toBe("Open the task.");
  });

  test("capped with an ellipsis", () => {
    const s = leadSentence("x".repeat(400));
    expect([...s].length).toBe(MOVES_STEP_CHARS);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("Lane attributes", () => {
  test("kind normalizes case; unknown and missing are waiting, not known", () => {
    expect(normalizeLaneKind(" YOU ")).toEqual({ kind: "you", known: true });
    expect(normalizeLaneKind("later")).toEqual({ kind: "waiting", known: false });
    expect(normalizeLaneKind(undefined)).toEqual({ kind: "waiting", known: false });
  });

  test("since is ISO or DD.MM.YYYY, as an ISO day; anything else is kept raw; who falls back to the kind's label", () => {
    const body = parseBlocks("- a");
    expect(laneFromAttrs({ kind: "draft", since: "2026-09-30" }, body)).toMatchObject({
      since: "2026-09-30",
      sinceRaw: null,
      label: "Draft, not sent",
      who: null,
    });
    expect(laneFromAttrs({ kind: "draft", since: "30.09.2026" }, body).since).toBe("2026-09-30");
    expect(laneFromAttrs({ kind: "draft", since: "2026-02-31" }, body)).toMatchObject({ since: null, sinceRaw: "2026-02-31" });
    expect(laneFromAttrs({ kind: "draft", since: " i forrige uke " }, body)).toMatchObject({ since: null, sinceRaw: "i forrige uke" });
    expect(laneFromAttrs({ kind: "draft" }, body)).toMatchObject({ since: null, sinceRaw: null });
    expect(laneFromAttrs({ kind: "you", who: "  Du " }, body)).toMatchObject({ label: "Du", who: "Du" });
  });

  test("parseLaneSince", () => {
    expect(parseLaneSince("1.9.2026")).toBe("2026-09-01");
    expect(parseLaneSince("31.02.2026")).toBeNull();
    expect(parseLaneSince("30.09.26")).toBeNull();
    expect(parseLaneSince("0099-01-05")).toBe("0099-01-05");
  });
});
