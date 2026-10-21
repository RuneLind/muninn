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

  test("a lifeline sequence numbered after its arrows, or with `1:`, is a sequenceDiagram (fix round 1 batch 2)", () => {
    expect(suggestMermaidKind(["Client            Server", "  │── 1. GET /x ──▶│", "  │◀─ 2. 200 ──────│"])).toBe("sequenceDiagram");
    expect(suggestMermaidKind(["Client            Server", "  │ 1: GET /x ──▶│", "  │◀─ 2: 200 ────│"])).toBe("sequenceDiagram");
    // `1:` at line start is a log line, not a message: it needs a lifeline or stem (fix round 2).
    expect(suggestMermaidKind(["Client            Server", "1: GET /x", "2: 200"])).toBe("flowchart");
    expect(suggestMermaidKind(["Client            Server", "  │── 1. GET /x ──▶│", "  │ ok │"])).toBe("flowchart");
    expect(lint(fence(["Client            Server", "  │── 1. GET /x ──▶│", "  │◀─ 2. 200 ──────│"]))[0]?.[2]).toEndWith("draw it as a mermaid sequenceDiagram");
  });

  test("a chain line with a numbered legend is a flowchart: arrow tokens are not participants (fix round 1 batch 2)", () => {
    expect(suggestMermaidKind(["web   ──▶   api   ──▶   db", "1. web calls api", "2. api reads db"])).toBe("flowchart");
    expect(suggestMermaidKind(["web   -->   api   -->   db", "1. web calls api", "2. api reads db"])).toBe("flowchart");
    expect(suggestMermaidKind(["web   ──HTTP──►   api", "1. web calls api", "2. api reads db"])).toBe("flowchart");
    expect(suggestMermaidKind(["web   ───   api", "1. web calls api", "2. api reads db"])).toBe("flowchart");
    // Box-drawn participant heads are heads, not arrows.
    expect(suggestMermaidKind(["┌─────┐        ┌─────┐", "1. web calls api", "2. api reads db"])).toBe("sequenceDiagram");
    expect(lint(fence(["web   ──▶   api   ──▶   db", "1. web calls api", "2. api reads db"]))[0]?.[2]).toEndWith("draw it as a mermaid flowchart");
  });

  test("`(1)` numbering is a numbered message", () => {
    expect(suggestMermaidKind(["Desk            Shelf", "(1) renew", "(2) commit"])).toBe("sequenceDiagram");
  });

  test("a tree's connector: a dash run alone, or an ASCII arrow alone, is one", () => {
    expect(lint(fence(["Loan", "  ├── book ─── Book#42", "  └── holds"]))).toHaveLength(1);
    expect(lint(fence(["Loan", "  ├── book --> Book#42", "  └── holds"]))).toHaveLength(1);
    expect(lint(fence(["Loan", "  ├── book <-- Book#42", "  └── holds"]))).toHaveLength(1);
    expect(lint(fence(["Loan", "  ├── book", "  └── holds"]))).toEqual([]);
  });

  test("a tree is at least half branch lines", () => {
    // 2 of 4 lines are branches: a tree.
    expect(lint(fence(["library/", "├── catalog/", "└── loans/", "renewals live here"]))).toEqual([]);
    // 1 of 3: under half, so not a tree, and 1 of 3 lines hold a token.
    expect(lint(fence(["library/", "└── loans/", "renewals live here"]))).toHaveLength(1);
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

  test("fences are the reader's: backticks only, longer runs, indented and nested in a component", () => {
    const body = ["catalog ──▶ loans", "loans ──▶ holds"];
    // The reader renders a `~~~` block as prose, so it is no code fence (fix round 1 batch 2).
    expect(lint(fence(body, "~~~", "~~~"))).toEqual([]);
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

  test("a CRLF page is judged like its LF twin: lines, info string and line numbers (fix round 1 batch 2)", () => {
    const crlf = (lines: string[]) => lines.join("\r\n") + "\r\n";
    expect(lint(crlf(["```", "A ──► B", "B ──► C", "```"]))).toEqual([
      [1, "info", "a text drawing in a code fence (2 of 2 lines hold an arrow or box); draw it as a mermaid flowchart"],
    ]);
    // Past the frontmatter, with a `text` info string; a `ts` one is still skipped.
    const page = ["---", "title: Loans", "---", "# Loans", "", "```text", "catalog ──▶ loans", "loans ──▶ holds", "```", "", "```ts", "a ──▶ b", "b ──▶ c", "```"];
    expect(lint(crlf(page))).toEqual(lint(page.join("\n")));
    expect(lint(crlf(page))).toEqual([[6, "info", "a text drawing in a code fence (2 of 2 lines hold an arrow or box); draw it as a mermaid flowchart"]]);
    // A closer with a trailing CR closes; an unclosed CRLF opener stays prose.
    expect(lint(crlf(["```", "A ──► B", "B ──► C"]))).toEqual([]);
  });

  test("two fences back to back are two fences (fix round 1 batch 2)", () => {
    const page = [fence(["catalog ──▶ loans", "loans ──▶ holds"]), fence(["const a = 1;", "const b = 2;"]), fence(["holds → shelf", "shelf → desk"])].join("\n");
    expect(lint(page).map((f) => f[0])).toEqual([1, 9]);
  });

  test("an HTML comment closer and a glued n-->0 are not ASCII arrows (fix round 1)", () => {
    expect(lint(fence(["<!-- research:loans -->", "<!-- wiki:begin -->", "text", "<!-- wiki:end -->"]))).toEqual([]);
    expect(lint(fence(["<div>", "<!-- keep this -->", "</div>"]))).toEqual([]);
    expect(lint(fence(["while (n-->0) {", "  sum += n;", "}"]))).toEqual([]);
    for (const line of ["<!-- x -->", "while (n-->0) {", "x-->y"]) expect([line, holdsDiagramToken(line)]).toEqual([line, false]);
    for (const line of ["A --> B", "web --> api --> db", "│ --> │", "A-->", "-->B", "(A)-->(B)", "<!-- x --> then A --> B"]) {
      expect([line, holdsDiagramToken(line)]).toEqual([line, true]);
    }
    expect(lint(fence(["catalog --> loans", "loans --> holds"]))).toHaveLength(1);
  });

  test("rule lines alone do not make a drawing; beside another token line they count (fix round 1)", () => {
    expect(lint(fence(["Results", "───────", "pass 12"]))).toEqual([]);
    expect(lint(fence(["Name      Status", "────────  ──────", "foo       ok"]))).toEqual([]);
    expect(lint(fence(["Totals", "═══════", "━━━━━━━", "loans 4"]))).toEqual([]);
    for (const line of ["┌──┐", "──▶", "├── loans", "──→", "loans ─── holds", "── │"]) expect([line, holdsDiagramToken(line)]).toEqual([line, true]);
    // A box edge is no rule line, and a rule line beside an arrow counts: 2 of 6.
    expect(lint(fence(["┌──────┐", "│ desk │", "└──────┘"]))).toHaveLength(1);
    expect(lint(fence(["Desk", "────", "renew", "holds", "fines", "desk → shelf"]))).toHaveLength(1);
  });

  test("each fence is judged on its own", () => {
    const page = [fence(["catalog ──▶ loans", "loans ──▶ holds"]), "", fence(["const a = 1;", "const b = 2;"]), "", fence(["holds → shelf", "shelf → desk"])].join("\n");
    expect(lint(page).map((f) => f[0])).toEqual([1, 11]);
  });

  test("a spaced C goes-to `n --> 0)` is code; a --> between nodes stays a token (fix round 2)", () => {
    expect(lint(fence(["while (n --> 0) {", "  sum += n;", "}"]))).toEqual([]);
    for (const line of ["while (n --> 0) {", "while (n -->0) {", "while (n --> 0 ) {", "if (left --> 10) {", "while (n--> 0) {", "while (n -->10) {"]) expect([line, holdsDiagramToken(line)]).toEqual([line, false]);
    for (const line of ["A --> B", "web --> api --> db", "│ --> │", "(A)-->(B)", "Raw sources  ──>  Wiki  ──>  Schema", "step --> 2. emit", "step --> 2 then", "step -->2 then", "step--> 2 then", "(A) --> (1)"]) {
      expect([line, holdsDiagramToken(line)]).toEqual([line, true]);
    }
  });

  test("a first-line head is a participant only when it names something; any other head makes a chain (fix round 2)", () => {
    const legend = ["1. web calls api", "2. api reads db"];
    for (const first of ["web   ──>   api   ──>   db", "web   ->   api   ->   db", "web   =>   api", "web   <──   api", "web   ↓   api", "web   ──HTTP──►   api"]) {
      expect([first, suggestMermaidKind([first, ...legend])]).toEqual([first, "flowchart"]);
    }
    // Names (letters or digits only) and box edges are participants.
    for (const first of ["web   api", "10.0.0.1   10.0.0.2", "┌─────┐        ┌─────┐", "╔═════╗        ╔═════╗", "┌─ desk ─┐     ┌─ shelf ─┐"]) {
      expect([first, suggestMermaidKind([first, ...legend])]).toEqual([first, "sequenceDiagram"]);
    }
    // Half a box edge is no edge.
    expect(suggestMermaidKind(["┌─────        ┌─────", ...legend])).toBe("flowchart");
    expect(suggestMermaidKind(["─────┐        ─────┐", ...legend])).toBe("flowchart");
  });

  test("a numbered message follows a lifeline or a stem, or opens the line; a single markdown marker is prose (fix round 2)", () => {
    const heads = "Client            Server";
    for (const numbered of ["  │── 1. GET /x", "|-- 1. GET", "<-- 2. 200", "━━ 3. retry", "▶ 4. done", "  │ 1: GET /x", "|| 5) ack", ">> 6. ack", "1. GET", "   2) 200", "(3) retry", "④ done", "│ (3) retry", "│ ④ done", "┃ 7. x", "─ 8. x", "◀ 9. x", "► 10. x", "◄ 11. x"]) {
      expect([numbered, suggestMermaidKind([heads, numbered, numbered])]).toEqual([numbered, "sequenceDiagram"]);
    }
    for (const prose of ["- 1. parse", "> 1) parse", "-1. drop", "10: start", "| 1. row", "< 1. x", "  - 2. emit", "1.5 GB", "│ ok │"]) {
      expect([prose, suggestMermaidKind([heads, prose, prose])]).toEqual([prose, "flowchart"]);
    }
  });

  test("a long dash run that is no numbered line is judged in linear time (fix round 2)", () => {
    const t = performance.now();
    expect(suggestMermaidKind(["Client            Server", `${"-".repeat(60)}x`, `${"<>".repeat(30)}x`])).toBe("flowchart");
    expect(performance.now() - t).toBeLessThan(500);
  });
});
