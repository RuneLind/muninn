import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import path from "node:path";
import { formatWebHtml } from "../web/web-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { CHAIN_VIEW_MIN, STRIP_VIEW_MIN, viewSlot } from "./decision-views.ts";
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
    expect(html).toContain('<details class="dc-node dc-d dc-struck"><summary>D2</summary><div class="dc-pop"><s>Rows per item.</s>');
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

  test("the glance slate draws only on a proposed plan with no ledger", () => {
    const glance = ["### At a glance", "", "| PR | What |", "|---|---|", "| 1 | a |", "| 2 | b |", "| 3 | c |", "| 4 | d |", ""].join("\n");
    const page = (status: string) => ["---", `plan_status: ${status}`, "---", "# Plan", "", NEXT, glance].join("\n");
    expect(renderWikiHtml(page("proposed"), resolve, { views: true })).toContain("dc-strip");
    expect(renderWikiHtml(page("shipped"), resolve, { views: true })).not.toContain(DC_VIEW_CLASS);
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
