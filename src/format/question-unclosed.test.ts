import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
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

  // An item ending in `?` with no break since the word: closers and marks aside.
  for (const item of [
    "Who decided this?",
    "Has this been answered?",
    "Hvem har avgjort dette?",
    "Decided?",
    "**Decided?**",
    "(Decided?)",
    "«Decided?»",
    "_Decided?_",
    "~Decided?~",
    "Decided?)",
    'Decided?"',
    "“Decided?”",
    "'Decided?'",
    "‘Decided?’",
    "[Decided?]",
    "Decided?!",
    "Decided?…",
    "Decided?? ",
    "Decided? `x`",
    "_Decided?_ `x`",
    "Decided?<br>",
    "Was it decided on 29.10?",
    "Decided?.",
  ]) {
    test(`a question rules on nothing: ${item}`, () => silent(item));
  }
  for (const [item, w] of [
    ["Decided A (why not B?)", "Decided"],
    ["Decided A [why not B?](x.mdx)", "Decided"],
    ["Decided A on 29.10, ok?", "Decided"],
    ["Decided A; ok?", "Decided"],
    ["Decided A: ok?", "Decided"],
    ["Decided A\n  Why not B?", "Decided"],
    ["Decided A. Why not B?", "Decided"],
    ["Decided A! Why not B?", "Decided"],
    ["Decided A… Why not B?", "Decided"],
    ["**Decided A.** Why not B?", "Decided"],
    ["Who decided this? Nobody knows.", "decided"],
    ["Keep it? Decided A.", "Decided"],
    ["Should we? Avgjort A.", "Avgjort"],
  ] as const) {
    test(`a question elsewhere in the item is no question about the word: ${item.replace(/\n/g, " ")}`, () =>
      expect(word(item)).toEqual([w]));
  }

  // One marker each, and the wrappers a marker or a word may wear.
  for (const item of [
    "not yet decided",
    "not (yet) decided",
    "NOT decided",
    "**not** really *decided*",
    "_not_ decided",
    'not "decided"',
    "ikke (ennå) besvart",
    "ikke «besvart»",
    "_ikke_ _besvart_",
    "ikkje avgjort",
    "never answered",
    "aldri besvart",
    "isn't decided",
    "hasn't been decided",
    "hasn’t decided",
    "nobody answered",
    "ingen har besvart",
    "to be decided",
    "to\n  be decided",
    "Should be decided by Kari",
    "will be decided on Friday",
    "Must this be decided by fag?",
    "Skal dette bli avgjort",
    "Skal dette bli avgjort av Kari?",
    "Waits until O2 is answered",
    "Kan tas når S2 er besvart",
    "not at all answered",
    "not yet been decided",
    "har ikke blitt endelig avgjort",
    "Ikke ennå helt avgjort",
    "ikke-besvart",
    "not-yet-answered",
    "to-be-decided",
    "See decided-cards for the list.",
    "Decidedly so.",
    "Undecided still.",
    'Not <Fact id="f">decided</Fact> here.',
  ]) {
    test(`negated or pending rules on nothing: ${item.replace(/\n/g, " ")}`, () => silent(item));
  }

  for (const [item, w] of [
    ["This has been decided: A.", "decided"],
    ["It has been answered by Kari on 29.10.", "answered"],
    ["Er blitt avgjort: A.", "avgjort"],
    ["Har blitt besvart av Kari 29.10.", "besvart"],
    ["When we met on 29.10 we decided A.", "decided"],
    ["Once Kari replied we decided A.", "decided"],
    ["Before the release we decided A.", "decided"],
    ["Før release ble det avgjort A.", "avgjort"],
    ["Etter at Kari svarte ble det avgjort A.", "avgjort"],
    ["No objections and Kari decided A on 29.10.", "decided"],
    ["Nothing blocks it and Kari decided A.", "decided"],
    ["We can't do B so decided A.", "decided"],
    ["It must be A as decided on 29.10.", "decided"],
    ["Spørsmålet til fag er besvart.", "besvart"],
    ["Forslaget til Kari er avgjort: A.", "avgjort"],
    ["Go/no-go decided on 29.10: go.", "decided"],
    ["Must-have list decided on 29.10.", "decided"],
    ["No change, decided and shipped.", "decided"],
    ["Kan leve med det, avgjort og lukket.", "avgjort"],
    ["Not yet\n  Decided A.", "Decided"],
    ["Venter på Kari\n  Avgjort A 29.10.", "Avgjort"],
  ] as const) {
    test(`a ruling keeps flagging: ${item.replace(/\n/g, " ")}`, () => expect(word(item)).toEqual([w]));
  }

  for (const [item, w] of [
    ["answered A 29.10.", "answered"],
    ["ANSWERED A 29.10.", "ANSWERED"],
    ["Decided: A.", "Decided"],
    ["Besvart med A.", "Besvart"],
    ["Avgjort 06.10.", "Avgjort"],
    ["decided A on 29.10", "decided"],
    ["Keep it?\n  - Rune decided A.", "decided"],
    ["Decided not to build it.", "Decided"],
    ["Noted and decided A.", "decided"],
    ["_Decided A._", "Decided"],
    ["_decided_ A.", "decided"],
    // Past the window.
    ["Not at all yet answered A.", "answered"],
    ["To be fully decided A.", "decided"],
    ["Not decided on 01.10 but decided A on 03.10.", "decided"],
    ["Ikke avgjort 01.10 men avgjort A 03.10.", "avgjort"],
    ["Maybe decided A.", "decided"],
    ["Knot decided A.", "decided"],
    // Across a break.
    ["Not sure, decided A.", "decided"],
    ["Not, decided A.", "decided"],
    ["Not sure; decided A.", "decided"],
    ["Not sure: decided A.", "decided"],
    ["Not sure. Decided A.", "Decided"],
    ["Not sure! Decided A.", "Decided"],
    ["Not sure? Decided A.", "Decided"],
    ["Not sure… Decided A.", "Decided"],
    ["Not sure — decided A.", "decided"],
    ["Not sure – decided A.", "decided"],
    ["Not sure - decided A.", "decided"],
    ["**Not sure.** Decided A.", "Decided"],
    ["(Not sure.) Decided A.", "Decided"],
    ["«Not sure.» Decided A.", "Decided"],
    ["Not sure.<br> Decided A.", "Decided"],
    ["Not asked yet\n  - decided A.", "decided"],
    ["Not\n  yet decided A.", "decided"],
    // A marker inside a compound.
    ["Not-applicable decided A.", "decided"],
    ["Why-not decided A.", "decided"],
    ["Can't-miss decided A.", "decided"],
    ["Must-be decided A.", "decided"],
    ["Be-all decided A.", "decided"],
    // Accepted false flags: a hedged warning, declared in the PR.
    ["Depends on O2 being answered", "answered"],
    ["Om S2 er besvart", "besvart"],
    ["Hardly decided", "decided"],
    ["O2 is answered, so this waits", "answered"],
    ["<s>decided A</s>", "decided"],
    ["See mailto:decided@x.example here.", "decided"],
    ["Waits until O2, O4 and O6 are answered", "answered"],
    ["Holdes til S2 er besvart", "besvart"],
    ["If decided by Friday", "decided"],
    ["not `x` decided", "decided"],
    ["Keep it. Who decided that `x`?", "decided"],
  ] as const) {
    test(`flags: ${item.replace(/\n/g, " ")}`, () => expect(word(item)).toEqual([w]));
  }
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
  test("a later sentence inside a <Fact> names nothing", () => {
    expect(row(['- **D5** — <Fact id="f">A long enough sentence one. Later O3 → B.</Fact> Slutt her nå.'])).toEqual([]);
  });
  test("a sentence inside a live decision's strike names nothing", () => {
    expect(row(["- **D5** — ~~O3 → A here in a long sentence. Second one.~~ Slutt her nå."])).toEqual([]);
  });
  test("a whole-item strike with no successor names nothing", () => {
    expect(row(["- **D5** — ~~O3 → A here in a long sentence.~~"])).toEqual([]);
    expect(row(["- ~~**D5** — O3 → A here in a long sentence.~~"])).toEqual([]);
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
  test("single-star emphasis around the id is tolerated", () => {
    expect(row(["- **D5** — *O3* → B."])).toEqual([["D5", "D5"]]);
  });

  // A live decision's struck span is gone whole: one space, no punctuation.
  for (const sentence of [
    "~~O3 → A~~ O3 → B stays now. Slutt her.",
    "O3 ~~→ A~~ → B stays here.",
    "O3 ~~= A~~ = B stays here.",
    "O3 ~~(old)~~ → B stays here.",
    "`~~` goes, O3 → B stays now. Next one ~~old~~ here.",
    "O3 → B ~~or is it C?~~",
    "~~A long struck sentence here.~~ O3 → B.",
    "~~The long struck sentence (O3 → A).~~ O3 → B was the second one here.",
    "~~Long enough one. O3 → A~~ O3 → B.",
    "`**` goes, O3 → B stays now. Next one **old** here.",
    "P~~x~~O3 → B stays here.",
    "Cafe\u0301 O3 ~~→ A~~ → B stays here.",
  ]) {
    test(`what stands beside a strike rules: ${sentence}`, () => expect(row([`- **D5** — ${sentence}`])).toEqual([["D5", "D5"]]));
  }
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
  test("a later decision saying not stated does not name the card, so the earlier one still does", () => {
    expect(row(["- **D5** — The first path here (O3 → B).", "- **D6** — The second look here, O3 → ikke avgjort likevel."])).toEqual([["D5", "D5"]]);
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

  // The Answer/Svar gap: at most three tokens of any characters.
  silent("O3", "Answer the mail before reading card O3.");
  silent("O3", "Answer the long mail on card O3.");
  silent("O3", "Answer A or B on card O3.");
  silent("O3", "Answered on card O3.");
  silent("O3", "NoAnswer on card O3.");
  silent("O3", "Besvar i kortet O3.");
  silent("O3", "Svaret på kortet O3.");
  silent("O3", "Answer not on card O3.");
  silent("O3", "Svar ikke på kortet O3.");
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
  flags("O3", "Answer given on card O3.");
  flags("S3", "Svar gitt i kortet S3.");
  flags("O3", "Answer *A* on card O3.");
  flags("O3", "Answer A/B on card O3.");
  flags("O3", "Answer mail on card O3.");
  flags("O3", "Answer A or B card O3.");
  flags("O3", "Answer `A` on card O3.");

  // A negation or question right after the arrow, `=` or `avgjort`.
  silent("O3", "O3 = ikke avgjort ennå her.");
  silent("O3", "O3 → not decided yet at all.");
  silent("O3", "O3 → Ikke avgjort ennå her.");
  silent("O3", "O3 → IKKE avgjort ennå.");
  silent("O3", "O3 → ikkje avgjort ennå her.");
  silent("O3", "O3 → *not* decided yet.");
  silent("O3", "O3 → _not_ decided yet.");
  silent("O3", "O3 → **not** decided yet.");
  silent("O3", "O3 → `not` decided yet.");
  silent("O3", "O3 → `NOT` decided yet.");
  silent("O3", "O3 → `ikke` avgjort ennå.");
  silent("O3", "O3 → `ikkje` avgjort ennå.");
  silent("O1", "O1 = ? until Rune replies.");
  silent("O1", "O1 →? until Rune replies.");
  silent("O1", "O1 = ?, until Rune replies.");
  silent("S1", "S1 avgjort ikke før møtet.");
  flags("O3", "O3 → B");
  flags("O1", "O1 = A");
  flags("O3", "O3\n  → B stays here.");
  flags("O3", "O3\u00a0→ B stays here.");
  flags("O3", "O3\t→ B stays here.");
  silent("O3", "O3 avgjorte saken her.");
  flags("S1", "S1 avgjort med A");
  flags("O3", "**O3** → B");
  flags("O3", "O3 → nothing else changes here.");
  flags("O3", "O3 = notify the owner first.");
  flags("O3", "O3 → ikke-relevant her.");
  flags("O3", "O3 → not-applicable here.");

  // A question: the sentence ends in `?` with no break since the sign.
  silent("O3", "Should O3 → B stand here?");
  silent("O3", "Should O3 → B stand here? Nobody has said so yet.");
  silent("O3", "(Should O3 → B stand here?)");
  silent("O3", "Answer on card O3?");
  flags("O3", "Keep it? O3 → B.");
  flags("O3", "O3 → B. Hvorfor? Fordi det holder.");
  flags("O3", "O3 → B (hvorfor?) holder lenge.");
  flags("O3", "O3 → B holder [Hvorfor ikke A?](https://x.example/y) for grunn.");
  flags("O3", "Should O3 → B? Ja.");

  // Accepted, and declared in the PR: no mood rule catches these.
  flags("O3", "If O3 → B, we drop the path.");
  flags("O3", "Hvis O3 = B, faller delen bort.");
  flags("O3", "Kari will answer O3 = B maybe.");
  flags("O1", "O1 → O2 is the order");
  flags("S1", "Svar på kortet S1 mangler fortsatt");
  flags("S1", "Svar kommer senere, se kortet S1 for valg.");
});

describe("question-unclosed.ts stays server-only", () => {
  const TARGET = resolve(import.meta.dir, "question-unclosed.ts");
  const transpiler = new Bun.Transpiler({ loader: "ts" });

  /** Every repo file `entry` reaches through a relative import. */
  async function graph(entry: string): Promise<Set<string>> {
    const seen = new Set<string>();
    const queue = [entry];
    for (let file = queue.pop(); file; file = queue.pop()) {
      if (seen.has(file) || !file.endsWith(".ts")) continue;
      seen.add(file);
      for (const { path } of transpiler.scanImports(await Bun.file(file).text())) {
        if (path.startsWith(".")) queue.push(resolve(dirname(file), path));
      }
    }
    return seen;
  }

  test("the walk finds it from its one importer", async () => {
    expect(await graph(resolve(import.meta.dir, "../wiki/lint.ts"))).toContain(TARGET);
  });

  test("no browser entry reaches it", async () => {
    const root = resolve(import.meta.dir, "..");
    const entries = [...new Bun.Glob("**/*-{browser,client}.ts").scanSync(root)].map((f) => resolve(root, f));
    expect(entries).toContain(resolve(root, "dashboard/views/components/wiki-browser.ts"));
    for (const entry of entries) expect([entry, (await graph(entry)).has(TARGET)]).toEqual([entry, false]);
  });
});
