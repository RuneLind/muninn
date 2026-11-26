/**
 * A fact chip changes nothing the renderer reads (class-check sweep B,
 * Discuss v2 PR 6): for every chip site, every character after it, every
 * character before the mention, every block and inline context, with and
 * without key marks, the page rendered with live facts is the page rendered
 * without them, less the chip spans and the mark wrappers. Each cell also
 * says whether it gets a chip, so a fix that refuses chips cannot pass.
 *
 * The neighbours an inline rule reads (`renderInlineWith` in
 * `src/web/web-format.ts`): `*`/`_` emphasis (`(?<!\w)` before an opener),
 * `**`, `~~`, code spans, links, angle links, the before → after chain
 * (`beforeAfterChipsHtml`), and the table's cell split on `|`.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { parseTrackersConfig } from "./trackers/index.ts";
import { jiraTrackers, loadFacts, markedMentions, parseWikiFacts } from "./live-facts.ts";
import { readerBody, renderWikiHtml } from "./render.ts";

// The shared fixture, plus a one-digit key: its chip parks after the `-`.
const FACTS = (() => {
  const r = parseWikiFacts(readFileSync(path.join(import.meta.dir, "__fixtures__", "live-facts-wiki-facts.json"), "utf8"));
  if ("error" in r) throw new Error(r.error);
  return loadFacts({ ...r.facts, keys: { ...r.facts.keys, "DEMO-1": { prs: [] } } });
})();
const GRAMMAR = { owner: "acme", aliases: { api: "acme-api", web: "acme-web" }, noProd: ["acme-e2e"] };
const TRACKERS = jiraTrackers(parseTrackersConfig([{ id: "jira", projects: ["DEMO"] }], () => {}));
const REL = "plans/demo.mdx";
const page = (body: string) => `---\ntitle: Demo\nrepos: [acme-api]\n---\n\n${body}\n`;
// The page route's reader options: the shapes and views read the text too.
const OPTS = { views: true, readerShapes: true } as const;

/** Chip sites: a mention's own end (key, PR forms) or the span holding it.
 *  `mentionEnd`: a mention whose grammar ends at a word boundary, so its chip
 *  never stands before a letter or digit (the URL form has no `\b`: `pull/103x`
 *  is #103 followed by `x`). */
const SITES: readonly { name: string; text: string; mentionEnd?: true; chipAfter?: string }[] = [
  { name: "key", text: "DEMO-12", mentionEnd: true, chipAfter: "DEMO-12" },
  { name: "qualified PR", text: "acme/acme-api#101", mentionEnd: true, chipAfter: "#101" },
  { name: "alias PR", text: "api #102", mentionEnd: true, chipAfter: "#102" },
  // One digit: the chip parks after the `-`, `#` or `/` before it.
  { name: "one-digit key", text: "DEMO-1", mentionEnd: true, chipAfter: "DEMO-1" },
  { name: "one-digit qualified PR", text: "acme/acme-e2e#7", mentionEnd: true, chipAfter: "#7" },
  { name: "one-digit URL-form PR", text: "github.com/acme/acme-e2e/pull/7", chipAfter: "pull/7" },
  { name: "URL-form PR", text: "github.com/acme/acme-api/pull/103", chipAfter: "pull/103" },
  { name: "bare URL", text: "https://github.com/acme/acme-api/pull/104" },
  { name: "link", text: "[the PR](https://github.com/acme/acme-api/pull/108)", chipAfter: "the PR</a>" },
  { name: "link text ending in `)`", text: "[see (it)](https://github.com/acme/acme-api/pull/101)", chipAfter: "see (it)</a>" },
  { name: "reference link", text: "[api #101][r]", chipAfter: "[api #101][r]" },
  { name: "autolink", text: "<https://github.com/acme/acme-api/pull/101>", chipAfter: "pull/101</a>" },
];

/** What follows the site: each inline delimiter, alone and as a pair, and the
 *  characters around them. */
const AFTER = [
  "", " ", "_", "*", "_x_", "*x*", "**x**", "__x__", "~~x~~", "~x~", "`x`", "[x](https://e.com)", "[x]", "]", "(x)", ")", "\\*x*",
  "<b>x</b>", "<https://e.com>", "!", "$x$", " → 5", "→5", " -> 5", "1 → 2", "_ and _y_", "* and *y*", ".", ",", ":", ":5", "'s", '"', "#",
  "/", "-", "—", "&", "&amp;", "|", "|x|", "\\|x", "\\", "x", "1", "_1", "*1*", ". _y_ x_", "?x=_a_ z_", "_.", "*.",
];
/** What precedes the mention. */
const BEFORE = ["", "(", "_", "*", "**", "~~", "[", '"', "x_", "1 → ", "`"];
/** The after strings each `BEFORE` is crossed with: the delimiters that pair
 *  with one before the mention, and the boundaries. Every `AFTER` string runs
 *  with nothing before (the full product is 4x the time, past CI's per-file bar). */
