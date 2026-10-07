import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import {
  closeNearMisses,
  closedQuestionIds,
  decisionLogEntries,
  itemQuestionState,
  parseQuestionPage,
  formatQuestionTarget,
  parseChoices,
  parseQuestions,
  parseQuestionsTo,
  parseToAttr,
  questionStates,
  type QuestionRenderOptions,
  type QuestionState,
  isAskedAuthor,
  resolveQuestionTargets,
} from "./question.ts";
import { parseQuestionLanguage, QUESTION_LABELS } from "./question-labels.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";

// Every fixture here is synthetic: invented ids, names and keys.

/** A page with one `<Question id="O3">` above a fold holding the log, as the
 *  plan pages write it, with `item` as the O3 item's text after its id. */
function page(item: string, extraItems: string[] = []): string {
  return [
    '<Question id="O3" choices="A|B">',
    "",
    "**Keep the export block in one language?**",
    "",
    "A: one language. B: the page's language.",
    "",
    "</Question>",
    "",
    '<Fold title="Decision log">',
    "",
    "<DecisionLog>",
    "",
    "- **D99** — The page's language.",
    ...extraItems,
    `- **O3** — ${item}`,
    "",
    "</DecisionLog>",
    "",
    "</Fold>",
  ].join("\n");
}

const stateOf = (md: string, id = "O3"): QuestionState | undefined => questionStates(parseBlocks(md)).get(id);
const open = { kind: "open" } as const;
const closed = { kind: "closed" } as const;
const decided = (decision: string) => ({ kind: "decided", decision }) as const;

