import { describe, expect, test } from "bun:test";
import { checkPageText, LINT_CHECKS, PAGE_TEXT_LINT_CHECKS } from "./lint.ts";
import { holdsDiagramToken, suggestMermaidKind, TEXT_DIAGRAM_MIN_LINES, TEXT_DIAGRAM_MIN_SHARE } from "./lint-text-diagram.ts";

// Invented pages only: a lending library's services.

const lint = (md: string, relPath = "flows/loans.md", extra: { culled?: boolean } = {}) =>
  checkPageText({ relPath, ...extra }, md, [])
    .filter((f) => f.check === "text-diagram")
    .map((f) => [f.line, f.severity, f.message]);

const fence = (body: string[], open = "```", close = open) => [open, ...body, close].join("\n");

/** The sed-a008 shape, invented: a chain of names, then a line of port numbers only. */
const CHAIN_OVER_PORTS = ["catalog-web  ──▶  loans-api  ──▶  holds-api  ──▶  shelf-db", "   :3000         :8080        :8081         :5432"];

describe("lint check 20 — text-diagram", () => {
  test("the kind is registered and runs with the page-text checks", () => {
    expect(LINT_CHECKS).toContain("text-diagram");
    expect(PAGE_TEXT_LINT_CHECKS).toContain("text-diagram");
  });

  test("a chain over a line of port numbers is flagged, on the opener's line, past the frontmatter", () => {
    const page = ["---", "title: Loans", "---", "# Loans", "", fence(CHAIN_OVER_PORTS), ""].join("\n");
    expect(lint(page)).toEqual([[6, "info", "a text drawing in a code fence (1 of 2 lines hold an arrow or box); draw it as a mermaid flowchart"]]);
  });

  test("a fence inside the frontmatter is not judged", () => {
    const page = ["---", "title: Loans", "notes: |", "  ```", "  catalog ──▶ loans", "  loans ──▶ holds", "  ```", "---", "# Loans", ""].join("\n");
    expect(lint(page)).toEqual([]);
  });

  test("the per-line rule: at least N non-blank lines, at least X of them with a token", () => {
    expect(TEXT_DIAGRAM_MIN_LINES).toBe(2);
    expect(TEXT_DIAGRAM_MIN_SHARE).toBe(1 / 3);
    // One line is under N, however much it draws.
    expect(lint(fence(["catalog → loans → holds"]))).toEqual([]);
    // Blank lines do not count toward N.
    expect(lint(fence(["catalog → loans → holds", "", "   "]))).toEqual([]);
    // 1 of 3 is exactly the share: flagged.
    expect(lint(fence(["catalog → loans", "renews a loan", "returns a book"]))).toHaveLength(1);
    // 1 of 4 is under it: a menu mock with one note arrow.
    expect(lint(fence(["Loans                [↻]", "  ● Renewals   ok", "  ● Holds      ok", "  ● Fines      down    ← red row"]))).toEqual([]);
  });

  test("only a fence with no language, or text, is judged", () => {
    const body = ["catalog ──▶ loans", "loans ──▶ holds"];
    expect(lint(fence(body))).toHaveLength(1);
    expect(lint(fence(body, "```text", "```"))).toHaveLength(1);
    expect(lint(fence(body, "``` TEXT", "```"))).toHaveLength(1);
    expect(lint(fence(body, "```ts", "```"))).toEqual([]);
    expect(lint(fence(body, "```mermaid", "```"))).toEqual([]);
    expect(lint(fence(body, "```txt", "```"))).toEqual([]);
  });

  test("a token: box and pointer characters, ASCII --> and <--, an arrow not glued between words", () => {
    for (const line of ["│", "└── loans", "──▶", "A ► B", "▼", "catalog --> loans", "loans <-- holds", "A → B", "A →B", "→ renew", "fines ←"]) {
      expect([line, holdsDiagramToken(line)]).toEqual([line, true]);
    }
    for (const line of ["red→green", "1→2", "a -> b", "plain prose", "loans - holds"]) {
      expect([line, holdsDiagramToken(line)]).toEqual([line, false]);
    }
    // A verify-pass log line is prose, not a drawing.
    expect(lint(fence(["verify pass (round 2): 1 finding — red→green 4/4 — fixed", "verify pass skipped: comments only"]))).toEqual([]);
  });

  test("a file tree, or a node tree with notes, is not a drawing; a tree with a connector is", () => {
    const tree = ["library/", "├── catalog/", "│   ├── books.md", "│   └── authors.md", "└── loans/        ← renewals live here"];
    expect(lint(fence(tree))).toEqual([]);
    const withConnector = ["Loan", "  ├── book → Book#42  ◀── same row", "  └── holds[*]", "       └── book → Book#42  ◀── same row"];
    expect(lint(fence(withConnector))).toHaveLength(1);
    const chainUnderTree = ["Front desk (library)", "  └─ loans tool     ──HTTP──►  loans-api (port 9180)", "  └─ holds tool     ──HTTP──►  holds-api"];
    expect(lint(fence(chainUnderTree))).toHaveLength(1);
  });

  test("a box table is not a drawing", () => {
    const table = ["┌────────┬───────┐", "│ book   │ loans │", "├────────┼───────┤", "│ Dune   │ 3     │", "└────────┴───────┘"];
    expect(lint(fence(table))).toEqual([]);
    // The same joints with a pointer between boxes are a drawing.
    const drawing = ["┌────────┬───────┐", "│ catalog│ loans │", "└────┬───┴───────┘", "     ▼", "  holds-api"];
    expect(lint(fence(drawing))).toHaveLength(1);
  });

  test("sequenceDiagram for participants on the first line and numbered messages, else flowchart", () => {
    const sequence = [
      "Desk (renew)                          Shelf job (nightly sweep)",
      "──────────────                        ──────────────────────────",
      "1. Load loan (open)",
      "                                      2. Load same loan (still open)",
      "                                      3. Mark overdue; commit",
      "4. Commit → stale state wins",
    ];
    expect(suggestMermaidKind(sequence)).toBe("sequenceDiagram");
    expect(lint(fence(sequence))[0]?.[2]).toEndWith("draw it as a mermaid sequenceDiagram");
    // Participants but no numbers, and numbers but one participant, are flowcharts.
    expect(suggestMermaidKind(["Desk                 loans-api", "  ├─ POST /renew ──► commit"])).toBe("flowchart");
    expect(suggestMermaidKind(["loans pipeline", "1. harvest → cluster", "2. cluster → draft"])).toBe("flowchart");
  });

  test("archive/ and plans/ are skipped as a path prefix only", () => {
    const page = fence(CHAIN_OVER_PORTS);
    expect(lint(page, "archive/x/y.md")).toEqual([]);
    expect(lint(page, "plans/z.mdx")).toEqual([]);
    expect(lint(page, "projects/plans-foo.md")).toHaveLength(1);
    expect(lint(page, "projects/archive/notes.md")).toHaveLength(1);
    expect(lint(page, "archived/notes.md")).toHaveLength(1);
  });

  test("reserved and culled pages are skipped", () => {
    const page = fence(CHAIN_OVER_PORTS);
    expect(lint(page, "index.md")).toEqual([]);
    expect(lint(page, "flows/log.md")).toEqual([]);
    expect(lint(page, "flows/loans.md", { culled: true })).toEqual([]);
  });

  test("fences: tildes, longer runs, indented and nested in a component behave like the other lints", () => {
    const body = ["catalog ──▶ loans", "loans ──▶ holds"];
    expect(lint(fence(body, "~~~", "~~~"))).toHaveLength(1);
    // A four-backtick fence holding a three-backtick line is one fence.
    expect(lint(["````", "```", ...body, "```", "````"].join("\n"))).toEqual([
      [1, "info", "a text drawing in a code fence (2 of 4 lines hold an arrow or box); draw it as a mermaid flowchart"],
    ]);
    // Up to three spaces of indent opens a fence; four is indented code, never a fence.
    expect(lint(fence(body.map((l) => `   ${l}`), "   ```", "   ```"))).toHaveLength(1);
    expect(lint(fence(body.map((l) => `    ${l}`), "    ```", "    ```"))).toEqual([]);
    // Inside an MDX component.
    expect(lint(["<Callout tone=\"info\">", "", fence(body), "", "</Callout>"].join("\n"))).toEqual([
      [3, "info", "a text drawing in a code fence (2 of 2 lines hold an arrow or box); draw it as a mermaid flowchart"],
    ]);
    // An opener with no closer is prose, as the reader shows it.
    expect(lint(["```", ...body].join("\n"))).toEqual([]);
  });

  test("each fence is judged on its own", () => {
    const page = [fence(["catalog ──▶ loans", "loans ──▶ holds"]), "", fence(["const a = 1;", "const b = 2;"]), "", fence(["holds → shelf", "shelf → desk"])].join("\n");
    expect(lint(page).map((f) => f[0])).toEqual([1, 11]);
  });
});