const AFTER_WITH_BEFORE = ["", " ", "_", "*", "_x_", "*x*", "**x**", "~~x~~", "`x`", "1 → 2", "x", "_ and _y_", "* and *y*", "|"];
const PAIRS: readonly (readonly [string, string])[] = [
  ...AFTER.map((a) => ["", a] as const),
  ...BEFORE.filter((b) => b !== "").flatMap((b) => AFTER_WITH_BEFORE.map((a) => [b, a] as const)),
];
/** Where the text stands; `chips: false` where no mention is ever marked. */
const CONTEXTS: readonly { name: string; wrap: (s: string) => string; chips: boolean }[] = [
  { name: "paragraph", wrap: (s) => `a ${s} z`, chips: true },
  { name: "line start", wrap: (s) => s, chips: true },
  { name: "bold", wrap: (s) => `**a ${s} z**`, chips: true },
  { name: "_italic_", wrap: (s) => `_a ${s} z_`, chips: true },
  { name: "*italic*", wrap: (s) => `*a ${s} z*`, chips: true },
  { name: "strike", wrap: (s) => `~~a ${s} z~~`, chips: true },
  { name: "link text", wrap: (s) => `[a ${s} z](https://e.com)`, chips: true },
  { name: "table cell", wrap: (s) => `| h | k |\n|---|---:|\n| a ${s} z | 1 |`, chips: true },
  { name: "list item", wrap: (s) => `- a ${s} z`, chips: true },
  { name: "ordered item", wrap: (s) => `1. a ${s} z`, chips: true },
  { name: "blockquote", wrap: (s) => `> a ${s} z`, chips: true },
  { name: "heading", wrap: (s) => `## a ${s} z`, chips: false },
  { name: "inline code", wrap: (s) => "`a " + s + " z`", chips: false },
  { name: "fence", wrap: (s) => "```\na " + s + " z\n```", chips: false },
];

/** Whether the cell should get a chip: some mention the parser marks
 *  (`markedMentions`, which this sweep does not touch) has a facts entry.
 *  Every such mention gets one; nothing refuses a chip any more. */
function wantsChip(md: string): boolean {
  const body = readerBody(md);
  const has = (id: string) => Object.hasOwn(FACTS.facts.keys, id) || FACTS.prIds.has(id.toLowerCase());
  return markedMentions(body, md, REL, GRAMMAR, TRACKERS, (id) => FACTS.facts.prs[FACTS.prIds.get(id.toLowerCase()) ?? ""]?.title).some((m) => has(m.id));
}

/** Cells where the chip's exact place is the site's end: no span the before
 *  and after characters build around the site (a link, a code span), and no
 *  letter or digit after it that makes another mention (`DEMO-1` + `1`). */
const plainPlace = (ctx: string, before: string, after: string) =>
  !["link text", "inline code", "heading", "fence"].includes(ctx) && ["", "(", '"', "1 → ", "*", "**", "~~"].includes(before) && !/^[[\]()`A-Za-z0-9]/.test(after);

const CHIP_RE = /<span class="fact-chip" data-live-fact="[^"]*" data-reader-only><\/span>/g;
const MARK_RE = /<span class="wiki-key" data-wiki-key="[^"]*">([^<]*)<\/span>/g;
const strip = (html: string) => html.replace(CHIP_RE, "").replace(MARK_RE, "$1");

function cell(md: string, marks: boolean): string {
  return renderWikiHtml(md, () => undefined, {
    ...OPTS,
    liveFacts: { loaded: FACTS, grammar: GRAMMAR, trackers: TRACKERS, relPath: REL },
    ...(marks ? { keyMarks: { grammar: GRAMMAR, trackers: TRACKERS, kinds: [], relPath: REL } } : {}),
  });
}

describe("a fact chip changes nothing the renderer reads: site × before × after × context × marks", () => {
  for (const site of SITES)
    for (const ctx of CONTEXTS)
      test(`${site.name} in ${ctx.name}`, () => {
        const failures: string[] = [];
        let cells = 0;
        let chipped = 0;
        for (const [before, after] of PAIRS) {
          const md = page(ctx.wrap(before + site.text + after));
          const plain = renderWikiHtml(md, () => undefined, OPTS);
          const want = wantsChip(md);
          // A `` ` `` before the site closes the context's code span, so only then may code hold a mention.
          if (want && !ctx.chips && before !== "`") failures.push(`${JSON.stringify(before)}+site+${JSON.stringify(after)}: the parser marks a mention in ${ctx.name}`);
          for (const marks of [false, true]) {
            cells++;
            const html = cell(md, marks);
            const id = `${JSON.stringify(before)}+site+${JSON.stringify(after)} marks=${marks}`;
            if (strip(html) !== plain) failures.push(`${id}: render differs\n  facts: ${html}\n  plain: ${plain}`);
            const got = html.includes('class="fact-chip"');
            if (got) chipped++;
            if (got !== want) failures.push(`${id}: chip ${got ? "present" : "absent"}, want ${want ? "present" : "absent"}`);
            if (!got) continue;
            // A chip at a mention's own end is never left before a letter or digit (inside the mention).
            if (site.mentionEnd && /<span class="fact-chip"[^>]*><\/span>[A-Za-z0-9]/.test(html)) failures.push(`${id}: chip inside the mention: ${html}`);
            // Where nothing builds a span around the site, the chip is right after its text (a mark's wrapper between).
            if (site.chipAfter && plainPlace(ctx.name, before, after)) {
              const at = html.search(CHIP_RE);
              if (!html.slice(0, at).replace(/<\/span>$/, "").endsWith(site.chipAfter)) failures.push(`${id}: chip not right after ${site.chipAfter}: ${html}`);
            }
          }
        }
        expect(failures).toEqual([]);
        expect(cells).toBe(PAIRS.length * 2);
        if (ctx.chips) expect(chipped).toBeGreaterThan(0);
      });
});