describe("D6: the closing rule, acceptance row 1", () => {
  // [label, item text after the id, expected state, near-miss words the linter reports]
  const rows: [string, string, QuestionState, string[]][] = [
    ["canonical close naming a defined decision", "Keep it? Closed 2026-10-08 (D99).", decided("D99"), []],
    ["Norwegian canonical close, D.M date", "Keep it? Lukket 8.10 (D99).", decided("D99"), []],
    ["DD.MM.YYYY date", "Keep it? Lukket 08.10.2026 (D99).", decided("D99"), []],
    ["close naming a decision the page does not define", "Keep it? Closed 2026-10-08 (D98).", closed, []],
    ["close then reopen: the last phrase wins", "Keep it? Lukket 08.10 (D99). Gjenåpnet 09.10.", open, []],
    ["reopen then close again", "Closed 2026-10-01 (D99). Reopened 2026-10-02. Closed 2026-10-03 (D99).", decided("D99"), []],
    ["English reopen at the end of the item", "Closed 2026-10-01 (D99). Reopened 2026-10-02", open, []],
    ["stays open: «aldri besvart»", "Spurt 30.09, aldri besvart direkte.", open, []],
    ["stays open: the whole phrase inside a code span", "Keep it? `Closed 2026-10-08 (D99)`", open, []],
    ["stays open: lowercase closed", "Keep it? closed 2026-10-08 (D99)", open, []],
    ["stays open: Unclosed is not the word", "Keep it? Unclosed 2026-10-08 (D99)", open, []],
    ["stays open, near miss: a colon between date and decision", "Keep it? Closed 2026-10-08: B (D99)", open, ["Closed"]],
    ["stays open, near miss: struck question text, Besvart", "~~Keep it?~~ Besvart 06.10: ja.", open, ["Besvart"]],
    ["stays open, near miss: Answered", "Keep it? Answered 2026-10-06.", open, ["Answered"]],
    ["stays open, near miss: a date the calendar lacks", "Keep it? Closed 2026-13-45 (D99).", open, ["Closed"]],
    ["stays open, near miss: Reopened with no date", "Reopened after review.", open, ["Reopened"]],
    ["stays open, near miss: a lower-case decision id", "Closed 2026-10-08 (d99).", open, ["Closed"]],
    ["struck remainder with no phrase: closed, no decision", "~~Keep it?~~", closed, []],
    ["superseded with no phrase: closed, no decision", "Keep it? Superseded by D99.", closed, []],
    ["erstattet av with no phrase: closed, no decision", "Behold det? Erstattet av D99.", closed, []],
    ["a struck item with a canonical close is still decided", "~~Keep it? Closed 2026-10-08 (D99).~~", decided("D99"), []],
  ];
  for (const [label, item, state, words] of rows) {
    test(label, () => {
      expect(stateOf(page(item))).toEqual(state);
      expect(closeNearMisses(item)).toEqual(words);
    });
  }

  test("a struck id alone shows Closed", () => {
    const md = page("placeholder").replace("- **O3** — placeholder", "- ~~**O3**~~ — Keep it?");
    expect(stateOf(md)).toEqual(closed);
  });

  test("an O item that mentions «a closed item» stays open with no near miss", () => {
    const md = page("Keep it?", ["- **O4** — Does this reopen a closed item?"]);
    expect(stateOf(md, "O4")).toEqual(open);
    expect(closeNearMisses("Does this reopen a closed item?")).toEqual([]);
  });

  test("an S item ending «Spurt 30.09, aldri besvart direkte.» stays open", () => {
    const md = page("Keep it?", ["- **S2** — Skal sakene henlegges? Spurt 30.09, aldri besvart direkte."]);
    expect(stateOf(md, "S2")).toEqual(open);
  });

  test("the decision may be defined in another DecisionLog on the page", () => {
    const md = [
      "<DecisionLog>",
      "",
      "- **O3** — Keep it? Closed 2026-10-08 (D7).",
      "",
      "</DecisionLog>",
      "",
      "<DecisionLog>",
      "",
      "- **D7** — Decided elsewhere on the page.",
      "",
      "</DecisionLog>",
    ].join("\n");
    expect(stateOf(md)).toEqual(decided("D7"));
  });

  test("an id with no item has no state; the first item carrying an id decides it", () => {
    const md = page("Closed 2026-10-08 (D99).", []).replace(
      "</DecisionLog>",
      "- **O3** — A second item, open.\n\n</DecisionLog>",
    );
    expect(stateOf(md)).toEqual(decided("D99"));
    expect(stateOf(md, "O9")).toBeUndefined();
  });

  test("closedQuestionIds is every id that is not open", () => {
    const md = page("Closed 2026-10-08 (D99).", ["- **O4** — Still open.", "- ~~**O5**~~ — Struck."]);
    expect([...closedQuestionIds(parseBlocks(md))].sort()).toEqual(["O3", "O5"]);
  });

  test("a DecisionLog item quoted in a fence is not an item", () => {
    const md = [
      '<Question id="O3">',
      "",
      "Q?",
      "",
      "</Question>",
      "",
      "```markdown",
      "<DecisionLog>",
      "- **O3** — Closed 2026-10-08 (D99).",
      "</DecisionLog>",
      "```",
    ].join("\n");
    expect(stateOf(md)).toBeUndefined();
  });
});

describe("parseQuestions", () => {
  test("id, choices, to, body and the duplicate signal", () => {
    const md = [
      '<Question id="O3" choices="A| B |A|" to="Yvonne Jacobs (X111111)|Ola Nordmann">',
      "",
      "**Keep it?**",
      "",
      "</Question>",
      "",
      '<Fold title="More">',
      "",
      '<Question id="O3">',
      "",
      "Same id again.",
      "",
      "</Question>",
      "",
      "</Fold>",
      "",
      "<Question>",
      "",
      "No id.",
      "",
      "</Question>",
    ].join("\n");
    const qs = parseQuestions(parseBlocks(md));
    expect(qs.map((q) => [q.id, q.duplicate])).toEqual([
      ["O3", true],
      ["O3", true],
      [null, false],
    ]);
    expect(qs[0]!.choices).toEqual(["A", "B"]);
    expect(qs[0]!.to).toEqual([
      { name: "Yvonne Jacobs", ident: "X111111" },
      { name: "Ola Nordmann", ident: null },
    ]);
    expect(qs[1]!.to).toBeNull();
    expect(qs[0]!.body).toBe("**Keep it?**");
  });

  test("the body text is deterministic, ignores reflow and changes when the words do", () => {
    const body = (inner: string) =>
      parseQuestions(parseBlocks(`<Question id="O1">\n\n${inner}\n\n</Question>`))[0]!.body;
    const a = body("**Keep it?**\n\nA: yes.   B:  no.\n\n- one\n- two");
    expect(a).toBe("**Keep it?**\nA: yes. B: no.\n- one\n- two");
    expect(body("**Keep it?**\n\n\nA: yes. B: no.\n\n- one\n- two")).toBe(a);
    expect(body("**Keep it?**\n\nA: yes. B: maybe.\n\n- one\n- two")).not.toBe(a);
  });

  test("a <Question> inside a fence is not a block", () => {
    expect(parseQuestions(parseBlocks("```\n<Question id=\"O1\">\n\nQ\n\n</Question>\n```"))).toEqual([]);
  });
});

