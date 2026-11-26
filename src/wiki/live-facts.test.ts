/**
 * Live chips (living facts PR 3b): the server half — the facts file, what is
 * marked, where the chip goes and the payload — and the shared chip text.
 *
 * The first two describe blocks are the DRIFT GATE against the sweep. The
 * three `__fixtures__/live-facts-*.json` files are copies of claude-skills
 * `plan-status-sweep/scripts/fixtures/{reference-forms,wiki-facts,wiki-facts-chips}.json`,
 * whose own suite (`sweep-lib.test.ts`) derives the same rows from the sweep's
 * code. One line differs: reference-forms case 1's tracker carries
 * `"frontmatterKeys": ["issue","tickets"]`, which muninn's tracker rule reads
 * its declared fields from (the sweep reads those two always). Synthetic
 * owners, repos and numbers only.
 */

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { chmod, rename, rm, stat, utimes, writeFile, unlink } from "node:fs/promises";
import { testTempDir } from "../test/temp-dir.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTrackersConfig } from "./trackers/index.ts";
import { parsePrGrammar, noProdSet } from "./pr-grammar.ts";
import {
  bodyKeyMentions,
  jiraTrackers,
  loadFacts,
  markedMentions,
  pageKeySet,
  prMentions,
  parseWikiFacts,
  planKeyMarks,
  planLiveChips,
  readWikiFacts,
  resetWikiFactsCache,
  __setWikiFactsStatForTest,
  type WikiFacts,
} from "./live-facts.ts";
import { chipView, countedKeyPrs, keySummary, prChipParts, repoOfPr, type LiveFactsPayload } from "./core/live-facts-chip.ts";
import { keyMarkClose, keyMarkOpen, readerBody, renderWikiHtml, wrapKeyMarks } from "./render.ts";
import { stripFrontmatter } from "./store.ts";
import { KEY_SCAN_LINE_MAX, parseKeyKinds } from "./key-kinds.ts";

const FIX = path.join(import.meta.dir, "__fixtures__");
const json = async (name: string) => JSON.parse(await Bun.file(path.join(FIX, name)).text());

function grammarOf(readerConfig: Record<string, unknown>) {
  const g = parsePrGrammar(readerConfig.prGrammar);
  expect(g.warnings).toEqual([]);
  const trackers = jiraTrackers(parseTrackersConfig(readerConfig.trackers, (w) => {
    throw new Error(`${w.key} ${w.reason}`);
  }));
  return { grammar: g.grammar, trackers };
}

const distinct = (xs: string[]) => [...new Set(xs)];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("the shared reference-form fixture (copied from plan-status-sweep)", async () => {
  const data = await json("live-facts-reference-forms.json");
  for (const c of data.cases)
    for (const row of c.rows)
      test(`${c.name}: ${row.name}`, () => {
        const { grammar, trackers } = grammarOf(c.readerConfig);
        expect([...pageKeySet(row.page, row.rel, trackers)].sort()).toEqual(row.keys);
        const projects = trackers.flatMap((t) => t.projects);
        expect(distinct(bodyKeyMentions(stripFrontmatter(row.page), projects).map((m) => m.key))).toEqual(row.bodyKeys);
        const body = readerBody(row.page);
        const marked = markedMentions(body, row.page, row.rel, grammar, trackers, (id) => row.titles[id]);
        expect(distinct(marked.filter((m) => m.kind === "pr").map((m) => m.id))).toEqual(row.marked);
        // Keys are marked only with tracker projects, and then every body mention outside code.
        if (!row.page.includes("```")) expect(distinct(marked.filter((m) => m.kind === "key").map((m) => m.id))).toEqual(projects.length ? row.bodyKeys : []);
      });
  for (const c of data.cases)
    if (c.noProd)
      test(`${c.name}: noProd matching ignores case`, () => {
        const set = noProdSet(grammarOf(c.readerConfig).grammar);
        for (const [repo, want] of Object.entries<boolean>(c.noProd)) expect([repo, set.has(repo.toLowerCase())]).toEqual([repo, want]);
      });
});

describe("the facts fixture and its chip inputs (copied from plan-status-sweep)", async () => {
  const text = await Bun.file(path.join(FIX, "live-facts-wiki-facts.json")).text();
  const chips = await json("live-facts-chips.json");
  test("every PR's state and prod part, and every key's summary, follow from the facts", () => {
    const r = parseWikiFacts(text);
    if ("error" in r) throw new Error(r.error);
    const { grammar } = grammarOf(chips.readerConfig);
    const noProd = noProdSet(grammar);
    const deploys = (id: string) => !noProd.has(repoOfPr(id).toLowerCase());
    expect(Object.keys(chips.prs).sort()).toEqual(Object.keys(r.facts.prs).sort());
    expect(Object.keys(chips.keys).sort()).toEqual(Object.keys(r.facts.keys).sort());
    for (const id of Object.keys(chips.prs)) expect([id, prChipParts(r.facts.prs[id]!, deploys(id), "no")]).toEqual([id, chips.prs[id]]);
    for (const k of Object.keys(chips.keys))
      expect([k, keySummary(countedKeyPrs(r.facts.keys[k]!, r.facts.prs, deploys), "no")]).toEqual([k, chips.keys[k].summary]);
  });
});

const FACTS: WikiFacts = (() => {
  const r = parseWikiFacts(require("node:fs").readFileSync(path.join(FIX, "live-facts-wiki-facts.json"), "utf8"));
  if ("error" in r) throw new Error(r.error);
  return r.facts;
})();
const GRAMMAR = { owner: "acme", aliases: { api: "acme-api", web: "acme-web" }, noProd: ["acme-e2e"] };
const TRACKERS = jiraTrackers(parseTrackersConfig([{ id: "jira", projects: ["DEMO"] }], () => {}));

