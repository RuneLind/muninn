import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { readGlossaries } from "./glossary.ts";
import { renderWikiHtml } from "../wiki/render.ts";

// Invented pages only: a lending library.
//
// The paragraph shape's decision table (`LEAD_TABLE` in glossary.ts), written
// out here on its own and enumerated: every (a) lead × (b) emphasis ×
// (c) separator × (d) what follows × (e) what precedes, with the sentence's
// first letter in either case, read through `readGlossaries` and through
// the reader's render.

type Lead = "none" | "article" | "pronoun" | "other";
const LEADS: [Lead, string][] = [
  ["none", ""],
  ...["A", "An", "The", "En", "Ei", "Et"].map((w): [Lead, string] => ["article", w]),
  ...["De", "Den", "Det"].map((w): [Lead, string] => ["pronoun", w]),
  ["other", "Kun"],
];
const EMPHASIS = ["*", "_", "**", "__", "***"];
type Separator = "inside" | "after" | "em dash" | "en dash" | "hyphen" | "none";
const SEPARATORS: [Separator, (d: string, t: string) => string][] = [
  ["inside", (d, t) => `${d}${t}:${d}`],
  ["after", (d, t) => `${d}${t}${d}:`],
  ["em dash", (d, t) => `${d}${t}${d} —`],
  ["en dash", (d, t) => `${d}${t}${d} –`],
  ["hyphen", (d, t) => `${d}${t}${d} -`],
  ["none", (d, t) => `${d}${t}${d}`],
];
type Follow = "copula" | "word" | "end";
const FOLLOWS: [Follow, string][] = [
  ["copula", " is a book kept back."],
  ["copula", " er en bok."],
  ["word", " grades a loan."],
  ["end", "."],
];
/** Column (e): the text before the sentence, and whether the sentence still
 *  starts there, given whether its first letter is a capital. */
const PRECEDES: [string, string, (upper: boolean) => boolean][] = [
  ["the paragraph start", "", () => true],
  ["a sentence end", "Kept a week. ", () => true],
  ["an abbreviation", "Kept, e.g. ", () => false],
  ["a number-gated abbreviation", "It costs kr. ", () => true],
  ["a name-gated abbreviation", "Named by Dr. ", (upper) => !upper],
  ["an ordinal dot", "Due on 1. ", (upper) => upper],
  ["a capital initial", "Plan B. ", () => true],
];
const DEFINES: Record<Lead, Record<Follow | "separator", boolean>> = {
  none: { separator: true, copula: true, word: true, end: false },
  article: { separator: true, copula: true, word: true, end: false },
  pronoun: { separator: true, copula: true, word: false, end: false },
  other: { separator: false, copula: false, word: false, end: false },
};

function expected(lead: Lead, sep: Separator, follow: Follow, starts: boolean): boolean {
  // A dash is a separator only with a space after it, which a sentence end has not.
  const separator = sep !== "none" && !(follow === "end" && sep !== "inside" && sep !== "after");
  return starts && DEFINES[lead][separator ? "separator" : follow];
}

const block = (body: string) => ["<Glossary>", "", body, "", "</Glossary>", ""].join("\n");
const firstUpper = (s: string, upper: boolean) => (upper ? s : s.replace(/\p{L}/u, (c) => c.toLowerCase()));

interface Combo { name: string; para: string; term: boolean }
function combos(): Combo[] {
  const out: Combo[] = [];
  for (const [lead, word] of LEADS)
    for (const upper of [true, false])
      for (const delim of EMPHASIS)
        for (const [sep, span] of SEPARATORS)
          for (const [follow, rest] of FOLLOWS)
            for (const [pre, before, starts] of PRECEDES) {
              const sentence = firstUpper(`${word ? `${word} ` : ""}${span(delim, "Hold")}${rest}`, upper);
              out.push({
                name: `${lead} «${word}» | ${delim} | ${sep} | ${follow} | ${pre} | ${upper ? "Upper" : "lower"}`,
                para: `${before}${sentence} It waits.`,
                term: expected(lead, sep, follow, starts(upper)),
              });
            }
  return out;
}
const ALL = combos();

