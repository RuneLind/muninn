import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import path from "node:path";
import { formatWebHtml } from "../web/web-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { CHAIN_VIEW_MIN, STATE_LOOKS, STRIP_VIEW_MIN, viewSlot } from "./decision-views.ts";
import { decisionViewsCss } from "./component-styles.ts";
import { DC_VIEW_CLASS, READER_ONLY_ATTR } from "./reader-lens.ts";
import { PEEK_SKIP, PEEK_STRIP_SELECTOR } from "../dashboard/views/components/wiki-ref-links.ts";

// A synthetic plan page in the real pages' shape: a NextMoves brief, a
// DecisionLog with three closed questions, and a five-row PR ledger.

const NEXT = ["<NextMoves>", "", '<Lane kind="you">', "", "1. Run it.", "", "</Lane>", "", "</NextMoves>", ""].join("\n");
const STATUS = ["<StatusRows>", "", "- **Status:** in flight.", "", "</StatusRows>", ""].join("\n");
const LOG = [
  "<DecisionLog>",
  "",
  "- **O1** — Which store? Closed 2026-10-01 (D1).",
  "- **O2** — Which shape? Closed 2026-10-02 (D2).",
  "- **O3** — Which key? Closed 2026-10-03 (D3).",
  "- **D1** — Use the flat file.",
  "- **D2** — ~~Rows per item.~~ Reversed, superseded by D3.",
  "- **D3** — One row per group.",
  "",
  "</DecisionLog>",
  "",
].join("\n");
const LEDGER = [
  "**PR ledger.**",
  "",
  "| PR | State | Decisions |",
  "|---|---|---|",
  "| 1 — store | merged [#11](https://example.test/pull/11) | D1 |",
  "| 2 — rows | dropped | D2 |",
  "| 3 — groups | open | D3 |",
  "| 4 — docs | planned | D3 |",
  "",
].join("\n");
const PAGE = ["# Plan", "", NEXT, "## Decisions", "", LOG, LEDGER].join("\n");