function render(md: string, relPath = "plans/demo.mdx", opts: Omit<NonNullable<Parameters<typeof renderWikiHtml>[2]>, "liveFacts"> = {}) {
  let facts: LiveFactsPayload | undefined;
  const html = renderWikiHtml(md, () => undefined, {
    ...opts,
    liveFacts: { loaded: loadFacts(FACTS), grammar: GRAMMAR, trackers: TRACKERS, relPath, collect: (f) => (facts = f) },
  });
  return { html, facts };
}
const stripChips = (html: string) => html.replace(/<span class="fact-chip" data-live-fact="[^"]*" data-reader-only><\/span>/g, "");
const chipIds = (html: string) => [...html.matchAll(/data-live-fact="([^"]+)"/g)].map((m) => m[1]);
const page = (body: string, fm = "repos: [acme-api]\n") => `---\ntitle: Demo\n${fm}---\n\n${body}\n`;

describe("the chip pass in renderWikiHtml", () => {
  test("a chip is an empty reader-only span after the mention", () => {
    const { html } = render(page("Merged acme/acme-api#101 today."));
    expect(html).toContain('acme/acme-api#101<span class="fact-chip" data-live-fact="acme/acme-api#101" data-reader-only></span> today');
  });

  test("a link is one mention: one chip per distinct id after the closing parenthesis, href unchanged", () => {
    const { html } = render(page("See [PR #101](https://github.com/acme/acme-api/pull/101) and [DEMO-12](https://jira.example/browse/DEMO-12)."));
    expect(html).toContain('<a href="https://github.com/acme/acme-api/pull/101" target="_blank" rel="noopener">PR #101</a><span class="fact-chip" data-live-fact="acme/acme-api#101"');
    expect(html).toContain('<a href="https://jira.example/browse/DEMO-12" target="_blank" rel="noopener">DEMO-12</a><span class="fact-chip" data-live-fact="DEMO-12"');
    expect(chipIds(html)).toEqual(["acme/acme-api#101", "DEMO-12"]);
  });

  test("a link whose text and target name two PRs gets both chips, in text order", () => {
    const { html } = render(page("[api #103](https://github.com/acme/acme-api/pull/101)"));
    expect(chipIds(html)).toEqual(["acme/acme-api#103", "acme/acme-api#101"]);
  });

  test("a bare URL is one mention: the chip goes after the URL, not inside it", () => {
    const { html } = render(page("At https://github.com/acme/acme-api/pull/102/files."));
    expect(html).toContain("pull/102/files<span");
  });

  test("forms: repo #n, alias, bare #n and PR #n resolved through repos:, Jira key", () => {
    // #101 and #103 carry DEMO-11 and DEMO-12 in their titles, which the page names.
    const { html } = render(page("acme-web #205, web PR #206, #101, PR #103, DEMO-11 and DEMO-12."));
    expect(chipIds(html)).toEqual(["acme/acme-web#205", "acme/acme-web#206", "acme/acme-api#101", "acme/acme-api#103", "DEMO-11", "DEMO-12"]);
  });

  test("a bare #n whose entry's title carries no page key gets no chip", () => {
    // #104's title names DEMO-110; the page names DEMO-11 only through its stem.
    expect(chipIds(render(page("#104 here."), "plans/demo-11-x.mdx").html)).toEqual([]);
  });

  test("a ref or key with no entry gets no chip", () => {
    expect(chipIds(render(page("acme/acme-api#999 and DEMO-99.")).html)).toEqual([]);
  });

  test("never marked: fences, inline code, attributes, headings, wikilinks", () => {
    const md = page(
      [
        "## Heading acme/acme-api#101",
        "",
        "```",
        "acme/acme-api#101 DEMO-11",
        "```",
        "",
        "Inline `acme/acme-api#101` code.",
        "",
        '<Fold summary="acme/acme-api#101 and DEMO-11">',
        "",
        "Inside.",
        "",
        "</Fold>",
        "",
        "[[acme/acme-api#101]]",
      ].join("\n"),
    );
    const out = render(md);
    expect(chipIds(out.html)).toEqual([]);
    // Not marked at all, so no entry ships: the rendered-code restore alone
    // would hide a chip in code, not keep its id out of the payload.
    expect(out.facts).toBeUndefined();
  });

  test("never marked: the state homes (StatusRows, a Status paragraph, the PR ledger)", () => {
    const md = page(
      [
        "<StatusRows>",
        "- acme/acme-api#101 i prod",
        "</StatusRows>",
        "",
        "**Status:** acme/acme-api#101 merget.",
        "",
        "PR ledger",
        "",
        "| PR | State |",
        "|---|---|",
        "| acme/acme-api#101 | merget |",
        "",
        "Prose acme/acme-api#102.",
      ].join("\n"),
    );
    expect(chipIds(render(md).html)).toEqual(["acme/acme-api#102"]);
  });

  test("history blocks and blockquotes are not homes: they get chips", () => {
    const md = page(["<Timeline>", "", "- **2026-01-05** acme/acme-api#101 merget", "", "</Timeline>", "", "> quoted acme/acme-api#102"].join("\n"));
    expect(chipIds(render(md).html)).toEqual(["acme/acme-api#101", "acme/acme-api#102"]);
  });

  test("homes are found on the string the render marks, after fact-check sentinel lines are removed", () => {
    const md = page(["<!-- factcheck:start -->", "<!-- factcheck:end -->", "Prose acme/acme-api#102.", "", "**Status:** acme/acme-api#101."].join("\n"));
    expect(chipIds(render(md).html)).toEqual(["acme/acme-api#102"]);
  });

  test("a `---` rule right after the stripped H1 is a rule, not frontmatter: the Status home under it stays unmarked", () => {
    const md = page(["# Demo", "---", "**Status:** merged acme/acme-api#101", "", "---", "", "Prose acme/acme-api#102."].join("\n"));
    expect(chipIds(render(md, "plans/demo.mdx", { stripTitle: "Demo" }).html)).toEqual(["acme/acme-api#102"]);
  });

  test("a chip adds no text to a plain-text reader: the page with chips stripped is the page without facts, Timeline lanes included", () => {
    const md = page(
      [
        "<StatusRows>", "", "- **Plan:** open", "", "</StatusRows>", "",
        "<DecisionLog>", "", "- **D1** — Ship DEMO-12: «Rename». 2026-01-05", "- **D2** — Then acme/acme-api#101: merge. 2026-01-10", "", "</DecisionLog>", "",
        "<Timeline>", "", "- **2026-01-05** — DEMO-12: «Rename»", "- **2026-01-10** — web acme/acme-api#101: merged", "", "</Timeline>",
      ].join("\n"),
    );
    const opts = { views: true, today: "2026-01-20" };
    const withChips = render(md, "plans/demo.mdx", opts).html;
    expect(chipIds(withChips).length).toBeGreaterThan(0);
    expect(withChips).toContain('title="2026-01-05: DEMO-12: «Rename»"');
    expect(stripChips(withChips)).toBe(renderWikiHtml(md, () => undefined, opts));
  });

  test("without liveFacts no chip; without prGrammar only owner-qualified forms; without trackers no key", () => {
    const md = page("api #103, acme/acme-api#101 and DEMO-11.");
    expect(renderWikiHtml(md, () => undefined)).not.toContain("fact-chip");
    let html = renderWikiHtml(md, () => undefined, { liveFacts: { loaded: loadFacts(FACTS), grammar: null, trackers: [], relPath: "plans/x.mdx" } });
    expect(chipIds(html)).toEqual(["acme/acme-api#101"]);
    html = renderWikiHtml(md, () => undefined, { liveFacts: { loaded: loadFacts(FACTS), grammar: GRAMMAR, trackers: [], relPath: "plans/x.mdx" } });
    expect(chipIds(html)).toEqual(["acme/acme-api#103", "acme/acme-api#101"]);
  });

  test("a PR id is matched ignoring case and keeps the case the page writes", () => {
    expect(chipIds(render(page("ACME/Acme-Api#101")).html)).toEqual(["ACME/Acme-Api#101"]);
  });

  test("one site, one PR in two spellings: one chip, in the first spelling", () => {
    const { html } = render(page("See [acme/acme-api#101](https://github.com/Acme/acme-api/pull/101) today."));
    expect(chipIds(html)).toEqual(["acme/acme-api#101"]);
  });
});

