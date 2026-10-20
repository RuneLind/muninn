import { describe, expect, test } from "bun:test";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { PEEK_RULE_TREE_CHROME } from "../dashboard/views/components/wiki-ref-links.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { locateExcerpt } from "../wiki/explain-context.ts";
import { checkPageText } from "../wiki/lint.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { formatEmailHtml } from "./email-format.ts";
import type { PageFileResult } from "./query-block.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { RULE_TREE_CHROME_CLASSES, ruleTreeViewHtml } from "./rule-tree-view.ts";

const reader = (md: string, opts: { files?: Record<string, PageFileResult>; language?: "en" | "no" } = {}) =>
  renderWikiHtml(md, () => undefined, {
    views: true,
    ...(opts.files ? { files: new Map(Object.entries(opts.files)) } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });

const tree = (body: string, attrs = 'title="Can the book be renewed?" outcomes="Renew=good;Return=muted"') =>
  `<RuleTree ${attrs}>\n\n${body}\n\n</RuleTree>\n`;

const LOANS = tree(
  [
    "- Is the book reserved by someone else?",
    "  - *Yes:* → Return (D2) — LIB-101, LIB-102",
    "  - *No:* Has it been renewed three times?",
    "    - *Yes:* → Return — LIB-103",
    "    - *No:* → Renew — LIB-104",
  ].join("\n"),
);

describe("the reader's tree", () => {
  test("a peek strips exactly the tree's chrome", () => {
    expect([...PEEK_RULE_TREE_CHROME]).toEqual([...RULE_TREE_CHROME_CLASSES]);
  });

  test("is a figure named by its title's text, a wikilink read as its label", () => {
    const html = reader(tree("- → Renew — LIB-1", 'title="Can the book be [[renewal|renewed]]?" outcomes="Renew=good"'));
    expect(html).toContain('<section class="rt" role="figure" aria-label="Can the book be renewed?">');
    expect(html).toMatch(/<p class="rt-title">Can the book be <[^>]+>renewed<\/span>\?<\/p>/);
  });

  test("an untitled tree is named by the view's own word, in the wiki's language", () => {
    expect(reader(tree("- → Renew", 'outcomes="Renew=good"'))).toContain('aria-label="Rule tree"');
    expect(reader(tree("- → Renew", 'outcomes="Renew=good"'), { language: "no" })).toContain('aria-label="Regeltre"');
  });

  test("the head is reader-only and the list is not", () => {
    const html = reader(LOANS);
    expect(html).toContain(`<div class="rt-head" ${READER_ONLY_ATTR}="">`);
    const list = html.slice(html.indexOf('<ul class="rt-list">'));
    expect(list).not.toContain(READER_ONLY_ATTR);
  });

  test("the picker is a labelled native select over the cases in first-seen order", () => {
    const html = reader(LOANS);
    expect(html).toContain(`<label class="rt-pick" ${READER_ONLY_ATTR}=""><span class="rt-pick-label">Case</span><select class="rt-select" data-rt-select aria-label="Case — Can the book be renewed?">`);
    const options = [...html.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]);
    expect(options).toEqual(["", "LIB-101", "LIB-102", "LIB-103", "LIB-104"]);
  });

  test("the picker is named by its tree, and a reader-only live region stands beside it", () => {
    const html = reader(LOANS);
    expect(html).toContain('<select class="rt-select" data-rt-select aria-label="Case — Can the book be renewed?">');
    const live = /<p class="rt-live" ([^>]*)><\/p>/.exec(html);
    expect(live?.[1]).toContain(`${READER_ONLY_ATTR}=""`);
    expect(live?.[1]).toContain('aria-live="polite"');
    expect(live?.[1]).toContain("data-rt-live");
    const say = JSON.parse((/data-rt-say="([^"]*)"/.exec(live?.[1] ?? "")?.[1] ?? "{}").replace(/&quot;/g, '"'));
    expect(say).toEqual({
      "LIB-101": "LIB-101: 1 leaf — Return",
      "LIB-102": "LIB-102: 1 leaf — Return",
      "LIB-103": "LIB-103: 1 leaf — Return",
      "LIB-104": "LIB-104: 1 leaf — Renew",
    });
    // The label too is the reader's, not the source's.
    expect(html).toContain(`<label class="rt-pick" ${READER_ONLY_ATTR}="">`);
  });

  test("the live text counts a case's leaves and names their outcomes once each, in the wiki's language", () => {
    const md = tree("- *2024:* → Renew — LIB-1\n- *2025:* → Return — LIB-1\n- *2026:* → Return — LIB-1\n- → Renew — LIB-2", 'outcomes="Renew=good;Return=muted"');
    const say = (html: string) => JSON.parse((/data-rt-say="([^"]*)"/.exec(html)?.[1] ?? "{}").replace(/&quot;/g, '"'));
    expect(say(reader(md))).toEqual({ "LIB-1": "LIB-1: 3 leaves — Renew, Return", "LIB-2": "LIB-2: 1 leaf — Renew" });
    expect(say(reader(md, { language: "no" }))).toEqual({ "LIB-1": "LIB-1: 3 blader — Renew, Return", "LIB-2": "LIB-2: 1 blad — Renew" });
    expect(reader(md, { language: "no" })).toContain('aria-label="Sak — Regeltre"');
  });

  test("a leaf with no outcome is counted and names none", () => {
    const md = tree("- *2024:* → — LIB-1\n- *2025:* → Renew — LIB-1", 'title="T" outcomes="Renew=good"');
    expect(reader(md)).toContain("LIB-1: 2 leaves — Renew");
    expect(reader(tree("- → — LIB-1", 'title="T"'))).toContain("LIB-1: 1 leaf&quot;");
  });

  test("a tree with no cases has no picker", () => {
    expect(reader(tree("- → Renew\n- → Return"))).not.toContain("<select");
    expect(reader(tree("- → Renew\n- → Return"))).not.toContain("rt-live");
  });

  test("leaves carry their tone and cases; the decision ref stays in the leaf text", () => {
    const html = reader(LOANS);
    expect(html).toContain('<li class="rt-node rt-leaf rt-tone-muted" data-rt-cases="[&quot;LIB-101&quot;,&quot;LIB-102&quot;]">');
    expect(html).toContain('<li class="rt-node rt-leaf rt-tone-good" data-rt-cases="[&quot;LIB-104&quot;]">');
    expect(html).toContain('<span class="rt-edge"><em>Yes:</em></span> → Return (D2) — <span class="rt-case" data-rt-case="LIB-101">LIB-101</span>, <span class="rt-case" data-rt-case="LIB-102">LIB-102</span>');
  });

  test("it renders where it stands, between the text around it", () => {
    const html = reader(["Intro line.", "", LOANS, "Outro line.", ""].join("\n"));
    const at = (s: string) => html.indexOf(s);
    expect(at("Intro line.")).toBeGreaterThanOrEqual(0);
    expect(at("Intro line.")).toBeLessThan(at('<section class="rt"'));
    expect(at("</section>")).toBeLessThan(at("Outro line."));
  });

  test("blocks before and after the list stay inside the figure, in place", () => {
    const html = reader(tree("Read top down.\n\n- → Renew\n\nAsk at the desk."));
    expect(html.indexOf("Read top down.")).toBeLessThan(html.indexOf('<ul class="rt-list">'));
    expect(html.indexOf("Ask at the desk.")).toBeGreaterThan(html.indexOf("</ul>"));
    expect(html.indexOf("Ask at the desk.")).toBeLessThan(html.indexOf("</section>"));
  });

  test("the cases follow the LAST dash; an earlier one stays in the leaf text", () => {
    const html = reader(tree("- → Renew — online only — LIB-7"));
    expect(html).toContain('data-rt-cases="[&quot;LIB-7&quot;]"');
    expect(html).toContain("→ Renew — online only — <span class=\"rt-case\" data-rt-case=\"LIB-7\">LIB-7</span>");
  });

  test("each chip names its case id in data-rt-case, read past a link or emphasis", () => {
    // LIB-1 sits in a link destination, struck text, and the edges of LIB-10 and XLIB-1.
    const html = reader(tree("- → Renew — LIB-1, [LIB-9](https://example.test/LIB-1), **LIB-10**, ~~LIB-1~~ LIB-12, XLIB-1"));
    expect(html).toContain('data-rt-cases="[&quot;LIB-1&quot;,&quot;LIB-9&quot;,&quot;LIB-10&quot;,&quot;LIB-12&quot;,&quot;XLIB-1&quot;]"');
    expect([...html.matchAll(/data-rt-case="([^"]*)"/g)].map((m) => m[1])).toEqual(["LIB-1", "LIB-9", "LIB-10", "LIB-12", "XLIB-1"]);
  });

  test("a chip whose source does not spell its id (a wikilink) takes it by position", () => {
    const html = reader(tree("- → Renew — LIB-6, [[LIB-5]]"));
    expect(html).toContain('data-rt-cases="[&quot;LIB-6&quot;,&quot;LIB-5&quot;]"');
    expect([...html.matchAll(/data-rt-case="([^"]*)"/g)].map((m) => m[1])).toEqual(["LIB-6", "LIB-5"]);
  });

  test("with a repeated id the position is ambiguous: that chip gets no id rather than a wrong one", () => {
    const html = reader(tree("- → Renew — LIB-5, LIB-5, [[LIB-6]], LIB-7"));
    expect(html).toContain('data-rt-cases="[&quot;LIB-5&quot;,&quot;LIB-6&quot;,&quot;LIB-7&quot;]"');
    expect([...html.matchAll(/data-rt-case="([^"]*)"/g)].map((m) => m[1])).toEqual(["LIB-5", "LIB-5", "LIB-7"]);
  });

  test("a body with no list renders as written", () => {
    const html = reader(tree("Nothing here."));
    expect(html).not.toContain('class="rt');
    expect(html).toContain("Nothing here.");
  });

  test("an ordered list stays ordered, its numbers kept", () => {
    const html = reader(tree("3. → Renew\n4. → Return"));
    expect(html).toContain('<ol class="rt-list" start="3">');
  });

  test("six authored levels draw the lists the parser builds, the leaf still a leaf", () => {
    const deep = Array.from({ length: 6 }, (_, i) => `${"  ".repeat(i)}- *Level ${i + 1}:* step`).join("\n") + `\n${"  ".repeat(6)}- → Renew — LIB-1`;
    const lists = (html: string) => html.match(/<ul\b/g)?.length;
    // The tree adds no level and drops none: it nests as the chat render does.
    expect(lists(reader(tree(deep)))).toBe(lists(formatWebHtml(deep)));
    expect(reader(tree(deep))).toContain('<li class="rt-node rt-leaf rt-tone-good" data-rt-cases="[&quot;LIB-1&quot;]">');
  });
});

describe("CaseBoard kort", () => {
  const board = ["- id: LIB-101", "  status: hold", "  kort: Two **loans** open", "- id: loan-7", "  status: ok", "  kort: Fine paid", "- id: LIB-104", "  status: ok"].join("\n");
  const page = (body: string) => ['<CaseBoard src="cases.yaml" />', "", tree(body)].join("\n");
  const files = { "cases.yaml": { ok: true, text: board } as const };

  test("a case the page's board holds shows its kort, hidden until picked", () => {
    const html = reader(page("- → Return — LIB-101\n- → Renew — LIB-104"), { files });
    expect(html).toContain('<p class="rt-korts"><span class="rt-kort" data-rt-kort="LIB-101" hidden>LIB-101 · Two <strong>loans</strong> open</span></p>');
    // A board row with no kort, and no note, adds no line.
    expect(html).not.toContain('data-rt-kort="LIB-104"');
  });

  test("a board id outside the grammar counts as a case on this page only", () => {
    expect(reader(page("- → Renew — loan-7"), { files })).toContain('data-rt-cases="[&quot;loan-7&quot;]"');
    expect(reader(tree("- → Renew — loan-7"))).not.toContain("data-rt-cases");
  });

  test("with two boards holding one id, the first board's kort wins", () => {
    const second = ["- id: LIB-101", "  status: ok", "  kort: From the second board"].join("\n");
    const two = ['<CaseBoard src="cases.yaml" />', "", '<CaseBoard src="more.yaml" />', "", tree("- → Return — LIB-101")].join("\n");
    const html = reader(two, { files: { ...files, "more.yaml": { ok: true, text: second } as const } });
    expect(html).toContain("LIB-101 · Two <strong>loans</strong> open");
    expect(html.slice(html.indexOf("<section class=\"rt\"")).match(/data-rt-kort="LIB-101"[^>]*>[^<]*/)?.[0]).toEndWith("LIB-101 · Two ");
  });

  test("a board whose file does not load joins nothing", () => {
    const html = reader(page("- → Return — LIB-101"), { files: {} });
    expect(html).toContain('data-rt-cases="[&quot;LIB-101&quot;]"');
    expect(html).not.toContain("rt-korts");
  });
});

describe("off the reader a <RuleTree> is its list", () => {
  const bare = ["Intro line.", "", "- Is the book reserved?", "  - *Yes:* → Return — LIB-1", "  - *No:* → Renew — LIB-2", "", "After the list.", ""].join("\n");
  const treed = ["Intro line.", "", tree(["- Is the book reserved?", "  - *Yes:* → Return — LIB-1", "  - *No:* → Renew — LIB-2"].join("\n")), "After the list.", ""].join("\n");
  const surfaces: [string, (s: string) => string][] = [
    ["web chat", (s) => formatWebHtml(s)],
    ["web with views and no tree view", (s) => formatWebHtml(s, { views: true })],
    ["the reader without views", (s) => renderWikiHtml(s, () => undefined)],
    ["telegram", formatTelegramHtml],
    ["slack", formatSlackMrkdwn],
    ["email", formatEmailHtml],
  ];
  surfaces.push(["a tree view handed in without views", (s) => formatWebHtml(s, { ruleTreeView: ruleTreeViewHtml })]);
  for (const [name, fmt] of surfaces) {
    test(`${name} prints the list as written`, () => {
      const out = fmt(treed);
      expect(out).not.toContain("rt-");
      expect(out).not.toContain("<select");
      expect(out.replace(/\s+/g, " ")).toBe(fmt(bare).replace(/\s+/g, " "));
    });
  }
});

/** The rendered leaves of `md`'s trees: toned, and carrying cases. */
function renderedLeaves(md: string, files?: Record<string, PageFileResult>): { toned: number; cased: number; leaves: number } {
  const lis = [...reader(md, files ? { files } : {}).matchAll(/<li class="(rt-node rt-leaf[^"]*)"([^>]*)>/g)];
  return { leaves: lis.length, toned: lis.filter((m) => m[1]?.includes("rt-tone-")).length, cased: lis.filter((m) => m[2]?.includes("data-rt-cases")).length };
}

const lintOf = (md: string) => checkPageText({ relPath: "plans/t.mdx" }, md, []).filter((f) => f.check === "rule-tree");

describe("the reader and the lint read one tree", () => {
  // Each item twice, as two leaves: the lint's untoned and shared-case
  // warnings fire exactly when the reader draws no tone and draws cases.
  test.each([
    ["a wikilinked outcome", "→ [[renew-page|Renew]] — LIB-1", false],
    ["a bare wikilink outcome", "→ [[Renew]] — LIB-1", false],
    ["a wikilinked edge label", "*[[yes-page|Yes]]:* → Renew — LIB-1", false],
    ["a wikilinked case id", "→ Renew — [[lib-page|LIB-1]]", false],
    ["a code outcome", "→ `Renew` — LIB-1", false],
    ["a code case id", "→ Renew — `LIB-1`", false],
    ["an emphasised outcome", "→ **Renew** — LIB-1", false],
    ["an emphasised arrow run", "**→ Renew** — LIB-1", false],
    ["NBSP around the dash", "→ Renew — LIB-1", false],
    ["an en dash", "→ Renew – LIB-1", false],
    ["a hyphen", "→ Renew - LIB-1", false],
    ["a dash inside code", "→ Renew `a — b`", false],
    ["a struck outcome word", "→ ~~Return~~ Renew — LIB-1", false],
    ["a struck case id", "→ Renew — ~~LIB-1~~", false],
    ["an outcome outcomes= does not name", "→ Extend — LIB-1", false],
    ["a decision ref before the dash", "→ Renew (D6) — LIB-1", false],
    ["text after the cases", "→ Renew — see the desk", false],
    ["a linked outcome", "→ [Renew](http://x) — LIB-1", false],
    ["a link in the outcome text", "→ Renew, see [the rule](http://x) — LIB-1", false],
    ["a decision ref after a linked outcome", "→ [Renew](http://x) (D2) — LIB-1", false],
    ["a comma in a linked case id's URL", "→ Renew — [LIB-1](http://x/?a=1,2)", false],
    ["an italic arrow run", "*→ Renew* — LIB-1", false],
    ["an underscore arrow run", "_→ Renew_ — LIB-1", false],
    ["text after a bold arrow run", "**→ Renew**, later — LIB-1", false],
    ["a later emphasis run after an italic arrow run", "*→ Renew* and *more* — LIB-1", false],
    ["a * in code inside an italic arrow run", "*→ Renew `a* b` c* — LIB-1", false],
    ["a * in a link destination inside an italic arrow run", "*→ [Renew](http://x/a*,b) c* — LIB-1", false],
    ["a dash inside link text", "→ [Renew — LIB-2](http://x)", false],
    ["a dash inside link text, then cases", "→ [Renew — more](http://x) — LIB-1", false],
    ["a board id beside a grammar id, no board", "→ Renew — LIB-1, loan-7", false],
    ["a board id beside a grammar id, on the board", "→ Renew — LIB-1, loan-7", true],
  ] as [string, string, boolean][])("%s", (_name, item, onBoard) => {
    const board = onBoard ? '<CaseBoard src="cases.yaml" />\n\n' : "";
    const md = board + tree(`- ${item}\n- ${item}`, 'title="T" outcomes="Renew=good"');
    const r = renderedLeaves(md, onBoard ? { "cases.yaml": { ok: true, text: "- id: loan-7\n  status: ok" } } : undefined);
    const fs = lintOf(md).map((f) => f.message);
    expect(r.leaves).toBe(2);
    expect(r.toned === 0).toBe(fs.some((m) => m.includes("has no tone")));
    expect(r.cased > 0).toBe(fs.some((m) => / is on 2 leaves /.test(m)));
    expect(fs.some((m) => m.includes("is not read as a leaf"))).toBe(false);
  });

  // Each item once: the lint names an item with an arrow exactly when the
  // reader draws no leaf, and a case tail exactly when it draws a leaf with no cases.
  test.each([
    ["a leaf with a case", "→ Renew — LIB-1"],
    ["a leaf with no dash", "→ Renew"],
    ["an ASCII arrow", "-> Renew — LIB-1"],
    ["an ASCII arrow after an edge label", "*Yes:* -> Renew — LIB-1"],
    ["a bold edge label", "**Yes:** → Renew — LIB-1"],
    ["a bold italic edge label", "***Yes:*** → Renew — LIB-1"],
    ["a bold italic arrow run", "***→ Renew*** — LIB-1"],
    ["a lead with * in a code span", "*`a*b`:* → Renew — LIB-1"],
    ["an ASCII arrow in a bold run", "**-> Renew** — LIB-1"],
    ["a full stop after the id", "→ Renew — LIB-1."],
    ["a lowercase id", "→ Renew — lib-1"],
    ["ids joined by a word", "→ Renew — LIB-7 og LIB-8"],
    ["a struck case id", "→ Renew — ~~LIB-1~~"],
    ["a dash inside code", "→ Renew `a — b`"],
    ["a dash inside link text", "→ [Renew — LIB-2](http://x)"],
  ])("%s: what drops is named", (_name, item) => {
    const md = tree(`- ${item}`, 'title="T" outcomes="Renew=good"');
    const r = renderedLeaves(md);
    const fs = lintOf(md);
    const notLeaf = fs.filter((f) => f.message.includes("is not read as a leaf"));
    const noCases = fs.filter((f) => f.message.includes("reads as no case ids"));
    expect(notLeaf.length).toBe(r.leaves === 0 ? 1 : 0);
    const tail = item.replace(/~~[^~]*~~/g, "").replace(/`[^`]*`/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "").split(" — ")[1]?.trim();
    expect(noCases.length).toBe(r.leaves === 1 && r.cased === 0 && Boolean(tail) ? 1 : 0);
    expect([...notLeaf, ...noCases].every((f) => f.severity === "info")).toBe(true);
  });

  test("the one stated divergence: on a board page, an id the board lacks beside a grammar id", () => {
    // The lint reads no board file, so it takes LIB-1x as a possible board id
    // and counts LIB-1; the reader, whose board lacks LIB-1x, draws no cases.
    const md = '<CaseBoard src="cases.yaml" />\n\n' + tree("- → Renew — LIB-1, LIB-1x\n- → Renew — LIB-1, LIB-1x", 'title="T" outcomes="Renew=good"');
    expect(renderedLeaves(md, { "cases.yaml": { ok: true, text: "- id: loan-7\n  status: ok" } }).cased).toBe(0);
    expect(lintOf(md).some((f) => / is on 2 leaves /.test(f.message))).toBe(true);
  });

  test.each([
    ["a Fold", '<Fold title="Rules">\n\n', "\n</Fold>\n"],
    ["a Lane", '<NextMoves>\n\n<Lane kind="you">\n\n', "\n</Lane>\n\n</NextMoves>\n"],
    ["a More", "<Tldr>\n\nIn short.\n\n<More>\n\n", "\n</More>\n\n</Tldr>\n"],
  ])("a tree nested in %s renders and lints as one at the top", (_name, open, close) => {
    const top = tree("- *A:* → Return — LIB-1\n- *B:* → Renew — LIB-1", 'title="T" outcomes="Renew=good"');
    const nested = open + top + close;
    expect(reader(nested).match(/<section class="rt"/g)).toHaveLength(1);
    expect(renderedLeaves(nested)).toEqual(renderedLeaves(top));
    expect(lintOf(nested).map((f) => f.message)).toEqual(lintOf(top).map((f) => f.message));
  });
});

describe("an Explain selection", () => {
  const body = ["# Loans", "", ...Array.from({ length: 30 }, (_, i) => `Padding paragraph ${i + 1} so the page is long.\n`), LOANS, "After the tree."].join("\n");

  test.each([
    ["one leaf", "Return (D2) — LIB-101, LIB-102"],
    ["across two rows", "Is the book reserved by someone else?\nYes: → Return (D2)"],
  ])("over %s locates in the source", (_name, selection) => {
    expect(locateExcerpt(body, selection)).toContain("*Yes:* → Return (D2) — LIB-101, LIB-102");
  });
});
