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
import { RULE_TREE_CHROME_CLASSES } from "./rule-tree-view.ts";

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
    expect(html).toContain('<label class="rt-pick"><span class="rt-pick-label">Case</span><select class="rt-select" data-rt-select>');
    const options = [...html.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]);
    expect(options).toEqual(["", "LIB-101", "LIB-102", "LIB-103", "LIB-104"]);
  });

  test("a tree with no cases has no picker", () => {
    expect(reader(tree("- → Renew\n- → Return"))).not.toContain("<select");
  });

  test("leaves carry their tone and cases; the decision ref stays in the leaf text", () => {
    const html = reader(LOANS);
    expect(html).toContain('<li class="rt-node rt-leaf rt-tone-muted" data-rt-cases="[&quot;LIB-101&quot;,&quot;LIB-102&quot;]">');
    expect(html).toContain('<li class="rt-node rt-leaf rt-tone-good" data-rt-cases="[&quot;LIB-104&quot;]">');
    expect(html).toContain('<span class="rt-edge"><em>Yes:</em></span> → Return (D2) — <span class="rt-case">LIB-101</span>, <span class="rt-case">LIB-102</span>');
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
    expect(html).toContain('<p class="rt-korts" aria-live="polite"><span class="rt-kort" data-rt-kort="LIB-101" hidden>LIB-101 · Two <strong>loans</strong> open</span></p>');
    // A board row with no kort, and no note, adds no line.
    expect(html).not.toContain('data-rt-kort="LIB-104"');
  });

  test("a board id outside the grammar counts as a case on this page only", () => {
    expect(reader(page("- → Renew — loan-7"), { files })).toContain('data-rt-cases="[&quot;loan-7&quot;]"');
    expect(reader(tree("- → Renew — loan-7"))).not.toContain("data-rt-cases");
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
function renderedLeaves(md: string): { toned: number; cased: number; leaves: number } {
  const lis = [...reader(md).matchAll(/<li class="(rt-node rt-leaf[^"]*)"([^>]*)>/g)];
  return { leaves: lis.length, toned: lis.filter((m) => m[1]?.includes("rt-tone-")).length, cased: lis.filter((m) => m[2]?.includes("data-rt-cases")).length };
}

const lintOf = (md: string) => checkPageText({ relPath: "plans/t.mdx" }, md, []).filter((f) => f.check === "rule-tree");

describe("the reader and the lint read one tree", () => {
  // Each item twice, as two leaves: the lint's untoned and shared-case
  // warnings fire exactly when the reader draws no tone and draws cases.
  test.each([
    ["a wikilinked outcome", "→ [[renew-page|Renew]] — LIB-1"],
    ["a bare wikilink outcome", "→ [[Renew]] — LIB-1"],
    ["a wikilinked edge label", "*[[yes-page|Yes]]:* → Renew — LIB-1"],
    ["a wikilinked case id", "→ Renew — [[lib-page|LIB-1]]"],
    ["a code outcome", "→ `Renew` — LIB-1"],
    ["a code case id", "→ Renew — `LIB-1`"],
    ["an emphasised outcome", "→ **Renew** — LIB-1"],
    ["an emphasised arrow run", "**→ Renew** — LIB-1"],
    ["NBSP around the dash", "→ Renew — LIB-1"],
    ["an en dash", "→ Renew – LIB-1"],
    ["a hyphen", "→ Renew - LIB-1"],
    ["a dash inside code", "→ Renew `a — b`"],
    ["a struck outcome word", "→ ~~Return~~ Renew — LIB-1"],
    ["a struck case id", "→ Renew — ~~LIB-1~~"],
    ["an outcome outcomes= does not name", "→ Extend — LIB-1"],
    ["a decision ref before the dash", "→ Renew (D6) — LIB-1"],
    ["text after the cases", "→ Renew — see the desk"],
  ])("%s", (_name, item) => {
    const md = tree(`- ${item}\n- ${item}`, 'title="T" outcomes="Renew=good"');
    const r = renderedLeaves(md);
    const fs = lintOf(md).map((f) => f.message);
    expect(r.leaves).toBe(2);
    expect(r.toned === 0).toBe(fs.some((m) => m.includes("has no tone")));
    expect(r.cased > 0).toBe(fs.some((m) => / is on 2 leaves /.test(m)));
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