describe("formatWebHtml views gate", () => {
  test("views absent or false ⇒ no view HTML, byte-identical output", () => {
    const plain = formatWebHtml(PAGE, { reader: true });
    expect(plain).not.toContain(DC_VIEW_CLASS);
    expect(formatWebHtml(PAGE, { reader: true, views: false })).toBe(plain);
    expect(formatWebHtml(PAGE)).not.toContain(DC_VIEW_CLASS);
  });

  test("views: true ⇒ the chain view then the strip, right after NextMoves, reader-only", () => {
    const html = formatWebHtml(PAGE, { reader: true, views: true });
    const chain = html.indexOf(`class="${DC_VIEW_CLASS} dc-chain" ${READER_ONLY_ATTR}`);
    const strip = html.indexOf(`class="${DC_VIEW_CLASS} dc-strip" ${READER_ONLY_ATTR}`);
    expect(chain).toBeGreaterThan(html.indexOf("Run it."));
    expect(strip).toBeGreaterThan(chain);
    expect(html.indexOf(">Decisions<")).toBeGreaterThan(strip);
    // The rest of the page renders exactly as without views.
    const without = formatWebHtml(PAGE, { reader: true });
    const viewStart = html.indexOf("<section", chain - 20);
    const viewEnd = html.indexOf("</section>", strip) + "</section>".length;
    expect((html.slice(0, viewStart) + html.slice(viewEnd)).replace(/\n+/g, "\n")).toBe(without.replace(/\n+/g, "\n"));
  });

  test("newest chain first, the reversal struck with «Snudd» in Norwegian", () => {
    const html = formatWebHtml(PAGE, { reader: true, views: true, language: "no" });
    const rows = [...html.matchAll(/<div class="dc-row[^"]*">[\s\S]*?<summary>(D\d+)<\/summary>/g)].map((m) => m[1]);
    expect(rows).toEqual(["D3", "D2", "D1"]);
    expect(html).toContain('<details class="dc-node dc-d dc-struck" name="dc-chain"><summary>D2</summary><div class="dc-pop"><s>Rows per item.</s>');
    expect(html).toContain('<span class="dc-snudd">Snudd</span>');
    expect(html).toContain("Beslutningskjede");
  });

  test("a node's go-to link lands on the DecisionLog item's anchor", () => {
    const html = formatWebHtml(PAGE, { reader: true, views: true });
    for (const m of html.matchAll(/<a class="dc-go" href="#([^"]+)" data-dc-ref="([^"]+)">/g)) {
      expect(`${m[2]} → ${html.includes(`id="${m[1]}"`)}`).toBe(`${m[2]} → true`);
    }
  });

  test("the strip groups squares by the decision each row cites, with state classes", () => {
    const html = formatWebHtml(PAGE, { reader: true, views: true });
    const strip = html.slice(html.indexOf("dc-strip"));
    const phases = [...strip.matchAll(/<div class="dc-phase"><div class="dc-ph">[\s\S]*?>(D\d+)<\/a><\/div><div class="dc-prs">([\s\S]*?)<\/div><\/div>/g)].map(
      (m) => `${m[1]}: ${[...m[2]!.matchAll(/dc-s-([a-z-]+)"[^>]*>(\d+)</g)].map((x) => `${x[2]}=${x[1]}`).join(" ")}`,
    );
    expect(phases).toEqual(["D1: 1=merged", "D2: 2=dropped", "D3: 3=open 4=planned"]);
  });

  test("O2 floors: fewer than 3 chains or 4 strip rows ⇒ that view is absent", () => {
    expect(CHAIN_VIEW_MIN).toBe(3);
    expect(STRIP_VIEW_MIN).toBe(4);
    const twoChains = PAGE.replace("- **O3** — Which key? Closed 2026-10-03 (D3).\n", "").replace("| 3 — groups | open | D3 |\n| 4 — docs | planned | D3 |\n", "");
    const html = formatWebHtml(twoChains, { reader: true, views: true });
    expect(html).not.toContain(DC_VIEW_CLASS);
  });

  test("a ledger with no state column draws no strip", () => {
    const html = formatWebHtml(PAGE.replace("| PR | State | Decisions |", "| PR | Result | Decisions |"), { reader: true, views: true });
    expect(html).toContain("dc-chain");
    expect(html).not.toContain("dc-strip");
  });

  test("placement: after StatusRows with no NextMoves; nowhere with neither", () => {
    const withStatus = formatWebHtml(PAGE.replace(NEXT, STATUS), { reader: true, views: true });
    expect(withStatus.indexOf("dc-chain")).toBeGreaterThan(withStatus.indexOf("in flight."));
    expect(formatWebHtml(PAGE.replace(NEXT, ""), { reader: true, views: true })).not.toContain(DC_VIEW_CLASS);
    expect(viewSlot(parseBlocks(PAGE.replace(NEXT, "")))).toBe(-1);
  });
});

describe("renderWikiHtml passes views through", () => {
  const resolve = () => undefined;
  test("only with views: true", () => {
    expect(renderWikiHtml(PAGE, resolve)).not.toContain(DC_VIEW_CLASS);
    expect(renderWikiHtml(PAGE, resolve, { views: true })).toContain(DC_VIEW_CLASS);
  });

  test("the glance slate draws only when the caller says the plan is proposed", () => {
    const glance = ["### At a glance", "", "| PR | What |", "|---|---|", "| 1 | a |", "| 2 | b |", "| 3 | c |", "| 4 | d |", ""].join("\n");
    const page = (status: string) => ["---", `plan_status: ${status}`, "---", "# Plan", "", NEXT, glance].join("\n");
    expect(renderWikiHtml(page("proposed"), resolve, { views: true, proposedPlan: true })).toContain("dc-strip");
    expect(renderWikiHtml(page("shipped"), resolve, { views: true })).not.toContain(DC_VIEW_CLASS);
    // F12: the route reads `plan_status` off the index (comment-stripped); the
    // renderer no longer re-reads the frontmatter for it.
    expect(renderWikiHtml(page("shipped"), resolve, { views: true, proposedPlan: true })).toContain("dc-strip");
    expect(renderWikiHtml(page("proposed"), resolve, { views: true })).not.toContain(DC_VIEW_CLASS);
  });
});

// Fix round 1, batch 4 (F10): with no `decisionText`, the views read each
// wikilink sentinel as its `wikiLinkTexts` text, so an edge inside a label counts.
describe("F10: the views read a sentinel as its link text", () => {
  test("a PR named inside a link label is an edge", () => {
    const log = LOG.replace("- **D1** — Use the flat file.", "- **D1** — Use the \x00WIKIPAGELINK0\x00 shape.");
    const html = formatWebHtml(["# Plan", "", NEXT, log].join("\n"), { reader: true, views: true, wikiLinkTexts: ["PR 7 plan"] });
    expect([...html.matchAll(/<span class="dc-out [^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(["PR 7"]);
  });
});

// Fix round 1, batch 4 (F11). Synthetic rows only.
describe("F11: tooltips and accessible names are plain text and carry the state", () => {
  const ledger = [
    "**PR ledger.**",
    "",
    "| PR | State | Decisions |",
    "|---|---|---|",
    "| 1 — A — api [#11](https://example.test/pull/11) | merged | D1 |",
    "| 2 — **rows** and `code` | dropped | D2 |",
    "| 3 — [[plans/foo|the store]] | open | D3 |",
    "| 4 — _docs_ | planned | D3 |",
    "",
  ].join("\n");
  const html = renderWikiHtml(["# Plan", "", NEXT, LOG, ledger].join("\n"), () => undefined, { views: true });

  test("a strip square's title and aria-label read links as their text and drop markers", () => {
    const squares = [...html.matchAll(/<span class="dc-pr [^"]*" role="img" title="([^"]*)" aria-label="([^"]*)">/g)];
    expect(squares.map((m) => m[1])).toEqual([
      "PR 1 · merged · A — api #11",
      "PR 2 · dropped · rows and code",
      "PR 3 · open · the store",
      "PR 4 · planned · docs",
    ]);
    expect(squares.map((m) => m[2])).toEqual(squares.map((m) => m[1]));
  });

  test("a chain output names its state in its accessible name, not by colour alone", () => {
    const outs = [...html.matchAll(/<span class="dc-out [^"]*"([^>]*)>([^<]*)<\/span>/g)].map((m) => `${m[2]}|${m[1]!.match(/aria-label="([^"]*)"/)?.[1]}|${/role="img"/.test(m[1]!)}`);
    expect(outs).toEqual(["PR 3|PR 3 · open|true", "PR 4|PR 4 · planned|true", "PR 2|PR 2 · dropped|true", "PR 1|PR 1 · merged|true"]);
  });
});

describe("the chat path never asks for views", () => {
  test("no formatWebHtml call under src/chat passes a views option", async () => {
    const root = path.join(import.meta.dir, "..", "chat");
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan(root)) {
      if (rel.endsWith(".test.ts")) continue;
      const src = await Bun.file(path.join(root, rel)).text();
      if (/formatWebHtml\([^)]*views/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("peeks never show a view", () => {
  test("a peek copy strips the view class and skips a view sibling", () => {
    expect(PEEK_STRIP_SELECTOR.split(", ")).toContain(`.${DC_VIEW_CLASS}`);
    expect(PEEK_SKIP.split(", ")).toContain(`.${DC_VIEW_CLASS}`);
    const html = formatWebHtml(PAGE, { reader: true, views: true });
    for (const m of html.matchAll(/<section class="([^"]*)" data-reader-only/g)) expect(m[1]!.split(" ")).toContain(DC_VIEW_CLASS);
  });
});

// Fix round 1, batch 2. Synthetic rows only.
/** The strip's groups as `head: pr=state …`; a linked head is `→D8`. */
function stripGroups(html: string): string[] {
  const strip = html.slice(html.indexOf("dc-strip"));
  return [...strip.matchAll(/<div class="dc-phase"><div class="dc-ph">([\s\S]*?)<\/div><div class="dc-prs">([\s\S]*?)<\/div><\/div>/g)].map((m) => {
    const head = m[1]!.startsWith("<a") ? `→${m[1]!.replace(/<[^>]+>/g, "")}` : m[1]!;
    return `${head}: ${[...m[2]!.matchAll(/dc-s-([a-z-]+)"[^>]*>(\d+)</g)].map((x) => `${x[2]}=${x[1]}`).join(" ")}`;
  });
}

describe("F5: the strip draws a PR repeated across ledgers once, the first row winning", () => {
  test("ledgers {1,2,3,4} and {1,2} draw four squares", () => {
    const second = ["**PR ledger (old).**", "", "| PR | State | Decisions |", "|---|---|---|", "| 1 — store | dropped | D1 |", "| 2 — rows | merged [#12](https://example.test/pull/12) | D2 |", ""].join("\n");
    const page = PAGE + second;
    const html = formatWebHtml(page, { reader: true, views: true });
    expect(stripGroups(html)).toEqual(["→D1: 1=merged", "→D2: 2=dropped", "→D3: 3=open 4=planned"]);
  });
});

describe("F6: the strip groups as the chain does; an absent decision is plain text", () => {
  const log = [
    "<DecisionLog>",
    "",
    "- **D8** — Ship the reader first in PR 7.",
    "- **D10** — Then the writer in PR 9.",
    "",
    "</DecisionLog>",
    "",
  ].join("\n");
  const ledger = (rows: string[]) => ["**PR ledger.**", "", "| PR | State |", "|---|---|", ...rows, ""].join("\n");
  const rows = ["| 7 — reader | merged |", "| 9 — writer | open |", "| 11 — docs | planned |", "| 12 — tidy | planned |"];

  test("a row citing no decision sits under the decision whose prose names its PR", () => {
    const html = formatWebHtml(["# Plan", "", NEXT, log, ledger(rows)].join("\n"), { reader: true, views: true });
    expect(stripGroups(html)).toEqual(["→D8: 7=merged", "→D10: 9=open", "No decision: 11=planned 12=planned"]);
  });

  test("a row citing a decision the log lacks gets its id as plain text, no link", () => {
    const withD99 = rows.map((r) => (r.startsWith("| 11") ? "| 11 — docs | planned — per D99 |" : r));
    const html = formatWebHtml(["# Plan", "", NEXT, log, ledger(withD99)].join("\n"), { reader: true, views: true });
    expect(stripGroups(html)).toContain("D99: 11=planned");
    expect(html).not.toContain('data-dc-ref="D99"');
    // Every go-to link in the views lands on an anchor the page has.
    for (const m of html.matchAll(/<a class="dc-go" href="#([^"]+)" data-dc-ref="([^"]+)">/g)) {
      expect(`${m[2]} → ${html.includes(`id="${m[1]}"`)}`).toBe(`${m[2]} → true`);
    }
  });
});

// Fix round 1, batch 5 (F13–F15). Synthetic rows only; the layout itself is
// measured in a browser by e2e/wiki-decision-views.spec.ts.
describe("F13/F14: chain rows sit on one shared grid and read as a unit when narrow", () => {
  const css = decisionViewsCss(".s");
  /** The declarations of the first rule whose selector is exactly `sel`. */
  const rule = (sel: string, from = css) => from.match(new RegExp(`\\${sel.replace(/ /g, "\\s+")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  test("a row leaves out the cells it has nothing for: no empty question cell or arrow", () => {
    const log = ["<DecisionLog>", "", "- **O1** — Which? Closed 2026-10-01 (D1).", "- **D1** — One in PR 3.", "- **D2** — ~~Two.~~ Reversed.", "- **D3** — Ship the reader in PR 7.", "", "</DecisionLog>", ""].join("\n");
    const html = formatWebHtml(["# Plan", "", NEXT, "## Decisions", "", log].join("\n"), { reader: true, views: true });
    expect(html.match(/<div class="dc-row[ "]/g)?.length).toBe(3);
    expect(html).not.toMatch(/<span class="dc-arrow[^"]*" aria-hidden="true"><\/span>/);
    expect(html).not.toContain('<span class="dc-qs"></span>');
    expect(html).not.toContain('<span class="dc-outs"></span>');
    // D3: no question ⇒ the row opens on its decision; D2: neither questions
    // nor outputs ⇒ the decision cell alone.
    expect(html).toContain('<div class="dc-row"><span class="dc-dec"><details class="dc-node dc-d" name="dc-chain"><summary>D3</summary>');
    expect(html).toMatch(/<div class="dc-row dc-reversed"><span class="dc-dec">[\s\S]*?<span class="dc-snudd">Reversed<\/span><\/span><\/div>/);
  });

  test("rows are subgrids of one grid and each cell has a fixed column", () => {
    expect(rule(".s .dc-row")).toMatch(/grid-template-columns:\s*subgrid/);
    expect(rule(".s .dc-rows")).toMatch(/display:\s*grid/);
    expect(rule(".s .dc-rows")).toMatch(/grid-template-columns:/);
    expect([".s .dc-qs", ".s .dc-a-q", ".s .dc-dec", ".s .dc-a-out", ".s .dc-outs"].map((s) => rule(s).match(/grid-column:\s*(\d)/)?.[1])).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("the popover sits in a band its own row reserves, so it covers no other row", () => {
    expect(rule(".s .dc-pop")).toMatch(/position:\s*absolute/);
    expect(rule(".s .dc-pop")).toMatch(/bottom:\s*0/);
    expect(rule(".s .dc-pop")).toMatch(/(?<![-\w])height:\s*var\(--dc-pop-h\)/);
    // A long label scrolls inside the band rather than spilling over the next row.
    expect(rule(".s .dc-pop")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".s .dc-row")).toMatch(/position:\s*relative/);
    expect(rule(".s .dc-node")).not.toMatch(/position:/);
    expect(css).toMatch(/\.s \.dc-row:has\(\.dc-node\[open\]\)\s*\{[^}]*padding-bottom:\s*calc\(var\(--dc-pop-h\)/);
  });

  test("one node opens at a time: every node shares one exclusive details name", () => {
    const html = formatWebHtml(PAGE, { reader: true, views: true });
    const names = [...html.matchAll(/<details class="dc-node[^"]*"([^>]*)>/g)].map((m) => m[1]!.match(/name="([^"]*)"/)?.[1]);
    expect(names.length).toBeGreaterThan(3);
    expect(new Set(names)).toEqual(new Set(["dc-chain"]));
  });

  test("the questions and decision columns are capped, so one long row moves no other", () => {
    const cols = rule(".s .dc-rows").match(/grid-template-columns:\s*([^;]*);/)?.[1] ?? "";
    expect(cols).toMatch(/^fit-content\((?:min\([^)]*\)|[^)]*)\) auto fit-content\((?:min\([^)]*\)|[^)]*)\) auto /);
  });

  test("the narrow form reads the view's width, not the viewport's, and keeps the arrows", () => {
    expect(css).not.toContain("@media");
    expect(rule(".s .dc-view")).toMatch(/container:\s*dc-view\s*\/\s*inline-size/);
    const narrow = css.slice(css.indexOf("@container dc-view (max-width: 30rem)"));
    expect(narrow.length).toBeLessThan(css.length);
    expect(rule(".s .dc-row", narrow)).toMatch(/border:\s*1px solid var\(--border-secondary\)/);
    expect(narrow).toMatch(/\.s \.dc-qs, \.s \.dc-dec, \.s \.dc-outs \{ display: contents; \}/);
    expect(narrow).not.toMatch(/dc-arrow[^{]*\{[^}]*display:\s*none/);
  });
});

describe("F15: the strip legend lists each look once", () => {
  const css = decisionViewsCss(".s");

  test("the CSS draws exactly the STATE_LOOKS groups alike", () => {
    const stateRules = [...css.matchAll(/((?:\.s \.dc-s-[a-z-]+(?:, )?)+)\s*\{/g)].map((m) => [...m[1]!.matchAll(/dc-s-([a-z-]+)/g)].map((x) => x[1]).sort().join(","));
    expect(stateRules.sort()).toEqual(STATE_LOOKS.map((l) => [...l].sort().join(",")).sort());
  });

  test("look-alike states share one entry; only present states are named", () => {
    const ledger = ["**PR ledger.**", "", "| PR | State | Decisions |", "|---|---|---|", "| 1 — a | merged | D1 |", "| 2 — b | closed | D2 |", "| 3 — c | dropped | D2 |", "| 4 — d | planned | D3 |", "| 5 — e | optional | D3 |", "| 6 — f | open | D3 |", ""].join("\n");
    const html = formatWebHtml(["# Plan", "", NEXT, LOG, ledger].join("\n"), { reader: true, views: true });
    const keys = [...html.matchAll(/<span class="dc-key"><span class="dc-sw dc-s-([a-z-]+)" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(keys).toEqual(["merged=merged", "closed=closed / dropped", "planned=planned / optional", "open=open"]);
  });

  test("a state repeated across rows is named once", () => {
    const ledger = ["**PR ledger.**", "", "| PR | State | Decisions |", "|---|---|---|", "| 1 — a | open | D1 |", "| 2 — b | open | D2 |", "| 3 — c | measurement | D2 |", "| 4 — d | open | D3 |", "| 5 — e | measurement | D3 |", ""].join("\n");
    const html = formatWebHtml(["# Plan", "", NEXT, LOG, ledger].join("\n"), { reader: true, views: true });
    const keys = [...html.matchAll(/<span class="dc-key"><span class="dc-sw dc-s-([a-z-]+)" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(keys).toEqual(["open=open / measurement"]);
  });

  test("the swatch's base border comes before the state rules, so a state's look wins", () => {
    const sw = css.indexOf(".s .dc-sw {");
    expect(sw).toBeGreaterThan(-1);
    expect(sw).toBeLessThan(css.indexOf(".s .dc-s-"));
  });
});