describe("mention forms the reader renders (fix round 1, k5)", () => {
  const chipFor = (id: string) => `<span class="fact-chip" data-live-fact="${id}" data-reader-only></span>`;

  test("an angle autolink is marked, its chip after the link", () => {
    const { html } = render(page("See <https://github.com/acme/acme-api/pull/101> now."));
    expect(html).toContain(`rel="noopener">https://github.com/acme/acme-api/pull/101</a>${chipFor("acme/acme-api#101")} now`);
  });

  test("a stray `<b` in prose opens no tag that hides a later mention", () => {
    const { html } = render(page("if a <b and it's x then acme/acme-api#101 ok ' b>"));
    expect(chipIds(html)).toEqual(["acme/acme-api#101"]);
  });

  test("fences are the reader's: an unclosed backtick fence and a `~~~` block stay prose and get chips", () => {
    expect(chipIds(render(page("```\nnever closed\n\nacme/acme-api#101 here.")).html)).toEqual(["acme/acme-api#101"]);
    expect(chipIds(render(page("~~~\nacme/acme-api#102\n~~~")).html)).toEqual(["acme/acme-api#102"]);
  });

  test("a reference link prints literally: its chip after `[…][…]`, and the definition's URL is a bare URL", () => {
    const { html } = render(page("See [api #101][r] now.\n\n[r]: https://github.com/acme/acme-api/pull/102"));
    expect(html).toContain(`[api #101][r]${chipFor("acme/acme-api#101")} now`);
    expect(html).toContain(`pull/102${chipFor("acme/acme-api#102")}`);
  });

  test("an id only in a link's title gets no chip", () => {
    const out = render(page('[lenke](https://example.com "api #103") here.'));
    expect(chipIds(out.html)).toEqual([]);
    expect(out.facts).toBeUndefined();
  });

  test("underscore italics read as `*…*` do: `_api #103_` and `_DEMO-12_` get chips inside the em", () => {
    const { html } = render(page("Both _api #103_ and _DEMO-12_ merged."));
    expect(html).toContain(`<em>api #103${chipFor("acme/acme-api#103")}</em>`);
    expect(html).toContain(`<em>DEMO-12${chipFor("DEMO-12")}</em>`);
    // Not italics in the reader (a word character outside): DEMO-12 is a whole
    // key there, and its chip, parked before the `2` (sweep B, `chipShifts`),
    // leaves that literal `_` literal.
    const literal = render(page("x_DEMO-12_ y")).html;
    expect(literal).toContain(`x_DEMO-12${chipFor("DEMO-12")}_ y`);
    expect(stripChips(literal)).toBe(renderWikiHtml(page("x_DEMO-12_ y"), () => undefined));
  });
});

