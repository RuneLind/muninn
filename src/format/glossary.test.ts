import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { glossaryKey, glossaryTerms, isMarkableTerm, readGlossaries } from "./glossary.ts";

// Invented pages only: a lending library.

const read = (md: string) => readGlossaries(parseBlocks(md));
const block = (body: string) => ["<Glossary>", "", body, "", "</Glossary>", ""].join("\n");

describe("the list shape", () => {
  test.each([
    ["bold with the colon inside", "- **Hold:** a book kept back", "Hold", "a book kept back"],
    ["bold with the colon after", "- **Hold**: a book kept back", "Hold", "a book kept back"],
    ["bold with an em dash", "- **Hold** — a book kept back", "Hold", "a book kept back"],
    ["bold with an en dash", "- **Hold** – a book kept back", "Hold", "a book kept back"],
    ["bold with a spaced hyphen", "- **Hold** - a book kept back", "Hold", "a book kept back"],
    ["italic", "- *Hold* — a book kept back", "Hold", "a book kept back"],
    ["underscore bold", "- __Hold:__ a book kept back", "Hold", "a book kept back"],
    ["a numbered list", "1. **Hold:** a book kept back", "Hold", "a book kept back"],
    ["a definition with emphasis and code", "- **Hold:** a *reserved* book, `held=true`", "Hold", "a reserved book, held=true"],
    ["a two-word term", "- **Renewal period:** the weeks added", "Renewal period", "the weeks added"],
  ])("%s", (_name, item, term, definition) => {
    const [r] = read(block(item));
    expect(r?.entries.map((e) => [e.term, e.definition])).toEqual([[term, definition]]);
    expect(r?.findings).toEqual([]);
  });

  test("an item whose emphasis has no separator has no term", () => {
    const [r] = read(block("- **Note** this list is short\n- **Hold** - a book kept back"));
    expect(r?.entries.map((e) => e.term)).toEqual(["Hold"]);
    expect(r?.findings).toEqual([{ level: "info", message: "has an item with no term: «Note this list is short»", at: 0 }]);
  });

  test("a hyphen inside the definition is not the separator", () => {
    const [r] = read(block("- **Hold**: a well-kept book"));
    expect(r?.entries[0]?.definition).toBe("a well-kept book");
  });

  test("an item with no leading emphasis is an info finding naming its text", () => {
    const [r] = read(block("- **Hold:** kept back\n- Renewal is a new loan"));
    expect(r?.entries.map((e) => e.term)).toEqual(["Hold"]);
    expect(r?.findings).toEqual([{ level: "info", message: "has an item with no term: «Renewal is a new loan»", at: 1 }]);
  });

  test("a code-spelled term is listed and not markable", () => {
    const [r] = read(block("- **`--renew`:** the desk's flag"));
    expect(r?.entries[0]).toMatchObject({ term: "--renew", codeSpelled: true });
    expect(isMarkableTerm(r!.entries[0]!)).toBe(false);
  });

  test("a one-letter term is listed and not markable", () => {
    const [r] = read(block("- **A:** the first shelf"));
    expect(isMarkableTerm(r!.entries[0]!)).toBe(false);
  });
});

