import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { parseQuestionPage } from "./question.ts";
import { unclosedCards } from "./question-unclosed.ts";

// Every fixture here is synthetic: invented ids, names and keys.

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

describe("unclosedCards: the fact a triage reads", () => {
  const cards = (md: string) => unclosedCards(parseQuestionPage(parseBlocks(md)));

  test("the card's own word and the decision naming it, side by side", () => {
    expect(cards(page("Keep it? decided A.", ["- **D5** — The old path stays (O3 → A)."]))).toEqual([
      { id: "O3", decision: "D5", namedBy: "D5", word: "decided" },
    ]);
    expect(cards(page("Keep it? decided A."))).toEqual([{ id: "O3", decision: null, namedBy: null, word: "decided" }]);
    expect(cards(page("Keep it?", ["- **D5** — The old path stays (O3 → A)."]))).toEqual([
      { id: "O3", decision: "D5", namedBy: "D5", word: null },
    ]);
  });

  test("it reports what the linter leaves to its near-miss finding", () => {
    expect(cards(page("Keep it? Besvart 06.10: ja."))).toEqual([{ id: "O3", decision: null, namedBy: null, word: "Besvart" }]);
  });

  test("a superseded decision names its successor as the one to close with", () => {
    const md = page("Keep it?", ["- **D5** — The old path stays (O3 → A). Erstattet av D6.", "- **D6** — A new path."]);
    expect(cards(md)).toEqual([{ id: "O3", decision: "D6", namedBy: "D5", word: null }]);
  });

  test("a supersede chain to nowhere, or round in a circle, rules on nothing", () => {
    expect(cards(page("Keep it?", ["- **D5** — The old path stays (O3 → A). Superseded by D9."]))).toEqual([]);
    expect(
      cards(page("Keep it?", ["- **D5** — The old path stays (O3 → A). Superseded by D6.", "- **D6** — A new path. Superseded by D5."])),
    ).toEqual([]);
  });

  test("two blocks sharing an id are one row, and a repeated decision id reads its first item", () => {
    const again = ['<Question id="O3">', "", "Q?", "", "</Question>"].join("\n");
    expect(cards(`${page("Keep it?", ["- **D5** — A first statement here.", "- **D5** — The old path stays (O3 → A)."])}\n\n${again}`)).toEqual([]);
    expect(cards(`${page("Keep it? decided A.")}\n\n${again}`).map((c) => c.id)).toEqual(["O3"]);
  });

  test("the ruling word reads the nested sub-bullets, as the close rule does", () => {
    expect(cards(page("Keep it?\n  - Rune decided A."))).toEqual([{ id: "O3", decision: null, namedBy: null, word: "decided" }]);
  });
});

