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

describe("unclosedCards: only a decision's first sentence is read, with emphasis or not", () => {
  const row = (items: string[], item = "Keep it?") =>
    unclosedCards(parseQuestionPage(parseBlocks(page(item, items)))).map((c) => [c.decision, c.namedBy]);

  test("a later sentence inside a whole-item strike names nothing", () => {
    expect(row(["- ~~**D5** — Something else entirely here. Later O3 → B. Superseded by D6.~~", "- **D6** — A new path."])).toEqual([]);
  });
  test("a later sentence inside bold names nothing", () => {
    expect(row(["- **D5** — **A long enough bold sentence one. Later O3 → B.** Slutt."])).toEqual([]);
  });
  test("a sentence inside a live decision's strike names nothing", () => {
    expect(row(["- **D5** — ~~O3 → A here in a long sentence. Second one.~~ Slutt her nå."])).toEqual([]);
  });
  test("a superseded decision's struck first sentence still hands over", () => {
    expect(row(["- ~~**D5** — The old path stays (O3 → A). Superseded by D6.~~", "- **D6** — A new path."])).toEqual([["D6", "D5"]]);
  });
  test("a bold first sentence still rules", () => {
    expect(row(["- **D5** — **O3 → B is the bold ruling.** Slutt her nå."])).toEqual([["D5", "D5"]]);
  });
  test("a live decision's struck id rules on nothing", () => {
    expect(row(["- **D5** — ~~O3 → A~~ Keeping the old path here. Slutt her."])).toEqual([]);
  });
  test("the sentence after a live decision's struck first sentence is not its first", () => {
    expect(row(["- **D5** — ~~The long struck sentence (O3 → A).~~ O3 → B was the second one here."])).toEqual([]);
  });
  test("text beside a live decision's strike in the first sentence still rules", () => {
    expect(row(["- **D5** — ~~O3 → A~~ O3 → B stays now. Slutt her."])).toEqual([["D5", "D5"]]);
  });
  test("single-star emphasis around the id is tolerated", () => {
    expect(row(["- **D5** — *O3* → B."])).toEqual([["D5", "D5"]]);
  });
});

describe("unclosedCards: the highest decision the chains end on wins, not the last in the source", () => {
  const row = (items: string[]) =>
    unclosedCards(parseQuestionPage(parseBlocks(page("Keep it?", items)))).map((c) => [c.decision, c.namedBy]);

  test("a newest-first log names its newest decision", () => {
    expect(row(["- **D6** — The new path (O3 → B).", "- **D5** — The old path (O3 → A)."])).toEqual([["D6", "D6"]]);
  });
  test("oldest-first reads the same", () => {
    expect(row(["- **D5** — The old path (O3 → A).", "- **D6** — The new path (O3 → B)."])).toEqual([["D6", "D6"]]);
  });
  test("the order is numeric", () => {
    expect(row(["- **D10** — The new path (O3 → B).", "- **D9** — The old path (O3 → A)."])).toEqual([["D10", "D10"]]);
  });
  test("a chain's end counts, above a live decision with a higher number than the one it started from", () => {
    expect(
      row(["- **D8** — The old path (O3 → A). Superseded by D10.", "- **D10** — A new path.", "- **D9** — The other path (O3 → B)."]),
    ).toEqual([["D10", "D8"]]);
  });
  test("a chain's end counts, not the number it started from", () => {
    expect(
      row(["- **D5** — The other path (O3 → B).", "- **D9** — The old path (O3 → A). Superseded by D3.", "- **D3** — A new path."]),
    ).toEqual([["D5", "D5"]]);
  });
  test("two decisions ending on the same one: the highest that names the card, listed last", () => {
    expect(
      row(["- **D5** — Another path (O3 → B). Superseded by D7.", "- **D6** — One path (O3 → A). Superseded by D7.", "- **D7** — A new path."]),
    ).toEqual([["D7", "D6"]]);
  });
  test("two decisions ending on the same one: the highest that names the card, listed first", () => {
    expect(
      row(["- **D6** — One path (O3 → A). Superseded by D7.", "- **D7** — A new path.", "- **D5** — Another path (O3 → B). Superseded by D7."]),
    ).toEqual([["D7", "D6"]]);
  });
  test("the successor naming the card itself beats the one it replaced, listed last", () => {
    expect(row(["- **D5** — The old path (O3 → A). Superseded by D7.", "- **D7** — The new path (O3 → B)."])).toEqual([["D7", "D7"]]);
  });
  test("the successor naming the card itself beats the one it replaced, listed first", () => {
    expect(row(["- **D7** — The new path (O3 → B).", "- **D5** — The old path (O3 → A). Superseded by D7."])).toEqual([["D7", "D7"]]);
  });
});

