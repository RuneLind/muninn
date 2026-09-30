import { describe, expect, test } from "bun:test";
import { extractNextMoves, leadSentence, MOVES_STEP_CHARS, MOVES_STEPS_MAX } from "./next-moves.ts";
import { laneFromAttrs, normalizeLaneKind, parseBlocks } from "../format/markdown-ast.ts";

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

  test("a you lane of prose with no list counts one step: its first line", () => {
    const m = extractNextMoves('<NextMoves>\n\n<Lane kind="you">\n\nSend the draft today.\nMore.\n\n</Lane>\n\n</NextMoves>')!;
    expect(m.counts.you).toBe(1);
    expect(m.youSteps).toEqual(["Send the draft today."]);
  });

  test("steps are capped at MOVES_STEPS_MAX while the count is not", () => {
    const items = Array.from({ length: 8 }, (_, i) => `- **Step ${i + 1}.**`).join("\n");
    const m = extractNextMoves(`<NextMoves>\n\n<Lane kind="you">\n\n${items}\n\n</Lane>\n\n</NextMoves>`)!;
    expect(m.counts.you).toBe(8);
    expect(m.youSteps.length).toBe(MOVES_STEPS_MAX);
  });
});

describe("leadSentence", () => {
  test("the bold run wins; else the first sentence; markup flattened", () => {
    expect(leadSentence("**Send it.** Then wait.")).toBe("Send it.");
    expect(leadSentence("Run `skarp 8045` with [the lists](x.md). Then report.")).toBe("Run skarp 8045 with the lists.");
    expect(leadSentence("See [[plans/x|the plan]] now")).toBe("See the plan now");
    expect(leadSentence("first line\nsecond")).toBe("first line");
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

  test("since is a strict calendar day; who falls back to the kind's label", () => {
    const body = parseBlocks("- a");
    expect(laneFromAttrs({ kind: "draft", since: "2026-09-30" }, body)).toMatchObject({
      since: "2026-09-30",
      label: "Draft, not sent",
    });
    expect(laneFromAttrs({ kind: "draft", since: "2026-02-31" }, body).since).toBeNull();
    expect(laneFromAttrs({ kind: "draft", since: "30.09.2026" }, body).since).toBeNull();
    expect(laneFromAttrs({ kind: "you", who: "  Du " }, body).label).toBe("Du");
  });
});