describe("unclosedCards: the own item rules on nothing it does not state", () => {
  const word = (item: string) => unclosedCards(parseQuestionPage(parseBlocks(page(item)))).map((c) => c.word);
  const silent = (item: string) => expect(word(item)).toEqual([]);

  for (const item of ["~~decided A~~ taken back.", "Keep it. ~~Besvart A.~~ Snudd 15.10."]) {
    test(`struck text rules on nothing: ${item}`, () => silent(item));
  }
  test("a struck negation negates nothing", () => {
    expect(word("~~not~~ decided A")).toEqual(["decided"]);
    expect(word("~~ikke~~ besvart A.")).toEqual(["besvart"]);
  });

  for (const item of [
    "See [notes](plans/decided-cards.mdx).",
    "See [notes](plans/decided.mdx).",
    "See [notes](a(1)/decided.mdx).",
    "See ![decided](b(1)/x.png).",
    "See [notes](a(1)/decided).",
    "See besvart/notes.mdx for more.",
    "Hastily-decided A.",
    "See notes.decided here.",
    "See decided.mdx here.",
    'See [notes](x.mdx "decided").',
    "See [notes][decided].",
    "See ![a](decided.png).",
    "See [[answered-questions]].",
    "See [[answered]].",
    "See [[answered|the notes]].",
    "See https://x.example/besvart/1 for more.",
    "See www.x.example/besvart for more.",
    "See <https://x.example/besvart/1> for more.",
    "See plans/besvart.mdx for more.",
    'A <span title="decided">note</span> here.',
    "A <!-- decided --> note here.",
    'A <span\n  title="decided">note</span> here.',
  ]) {
    test(`a target is not prose: ${item}`, () => silent(item));
  }
  for (const [item, w] of [
    ["See [decided A](plans/x.mdx).", "decided"],
    ["See [[plans/x|decided A]].", "decided"],
    ['A <span title="x">decided A</span> here.', "decided"],
    ["See [notes][x], besvart A.", "besvart"],
    ["See https://x.example/a, avgjort A.", "avgjort"],
  ] as const) {
    test(`text beside a target is prose: ${item}`, () => expect(word(item)).toEqual([w]));
  }

  for (const item of [
    "Who decided this?",
    "Has this been answered?",
    "Hvem har avgjort dette?",
    "Decided?",
    "**Decided?**",
    "(Decided?)",
    "Who decided this? Nobody knows.",
    "Keep it. Who decided that `x`?",
  ]) {
    test(`a question rules on nothing: ${item}`, () => silent(item));
  }

  for (const item of [
    "Should be decided by Kari",
    "Must this be decided by fag?",
    "will be decided on Friday",
    "Skal dette bli avgjort av Kari?",
    "Waits until O2 is answered",
    "Waits until O2, O4 and O6 are answered",
    "Waits until Kari, Per, Ola and Geir have answered",
    "Kan tas når S2 er besvart",
    "Holdes til S2 er besvart",
    "Tas etter at S2 er besvart",
    "If decided by Friday",
    "Hvis avgjort i dag",
    "hasn't been decided",
    "hasn’t decided",
    "isn't decided",
    "ikkje avgjort",
    "no one has answered",
    "nobody answered",
    "ingen har besvart",
    "not yet been decided",
    "har ikke blitt endelig avgjort",
    "Not at all answered",
    "Ikke ennå helt avgjort",
    "ikke-besvart",
    "not-yet-answered",
    "to-be-decided",
    "not (yet) decided",
    "ikke (ennå) besvart",
    'not "decided"',
    "ikke «besvart»",
    "to\n  be decided",
    "not `x` decided",
    "**not** really *decided*",
    "_not_ decided",
    "_ikke_ _besvart_",
    "See decided-cards for the list.",
  ]) {
    test(`pending or negated rules on nothing: ${item}`, () => silent(item));
  }

  for (const [item, w] of [
    ["answered A 29.10.", "answered"],
    ["ANSWERED A 29.10.", "ANSWERED"],
    ["Decided: A.", "Decided"],
    ["Besvart med A.", "Besvart"],
    ["Avgjort 06.10.", "Avgjort"],
    ["decided A on 29.10", "decided"],
    ["Keep it? Decided A.", "Decided"],
    ["Keep it?\n  - Rune decided A.", "decided"],
    ["Not sure, decided A.", "decided"],
    ["When Kari replied, decided A.", "decided"],
    ["Not decided on 01.10; decided A on 03.10.", "decided"],
    ["Not decided on 01.10. Decided A on 03.10.", "Decided"],
    ["Not decided on 01.10 — decided A on 03.10.", "decided"],
    ["Not decided on 01.10 but decided A on 03.10.", "decided"],
    ["Should we? Avgjort A.", "Avgjort"],
    ["Decided not to build it.", "Decided"],
    ["Noted and decided A.", "decided"],
    ["_Decided A._", "Decided"],
    ["_decided_ A.", "decided"],
    ["Not decided.<br> Decided A.", "Decided"],
  ] as const) {
    test(`a ruling keeps flagging: ${item.replace(/\n/g, " ")}`, () => expect(word(item)).toEqual([w]));
  }

  for (const marker of [
    "not", "ikke", "ikkje", "no", "nobody", "noone", "none", "nothing", "ingen", "ingenting", "never", "aldri",
    "neither", "nor", "verken", "hverken", "without", "uten", "cannot", "won't", "won’t",
    "be", "been", "bli", "blir", "blitt", "should", "must", "can", "could", "skal", "bør", "må", "kan", "kunne",
    "need", "needs", "trenger", "until", "till", "inntil", "when", "once", "når", "if", "unless", "hvis", "dersom",
    "before", "før", "wait", "waits", "waiting", "awaiting", "pending", "vent", "venter", "avventer", "mangler",
    "maybe", "perhaps", "kanskje", "etter at", "til O2 er", "after O2 is", "after O2 are", "after O2 has",
  ]) {
    test(`marker «${marker}» holds in its clause, whatever stands between`, () => {
      silent(`Keep it. ${marker} Kari somehow decided A.`);
      expect(word(`${marker} Kari. Decided A.`)).toEqual(["Decided"]);
    });
  }

  for (const item of ["«Decided?»", "_Decided?_", "~Decided?~", "Decided?)", 'Decided?"', "“Decided?”", "'Decided?'", "‘Decided?’", "[Decided?]", "Decided?!", "Decided?…", "Decided?? ", "Decided? `x`", "_Decided?_ `x`", "Decided?<br>"]) {
    test(`a closer after the question mark: ${item}`, () => silent(item));
  }
  test("an image's alt text is not a ruling", () => silent("See ![decided](x.png)."));

  for (const [item, w] of [
    ["**Not decided.** Decided A.", "Decided"],
    ["_Not decided._ Decided A.", "Decided"],
    ["~Not decided.~ Decided A.", "Decided"],
    ["(Not decided.) Decided A.", "Decided"],
    ["[Not decided.] Decided A.", "Decided"],
    ["«Not decided.» Decided A.", "Decided"],
    ['"Not decided." Decided A.', "Decided"],
    ["“Not decided.” Decided A.", "Decided"],
    ["'Not decided.' Decided A.", "Decided"],
    ["‘Not decided.’ Decided A.", "Decided"],
    ["Not asked [x](y). Decided A.", "Decided"],
    ["Not decided! Decided A.", "Decided"],
    ["Not decided… Decided A.", "Decided"],
    ["Not decided on 01.10: decided A on 03.10.", "decided"],
    ["Not decided on 01.10 – decided A on 03.10.", "decided"],
    ["Not decided on 01.10 - decided A on 03.10.", "decided"],
    ["Ikke avgjort 01.10 men avgjort A 03.10.", "avgjort"],
    ["Not sure, decided A, then B.", "decided"],
  ] as const) {
    test(`a break ends what came before: ${item}`, () => expect(word(item)).toEqual([w]));
  }
  for (const item of ["Waits until O2, O4 or O6 are answered", "Venter til S1, S2 og S3 er besvart", "Venter til S1, S2 eller S3 er besvart"]) {
    test(`an enumeration does not break the clause: ${item}`, () => silent(item));
  }

  test("a nested paragraph is its own clause", () => {
    expect(word("Not asked yet\n  - decided A.")).toEqual(["decided"]);
  });
});

describe("unclosedCards: a decision's target is not its sentence", () => {
  const decision = (sentence: string) =>
    unclosedCards(parseQuestionPage(parseBlocks(page("Keep it?", [`- **D5** — ${sentence}`])))).map((c) => c.decision);

  for (const sentence of [
    "See [doc](https://x.example/?q=O3=1) for the rest.",
    "See [doc](plans/O3=1.mdx) for the rest.",
    "See https://x.example/?q=O3=1 for the rest.",
    "See <https://x.example/?q=O3=1> for the rest.",
    "See [[O3=1]] for the rest here.",
    'See <span title="O3 = 1">this</span> for the rest.',
    "O3 https://x.example/ → B is the rest here.",
  ]) {
    test(`silent: ${sentence}`, () => expect(decision(sentence)).toEqual([]));
  }

  for (const sentence of ["See [O3 → B](plans/x.mdx) for the rest.", "See [[plans/x|O3 → B]] for the rest."]) {
    test(`link text still rules: ${sentence}`, () => expect(decision(sentence)).toEqual(["D5"]));
  }
});