describe("unclosedCards: what a decision's sentence does not rule on", () => {
  const onCard = (id: string, sentence: string) =>
    unclosedCards(
      parseQuestionPage(
        parseBlocks(
          [`<Question id="${id}">`, "", "Q?", "", "</Question>", "", "<DecisionLog>", "", `- **${id}** — Keep it?`, `- **D5** — ${sentence}`, "", "</DecisionLog>"].join("\n"),
        ),
      ),
    ).map((c) => c.decision);
  const silent = (id: string, sentence: string) => test(`silent: ${sentence}`, () => expect(onCard(id, sentence)).toEqual([]));
  const flags = (id: string, sentence: string) => test(`flags: ${sentence}`, () => expect(onCard(id, sentence)).toEqual(["D5"]));

  // The Answer/Svar gap.
  silent("O3", "Answer the mail before reading card O3.");
  silent("O3", "Svar kommer senere, se kortet O3 for valg.");
  silent("O3", "Answer the long mail on card O3.");
  silent("O3", "Answer A or B on card O3.");
  silent("O3", "Answer A or B card O3.");
  silent("O3", "Answer mail on card O3.");
  flags("O1", "Answer A on card O1");
  flags("S1", "Svar B på kortet S1");
  flags("O1", "Answer on card O1");
  flags("O1", "Answer card O1");
  flags("O1", "Answer yes on card O1");
  flags("S1", "Svar i kortet S1");
  flags("O1", "Answer A on card *O1*");
  flags("O1", "Answer A on card **O1**");
  flags("O1", "Answer: A on card O1");
  flags("O1", "Answer A, on card O1");
  flags("S1", "Svar A på kortet S1");
  flags("O1", "Answer A on\n  card O1");

  // A negation or question right after the arrow, `=` or `avgjort`.
  silent("O3", "O3 = ikke avgjort ennå her.");
  silent("O3", "O3 → not decided yet at all.");
  silent("O3", "O3 → Ikke avgjort ennå her.");
  silent("O3", "O3 → ikkje avgjort ennå her.");
  silent("O1", "O1 = ? until Rune replies.");
  silent("O1", "O1 →? until Rune replies.");
  silent("O1", "O1 = ?, until Rune replies.");
  silent("S1", "S1 avgjort ikke før møtet.");
  flags("O3", "O3 → B");
  flags("O1", "O1 = A");
  flags("S1", "S1 avgjort med A");
  flags("O3", "**O3** → B");
  flags("O3", "O3 → nothing else changes here.");
  flags("O3", "O3 = notify the owner first.");

  // A question.
  silent("O3", "Should O3 → B stand here?");
  silent("O3", "Should O3 → B stand here? Nobody has said so yet.");
  silent("O3", "(Should O3 → B stand here?)");
  silent("O3", "Should O3 → B? Ja.");
  flags("O3", "Keep it? O3 → B.");
  flags("O3", "O3 → B. Hvorfor? Fordi det holder.");

  // A conditional opening the sentence.
  silent("O3", "If O3 → B, we drop the path.");
  silent("O3", "Hvis O3 = B, faller delen bort.");
  silent("O3", "Dersom O3 = B, faller delen bort.");
  silent("O3", "**If O3 → B, we drop the path.** Slutt her nå.");
  silent("O3", "(If O3 → B, we drop the path.)");
  silent("O3", "if O3 → B, we drop the path.");
  flags("O3", "Iffy start, O3 → B stands.");
  flags("O3", "We drop the path if O3 → B holds.");
  flags("O3", "O3 → B. If that fails, we drop the path.");

  // Accepted, and declared in the PR: no mood word list catches these.
  flags("O3", "Kari will answer O3 = B maybe.");
  flags("O1", "O1 → O2 is the order");
  flags("S1", "Svar på kortet S1 mangler fortsatt");
});