describe("link spans and emphasis (fix round 2)", () => {
  const chipFor = (id: string) => `<span class="fact-chip" data-live-fact="${id}" data-reader-only></span>`;
  const pull = (n: number) => `https://github.com/acme/acme-api/pull/${n}`;

  test("autolinks inside a reference link are the reference link's: every chip after `][r]`, in text order", () => {
    const { html } = render(page(`See [<${pull(101)}> <${pull(102)}> <${pull(103)}>][r] now.`));
    expect(html).toContain(`][r]${chipFor("acme/acme-api#101")}${chipFor("acme/acme-api#102")}${chipFor("acme/acme-api#103")} now`);
    expect(chipIds(html)).toEqual(["acme/acme-api#101", "acme/acme-api#102", "acme/acme-api#103"]);
  });

  test("a bare URL ending in emphasis the reader opens inside it: the chip after the `</em>`, never inside", () => {
    expect(render(page(`At ${pull(101)}?x=_a_ now.`)).html).toContain(`?x=<em>a</em>${chipFor("acme/acme-api#101")} now`);
    expect(render(page(`At ${pull(101)}?x=**a** now.`)).html).toContain(`?x=<strong>a</strong>${chipFor("acme/acme-api#101")} now`);
    // Emphasis opened before the URL holds the chip, and trailing punctuation stays out.
    expect(render(page(`_see ${pull(101)}_ ok`)).html).toContain(`pull/101${chipFor("acme/acme-api#101")}</em> ok`);
    expect(render(page(`At ${pull(101)}. Done`)).html).toContain(`pull/101${chipFor("acme/acme-api#101")}. Done`);
  });
});

describe("pinned edges (fix round 2: each kills a named mutant)", () => {
  test("a mention followed directly by a tag is not inside it: both mentions chip", () => {
    expect(chipIds(render(page("See acme/acme-api#101<br/> and acme/acme-api#102")).html)).toEqual(["acme/acme-api#101", "acme/acme-api#102"]);
  });

  test("a mention inside a tag that also holds a wikilink gets no chip", () => {
    expect(chipIds(render(page('<T a="[[p|x]] acme/acme-api#101 z"> ok')).html)).toEqual([]);
  });

  test("adjacent claims are both accepted", () => {
    const url = (n: number) => `github.com/acme/acme-api/pull/${n}`;
    expect(prMentions(`${url(101)}${url(102)}`, GRAMMAR, null).map((m) => m.id)).toEqual(["acme/acme-api#101", "acme/acme-api#102"]);
  });

  test("a digit run past 2^53 is looked up by the id it rounds to", () => {
    const big = "acme/acme-api#9007199254740992";
    const loaded = loadFacts({ version: 1, prs: { [big]: FACTS.prs["acme/acme-api#101"]! }, keys: {} });
    const md = page("Then acme/acme-api#9007199254740993 landed.");
    const r = planLiveChips(readerBody(md), md, { loaded, grammar: GRAMMAR, trackers: TRACKERS, relPath: "plans/demo.mdx" });
    expect(r.insertions.flatMap((s) => s.ids.map((x) => x.id))).toEqual([big]);
  });

  test("a quoted attribute value never spans lines: a multi-line `<Fold summary=…` prints literally and keeps its chip", () => {
    const { html } = render(page('<Fold summary="see acme/acme-api#101\nmore">\n\nInside.\n\n</Fold>'));
    expect(html).toContain("&lt;Fold summary=&quot;see acme/acme-api#101<span");
    expect(chipIds(html)).toEqual(["acme/acme-api#101"]);
  });

  test("an `_` inside inline code is no italic delimiter: `_api #103 `x_y` z_` keeps its chip", () => {
    expect(render(page("Both _api #103 `x_y` z_ ok")).html).toContain('<em>api #103<span class="fact-chip" data-live-fact="acme/acme-api#103"');
  });

  test("the page key set is the sweep's, read on the body: `_DEMO-12_` does not admit a bare #103", () => {
    // #103's title carries DEMO-12; the sweep's key pattern does not see it between underscores.
    expect(chipIds(render(page("Both _DEMO-12_ and #103")).html)).toEqual(["DEMO-12"]);
  });

  test("a reference link overlapping an inline link is no span: the link stays intact, the chip after the mention", () => {
    const { html } = render(page("[api #101][b](https://e.com)"));
    expect(html).toContain('[api #101<span class="fact-chip" data-live-fact="acme/acme-api#101" data-reader-only></span>]<a href="https://e.com" target="_blank" rel="noopener">b</a>');
  });

  // `_DEMO-12_y`: a whole key since fix round 2 batch 3; its chip leaves the literal `_` literal (sweep B).
  test("an `_` followed by a word character closes no italics: `_api #103_x` is no mention, `_DEMO-12_y` chips with no italics", () => {
    const md = page("_api #103_x and _DEMO-12_y");
    const { html } = render(md);
    expect(chipIds(html)).toEqual(["DEMO-12"]);
    expect(html).not.toContain("<em>");
    expect(stripChips(html)).toBe(renderWikiHtml(md, () => undefined));
  });
});

describe("a repo or alias form the grammar cannot qualify (no owner)", () => {
  const OWNERLESS = { owner: null, aliases: { web: "acme-web", other: "acme/other" }, noProd: [] };
  const home = "acme/acme-api";
  // The sweep's repo form always claims its span (it qualifies under a
  // default owner); with no owner muninn has no id for it, but the bare form
  // must not take the `#n` inside it and resolve it under the home repo.
  for (const text of ["acme-web #101", "web #101", "acme-web PR #101", "web#101"])
    test(`«${text}» gives no mention, never the home repo's #101`, () => {
      expect(prMentions(`Then ${text} landed.`, OWNERLESS, home)).toEqual([]);
    });

  test("a bare #n beside it still resolves under the home repo, and an alias to owner/repo still qualifies", () => {
    expect(prMentions("web #101, #102 and other #77", OWNERLESS, home).map((m) => [m.id, m.form])).toEqual([
      ["acme/acme-api#102", "bare"],
      ["acme/other#77", "alias"],
    ]);
  });

  test("the chip pass places no chip for it (a bare #101 on the same page would get one)", () => {
    const plan = (text: string) => {
      const md = page(`For DEMO-11: then ${text} landed.`, "repos: [acme/acme-api]\n");
      return planLiveChips(readerBody(md), md, { loaded: loadFacts(FACTS), grammar: OWNERLESS, trackers: [], relPath: "plans/demo.mdx" }).insertions;
    };
    expect(plan("#101").flatMap((s) => s.ids.map((x) => x.id))).toEqual(["acme/acme-api#101"]);
    expect(plan("web #101")).toEqual([]);
  });
});

