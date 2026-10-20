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
    const page = ["<Glossary>", "", "**Words on the page:** A **Renewal** keeps a book out.", "It lasts a week. A **Renewal**", "adds two weeks.", "", "</Glossary>", ""].join("\n");
    expect(lint(page)).toEqual([[4, "warning", "<Glossary> defines «Renewal» twice; the first definition is shown"]]);
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
