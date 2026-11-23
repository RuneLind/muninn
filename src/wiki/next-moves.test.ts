import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractNextMoves, leadSentence, MOVES_STEP_CHARS, MOVES_STEPS_MAX, waitOwnerFrom, waitsOnOwner } from "./next-moves.ts";
import { __setWikiIndexAnswerConfigForTest, buildWikiIndex, parseFrontmatter } from "./store.ts";
import { laneFromAttrs, normalizeLaneKind, parseBlocks, parseLaneSince } from "../format/markdown-ast.ts";
import { renderWikiHtml } from "./render.ts";
import { testTempDir } from "../test/temp-dir.ts";

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
      expect(html.match(/class="next-moves nm-compact"/g)?.length).toBe(1);
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

  test("keepLabel puts the label back in front of its sentence, flattened like the rest", () => {
    const kept = (item: string) => leadSentence(item, { keepLabel: true });
    expect(kept("**Rune:** send the draft. Then wait.")).toBe("Rune: send the draft.");
    expect(kept("__Rune__: send the draft. Then wait.")).toBe("Rune: send the draft.");
    expect(kept("**Open `/wiki`:** read [the page](https://example.invalid/p). Then wait.")).toBe("Open /wiki: read the page.");
    // A label with nothing after it is no label, with the option or without.
    expect(kept("**Rune:**")).toBe(leadSentence("**Rune:**"));
    // No label: the option changes nothing.
    for (const item of ["**Send the draft.** Blocks O3.", "Read the page. Twice.", "**Send** the draft to **Rune:** now."]) {
      expect(kept(item)).toBe(leadSentence(item));
    }
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
    expect(leadSentence("Ring Dr. Hansen i dag. Så mer.")).toBe("Ring Dr. Hansen i dag.");
    expect(leadSentence("Betal 5 kr pr. dag nå. Så mer.")).toBe("Betal 5 kr pr. dag nå.");
    expect(leadSentence("Gjelder t.o.m. fredag. Så mer.")).toBe("Gjelder t.o.m. fredag.");
    expect(leadSentence("Open a publish PR. Then wait.")).toBe("Open a publish PR.");
  });

  test("a word that is also an abbreviation ends a sentence where no number or name follows (fix round 2)", () => {
    expect(leadSentence("Feir i jul. Så mer.")).toBe("Feir i jul.");
    expect(leadSentence("Ring Jan. Så mer.")).toBe("Ring Jan.");
    expect(leadSentence("Frist jan. 2027 for alle. Så mer.")).toBe("Frist jan. 2027 for alle.");
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

// ── What waits on the owner (plan muninn-wiki-your-work-board, P1) ──────
const OWNER = "Kari Testdal (A123456)";
const GROUPS = new Map([
  ["utvikler", new Set(["A123456"])],
  ["fag", new Set(["B999999"])],
]);
const who = waitOwnerFrom({ owner: OWNER, groups: GROUPS })!;

function q(id: string, to?: string): string {
  return `<Question id="${id}"${to ? ` to="${to}"` : ""}>\n\nWhich one?\n\n</Question>`;
}
function lane(items: string[], attrs = 'since="2026-09-30"'): string {
  return `<Lane kind="waiting" ${attrs}>\n\n${items.map((i) => `- ${i}`).join("\n")}\n\n</Lane>`;
}
function page(lanes: string[], rest: string[], fm = ""): string {
  return `---\ntitle: Fixture\n${fm}---\n\n<NextMoves>\n\n${lanes.join("\n\n")}\n\n</NextMoves>\n\n${rest.join("\n\n")}\n`;
}
function waits(content: string, owner = who) {
  const moves = extractNextMoves(content)!;
  return waitsOnOwner(moves, parseFrontmatter(content).questions_to, owner);
}

describe("waitsOnOwner", () => {
  test("a question naming nobody asks the owner; the lane's since is the oldest", () => {
    expect(waits(page([lane(["O1 needs a pick"])], [q("O1")]))).toEqual({ ids: ["O1"], oldestSince: "2026-09-30" });
  });

  test('to="utvikler" counts with the owner in the group and not out of it', () => {
    const content = page([lane(["O1"])], [q("O1", "utvikler")]);
    expect(waits(content).ids).toEqual(["O1"]);
    const outside = waitOwnerFrom({ owner: "Ola Testdal (C000000)", groups: GROUPS })!;
    expect(waits(content, outside).ids).toEqual([]);
  });

  test("a wait on another group does not count, on the block or from questions_to:", () => {
    expect(waits(page([lane(["O1"])], [q("O1", "fag")])).ids).toEqual([]);
    expect(waits(page([lane(["O1"])], [q("O1")], 'questions_to: ["fag"]\n')).ids).toEqual([]);
    expect(waits(page([lane(["O1"])], [q("O1", "utvikler")], 'questions_to: ["fag"]\n')).ids).toEqual(["O1"]);
  });

  test("the owner's ident matches a named target with another spelling of the name", () => {
    expect(waits(page([lane(["O1"])], [q("O1", "K. Testdal (a123456)")])).ids).toEqual(["O1"]);
    expect(waits(page([lane(["O1"])], [q("O1", "Someone Else (Z111111)")])).ids).toEqual([]);
  });

  test("an item naming two ids mid-sentence counts both", () => {
    expect(waits(page([lane(["See O1 and also O2, then decide."])], [q("O1"), q("O2")])).ids).toEqual(["O1", "O2"]);
  });

  test("an id on a longer token's edge is not named", () => {
    expect(waits(page([lane(["O10 and O1.1 and O1-2"])], [q("O1")])).ids).toEqual([]);
  });

  test("an id inside a wikilink names nothing, target or label", () => {
    expect(waits(page([lane(["See [[other-page#O1]]", "See [[other-page|O1]]"])], [q("O1")])).ids).toEqual([]);
    expect(waits(page([lane(["See [[other-page#O1]] for O1"])], [q("O1")])).ids).toEqual(["O1"]);
  });

  test("a duplicated id does not count", () => {
    expect(waits(page([lane(["O1"])], [q("O1"), q("O1")])).ids).toEqual([]);
  });

  test("a closed or decided question does not count; a reopened one does", () => {
    const log = (item: string) => `<DecisionLog>\n\n- **D1** — Picked it.\n- **O1** — ${item}\n\n</DecisionLog>`;
    expect(waits(page([lane(["O1"])], [q("O1"), log("Which one? Lukket 2026-10-01 (D1)")])).ids).toEqual([]);
    expect(waits(page([lane(["O1"])], [q("O1"), log("Which one? Closed 2026-10-01 (D9)")])).ids).toEqual([]);
    expect(waits(page([lane(["O1"])], [q("O1"), log("Which one? Closed 2026-10-01 (D1). Reopened 2026-10-02.")])).ids).toEqual(["O1"]);
  });

  test("an id absent from the log is open", () => {
    expect(waits(page([lane(["O1"])], [q("O1"), "<DecisionLog>\n\n- **D1** — Other.\n\n</DecisionLog>"])).ids).toEqual(["O1"]);
  });

  test("two lanes naming one id count once, and the older lane's since wins", () => {
    const content = page([lane(["O1"], 'since="2026-10-05"'), lane(["O1 again"], 'since="2026-09-01"')], [q("O1")]);
    expect(waits(content)).toEqual({ ids: ["O1"], oldestSince: "2026-09-01" });
  });

  test("a lane holding no counted item does not move the oldest since", () => {
    const content = page([lane(["A plain task"], 'since="2020-01-01"'), lane(["O1"], 'since="2026-10-05"')], [q("O1")]);
    expect(waits(content)).toEqual({ ids: ["O1"], oldestSince: "2026-10-05" });
  });

  test("an unparsable since counts the id and gives no oldest; a parsed sibling still does", () => {
    expect(waits(page([lane(["O1"], 'since="last week"')], [q("O1")]))).toEqual({ ids: ["O1"], oldestSince: null });
    const two = page([lane(["O1"], 'since="last week"'), lane(["O2"], 'since="2026-10-05"')], [q("O1"), q("O2")]);
    expect(waits(two)).toEqual({ ids: ["O1", "O2"], oldestSince: "2026-10-05" });
  });

  test("only waiting lanes name; a checked item and a nested item name nothing", () => {
    expect(waits(page(['<Lane kind="you">\n\n- O1\n\n</Lane>'], [q("O1")])).ids).toEqual([]);
    expect(waits(page([lane(["[x] O1"])], [q("O1")])).ids).toEqual([]);
    expect(waits(page([lane(["Parent\n  - O1"])], [q("O1")])).ids).toEqual([]);
  });

  test("a lane in a settled section does not count", () => {
    const historic = `<Historic since="x">\n\n<NextMoves>\n\n${lane(["O1"])}\n\n</NextMoves>\n\n</Historic>\n\n${q("O1")}\n`;
    expect(waits(`---\ntitle: F\n---\n\n${historic}`).ids).toEqual([]);
  });

  test("a name with no block behind it counts nothing", () => {
    expect(waits(page([lane(["O1"])], [])).ids).toEqual([]);
  });

  test("no owner, no WaitOwner", () => {
    expect(waitOwnerFrom({ owner: null })).toBeNull();
    expect(waitOwnerFrom({ owner: "   " })).toBeNull();
    expect(waitOwnerFrom({ owner: OWNER, groups: GROUPS })!.author).toEqual({ name: "Kari Testdal", navIdent: "A123456" });
  });
});

describe("waitsOnOwner: only the owner's lane holds a counted item", () => {
  const outside = waitOwnerFrom({ owner: "Ola Testdal (C000000)", groups: GROUPS })!;
  const onLane = (attrs: string, question = q("O1"), owner = who) => waits(page([lane(["O1"], attrs)], [question]), owner).ids;

  test('a role="fag" lane the owner is not in holds nothing, whatever the question says', () => {
    expect(onLane('role="fag"')).toEqual([]);
    expect(onLane('role="fag"', q("O1", "utvikler"))).toEqual([]);
    expect(onLane('role="fag"', q("O1", OWNER))).toEqual([]);
  });

  test("a role lane counts for its member, by ident, and not for someone outside it", () => {
    expect(onLane('role="utvikler"')).toEqual(["O1"]);
    expect(onLane('role="Utvikler"', q("O1", "utvikler"))).toEqual(["O1"]);
    expect(onLane('role="utvikler"', q("O1", "Ola Testdal (C000000)"), outside)).toEqual([]);
    const nameOnly = waitOwnerFrom({ owner: "Kari Testdal", groups: GROUPS })!;
    expect(onLane('role="utvikler"', q("O1"), nameOnly)).toEqual([]);
  });

  test("the question's rule still applies inside the owner's lane", () => {
    expect(onLane('role="utvikler"', q("O1", "fag"))).toEqual([]);
    expect(onLane('who="Waiting on Kari"', q("O1", "fag"))).toEqual([]);
  });

  test("a role decides even with a who beside it", () => {
    expect(onLane('role="fag" who="Waiting on Kari"')).toEqual([]);
    expect(onLane('role="utvikler" who="Waiting on the calendar"')).toEqual(["O1"]);
  });

  test("a role that is not a valid key reads as no role: open, or left to the who", () => {
    for (const role of ["fag jus", "z990001"]) {
      expect(onLane(`role="${role}"`)).toEqual(["O1"]);
      expect(onLane(`role="${role}"`, q("O1", "fag"))).toEqual([]);
      expect(onLane(`role="${role}" who="Waiting on Kari"`)).toEqual(["O1"]);
      expect(onLane(`role="${role}" who="Waiting on the calendar"`)).toEqual([]);
    }
  });

  test("a who naming nobody the owner is holds nothing", () => {
    for (const text of ["Waiting on the calendar", "Venter på prioritering", "Claude", "Next", "Whoever next touches it", "Venter på fag"]) {
      expect(`${text}: ${onLane(`who="${text}"`)}`).toBe(`${text}: `);
    }
  });

  test("a who names the owner by a name token, the ident or a group they are in", () => {
    for (const text of ["Waiting on Kari", "venter på TESTDAL", "Waiting on a123456", "Venter på Utvikler", "(Kari)", "Kari's call"]) {
      expect(`${text}: ${onLane(`who="${text}"`)}`).toBe(`${text}: O1`);
    }
    const rune = waitOwnerFrom({ owner: "Rune Lind (RUNE)", groups: new Map([["utvikler", new Set(["RUNE"])]]) })!;
    expect(onLane('who="Waiting on Rune"', q("O1", "utvikler"), rune)).toEqual(["O1"]);
  });

  test("a who match is a whole word, with letters beyond ASCII as word characters", () => {
    for (const text of ["Karianne", "Testdalen", "Mari-Kari", "Kari-Anne"]) {
      expect(`${text}: ${onLane(`who="${text}"`)}`).toBe(`${text}: `);
    }
    const ase = waitOwnerFrom({ owner: "Åse Ørn (D111111)" })!;
    expect(onLane('who="Venter på Åse"', q("O1"), ase)).toEqual(["O1"]);
    expect(onLane('who="Venter på ØRN"', q("O1"), ase)).toEqual(["O1"]);
    expect(onLane(`who="Venter på ${"Åse".normalize("NFD")}"`, q("O1"), ase)).toEqual(["O1"]);
    for (const text of ["Åsebø", "Bråse", "Ørnulf", "Sørn"]) {
      expect(`${text}: ${onLane(`who="${text}"`, q("O1"), ase)}`).toBe(`${text}: `);
    }
  });

  // Each of these is a character class in the word split: without it the text
  // breaks into pieces, and a piece names the owner.
  test("a digit is a word character: another person's ident shares no word with the owner's", () => {
    expect(onLane('who="Waiting on A999999"')).toEqual([]);
  });

  test("an underscore is a word character: a group key's parts name nothing", () => {
    const inFagJus = waitOwnerFrom({ owner: OWNER, groups: new Map([["fag_jus", new Set(["A123456"])]]) })!;
    expect(onLane('who="jus"', q("O1"), inFagJus)).toEqual([]);
    expect(onLane('who="fag_jus"', q("O1"), inFagJus)).toEqual(["O1"]);
  });

  test("a combining mark is a word character: a mark inside a word does not end it", () => {
    expect(onLane('who="Kari\u0307x"')).toEqual([]);
  });

  // The empty ident and the split's empty edge strings must not meet.
  test("a name-only owner matches no who through punctuation", () => {
    const nameOnly = waitOwnerFrom({ owner: "Kari Testdal", groups: GROUPS })!;
    expect(onLane('who="(Ola)"', q("O1"), nameOnly)).toEqual([]);
    expect(onLane('who="(Kari)"', q("O1"), nameOnly)).toEqual(["O1"]);
  });

  test("a lane with neither role nor who is open to the question's rule", () => {
    expect(onLane('since="2026-09-30"')).toEqual(["O1"]);
    expect(onLane('since="2026-09-30"', q("O1", "fag"))).toEqual([]);
  });

  test("a lane that is not the owner's does not move the oldest since", () => {
    const content = page([lane(["O1"], 'role="fag" since="2020-01-01"'), lane(["O1"], 'who="Waiting on Kari" since="2026-10-05"')], [q("O1")]);
    expect(waits(content)).toEqual({ ids: ["O1"], oldestSince: "2026-10-05" });
  });
});

describe("waitOwnerFrom: an owner who can be asked something", () => {
  test("blank after the target parse is not set", () => {
    expect(waitOwnerFrom({ owner: '""' })).toBeNull();
    expect(waitOwnerFrom({ owner: "''" })).toBeNull();
  });

  test("a group name is not a person, in any case; a bare name beside no such group is", () => {
    expect(waitOwnerFrom({ owner: "utvikler", groups: GROUPS })).toBeNull();
    expect(waitOwnerFrom({ owner: "UTVIKLER", groups: GROUPS })).toBeNull();
    expect(waitOwnerFrom({ owner: "utvikler" })?.owner).toBe("utvikler");
    expect(waitOwnerFrom({ owner: "Kari Testdal", groups: GROUPS })?.author).toEqual({ name: "Kari Testdal", navIdent: null });
    expect(waitOwnerFrom({ owner: "utvikler (A123456)", groups: GROUPS })?.author.navIdent).toBe("A123456");
  });
});

describe("buildWikiIndex: movesWaiting and waitingSince", () => {
  let root: string;
  afterEach(async () => {
    __setWikiIndexAnswerConfigForTest(null);
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>) {
    root = await testTempDir(path.join(tmpdir(), "muninn-waits-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text, "utf8");
    }
    const built = await buildWikiIndex(root);
    return (rel: string) => built.pages.find((p) => p.relPath === rel)!;
  }

  const FILES = {
    "plans/two.mdx": page([lane(["O1 and O2"], 'since="2026-09-01"'), lane(["O1"], 'since="2026-10-01"')], [q("O1"), q("O2")]),
    "plans/none.mdx": "---\ntitle: No lanes\n---\n\nBody.\n",
    "plans/other.mdx": page([lane(["O1"])], [q("O1", "fag")]),
    "plans/nodate.mdx": page([lane(["O1"], 'since="soon"')], [q("O1")]),
  };

  test("set where something waits on the owner, absent everywhere else", async () => {
    __setWikiIndexAnswerConfigForTest({ owner: OWNER, groups: GROUPS });
    const at = await index(FILES);
    expect(at("plans/two.mdx").movesWaiting).toBe(2);
    expect(at("plans/two.mdx").waitingSince).toBe("2026-09-01");
    expect(at("plans/none.mdx").movesWaiting).toBeUndefined();
    expect(at("plans/other.mdx").movesWaiting).toBeUndefined();
    expect(at("plans/other.mdx").waitingSince).toBeUndefined();
    expect(at("plans/nodate.mdx").movesWaiting).toBe(1);
    expect(at("plans/nodate.mdx").waitingSince).toBeUndefined();
  });

  test("a page's questions_to: reaches the rule", async () => {
    __setWikiIndexAnswerConfigForTest({ owner: OWNER, groups: GROUPS });
    const at = await index({
      "plans/fag.mdx": page([lane(["O1"])], [q("O1")], 'questions_to: ["fag"]\n'),
      "plans/mine.mdx": page([lane(["O1"])], [q("O1")], 'questions_to: ["utvikler"]\n'),
    });
    expect(at("plans/fag.mdx").movesWaiting).toBeUndefined();
    expect(at("plans/mine.mdx").movesWaiting).toBe(1);
  });

  test("the index says whether it counted for an owner, and a group name is none", async () => {
    __setWikiIndexAnswerConfigForTest({ owner: "utvikler", groups: GROUPS });
    root = await testTempDir(path.join(tmpdir(), "muninn-waits-"));
    await writeFile(path.join(root, "two.mdx"), FILES["plans/two.mdx"], "utf8");
    const group = await buildWikiIndex(root);
    expect(group.waitOwnerSet).toBe(false);
    expect(group.pages[0]!.movesWaiting).toBeUndefined();
    __setWikiIndexAnswerConfigForTest({ owner: OWNER, groups: GROUPS });
    const person = await buildWikiIndex(root);
    expect(person.waitOwnerSet).toBe(true);
    expect(person.pages[0]!.movesWaiting).toBe(2);
  });

  test("no owner, no field on any page", async () => {
    __setWikiIndexAnswerConfigForTest({ owner: null });
    const at = await index(FILES);
    expect(at("plans/two.mdx").movesWaiting).toBeUndefined();
    expect(at("plans/two.mdx").waitingSince).toBeUndefined();
  });
});