describe("the payload's facts", () => {
  test("the marked PRs' entries, the marked keys' entries and every PR in their lists", () => {
    const { facts } = render(page("acme/acme-api#103 and DEMO-11."));
    expect(Object.keys(facts!.keys)).toEqual(["DEMO-11"]);
    expect(Object.keys(facts!.prs).sort()).toEqual(["acme/acme-api#101", "acme/acme-api#102", "acme/acme-api#103", "acme/acme-e2e#7"]);
    expect(facts!.noProd).toEqual(["acme/acme-e2e"]);
  });

  test("one entry per PR, under the facts file's id, whatever spellings the page uses; every chip still reads it", () => {
    const now = Date.parse("2026-01-21T08:00:00Z");
    const { html, facts } = render(page("ACME/Acme-Api#101, then acme/acme-api#101 and DEMO-11."));
    expect(Object.keys(facts!.prs).sort()).toEqual(["acme/acme-api#101", "acme/acme-api#102", "acme/acme-e2e#7"]);
    expect(chipIds(html)).toEqual(["ACME/Acme-Api#101", "acme/acme-api#101", "DEMO-11"]);
    for (const id of chipIds(html)) expect([id, chipView(id!, facts!, now, "no")?.text ?? null]).not.toEqual([id, null]);
    expect(chipView("ACME/Acme-Api#101", facts!, now, "no")?.text).toBe(chipView("acme/acme-api#101", facts!, now, "no")!.text);
  });

  test("no chip ⇒ no payload", () => {
    expect(render(page("nothing here")).facts).toBeUndefined();
  });

  test("planLiveChips places nothing for a key or ref with no entry", () => {
    const r = planLiveChips(readerBody(page("DEMO-13x and DEMO-99")), page(""), { loaded: loadFacts(FACTS), grammar: GRAMMAR, trackers: TRACKERS, relPath: "a.mdx" });
    expect(r.insertions).toEqual([]);
  });
});

describe("chip text (core/live-facts-chip.ts)", () => {
  const now = Date.parse("2026-01-21T08:00:00Z");
  const payload = (ids: string[], keys: string[] = []): LiveFactsPayload => ({
    prs: Object.fromEntries(ids.map((id) => [id, FACTS.prs[id]!])),
    keys: Object.fromEntries(keys.map((k) => [k, FACTS.keys[k]!])),
    noProd: ["acme/acme-e2e"],
  });

  test("a PR: state, prod part, age; a noProd repo the state alone; English", () => {
    expect(chipView("acme/acme-api#101", payload(["acme/acme-api#101"]), now, "no")?.text).toBe("merget · i prod 26.006.120000 · 1 d");
    expect(chipView("acme/acme-e2e#7", payload(["acme/acme-e2e#7"]), now, "no")?.text).toBe("merget · 1 d");
    expect(chipView("acme/acme-api#108", payload(["acme/acme-api#108"]), now, "no")?.text).toBe("merget · ? · 1 d");
    expect(chipView("acme/acme-api#102", payload(["acme/acme-api#102"]), now, "en")?.text).toBe("merged · not in prod · 1 d");
    expect(chipView("acme/acme-web#206", payload(["acme/acme-web#206"]), now, "no")?.text).toBe("lukket · 1 d");
  });

  test("a key: Jira status with its date, then the summary over its PRs, oldest age", () => {
    const p = payload(["acme/acme-api#101", "acme/acme-api#102", "acme/acme-e2e#7"], ["DEMO-11"]);
    expect(chipView("DEMO-11", p, now, "no")?.text).toBe("1 av 2 i prod · 1 d");
    expect(chipView("DEMO-11", p, now, "no", { status: "Under utvikling", updated: "2026-01-19T10:00:00Z" })?.text).toBe("Under utvikling 19.01 · 1 av 2 i prod · 1 d");
  });

  test("a key whose only other PR is noProd reads «i prod»; one in prod plus one closed unmerged reads «i prod»", () => {
    const p: LiveFactsPayload = { prs: { "acme/acme-web#210": FACTS.prs["acme/acme-web#210"]!, "acme/acme-web#211": FACTS.prs["acme/acme-web#211"]!, "acme/acme-e2e#7": FACTS.prs["acme/acme-e2e#7"]! }, keys: { "DEMO-16": FACTS.keys["DEMO-16"]!, X: { prs: ["acme/acme-web#210", "acme/acme-e2e#7"] } }, noProd: ["acme/acme-e2e"] };
    expect(chipView("DEMO-16", p, now, "no")?.text).toBe("i prod · 1 d");
    expect(chipView("X", p, now, "no")?.text).toBe("i prod · 1 d");
  });

  test("a key with no counted PR: Jira status alone, or no chip", () => {
    const p = payload([], ["DEMO-13"]);
    expect(chipView("DEMO-13", p, now, "no")).toBeNull();
    expect(chipView("DEMO-13", p, now, "no", { status: "Ferdig" })?.text).toBe("Ferdig");
  });

  test("an entry older than 7 days dims; today reads «i dag»", () => {
    const p = payload(["acme/acme-web#205"]);
    expect(chipView("acme/acme-web#205", p, Date.parse("2026-01-19T08:00:00Z"), "no")).toMatchObject({ text: "draft · 7 d", dim: false });
    expect(chipView("acme/acme-web#205", p, Date.parse("2026-01-20T08:00:00Z"), "no")).toMatchObject({ text: "draft · 8 d", dim: true });
    expect(chipView("acme/acme-api#103", payload(["acme/acme-api#103"]), Date.parse("2026-01-20T09:00:00Z"), "no")).toMatchObject({ text: "åpen · i dag", dim: false });
  });
});