describe("the paragraph shape", () => {
  test("a sentence's lead span is a term; its definition runs to the next term's sentence, without the term", () => {
    const [r] = read(block("**Words on the page:** A **Hold** is a book kept back. It lasts a week. **Renewal:** two weeks more."));
    expect(r?.entries.map((e) => [e.term, e.definition])).toEqual([
      ["Hold", "is a book kept back. It lasts a week."],
      ["Renewal", "two weeks more."],
    ]);
  });

  test("emphasis past a sentence's lead is definition text, not a term", () => {
    const [r] = read(block("**Hold** is a book *not* returned. It is *never* lent. Then *one* reader waits."));
    expect(r?.entries.map((e) => [e.term, e.definition])).toEqual([["Hold", "is a book not returned. It is never lent. Then one reader waits."]]);
  });

  // A continuation sentence opening with an article-list word then emphasis, and an
  // abbreviation's dot, start no term (fix round 2, R2-1).
  test.each([
    ["Det before emphasis", "**Lån** er en avtale. Det *må* fornyes.", "Lån", "er en avtale. Det må fornyes."],
    ["De before emphasis", "**Lån** er en avtale. De *eldste* lånene purres.", "Lån", "er en avtale. De eldste lånene purres."],
    ["Den before emphasis", "**Lån** er en avtale. Den *skal* leveres.", "Lån", "er en avtale. Den skal leveres."],
    ["A before an adverb", "**Hold** is a state. A *very* long wait follows.", "Hold", "is a state. A very long wait follows."],
    ["e.g.", "**Hold** is a state, e.g. *paused* lending.", "Hold", "is a state, e.g. paused lending."],
    ["f.eks.", "**Lån** er en avtale, f.eks. *pause* i lånet.", "Lån", "er en avtale, f.eks. pause i lånet."],
    ["bl.a.", "**Lån** er en avtale, bl.a. *Renewal* av lånet.", "Lån", "er en avtale, bl.a. Renewal av lånet."],
  ])("%s extends the definition above", (_name, para, term, definition) => {
    const [r] = read(block(para));
    expect(r?.entries.map((e) => [e.term, e.definition])).toEqual([[term, definition]]);
  });

  test.each([
    ["a copula", "A **Hold** is a book kept back.", "Hold", "is a book kept back."],
    ["a Norwegian copula", "Et **Lån** er en avtale.", "Lån", "er en avtale."],
    ["a plural copula", "The *Renewals* are new loans.", "Renewals", "are new loans."],
    ["a colon", "A **Hold**: a book kept back.", "Hold", "a book kept back."],
    ["an em dash", "The *Renewal* — a new loan.", "Renewal", "a new loan."],
  ])("an article-led term followed by %s is a term", (_name, para, term, definition) => {
    const [r] = read(block(para));
    expect(r?.entries.map((e) => [e.term, e.definition])).toEqual([[term, definition]]);
  });

  test("an article-led emphasis followed by any other word is definition text", () => {
    const [r] = read(block("**Hold** is a state. A *Renewal* adds a week."));
    expect(r?.entries.map((e) => [e.term, e.definition])).toEqual([["Hold", "is a state. A Renewal adds a week."]]);
  });

  test("the Norwegian label is not a term", () => {
    const [r] = read(block("**Ord på siden:** Et **Lån** er en avtale om tre uker."));
    expect(r?.entries.map((e) => e.term)).toEqual(["Lån"]);
  });
});

describe("the block", () => {
  test("an empty block warns", () => {
    expect(read(block(""))[0]?.findings).toEqual([{ level: "warning", message: "holds no term; nothing on the page is marked" }]);
  });

  test("a term twice in one block warns at its second item; the first definition wins", () => {
    const [r] = read(block("- **Hold:** first\n- **hold:** second"));
    expect(r?.findings).toEqual([{ level: "warning", message: "defines «hold» twice; the first definition is shown", at: 1 }]);
    expect(glossaryTerms(read(block("- **Hold:** first\n- **hold:** second"))).map((e) => e.definition)).toEqual(["first"]);
  });

  test("a term in two blocks warns in the second", () => {
    const reads = read(block("- **Hold:** first") + "\n" + block("- **Hold:** again"));
    expect(reads.map((r) => r.findings.length)).toEqual([0, 1]);
    expect(glossaryTerms(reads).map((e) => e.definition)).toEqual(["first"]);
  });

  test("a block inside More, Fold and Lane is read", () => {
    for (const [open, close] of [
      ["<More>", "</More>"],
      ['<Fold title="Words">', "</Fold>"],
      ['<NextMoves>\n\n<Lane who="desk">', "</Lane>\n\n</NextMoves>"],
    ]) {
      const md = [open, "", block("- **Hold:** kept back"), close, ""].join("\n");
      expect(glossaryTerms(read(md)).map((e) => e.term)).toEqual(["Hold"]);
    }
  });

  test("a block inside a code fence is not a block", () => {
    expect(read(["```", block("- **Hold:** kept back"), "```", ""].join("\n"))).toEqual([]);
  });
});

describe("the key", () => {
  test.each([
    ["Hold", "hold", false],
    ["LIB", "lIB", true],
    ["Due Date", "due Date", true],
    // A sentence-case capital alone keeps the term case-free.
    ["Hold queue", "hold queue", false],
    ["Soft AND", "soft AND", true],
    // White space runs read as one space.
    ["Due\u00a0 date", "due date", false],
    ["Låneår", "låneår", false],
    // NFD in, NFC out.
    ["Låneår", "låneår", false],
  ])("%s", (term, key, exactCase) => {
    expect(glossaryKey(term)).toEqual({ key, exactCase });
  });
});