describe("the paragraph shape's decision table", () => {
  test("enumerates every combination", () => {
    expect(ALL.length).toBe(LEADS.length * 2 * EMPHASIS.length * SEPARATORS.length * FOLLOWS.length * PRECEDES.length);
    // Both outcomes occur, so a table of all-true or all-false cannot pass.
    expect(ALL.filter((c) => c.term).length).toBeGreaterThan(1000);
    expect(ALL.filter((c) => !c.term).length).toBeGreaterThan(1000);
  });

  test("readGlossaries reads a term exactly where the table says", () => {
    const wrong = ALL.filter((c) => {
      const terms = readGlossaries(parseBlocks(block(c.para)))[0]!.entries.map((e) => e.term.toLowerCase());
      return terms.includes("hold") !== c.term;
    });
    expect(wrong.map((c) => `${c.name}: ${c.para}`)).toEqual([]);
  });

  test("the reader marks the term's use exactly where the table says", () => {
    const wrong = ALL.filter((c) => {
      const html = renderWikiHtml(`The hold waits at the desk.\n${block(c.para)}`, () => undefined, { views: true, language: "no" });
      return /data-gl-key="hold"/.test(html) !== c.term;
    });
    expect(wrong.map((c) => `${c.name}: ${c.para}`)).toEqual([]);
  }, 30_000);
});

describe("named regressions", () => {
  const read = (para: string) => readGlossaries(parseBlocks(block(para)))[0]!.entries.map((e) => [e.term, e.definition]);
  test.each([
    ["a colon inside bold after The", "The **Hold:** a lock.", [["Hold", "a lock."]]],
    ["Det and a modal", "**Lån** er en avtale. Det *må* fornyes.", [["Lån", "er en avtale. Det må fornyes."]]],
    ["De and an adjective", "**Lån** er en avtale. De *eldste* lånene purres.", [["Lån", "er en avtale. De eldste lånene purres."]]],
    ["Den and a modal", "**Lån** er en avtale. Den *skal* leveres.", [["Lån", "er en avtale. Den skal leveres."]]],
    ["A and an adverb", "**Hold** is a state. A *very* long wait follows.", [["Hold", "is a state. A very long wait follows."]]],
    ["a function word alone", "**Hold** is a state. *Not* a loan.", [["Hold", "is a state. Not a loan."]]],
    ["e.g.", "**Hold** is a state, e.g. *paused* lending.", [["Hold", "is a state, e.g. paused lending."]]],
    ["an ordinal dot", "**Lån** forfaller 1. *januar* hvert år.", [["Lån", "forfaller 1. januar hvert år."]]],
    ["kr. before a number", "**Gebyr** er kr. **500** per dag.", [["Gebyr", "er kr. 500 per dag."]]],
    ["Dr. before a name", "**Hold** was named by Dr. **Who** himself.", [["Hold", "was named by Dr. Who himself."]]],
    ["an article, a noun and a verb", "**Hold** is a state. A *Renewal* adds a week.", [["Hold", "is a state."], ["Renewal", "adds a week."]]],
    ["a number's dot before a capital", "**Hold** lasts 3. **Renewal** is a new loan.", [["Hold", "lasts 3."], ["Renewal", "is a new loan."]]],
  ])("%s", (_name, para, entries) => {
    expect(read(para)).toEqual(entries);
  });

  test.each(["is", "are", "was", "were", "er", "var", "blir", "ble"])("a pronoun-article before «%s» is a term", (copula) => {
    expect(read(`Det **Lånet** ${copula} nytt.`)).toEqual([["Lånet", `${copula} nytt.`]]);
  });

  test("a pronoun-article before any other word is not", () => {
    expect(read("Det **Lånet** forfaller i dag.")).toEqual([]);
  });
});