describe("targets and choices", () => {
  test("questions_to: an inline list of Name / Name (IDENT), or one string", () => {
    expect(parseQuestionsTo(["Yvonne Jacobs (X111111)", "Ola Nordmann", "  ", '"Kari (Y222222)"'])).toEqual([
      { name: "Yvonne Jacobs", ident: "X111111" },
      { name: "Ola Nordmann", ident: null },
      { name: "Kari", ident: "Y222222" },
    ]);
    expect(parseQuestionsTo("Ola Nordmann")).toEqual([{ name: "Ola Nordmann", ident: null }]);
    expect(parseQuestionsTo(undefined)).toEqual([]);
    expect(parseQuestionsTo(42)).toEqual([]);
  });

  test("to= takes the same entries |-separated, and formats back as written", () => {
    const t = parseToAttr("Yvonne Jacobs (X111111)| Ola Nordmann |");
    expect(t.map(formatQuestionTarget)).toEqual(["Yvonne Jacobs (X111111)", "Ola Nordmann"]);
  });

  test("choices: trimmed, blanks and repeats dropped", () => {
    expect(parseChoices(" A |B||A")).toEqual(["A", "B"]);
    expect(parseChoices(undefined)).toEqual([]);
  });
});

describe(".wiki-reader.json language", () => {
  test("en and no, case-folded; absent is en with no warning; anything else warns", () => {
    expect(parseQuestionLanguage("no")).toEqual({ language: "no" });
    expect(parseQuestionLanguage(" NO ")).toEqual({ language: "no" });
    expect(parseQuestionLanguage(undefined)).toEqual({ language: "en" });
    expect(parseQuestionLanguage("nb").language).toBe("en");
    expect(parseQuestionLanguage("nb").warning).toContain('"nb"');
    expect(parseQuestionLanguage(1).warning).toBeDefined();
  });

  test("the label table carries every card string in both languages", () => {
    const no = QUESTION_LABELS.no;
    expect([no.open, no.answered, no.copied, no.decided, no.closed, no.for]).toEqual([
      "Åpent",
      "Besvart",
      "Kopiert",
      "Avgjort",
      "Lukket",
      "Stilt til",
    ]);
    expect(QUESTION_LABELS.en.copyNew(3)).toBe("Copy new answers (3)");
    expect(QUESTION_LABELS.no.edited(2)).toBe("endret 2×");
    expect(Object.keys(QUESTION_LABELS.en).sort()).toEqual(Object.keys(QUESTION_LABELS.no).sort());
  });
});

