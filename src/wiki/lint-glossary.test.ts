import { describe, expect, test } from "bun:test";
import { checkPageText } from "./lint.ts";

// Invented pages only: a lending library.

const lint = (md: string, relPath = "plans/g.mdx") =>
  checkPageText({ relPath }, md, [])
    .filter((f) => f.check === "glossary")
    .map((f) => [f.line, f.severity ?? "warning", f.message]);

describe("lint check 19 — glossary", () => {
  test("each finding names its item, on the item's own line, past the frontmatter", () => {
    const page = [
      "---",
      "title: G",
      "---",
      "A Hold keeps the book.",
      "",
      "<Glossary>",
      "",
      "- **Hold:** a book kept back",
      "- **Renewal:** a new loan",
      "- plain item with no term",
      "- **Hold:** a book kept back",
      "",
      "</Glossary>",
      "",
      "<More>",
      "",
      "<Glossary>",
      "",
      "- **Renewal:** again",
      "",
      "</Glossary>",
      "",
      "</More>",
      "",
      "<Glossary>",
      "",
      "</Glossary>",
      "",
    ].join("\n");
    expect(lint(page)).toEqual([
      [10, "info", "<Glossary> has an item with no term: «plain item with no term»"],
      // The repeated item is identical to the first: it still lands on its own line.
      [11, "warning", "<Glossary> defines «Hold» twice; the first definition is shown"],
      [19, "warning", "<Glossary> defines «Renewal» twice; the first definition is shown"],
      [25, "warning", "<Glossary> holds no term; nothing on the page is marked"],
    ]);
  });

  test("a paragraph term is found on the line its sentence starts, wrapped or not", () => {
    const page = ["<Glossary>", "", "**Words on the page:** A **Renewal** is a new loan.", "It lasts a week. A **Renewal**", "is two weeks more.", "", "</Glossary>", ""].join("\n");
    expect(lint(page)).toEqual([[4, "warning", "<Glossary> defines «Renewal» twice; the first definition is shown"]]);
    const twice = "<Glossary> defines «Hold» twice; the first definition is shown";
    // Unwrapped: the repeat shares line 3 with the first sentence.
    expect(lint(["<Glossary>", "", "A **Hold** keeps a book. A **Hold** is two weeks more.", "", "</Glossary>", ""].join("\n"))).toEqual([[3, "warning", twice]]);
    // A short sentence head that ends its line: the probe reads across the break.
    expect(lint(["<Glossary>", "", "A **Hold** keeps a book.", "It lasts a week. A **Hold**", "is two weeks more.", "", "</Glossary>", ""].join("\n"))).toEqual([[4, "warning", twice]]);
    expect(lint(["<Glossary>", "", "A **Hold** keeps a book. A **Hold**", "is two weeks more.", "", "</Glossary>", ""].join("\n"))).toEqual([[3, "warning", twice]]);
    expect(lint(["<Glossary>", "", "A **Hold** keeps a book.", "", "A", "**Hold** is two weeks more.", "", "</Glossary>", ""].join("\n"))).toEqual([[5, "warning", twice]]);
    // A paragraph that ends in the head's first word is not the sentence.
    expect(lint(["<Glossary>", "", "A **Hold** keeps a book. It is plan A", "", "A **Hold** is two weeks more.", "", "</Glossary>", ""].join("\n"))).toEqual([[5, "warning", twice]]);
  });

  test("a list item's term is found on its own line, wrapped or not", () => {
    const twice = "<Glossary> defines «Hold» twice; the first definition is shown";
    expect(lint(["<Glossary>", "", "- **Hold:** a book", "- **Hold:**", "  kept back", "", "</Glossary>", ""].join("\n"))).toEqual([[4, "warning", twice]]);
    expect(lint(["<Glossary>", "", "- **Hold:** a book", "- **Hold:** kept back", "", "</Glossary>", ""].join("\n"))).toEqual([[4, "warning", twice]]);
  });

  test("a term the page never uses raises no finding: whether a term is used is the reader's call", () => {
    expect(lint(["A loan lasts a week.", "", "<Glossary>", "", "- **Hold:** a book kept back", "- **Renewal:** a new loan", "", "</Glossary>", ""].join("\n"))).toEqual([]);
  });

  test("a fenced block, a .md page and a page with none report nothing", () => {
    expect(lint(["```", "<Glossary>", "", "</Glossary>", "```", ""].join("\n"))).toEqual([]);
    expect(lint(["<Glossary>", "", "</Glossary>", ""].join("\n"), "plans/g.md")).toEqual([]);
    expect(lint("A Hold.\n")).toEqual([]);
  });
});