describe("readWikiFacts", () => {
  let root = "";
  const warnings: string[] = [];
  const warn = (r: string) => warnings.push(r);
  beforeEach(async () => {
    resetWikiFactsCache();
    warnings.length = 0;
    if (root) await rm(root, { recursive: true, force: true });
    root = await testTempDir(path.join(tmpdir(), "live-facts-"));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  const file = () => path.join(root, ".wiki-facts.json");

  test("no file: null and no warning", async () => {
    expect(await readWikiFacts(root, warn)).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("a valid file loads", async () => {
    await writeFile(file(), JSON.stringify(FACTS));
    expect((await readWikiFacts(root, warn))?.facts.prs["acme/acme-api#101"]?.state).toBe("MERGED");
  });

  test("a malformed file or another version: null, one warning per change of the file", async () => {
    await writeFile(file(), "{ not json");
    expect(await readWikiFacts(root, warn)).toBeNull();
    expect(await readWikiFacts(root, warn)).toBeNull();
    expect(warnings.length).toBe(1);
    await writeFile(file(), JSON.stringify({ ...FACTS, version: 2 }));
    expect(await readWikiFacts(root, warn)).toBeNull();
    expect(await readWikiFacts(root, warn)).toBeNull();
    expect(warnings.length).toBe(2);
    expect(warnings[1]).toContain("version 1");
    // A different size: two writes inside one mtime tick are told apart by size.
    await writeFile(file(), JSON.stringify(FACTS, null, 1));
    expect(await readWikiFacts(root, warn)).not.toBeNull();
    await unlink(file());
    expect(await readWikiFacts(root, warn)).toBeNull();
    expect(warnings.length).toBe(2);
  });

  test("a same-size rewrite that keeps the mtime is a change of the file", async () => {
    // A whole-second mtime, so putting it back is exact.
    const T = 1_767_000_000;
    await writeFile(file(), JSON.stringify({ ...FACTS, version: 2 }));
    await utimes(file(), T, T);
    expect(await readWikiFacts(root, warn)).toBeNull();
    // Same size, mtime put back: only ctime (and the content) moved.
    const before = await stat(file());
    await writeFile(file(), JSON.stringify({ ...FACTS, version: 1 }));
    await utimes(file(), T, T);
    const after = await stat(file());
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(await readWikiFacts(root, warn)).not.toBeNull();
  });

  test.skipIf(isRoot)("a chmod is a change of the file: unreadable gives null, readable again loads", async () => {
    await writeFile(file(), JSON.stringify(FACTS));
    expect(await readWikiFacts(root, warn)).not.toBeNull();
    await chmod(file(), 0o000);
    expect(await readWikiFacts(root, warn)).toBeNull();
    await chmod(file(), 0o644);
    expect(await readWikiFacts(root, warn)).not.toBeNull();
  });

  describe("with ctime pinned (a test cannot set it), each other part of the signature alone is a change", () => {
    afterAll(() => __setWikiFactsStatForTest(null));
    const pinCtime = () => {
      let ctimeNs: bigint | undefined;
      __setWikiFactsStatForTest(async (real, f) => {
        const st = await real(f);
        ctimeNs ??= st.ctimeNs;
        return { ino: st.ino, mtimeNs: st.mtimeNs, size: st.size, ctimeNs };
      });
    };
    const T = 1_767_000_000;

    test("a new inode with the same size and mtime (renamed over) is re-read", async () => {
      pinCtime();
      await writeFile(file(), JSON.stringify({ ...FACTS, version: 2 }));
      await utimes(file(), T, T);
      expect(await readWikiFacts(root, warn)).toBeNull();
      const next = path.join(root, "next.json");
      await writeFile(next, JSON.stringify({ ...FACTS, version: 1 }));
      await utimes(next, T, T);
      const before = await stat(file());
      await rename(next, file());
      const after = await stat(file());
      expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
      expect(after.ino).not.toBe(before.ino);
      expect(await readWikiFacts(root, warn)).not.toBeNull();
    });

    test("an mtime moved by less than a millisecond is re-read", async () => {
      pinCtime();
      await writeFile(file(), JSON.stringify({ ...FACTS, version: 2 }));
      await utimes(file(), T + 0.0001, T + 0.0001);
      expect(await readWikiFacts(root, warn)).toBeNull();
      // Same size, same file, mtime 0.1 ms later: the same whole millisecond.
      await writeFile(file(), JSON.stringify({ ...FACTS, version: 1 }));
      await utimes(file(), T + 0.0002, T + 0.0002);
      const st = await stat(file(), { bigint: true });
      expect(st.mtimeNs / 1_000_000n).toBe(BigInt(T) * 1000n);
      expect(await readWikiFacts(root, warn)).not.toBeNull();
    });
  });

  test("a not-JSON file: null, and the warning is the not-JSON reason", async () => {
    await writeFile(file(), '{"version": 1, "prs": {');
    expect(await readWikiFacts(root, warn)).toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/^not JSON: /)]);
    expect(parseWikiFacts("{ not json")).toEqual({ error: expect.stringMatching(/^not JSON: /) });
  });

  test("page opens that miss together share one read: one warning per change", async () => {
    await writeFile(file(), JSON.stringify({ ...FACTS, version: 2 }));
    const all = await Promise.all([readWikiFacts(root, warn), readWikiFacts(root, warn), readWikiFacts(root, warn)]);
    expect(all).toEqual([null, null, null]);
    expect(warnings.length).toBe(1);
  });

  test("a key list naming a missing entry is an error", () => {
    expect(parseWikiFacts(JSON.stringify({ version: 1, prs: {}, keys: { "DEMO-1": { prs: ["a/b#1"] } } }))).toEqual({ error: "keys.DEMO-1.prs names a/b#1, which has no prs entry" });
  });
});

// ── Key marks (Discuss v2 PR 6, D5) ──────────────────────────────────────────

describe("key marks: the page's keys underlined for the hover peek", () => {
  const KINDS = parseKeyKinds([{ name: "case", pattern: "MEL-\\d+" }]).kinds;
  const marks = { grammar: GRAMMAR, trackers: TRACKERS, kinds: KINDS, relPath: "plans/demo.mdx" };
  const markIds = (html: string) => [...html.matchAll(/<span class="wiki-key" data-wiki-key="([^"]+)">\1<\/span>/g)].map((m) => m[1]);

  test("tracker keys and `keys` kinds are marked; the text the reader reads is unchanged", () => {
    const md = page("DEMO-20 and MEL-1029036 are open; MEL-5x is not a key.");
    const html = renderWikiHtml(md, () => undefined, { keyMarks: marks });
    expect(markIds(html)).toEqual(["DEMO-20", "MEL-1029036"]);
    expect(html.replace(/<[^>]+>/g, "")).toBe(renderWikiHtml(md, () => undefined).replace(/<[^>]+>/g, ""));
  });

  test("never in a never-marked region: code spans and fences, a heading, a wikilink, a tag's attribute, a link or a bare URL", () => {
    const body = [
      "## MEL-1 in a heading",
      "",
      "`MEL-2` in a span, and [MEL-3](https://jira.example/MEL-3), and https://x.example/MEL-4 too, and [[MEL-5|the MEL-5 page]].",
      "",
      "```",
      "MEL-6 in a fence",
      "```",
      "",
      '<Fold title="MEL-7">',
      "",
      "MEL-8 in prose.",
      "",
      "</Fold>",
    ].join("\n");
    const { marks: got } = planKeyMarks(readerBody(page(body), "Demo"), page(body), marks);
    expect(got.map((m) => m.key)).toEqual(["MEL-8"]);
  });

  test("a key with its own fact chip is marked too, the chip right after the mark: the reader hides a chip with nothing to show, and the key keeps a target (fix round 1 J1)", () => {
    const { html } = render(page("DEMO-12 has facts, DEMO-20 has none."), "plans/demo.mdx", { keyMarks: marks });
    expect(chipIds(html)).toEqual(["DEMO-12"]);
    expect(markIds(html)).toEqual(["DEMO-12", "DEMO-20"]);
    expect(html).toContain('<span class="wiki-key" data-wiki-key="DEMO-12">DEMO-12</span><span class="fact-chip" data-live-fact="DEMO-12" data-reader-only></span> has facts');
  });

  test("marks and chips share one pass: a mark right before a PR chip keeps both in text order", () => {
    const { html } = render(page("MEL-9 acme/acme-api#101 merged."), "plans/demo.mdx", { keyMarks: marks });
    expect(html).toContain('<span class="wiki-key" data-wiki-key="MEL-9">MEL-9</span> acme/acme-api#101<span class="fact-chip" data-live-fact="acme/acme-api#101"');
  });

  test("a key must start with a letter: a `keys` kind's digit-first match (12-MEL, 1.2) is not marked, a letter-first one is (fix round 2 batch 4)", () => {
    const kinds = parseKeyKinds([{ name: "rel", pattern: "\\d{2}-MEL" }, { name: "ver", pattern: "\\d\\.\\d" }, { name: "tag", pattern: "V\\d\\.\\d" }]).kinds;
    expect(kinds.map((k) => k.name)).toEqual(["rel", "ver", "tag"]);
    const body = "Release 12-MEL ships 1.2 as V3.4.";
    const { marks: got } = planKeyMarks(body, body, { grammar: null, trackers: [], kinds, relPath: "x.md" });
    expect(got.map((m) => m.key)).toEqual(["V3.4"]);
  });

  test("without trackers or kinds nothing is scanned (mimir's case)", () => {
    expect(planKeyMarks("MEL-1 DEMO-2", "MEL-1 DEMO-2", { grammar: null, trackers: [], kinds: [], relPath: "x.md" })).toEqual({ marks: [], skippedLines: 0, skippedChars: 0 });
  });

  test("a line over the scan bound is skipped for the `keys` kinds and counted", () => {
    const long = `${"word ".repeat(KEY_SCAN_LINE_MAX / 5)} MEL-10`;
    const r = planKeyMarks(`${long}\nMEL-11`, `${long}\nMEL-11`, marks);
    expect(r.marks.map((m) => m.key)).toEqual(["MEL-11"]);
    expect(r.skippedLines).toBe(1);
  });
});

// ── Key marks change nothing but the wrapper (fix round 1, G3) ───────────────

describe("key marks: the marked render is the unmarked render plus the wrappers", () => {
  const KINDS = parseKeyKinds([{ name: "case", pattern: "MEL-\\d+" }]).kinds;
  const marks = { grammar: GRAMMAR, trackers: TRACKERS, kinds: KINDS, relPath: "plans/demo.mdx" };
  const unwrap = (html: string) => html.replace(/<span class="wiki-key" data-wiki-key="[^"]*">([^<]*)<\/span>/g, "$1");
  // The page route's reader options: number columns and the views read the text too.
  const both = (md: string) => {
    const marked = renderWikiHtml(md, () => undefined, { views: true, readerShapes: true, keyMarks: marks });
    return { marked, plain: renderWikiHtml(md, () => undefined, { views: true, readerShapes: true }) };
  };

  test("emphasis right after a key keeps its meaning: MEL-12*34*, a table cell's MEL-22*n*, DEMO-2*w*", () => {
    for (const [body, key] of [
      ["A MEL-12*34* b", "MEL-12"],
      ["| a | b |\n|---|---|\n| MEL-22*n* | x |", "MEL-22"],
      ["See DEMO-2*w* here.", "DEMO-2"],
    ] as const) {
      const { marked, plain } = both(page(body));
      expect(marked).toContain(`data-wiki-key="${key}"`);
      expect(marked).not.toContain("<em>");
      expect(unwrap(marked)).toBe(plain);
    }
  });

  test("every neighbour an inline rule reads sees the page's own characters", () => {
    const bodies = [
      "*MEL-1*", "**MEL-2**", "_MEL-3_", "~~MEL-4~~", "MEL-5_x_", "x_MEL-6_ y", "`a`MEL-7", "MEL-8`b`", "[MEL-9]", "(MEL-10)",
      "MEL-11\\*x*", "<MEL-12>", "MEL-13 → 14", "1 → MEL-15", "MEL-16 -> 17", "MEL-17 → 18 ms", "- MEL-18 item", "> MEL-19 quote",
      "MEL-20: x", "MEL-21.", "**MEL-22*x***", "*a MEL-23*b*", "MEL-24~~s~~", "MEL-25*", "*MEL-26", "_MEL-27", "MEL-28_",
      "DEMO-29_a_", "*DEMO-30*x*", "a*DEMO-31*", "MEL-32 → MEL-33", "[[MEL-34]] MEL-35*a*", "| MEL-36 | 1 → 2 |\n|---|---|\n| x | y |",
      // A number column with a key in a cell's short note (melosys-kode-wiki, `skarp-2024-2025-rapport`).
      "| Kjøring | Hoppet over |\n|---|---:|\n| a | 0 |\n| b | 1 (MEL-604246) |",
    ];
    let markedCount = 0;
    for (const body of bodies) {
      const { marked, plain } = both(page(body));
      markedCount += (marked.match(/class="wiki-key"/g) ?? []).length;
      expect([body, unwrap(marked)]).toEqual([body, plain]);
    }
    expect(markedCount).toBeGreaterThan(25);
  });

  test("a number column reads only a sentinel with no text AND no source as nothing: a wikilink that shows no text still counts (fix round 2 batch 4)", () => {
    const table = (cell: string) => page(`| Kjøring | Hoppet over |\n|---|---:|\n| a | 0 |\n| b | 1 ${cell} |`);
    // A key mark's two sentinels (empty text, empty source): still a number column.
    expect(both(table("(MEL-604246)")).marked).toContain('<th class="num">Hoppet over</th>');
    // `[[ ]]` parks a sentinel with empty link text but its source `[[ ]]`: not a number.
    const { marked, plain } = both(table("[[ ]]"));
    expect(marked).toContain("<th>Hoppet over</th>");
    expect(plain).toContain("<th>Hoppet over</th>");
  });

  test("a key with no `-` or `.` join is an item id's shape and is not marked: the decision log keeps its ids", () => {
    const idKinds = { ...marks, kinds: parseKeyKinds([{ name: "id", pattern: "[A-Z]\\d{1,3}" }, { name: "case", pattern: "MEL-\\d+" }]).kinds };
    const md = page(["<DecisionLog>", "", "- **D12** — Ship MEL-7 and D12 in prose.", "", "</DecisionLog>"].join("\n"));
    const marked = renderWikiHtml(md, () => undefined, { views: true, keyMarks: idKinds });
    expect([...marked.matchAll(/data-wiki-key="([^"]+)"/g)].map((m) => m[1])).toEqual(["MEL-7"]);
    expect(unwrap(marked)).toBe(renderWikiHtml(md, () => undefined, { views: true }));
    expect(marked).toContain('id="d12"');
  });

  test("a mark's placeholders become its span only around the key's own text in one run; otherwise they are dropped", () => {
    const o = keyMarkOpen(0);
    const c = keyMarkClose(0);
    expect(wrapKeyMarks(`a M${o}EL-1${c}2 b`, ["MEL-12"])).toBe('a <span class="wiki-key" data-wiki-key="MEL-12">MEL-12</span> b');
    expect(wrapKeyMarks(`a M${o}EL<em>-1</em>${c}2 b`, ["MEL-12"])).toBe("a MEL<em>-1</em>2 b");
    expect(wrapKeyMarks(`a M${o}EL-1${c}3 b`, ["MEL-12"])).toBe("a MEL-13 b");
    expect(wrapKeyMarks(`a M${o}EL-1 b`, ["MEL-12"])).toBe("a MEL-1 b");
  });

  test("generated KEY<punct>… strings: parity on every one", () => {
    const tokens = ["MEL-12", "DEMO-3", "MEL-4", "*", "**", "_", "~~", "~", "`", "<", ">", "\\", "[", "]", "(", ")", " ", "a", "æ", "1", "-", "→", "->", "|", "#", ".", ":", "https://x.example/", "&", "\n"];
    let seed = 20261126;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let markedCount = 0;
    for (let n = 0; n < 1500; n++) {
      const len = 3 + Math.floor(next() * 10);
      let body = "";
      for (let i = 0; i < len; i++) body += tokens[Math.floor(next() * tokens.length)];
      const { marked, plain } = both(page(`x ${body} y`));
      markedCount += (marked.match(/class="wiki-key"/g) ?? []).length;
      expect([body, unwrap(marked)]).toEqual([body, plain]);
    }
    expect(markedCount).toBeGreaterThan(300);
  });
});