describe("the web card", () => {
  const opts = (o: Partial<QuestionRenderOptions> = {}): QuestionRenderOptions => ({
    questionsTo: [],
    language: "en",
    answerable: false,
    ...o,
  });
  const card = (html: string) => /<section class="question[^"]*"[^>]*>[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

  test("Decided → D99 links the decision; the card has no id attribute and the item keeps o3", () => {
    const html = formatWebHtml(page("Keep it? Closed 2026-10-08 (D99)."), { question: opts() });
    const c = card(html);
    expect(c).toContain('class="question q-decided"');
    expect(c).toContain('data-question-state="decided"');
    expect(c).toContain('<span class="q-state">Decided → <a class="q-decision" href="#d99">D99</a></span>');
    expect(c).toContain('<a class="q-id" href="#o3">O3</a>');
    expect(c).not.toMatch(/<section[^>]*\sid="/);
    expect(html).toContain('<li class="dl-item" id="o3">');
    expect(html).not.toContain('id="o3-2"');
  });

  test("Open, Closed and the reopened item render their own state", () => {
    const stateText = (item: string) => /<span class="q-state">([^<]*)/.exec(formatWebHtml(page(item), { question: opts() }))?.[1];
    expect(stateText("Keep it?")).toBe("Open");
    expect(stateText("Keep it? Closed 2026-10-08 (D98).")).toBe("Closed");
    expect(stateText("Lukket 08.10 (D99). Gjenåpnet 09.10.")).toBe("Open");
  });

  test("language no: Norwegian labels", () => {
    const c = card(formatWebHtml(page("Lukket 08.10 (D99)."), { question: opts({ language: "no", questionsTo: [{ name: "Yvonne Jacobs", ident: "X111111" }] }) }));
    expect(c).toContain('<span class="q-label">Spørsmål</span>');
    expect(c).toContain("Avgjort → ");
    expect(c).toContain('<div class="q-for"><span class="q-for-label">Stilt til</span> Yvonne Jacobs</div>');
    expect(c).toContain('data-question-lang="no"');
  });

  test("who it is for: to= overrides questions_to:, and the data carries the entries as written", () => {
    const md = page("Keep it?").replace('<Question id="O3" choices="A|B">', '<Question id="O3" choices="A|B" to="Kari Nordmann (Y222222)">');
    const c = card(formatWebHtml(md, { question: opts({ questionsTo: [{ name: "Yvonne Jacobs", ident: "X111111" }] }) }));
    expect(c).toContain("For</span> Kari Nordmann</div>");
    expect(c).toContain('data-question-to-source="block"');
    expect(c).toContain('data-question-to="Kari Nordmann (Y222222)"');
    expect(c).toContain('data-question-choices="A|B"');
    const pageTo = card(formatWebHtml(page("Keep it?"), { question: opts({ questionsTo: [{ name: "Yvonne Jacobs", ident: "X111111" }] }) }));
    expect(pageTo).toContain('data-question-to-source="page"');
    const none = card(formatWebHtml(page("Keep it?"), { question: opts() }));
    expect(none).toContain('data-question-to-source="none"');
    expect(none).not.toContain("q-for");
  });

  test("answerable rides the option end to end", () => {
    expect(card(formatWebHtml(page("x"), { question: opts() }))).toContain('data-wiki-answerable="false"');
    expect(card(formatWebHtml(page("x"), { question: opts({ answerable: true }) }))).toContain('data-wiki-answerable="true"');
  });

  test("a duplicated id says so on each card; a missing id renders without a state", () => {
    const md = '<Question id="O3">\n\nOne\n\n</Question>\n\n<Question id="O3">\n\nTwo\n\n</Question>\n\n<Question>\n\nThree\n\n</Question>';
    const html = formatWebHtml(md, { question: opts() });
    expect(html.match(/class="q-note q-duplicate"/g)).toHaveLength(2);
    expect(html).toContain('<section class="question q-noid" data-question-state="none"');
    expect(html).toContain('<span class="q-label">Question without id</span>');
  });

  test("on an answerable wiki a duplicated id renders read-only, since the POST refuses it", () => {
    const md = '<Question id="O3">\n\nOne\n\n</Question>\n\n<Question id="O3">\n\nTwo\n\n</Question>\n\n<Question id="O4">\n\nThree\n\n</Question>';
    const html = formatWebHtml(md, { question: opts({ answerable: true }) });
    const flags = [...html.matchAll(/data-question-id="(\w+)"[^>]*data-wiki-answerable="(\w+)"/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(flags).toEqual(["O3=false", "O3=false", "O4=true"]);
  });

  test("without the wiki option (chat) it is a plain bordered question with no state", () => {
    const html = formatWebHtml(page("Closed 2026-10-08 (D99)."));
    const c = card(html);
    expect(c).toContain('class="question question-plain" data-question-id="O3"');
    expect(c).not.toContain("q-state");
    expect(c).not.toContain("data-wiki-answerable");
    expect(c).toContain("<strong>Keep the export block in one language?</strong>");
  });

  test("a page without a <Question> renders byte-identically with or without the option", () => {
    const md = "<DecisionLog>\n\n- **O3** — Closed 2026-10-08 (D99).\n\n</DecisionLog>\n\nText.";
    expect(formatWebHtml(md, { question: opts({ language: "no", answerable: true }) })).toBe(formatWebHtml(md));
  });
});

describe("the text surfaces: a lead line and the body", () => {
  const md = '<Question id="O3">\n\n**Keep it?**\n\n</Question>';
  test("Telegram", () => {
    expect(formatTelegramHtml(md)).toBe("<b>Question O3</b>\n\n<b>Keep it?</b>");
  });
  test("Slack", () => {
    expect(formatSlackMrkdwn(md)).toBe("*Question O3*\n\n*Keep it?*");
  });
  test("email: a bordered question", () => {
    const html = formatEmailHtml(md);
    expect(html).toContain("border:1px solid");
    expect(html).toContain(">Question O3</div>");
    expect(html).toContain("Keep it?");
  });
  test("a question with no id leads with the bare word", () => {
    expect(formatTelegramHtml("<Question>\n\nQ\n\n</Question>")).toBe("<b>Question</b>\n\nQ");
  });
});

// ── Fix round 1 ────────────────────────────────────────────────────────────

describe("fix round 1: the closing rule's white space, code spans, NFD and nested items", () => {
  const rows: [string, string, QuestionState, string[]][] = [
    // Item 4: a code span between two tokens is not white space.
    ["a code span between Closed and the date", "Keep it? Closed `x` 2026-10-08 (D99).", open, ["Closed"]],
    ["a code span between the date and (Dn)", "Keep it? Closed 2026-10-08 `note` (D99).", open, ["Closed"]],
    ["a code span between Reopened and the date", "Closed 2026-10-08 (D99). Reopened `x` 2026-10-09.", decided("D99"), ["Reopened"]],
    // Item 5: one line break inside the phrase's white space, indentation allowed.
    ["a hard wrap after Closed, indented", "Keep it? Closed\n  2026-10-08 (D99).", decided("D99"), []],
    ["a hard wrap before (Dn)", "Keep it? Closed 2026-10-08\n(D99)", decided("D99"), []],
    ["a hard wrap after Reopened", "Closed 2026-10-08 (D99). Reopened\n  2026-10-09.", open, []],
    ["a blank line inside the phrase is not one break", "Keep it? Closed\n\n2026-10-08 (D99).", open, ["Closed"]],
    ["a code span and a wrap together are still not white space", "Keep it? Closed `x`\n2026-10-08 (D99).", open, ["Closed"]],
    ["a wrap and then a code span are still not white space", "Keep it? Closed\n`x` 2026-10-08 (D99).", open, ["Closed"]],
    // Item 6: an NFD item reads like its NFC spelling.
    ["an NFD Gjenåpnet reopens", "Lukket 08.10 (D99). Gjenåpnet 09.10.", open, []],
  ];
  for (const [label, item, state, words] of rows) {
    test(label, () => {
      expect(itemQuestionState(item, false, new Set(["D99"]))).toEqual(state);
      expect(closeNearMisses(item)).toEqual(words);
    });
  }

  test("a hard-wrapped close inside a real DecisionLog item closes the card", () => {
    expect(stateOf(page("Keep it? Closed\n  2026-10-08 (D99)."))).toEqual(decided("D99"));
  });

  test("a close in a nested sub-bullet belongs to its item", () => {
    const md = page("Keep it?\n  - Closed 2026-10-08 (D99).");
    expect(stateOf(md)).toEqual(decided("D99"));
    const nested = decisionLogEntries(parseBlocks(md)).find((e) => e.id === "O3")!;
    expect(closeNearMisses(nested.text)).toEqual([]);
  });

  test("a close in a paragraph nested under the item belongs to it", () => {
    expect(stateOf(page("Keep it?\n\n  Closed 2026-10-08 (D99)."))).toEqual(decided("D99"));
  });

  test("a near miss in a nested sub-bullet is a near miss of its item", () => {
    const md = page("Keep it?\n  - Besvart 06.10: ja.");
    const item = decisionLogEntries(parseBlocks(md)).find((e) => e.id === "O3")!;
    expect(closeNearMisses(item.text)).toEqual(["Besvart"]);
  });
});

describe("fix round 1: parseQuestionPage, the one page parse", () => {
  test("questions, entries and states from one call agree with the single-purpose functions", () => {
    const md = page("Closed 2026-10-08 (D99).", ["- **O4** — Still open."]);
    const blocks = parseBlocks(md);
    const parsed = parseQuestionPage(blocks);
    expect(parsed.questions.map((q) => q.id)).toEqual(["O3"]);
    expect(parsed.entries.map((e) => e.id)).toEqual(["D99", "O4", "O3"]);
    expect(parsed.states.get("O3")).toEqual(decided("D99"));
    expect(parsed.states.get("O4")).toEqual(open);
    expect(parsed.states).toEqual(questionStates(blocks));
  });
});

describe("fix round 1: to= and the hash input", () => {
  test('to="" and to="|" fall back to the page\'s questions_to:', () => {
    for (const to of ["", "|", " | "]) {
      const qs = parseQuestions(parseBlocks(`<Question id="O1" to="${to}">\n\nQ?\n\n</Question>`));
      expect(qs[0]!.to).toBeNull();
    }
  });

  const parsed = (inner: string, attrs = 'id="O1"') => parseQuestions(parseBlocks(`<Question ${attrs}>\n\n${inner}\n\n</Question>`))[0]!;

  test("reflowing a paragraph leaves the hashed body unchanged", () => {
    expect(parsed("Keep the block in one\nlanguage on every page?").body).toBe(
      parsed("Keep the block in one language\non every page?").body,
    );
    expect(parsed("- one item that\n  wraps here").body).toBe(parsed("- one item that wraps\n  here").body);
  });

  test("code-block content and indentation are kept verbatim", () => {
    expect(parsed("```ts\n  a\n    b\n```").body).not.toBe(parsed("```ts\na\nb\n```").body);
  });

  test("a heading and a paragraph with the same words differ", () => {
    expect(parsed("# Keep it?").body).not.toBe(parsed("Keep it?").body);
  });

  test("two paragraphs and one paragraph with the same words differ", () => {
    expect(parsed("Keep it?\n\nYes.").body).not.toBe(parsed("Keep it? Yes.").body);
  });

  test("changing the choices changes the hash input", () => {
    expect(parsed("Keep it?", 'id="O1" choices="A|B"').hashInput).not.toBe(parsed("Keep it?", 'id="O1" choices="A|C"').hashInput);
    expect(parsed("Keep it?", 'id="O1" choices="A|B"').hashInput).toBe(parsed("Keep it?", 'id="O1" choices=" A | B "').hashInput);
    expect(parsed("Keep it?", 'id="O1" choices="A|B"').hashInput).toContain(parsed("Keep it?").body);
  });
});

describe("fix round 1: the web card", () => {
  const opts = (o: Partial<QuestionRenderOptions> = {}): QuestionRenderOptions => ({
    questionsTo: [],
    language: "en",
    answerable: false,
    ...o,
  });
  const card = (html: string) => /<section class="question[^"]*"[^>]*>[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

  test("data-question-decision is set on a decided card only", () => {
    expect(card(formatWebHtml(page("Closed 2026-10-08 (D99)."), { question: opts() }))).toContain('data-question-decision="D99"');
    expect(card(formatWebHtml(page("Closed 2026-10-08 (D98)."), { question: opts() }))).not.toContain("data-question-decision");
    expect(card(formatWebHtml(page("Keep it?"), { question: opts() }))).not.toContain("data-question-decision");
  });

  test("the id link follows the DecisionLog item when its anchor is renamed", () => {
    const md = [
      '<Query id="O2" question="A query that takes the o2 anchor first">',
      "",
      "Body.",
      "",
      "</Query>",
      "",
      '<Question id="O2">',
      "",
      "Q?",
      "",
      "</Question>",
      "",
      "<DecisionLog>",
      "",
      "- **D7** — A decision.",
      "- **O2** — Q? Closed 2026-10-08 (D7).",
      "",
      "</DecisionLog>",
    ].join("\n");
    const html = formatWebHtml(md, { question: opts() });
    expect(html).toContain('<li class="dl-item" id="o2-2">');
    expect(card(html)).toContain('<a class="q-id" href="#o2-2">O2</a>');
  });

  test("the decision link follows the D item when its anchor is renamed", () => {
    const md = [
      '<Query id="D7" question="A query that takes the d7 anchor first">',
      "",
      "Body.",
      "",
      "</Query>",
      "",
      '<Question id="O2">',
      "",
      "Q?",
      "",
      "</Question>",
      "",
      "<DecisionLog>",
      "",
      "- **D7** — A decision.",
      "- **O2** — Q? Closed 2026-10-08 (D7).",
      "",
      "</DecisionLog>",
    ].join("\n");
    const html = formatWebHtml(md, { question: opts() });
    expect(html).toContain('<li class="dl-item" id="d7-2">');
    expect(card(html)).toContain('<a class="q-decision" href="#d7-2">D7</a>');
  });

  test("an id with no DecisionLog item renders as plain text, not a dangling link", () => {
    const md = '<Question id="O9">\n\nQ?\n\n</Question>';
    const c = card(formatWebHtml(md, { question: opts() }));
    expect(c).toContain('<span class="q-id">O9</span>');
    expect(c).not.toContain('href="#o9"');
  });

  test('to="" keeps the page\'s questions_to: on the card', () => {
    const md = page("Keep it?").replace('<Question id="O3" choices="A|B">', '<Question id="O3" choices="A|B" to="">');
    const c = card(formatWebHtml(md, { question: opts({ questionsTo: [{ name: "Yvonne Jacobs", ident: "X111111" }] }) }));
    expect(c).toContain('data-question-to-source="page"');
    expect(c).toContain('data-question-to="Yvonne Jacobs (X111111)"');
  });
});

// ── Fix round 2 ────────────────────────────────────────────────────────────

describe("fix round 2: a wikilink alias in to= and choices=", () => {
  test("the | inside [[Page|Alias]] is the alias, not a separator", () => {
    expect(parseToAttr("[[Bar|Alias]] (X1)|Ola Nordmann")).toEqual([
      { name: "[[Bar|Alias]]", ident: "X1" },
      { name: "Ola Nordmann", ident: null },
    ]);
    expect(parseChoices("[[Foo|F]]|B")).toEqual(["[[Foo|F]]", "B"]);
    const q = parseQuestions(parseBlocks('<Question id="O1" to="[[Bar|Alias]] (X1)" choices="[[Foo|F]]|B">\n\nQ?\n\n</Question>'))[0]!;
    expect(q.to).toEqual([{ name: "[[Bar|Alias]]", ident: "X1" }]);
    expect(q.choices).toEqual(["[[Foo|F]]", "B"]);
  });

  test("a [[ with no ]] after it opens nothing", () => {
    expect(parseChoices("[[A|B")).toEqual(["[[A", "B"]);
    expect(parseChoices("A]]|[[B")).toEqual(["A]]", "[[B"]);
  });

  test("the card's data-question-to reads back as the same entries", () => {
    const md = '<Question id="O1" to="[[Bar|Alias]] (X1)">\n\nQ?\n\n</Question>';
    const html = formatWebHtml(md, { question: { questionsTo: [], language: "en", answerable: false } });
    const to = /data-question-to="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(to).toBe("[[Bar|Alias]] (X1)");
    expect(parseToAttr(to)).toHaveLength(1);
  });
});

describe("fix round 2: pins", () => {
  test("the card links the FIRST DecisionLog item carrying its id", () => {
    const md = [
      '<Question id="O2">',
      "",
      "Q?",
      "",
      "</Question>",
      "",
      "<DecisionLog>",
      "",
      "- **O2** — The item that decides the card.",
      "- **O2** — A later item, renamed o2-2.",
      "",
      "</DecisionLog>",
    ].join("\n");
    const html = formatWebHtml(md, { question: { questionsTo: [], language: "en", answerable: false } });
    expect(html).toContain('<li class="dl-item" id="o2-2">');
    expect(html).toContain('<a class="q-id" href="#o2">O2</a>');
  });

  test("no canonical phrase spans an item and its sub-bullet", () => {
    const md = page("Keep it? Closed\n  - 2026-10-08 (D99).");
    expect(stateOf(md)).toEqual(open);
    const item = decisionLogEntries(parseBlocks(md)).find((e) => e.id === "O3")!;
    expect(closeNearMisses(item.text)).toEqual(["Closed"]);
  });

  test("a close inside code nested under the item does not close it", () => {
    const md = page("Keep it?\n\n  ```\n  Closed 2026-10-08 (D99).\n  ```");
    expect(stateOf(md)).toEqual(open);
    expect(decisionLogEntries(parseBlocks(md)).find((e) => e.id === "O3")!.text).toBe("Keep it?");
  });

  const parsed = (inner: string, attrs = 'id="O1"') => parseQuestions(parseBlocks(`<Question ${attrs}>\n\n${inner}\n\n</Question>`))[0]!;

  test("the hash input keeps the body and the choices apart", () => {
    expect(parsed("Keep it?A").hashInput).not.toBe(parsed("Keep it?", 'id="O1" choices="A"').hashInput);
    expect(parsed("Keep it?", 'id="O1" choices="A"').hashInput).toBe("Keep it?\n\nchoices: A");
  });

  // src/web/CLAUDE.md: the hashed body keeps these, so each one changes the hash.
  const kept: [string, string, string][] = [
    ["a blockquote's >", "> Quoted\n> line.", "> Quoted line."],
    ["a thematic break", "A.\n\n---\n\nB.", "A.\n---\nB."],
    ["an ordered list's numbering", "3. a\n4. b", "3. a\n4. b"],
    ["a table's pipes", "| a | b |\n|---|---|\n| c | d |", "| a | b |\n| c | d |"],
    ["a nested paragraph's indent", "- a\n\n  Nested para.", "- a\n  Nested para."],
  ];
  for (const [label, inner, body] of kept) {
    test(`the hashed body keeps ${label}`, () => {
      expect(parsed(inner).body).toBe(body);
    });
  }
});

describe("who a question is for, and whether an author was asked", () => {
  const yv = { name: "Yvonne Jacobs", ident: "X111111" };
  test("to= wins, then questions_to:, then the owner, then nobody", () => {
    expect(resolveQuestionTargets([yv], [{ name: "Ola", ident: null }], "Owner")).toEqual({ to: [yv], source: "block" });
    expect(resolveQuestionTargets(null, [yv], "Owner")).toEqual({ to: [yv], source: "page" });
    expect(resolveQuestionTargets(null, [], "Owner")).toEqual({ to: [{ name: "Owner", ident: null }], source: "owner" });
    expect(resolveQuestionTargets(null, [], null)).toEqual({ to: [], source: "none" });
  });

  test("the ident decides when both sides carry one, else the folded name; nobody named is null", () => {
    expect(isAskedAuthor({ name: "Someone Else", navIdent: "x111111" }, [yv])).toBe(true);
    expect(isAskedAuthor({ name: "Yvonne Jacobs", navIdent: "Z999999" }, [yv])).toBe(false);
    expect(isAskedAuthor({ name: " yvonne   JACOBS ", navIdent: null }, [yv])).toBe(true);
    expect(isAskedAuthor({ name: "Ola", navIdent: "Y222222" }, [{ name: "ola", ident: null }])).toBe(true);
    expect(isAskedAuthor({ name: "Ola", navIdent: null }, [])).toBeNull();
  });
});
