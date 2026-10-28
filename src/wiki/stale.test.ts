import { test, expect, describe } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bucketFor,
  isChangedPage,
  isLivingPage,
  linkingBuckets,
  linkingCounts,
  movedWith,
  pageLastChangeMs,
  parseStaleAsOf,
  hasDateDM,
  passageClaim,
  resolveStatusLineHits,
  staleSummary,
  stalePageReport,
  statusLineCandidates,
  statusWordsIn,
  type StatusLineCandidate,
} from "./stale.ts";
import { buildWikiIndex, type WikiIndex, type WikiPageMeta } from "./store.ts";
import { lintWiki } from "./lint.ts";
import { renderWikiHtml } from "./render.ts";
import { testTempDir } from "../test/temp-dir.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-06-15T12:00:00Z");

describe("status words (D18)", () => {
  test("English and Norwegian, with edges that hold on æøå", () => {
    expect(statusWordsIn("is shipped now")).toEqual(["shipped"]);
    expect(statusWordsIn("arbeidet pågår")).toEqual(["in-flight"]);
    expect(statusWordsIn("en åpen PR")).toEqual(["in-flight"]);
    expect(statusWordsIn("foreslått i går")).toEqual(["proposed"]);
    expect(statusWordsIn("blokkert av X")).toEqual(["blocked"]);
    // A word inside a longer word is no status word.
    expect(statusWordsIn("undone, shippedness, draftsman")).toEqual([]);
    expect(statusWordsIn("ferdigheter")).toEqual([]);
  });

  test("merget and merged are shipped unless negated, and the negation is in-flight", () => {
    expect(statusWordsIn("PR-en er merget")).toEqual(["shipped"]);
    expect(statusWordsIn("ikke merget ennå")).toEqual(["in-flight"]);
    expect(statusWordsIn("not merged")).toEqual(["in-flight"]);
    expect(statusWordsIn("merged into main")).toEqual(["shipped"]);
  });

  test("a negation reads through a whitespace run and one adverb, and cancels every shipped word (F7a)", () => {
    for (const t of ["not yet merged", "ikke  merget", "ikke ennå merget", "ikke enda merget", "still not merged", "not still merged", "ikke fortsatt merget"]) {
      expect([t, statusWordsIn(t)]).toEqual([t, ["in-flight"]]);
    }
    for (const t of ["not yet shipped", "ikke levert", "ikke ennå ferdig", "not done"]) expect([t, statusWordsIn(t)]).toEqual([t, []]);
    // A negation word ending a longer word, or two adverbs, negates nothing.
    expect(statusWordsIn("cannot merged")).toEqual(["shipped"]);
    expect(statusWordsIn("not yet still merged")).toEqual(["shipped"]);
  });

  test("open PRs and åpen PR-er are in-flight (F7b)", () => {
    for (const t of ["two open PRs", "åpen PR-er", "en åpen PR", "an open PR"]) expect([t, statusWordsIn(t)]).toEqual([t, ["in-flight"]]);
    expect(statusWordsIn("open PRsx")).toEqual([]);
    // The prefilter lets the plural through to the segment parse.
    expect(statusLineCandidates("[[x]] har to open PRs\n").map((c) => c.said)).toEqual([["in-flight"]]);
  });

  test("plural «åpne PR-er/PR-ene» is in-flight; bare «åpne PR» and «åpne PR-en» are the verb (class check)", () => {
    for (const t of ["sjekk åpne PR-er", "de åpne PR-ene", "Åpne PR-er:"]) expect([t, statusWordsIn(t)]).toEqual([t, ["in-flight"]]);
    for (const t of ["Åpne PR-en.", "åpne PR", "åpne PR-en mot main"]) expect([t, statusWordsIn(t)]).toEqual([t, []]);
    // Accepted loss: the verb with a plural object still reads as in-flight.
    expect(statusWordsIn("kan åpne PR-er")).toEqual(["in-flight"]);
    expect(statusLineCandidates("[[x]] — sjekk åpne PR-er\n").map((c) => c.said)).toEqual([["in-flight"]]);
    expect(statusLineCandidates("[[x]] — Åpne PR-en.\n")).toEqual([]);
  });
});

const fm = (extra = "") => `---\ntitle: Page\n${extra}---\n`;

describe("statusLineCandidates (phase A)", () => {
  test("a status word between a link and the next link on its line", () => {
    const c = statusLineCandidates(`${fm()}\n- [[plan-a]] is shipped, see [[plan-b]] for the rest\n`);
    expect(c.map((x) => [x.line, x.target, x.said])).toEqual([[5, "plan-a", ["shipped"]]]);
  });

  test("anchor and escapes are dropped from the target; a bare anchor is no target", () => {
    const c = statusLineCandidates("[[plan-a#Status|the plan]] is blocked. [[#local]] is done\n");
    expect(c.map((x) => x.target)).toEqual(["plan-a"]);
  });

  test("check 14's masks: fences, blockquotes, table headers, history blocks", () => {
    const body = [
      fm(),
      "```",
      "[[plan-a]] shipped",
      "```",
      "> [[plan-a]] shipped",
      "",
      "| [[plan-a]] shipped | b |",
      "|---|---|",
      "| [[plan-a]] blocked | b |",
      "",
      "<Timeline>",
      "- [[plan-a]] proposed",
      "</Timeline>",
      "",
      "<Historic>",
      "[[plan-a]] proposed",
      "</Historic>",
      "",
      "[[plan-a]] in-flight",
    ].join("\n");
    const c = statusLineCandidates(body);
    expect(c.map((x) => x.said[0])).toEqual(["blocked", "in-flight"]);
  });

  test("a Status home is NOT exempt — that is where a stale status sits", () => {
    const c = statusLineCandidates(`${fm()}\n**Status:** [[plan-a]] is shipped.\n`);
    expect(c).toHaveLength(1);
  });

  test("the first body line straight after the closing fence is body, not frontmatter, LF and CRLF alike", () => {
    for (const page of ["---\ntitle: T\n---\n- [[p]] proposed\n", "---\r\ntitle: T\r\n---\r\n- [[p]] proposed\r\n"]) {
      const c = statusLineCandidates(page);
      expect(c.map((x) => [x.line, x.target, x.said, x.frontmatter])).toEqual([[4, "p", ["proposed"], undefined]]);
    }
  });

  test("this check's own exemptions: inline code, strikethrough, title/description/status_note, a markdown link in the segment", () => {
    const body = [
      "---",
      "title: About [[plan-a]] shipped",
      "description: >",
      "  [[plan-a]] shipped",
      "status_note: [[plan-a]] shipped",
      "tags: [x]",
      "---",
      "`[[plan-a]] shipped` in code",
      "~~[[plan-a]] shipped~~ struck",
      "[[plan-a]] ~~shipped~~ struck word",
      "[[plan-a]] see [notes](x.md) shipped",
      "[[plan-a]] shipped for real",
    ].join("\n");
    const c = statusLineCandidates(body);
    expect(c.map((x) => x.line)).toEqual([12]);
  });

  test("a markdown link the masks remove does not drop the segment (F1)", () => {
    // The `](` sits inside inline code or a struck span: masked away, so the
    // segment holds no markdown link and the status word is a candidate.
    expect(statusLineCandidates("[[plan-a]] is in-flight, see `[x](y.md)`\n").map((x) => x.said)).toEqual([["in-flight"]]);
    expect(statusLineCandidates("[[plan-a]] is in-flight ~~[old](y.md)~~\n").map((x) => x.said)).toEqual([["in-flight"]]);
  });

  test("a struck span holding inline code or a single `~` is struck whole (F1)", () => {
    expect(statusLineCandidates("[[plan-a]] ~~shipped `v2`~~ in-flight\n").map((x) => x.said)).toEqual([["in-flight"]]);
    expect(statusLineCandidates("[[plan-a]] ~~shipped ~1 day~~ in-flight\n").map((x) => x.said)).toEqual([["in-flight"]]);
  });

  test("an HTML comment is read like any other text: the reader shows it (R2-2)", () => {
    // `renderWikiHtml` (the `/api/wiki/page` path) escapes a comment and draws
    // it, link and status word included, so the check reads it too.
    const html = renderWikiHtml("<!-- [[plan-a]] is in-flight -->\n", () => undefined);
    expect(html).toContain("&lt;!--");
    expect(html).toContain("in-flight");
    const body = [
      fm(),
      "<!-- [[plan-a]] is in-flight -->",
      "<!--",
      "[[plan-a]] blocked",
      "-->",
    ].join("\n");
    expect(statusLineCandidates(body).map((x) => [x.line, x.said])).toEqual([
      [5, ["in-flight"]],
      [7, ["blocked"]],
    ]);
    const shipped = { "plan-a": meta({ relPath: "plans/plan-a.md", plan_status: "shipped" }) } as Record<string, WikiPageMeta>;
    const hits = resolveStatusLineHits("notes/x.md", statusLineCandidates(body), (t) => shipped[t]);
    expect(hits.map((h) => [h.line, h.now])).toEqual([
      [5, "shipped"],
      [7, "shipped"],
    ]);
  });

  test("no `[[` or no status word: nothing, and no masks paid", () => {
    expect(statusLineCandidates("shipped and done\n")).toEqual([]);
    expect(statusLineCandidates("[[plan-a]] and [[plan-b]]\n")).toEqual([]);
    // A status word BEFORE the link names nothing about it.
    expect(statusLineCandidates("shipped: [[plan-a]]\n")).toEqual([]);
  });

  // A1: a long line is cut around the hit, never at its head, so the model
  // always sees the link and the status word it judges.
  test("A1: a long line's text is a window that holds the link and the status word", () => {
    const head = "Lead-in prose that runs on and on. ".repeat(14); // 490 chars before the link
    const c = statusLineCandidates(`${head}[[plan-a]] is in-flight, two PRs open. ${"Tail text. ".repeat(40)}\n`);
    expect(c).toHaveLength(1);
    expect(c[0]!.text).toContain("[[plan-a]] is in-flight");
    expect(c[0]!.text.length).toBeLessThanOrEqual(362);
    expect(c[0]!.text.startsWith("…")).toBe(true);
    expect(c[0]!.text.endsWith("…")).toBe(true);
  });

  test("A1: a link far from its status word keeps both, with a gap between", () => {
    const c = statusLineCandidates(`[[plan-a]] ${"and then some filler ".repeat(30)}is now shipped. ${"x ".repeat(100)}\n`);
    expect(c).toHaveLength(1);
    expect(c[0]!.text).toContain("[[plan-a]]");
    expect(c[0]!.text).toContain("is now shipped");
    expect(c[0]!.text).toContain(" … ");
  });

  test("A1: status words spread over a very long segment keep the window bounded, on the nearest word", () => {
    const c = statusLineCandidates(`${"Lead. ".repeat(70)}[[plan-a]] is proposed ${"filler ".repeat(800)}and later shipped.\n`);
    expect(c).toHaveLength(1);
    expect(c[0]!.said).toEqual(["proposed", "shipped"]);
    expect(c[0]!.text).toContain("[[plan-a]] is proposed");
    expect(c[0]!.text.length).toBeLessThanOrEqual(365);
  });

  test("A1: a short line's text is the whole trimmed line", () => {
    const c = statusLineCandidates("  - [[plan-a]] is shipped  \n");
    expect(c[0]!.text).toBe("- [[plan-a]] is shipped");
  });
});

function meta(over: Partial<WikiPageMeta> & { relPath: string }): WikiPageMeta {
  return { name: path.posix.basename(over.relPath).replace(/\.mdx?$/, ""), title: over.relPath, type: "note", domain: "ai", tags: [], aliases: [], ...over };
}

describe("resolveStatusLineHits (phase B)", () => {
  const plans: Record<string, WikiPageMeta> = {
    a: meta({ relPath: "plans/a.md", plan_status: "in-flight" }),
    r: meta({ relPath: "plans/r.md", plan_status: "ready" }),
    s: meta({ relPath: "plans/s.md", plan_status: "superseded" }),
    n: meta({ relPath: "notes/n.md" }),
  };
  const resolve = (t: string) => plans[t];
  const cand = (target: string, said: StatusLineCandidate["said"], line = 3): StatusLineCandidate => ({ line, target, said, text: "x" });

  test("a status that disagrees is a hit; naming the current one too passes", () => {
    const hits = resolveStatusLineHits("notes/x.md", [cand("a", ["shipped"]), cand("a", ["shipped", "in-flight"], 4)], resolve);
    expect(hits.map((h) => [h.line, h.target, h.now])).toEqual([[3, "plans/a.md", "in-flight"]]);
  });

  test("ready reads as proposed; superseded targets and pages without plan_status are skipped", () => {
    expect(resolveStatusLineHits("notes/x.md", [cand("r", ["proposed"]), cand("s", ["shipped"]), cand("n", ["shipped"])], resolve)).toEqual([]);
    expect(resolveStatusLineHits("notes/x.md", [cand("r", ["shipped"])], resolve)).toHaveLength(1);
  });

  test("a frontmatter line's hit says so, for the reader's marks (D21); a body line's does not", () => {
    const page = `---\ntitle: T\nrelated:\n  - "[[a]] shipped"\n---\n\n- [[a]] shipped in May\n`;
    const hits = resolveStatusLineHits("notes/x.md", statusLineCandidates(page), resolve);
    expect(hits.map((h) => [h.line, h.frontmatter])).toEqual([[4, true], [7, undefined]]);
  });

  test("a page's line about itself is no hit, and one hit per line and target", () => {
    expect(resolveStatusLineHits("plans/a.md", [cand("a", ["shipped"])], resolve)).toEqual([]);
    expect(resolveStatusLineHits("notes/x.md", [cand("a", ["shipped"]), cand("a", ["blocked"])], resolve)).toHaveLength(1);
  });
});

describe("living pages and history (D4)", () => {
  test("archive and blog paths, history types, closed plans, reserved and culled pages are not living", () => {
    expect(isLivingPage(meta({ relPath: "plans/a.md", plan_status: "in-flight" }))).toBe(true);
    expect(isLivingPage(meta({ relPath: "archive/x/a.md" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "blogs/a.mdx" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "notes/a.md", type: "report" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "plans/a.md", plan_status: "shipped" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "plans/index.md" }))).toBe(false);
    expect(isLivingPage(meta({ relPath: "notes/a.md", culled: true }))).toBe(false);
  });

  test("every history type and every closed status, on a plain path, is history (B4-2)", () => {
    for (const type of ["archive", "report", "blog", "review", "handoff", "source"]) {
      expect([type, isLivingPage(meta({ relPath: "notes/a.md", type }))]).toEqual([type, false]);
    }
    for (const plan_status of ["shipped", "superseded", "abandoned"] as const) {
      expect([plan_status, isLivingPage(meta({ relPath: "plans/a.md", plan_status }))]).toEqual([plan_status, false]);
    }
    for (const plan_status of ["proposed", "ready", "in-flight", "blocked"] as const) {
      expect([plan_status, isLivingPage(meta({ relPath: "plans/a.md", plan_status }))]).toEqual([plan_status, true]);
    }
  });
});

describe("isChangedPage: a 14-day window that ends at «now» (B4-2)", () => {
  test("14 days back is changed, a millisecond more is not, and the future is not", () => {
    expect(isChangedPage(T0 - 14 * DAY, T0)).toBe(true);
    expect(isChangedPage(T0 - 14 * DAY - 1, T0)).toBe(false);
    expect(isChangedPage(T0, T0)).toBe(true);
    expect(isChangedPage(T0 + 1, T0)).toBe(false);
    expect(isChangedPage(undefined, T0)).toBe(false);
  });
});

describe("pageLastChangeMs (D29)", () => {
  const p = (over: Partial<WikiPageMeta>) => meta({ relPath: "a.md", ...over });

  test("the newest of worked, non-sweep commit and — only while dirty — mtime", () => {
    expect(pageLastChangeMs(p({ workedMs: T0, gitTouchedMs: T0 - DAY, mtimeMs: T0 + DAY }))).toBe(T0);
    expect(pageLastChangeMs(p({ gitTouchedMs: T0 - DAY, mtimeMs: T0 + DAY, gitDirty: true }))).toBe(T0 + DAY);
    expect(pageLastChangeMs(p({ mtimeMs: T0 }))).toBeUndefined();
  });

  test("asOf drops newer signals and falls back to the stepped-back commit", () => {
    expect(pageLastChangeMs(p({ gitTouchedMs: T0 + 2 * DAY, workedMs: T0 + DAY }), T0, T0 - 3 * DAY)).toBe(T0 - 3 * DAY);
    expect(pageLastChangeMs(p({ gitTouchedMs: T0 + 2 * DAY }), T0)).toBeUndefined();
  });
});

describe("hasDateDM: the D.M date rule (R2-1)", () => {
  const dates = [
    "slettet av Rune 13.10", "avklart med Jonas 15.10", "Godkjent av Rune 24.10", "sendt Yvonne 13.10",
    "Rune valgte B 24.10", "Vurdering 20.10", "Planreview 18.10", "Fag svarte ja på S1 12.10",
    "valgte A på S4 20.10", "Simuleringen 29.09", "Oppdatering 20.08", "Status 11.09", "NAV 23.10",
    "Møtet 23.10", "x, men. Siden 3.10 har den", "x og Torsdag 2.10 kom", "23.10", "den 4.6", "på 3.10",
    "(23.10)", "23.10.2026", "fra 1.11.", "fra 1.11. til", "Siden 03.10", "Rune 08.10",
    // Two-digit day and month: a date before a hyphenated word (R2-4a).
    "08.09-sakene", "29.09-siden", "14.10-lista", "28.05-kjøringen", "03.07-artefakter",
    // Accepted loss: lowercase and two-digit versions read as dates.
    "bun 1.3", "python 3.12", "node 22.12", "Node 22.12", "Python 3.12",
    // A version word or capitalised word counts one space before, no more.
    "section  4.2", "Opus  4.6",
    // A version word is a whole word: these end in «ver» and are dates (class check).
    "over 13.10", "server 3.10", "however 3.9", "Oliver 13.10",
    // Accepted loss: no camelCase version tail any more; a year form after a letter is a date.
    "sedVer 4.4", "v3.10.2026",
  ];
  const notDates = [
    "model: Opus 4.6", "| Opus 4.6 |", "[[x]]. Opus 4.6", "Gemini 2.5", "art. 13.1", "artikkel 13.1",
    "4.4-versjon", "3.10-mapping", "12.1-sak", "2.5-familien", "8.09-sakene", "takes 2.5 min", "12.5 %", "section 4.2", "1.2.3", "v1.2", "sedVer4.4",
    "CDM 4.4", "Bun 1.3", "version 2.10", "Versjon 2.10", "kap. 3.2", "seksjon 12.1", "kapittel 4.11", "5G 1.2",
    // Accepted loss: a capitalised word and a single-digit date read as a version.
    "Mandag 4.6",
  ];
  test("each string reads as a date or not, as the rule says", () => {
    expect({ missedDates: dates.filter((t) => !hasDateDM(t)), readAsDates: notDates.filter((t) => hasDateDM(t)) }).toEqual({
      missedDates: [],
      readAsDates: [],
    });
  });
  test("ISO is its own claim; a D.M inside a link is blanked first", () => {
    expect(passageClaim("[[x]] 2026-10-23")).toBe("date");
    expect(passageClaim("[[x]] Vurdering 20.10")).toBe("date");
    expect(passageClaim("[[x]] Opus 4.6")).toBeUndefined();
  });
});

describe("bucketFor (D5)", () => {
  const changedAtMs = T0;
  const passage = (text: string, over: { inFrontmatter?: boolean; pointerHeading?: boolean } = {}) => ({
    line: 1,
    text,
    inFrontmatter: over.inFrontmatter ?? false,
    pointerHeading: over.pointerHeading ?? false,
    ...(passageClaim(text) ? { claim: passageClaim(text) } : {}),
  });
  const page = meta({ relPath: "notes/a.md" });
  const old = T0 - 10 * DAY;

  test("History is tested first, whatever the dates", () => {
    expect(bucketFor({ page: meta({ relPath: "archive/a.md" }), lastChangeMs: T0 + DAY, changedAtMs, passages: [passage("[[x]] shipped")] })).toBe("history");
    expect(bucketFor({ page: meta({ relPath: "plans/p.md", plan_status: "abandoned" }), lastChangeMs: old, changedAtMs, passages: [] })).toBe("history");
  });

  test("Changed since, then a page inside the 2-day margin is a Mention", () => {
    expect(bucketFor({ page, lastChangeMs: T0 + 1, changedAtMs, passages: [passage("[[x]] shipped")] })).toBe("changedSince");
    expect(bucketFor({ page, lastChangeMs: T0 - DAY, changedAtMs, passages: [passage("[[x]] shipped")] })).toBe("mentions");
  });

  test("the boundaries: the same instant is no Changed since; exactly 2 days before is inside the margin (B4-2)", () => {
    const at = (lastChangeMs: number) => bucketFor({ page, lastChangeMs, changedAtMs, passages: [passage("[[x]] shipped")] });
    expect(at(T0)).toBe("mentions");
    expect(at(T0 - 2 * DAY)).toBe("mentions");
    expect(at(T0 - 2 * DAY - 1)).toBe("toCheck");
  });

  test("a superseded plan is History (B4-2)", () => {
    expect(bucketFor({ page: meta({ relPath: "plans/p.md", plan_status: "superseded" }), lastChangeMs: old, changedAtMs, passages: [passage("[[x]] shipped")] })).toBe("history");
  });

  test("older: Pointers when every passage is a pointer", () => {
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("related: [[x]] shipped", { inFrontmatter: true })] })).toBe("pointers");
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("- [[x]] shipped 12.10", { pointerHeading: true })] })).toBe("pointers");
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("- [[x]] — the e2e repo")] })).toBe("pointers");
    // More than 30 characters after the link is no bare item.
    expect(bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage("- [[x]] — the e2e repo and its long story")] })).toBe("mentions");
  });

  test("older: To check on a status word, a date, a PR or an N of M count; else Mentions", () => {
    const at = (text: string) => bucketFor({ page, lastChangeMs: old, changedAtMs, passages: [passage(text)] });
    expect(at("[[x]] is under arbeid")).toBe("toCheck");
    expect(at("pinned in [[x]] on 23.10")).toBe("toCheck");
    expect(at("pinned in [[x]] on 2026-10-23")).toBe("toCheck");
    expect(at("see [[x]], PR #3538")).toBe("toCheck");
    expect(at("see [[x]], PR 2")).toBe("toCheck");
    expect(at("[[x]] runs 7 av 8 tests")).toBe("toCheck");
    expect(at("[[x]] holds the fixtures")).toBe("mentions");
    // A version, an anchor and a link destination are no claim.
    expect(at("[[x]] needs v1.2 and [[x#12]] and [doc](y.md#34)")).toBe("mentions");
    // Version numbers, decimals and measurements are no date (F2).
    for (const t of ["Opus 4.6", "CDM 4.4", "Bun 1.3", "section 4.2", "takes 2.5 min", "12.5 %", "v1.2", "1.2.3", "GPT‑5.6", "Python 3.10+", "in 9.5–10.6 min", "a 2.5k-char note", "Version 8.7"]) {
      expect([t, at(`[[x]] uses ${t}`)]).toEqual([t, "mentions"]);
    }
    for (const t of ["on 23.10", "den 4.6", "på 3.10", "(23.10)", "23.10.2026", "fra 1.11.", "2026-10-23", "Siden 03.10", "x. Fra 13.10 y"]) {
      expect([t, at(`[[x]] ${t}`)]).toEqual([t, "toCheck"]);
    }
    // A two-digit day or month stays a date after a capitalised word; single
    // digits after one read as a version (the full table: `hasDateDM`'s).
    expect(at("Mandag 23.10: [[x]] got its pin")).toBe("toCheck");
    expect(at("[[x]] Vurdering 20.10")).toBe("toCheck");
    expect(at("CDM 4.4 rollout: [[x]] holds the toggle")).toBe("mentions");
    expect(at("[[x]] Opus 4.6 drafts it")).toBe("mentions");
    expect(at("[[x]] confirmed by Rune 08.10")).toBe("toCheck");
    // No linking passage left (all on exempt lines): a Mention.
    expect(bucketFor({ page, lastChangeMs: undefined, changedAtMs, passages: [] })).toBe("mentions");
  });
});

describe("parseStaleAsOf", () => {
  test("a day is its end, an instant is itself, digits are ms, junk is null", () => {
    expect(parseStaleAsOf("2026-10-25")).toBe(Date.parse("2026-10-25T23:59:59.999Z"));
    expect(parseStaleAsOf("2026-10-25T08:00:00Z")).toBe(Date.parse("2026-10-25T08:00:00Z"));
    expect(parseStaleAsOf("1793000000000")).toBe(1793000000000);
    expect(parseStaleAsOf(undefined)).toBeUndefined();
    expect(parseStaleAsOf("yesterday")).toBeNull();
    expect(parseStaleAsOf("2026-13-45")).toBeNull();
  });

  test("an impossible date, an epoch in seconds and a zone-less instant are refused (F9a)", () => {
    expect(parseStaleAsOf("2026-02-30")).toBeNull();
    expect(parseStaleAsOf("2026-02-30T10:00:00Z")).toBeNull();
    expect(parseStaleAsOf("1761400000")).toBeNull();
    expect(parseStaleAsOf("99999999999999")).toBeNull();
    expect(parseStaleAsOf("2026-10-25T10:00")).toBeNull();
    expect(parseStaleAsOf("2026-10-25T10:00:00")).toBeNull();
    expect(parseStaleAsOf("2026-10-25T10:00:00+02:00")).toBe(Date.parse("2026-10-25T08:00:00Z"));
    expect(parseStaleAsOf("2024-02-29")).toBe(Date.parse("2024-02-29T23:59:59.999Z"));
  });

  test("13 digits with a leading 1–9 are epoch ms, 2001-09-09 to 2286-11-20; a zone may be ±HHMM (R2-4c)", () => {
    expect(parseStaleAsOf("0000000000000")).toBeNull();
    expect(parseStaleAsOf("0001761400000")).toBeNull();
    expect(parseStaleAsOf("1000000000000")).toBe(1_000_000_000_000);
    expect(parseStaleAsOf("9999999999999")).toBe(9_999_999_999_999);
    expect(parseStaleAsOf("2026-10-25T10:00:00+0200")).toBe(Date.parse("2026-10-25T08:00:00Z"));
    expect(parseStaleAsOf("2026-10-25T10:00-0130")).toBe(Date.parse("2026-10-25T11:30:00Z"));
  });
});

// ── Against a real (temp, git-backed) index ────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=f@example.com", "-c", "user.name=f", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

describe("the index, the buckets and Moved with on a temp wiki", () => {
  let root = "";
  let index: WikiIndex;
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (iso: string, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso, "-m", msg);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-"));
    await git(root, "init", "-q", "-b", "main");
    // Old linking pages, one per bucket.
    await write("notes/claim.md", page("Claim", "The pin in [[hub]] landed on 23.05."));
    await write("notes/mention.md", page("Mention", "The fixtures live in [[hub]]."));
    await write("notes/pointer.md", page("Pointer", "Body.\n\n## See also\n\n- [[hub]] and its whole long description here"));
    await write("archive/old.md", page("Old", "[[hub]] was shipped on 01.05."));
    await write("notes/later.md", page("Later", "Draft of [[hub]]."));
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
    await write("plans/q.md", page("Q", "Body.", "plan_status: in-flight\n"));
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n- [[q]] is in-flight\n- [[p]] ~~in-flight~~ shipped"));
    await commitAt("2026-05-01T10:00:00Z", "seed");
    // The changed page moves together with plans/q.md.
    await write("hub.md", page("Hub", "- [[p]] is in-flight\n- [[q]] is in-flight\n- [[p]] ~~in-flight~~ shipped\n\nMore."));
    await write("plans/q.md", page("Q", "Body two.", "plan_status: in-flight\n"));
    await write("index.md", page("Index", "- [[hub]]"));
    await commitAt("2026-06-18T10:00:00Z", "hub and q");
    // A linking page changed after the hub did.
    await write("notes/later.md", page("Later", "Draft of [[hub]], again."));
    await commitAt("2026-06-19T10:00:00Z", "later");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("the build keeps the hits: a disagreeing status on a living page, struck text and agreeing ones pass", () => {
    const hits = index.statusLineHits?.get("hub.md") ?? [];
    expect(hits.map((h) => [h.line, h.target, h.said, h.now])).toEqual([[5, "plans/p.md", ["in-flight"], "shipped"]]);
    // The archive page says «shipped» of a non-plan link: no hit, and archive is not living anyway.
    expect(index.statusLineHits?.has("archive/old.md")).toBe(false);
  });

  test("lint check 24 reports the same hit, at info", async () => {
    const report = await lintWiki(index);
    const f = report.findings.filter((x) => x.check === "status-line");
    expect(f.map((x) => [x.relPath, x.line, x.severity])).toEqual([["hub.md", 5, "info"]]);
    expect(report.counts["status-line"]).toBe(1);
  });

  test("lint check 24 reads the index's hits, not a second derivation (D27)", async () => {
    const lines = async (statusLineHits: WikiIndex["statusLineHits"]) =>
      (await lintWiki({ ...index, statusLineHits })).findings.filter((x) => x.check === "status-line").map((x) => [x.relPath, x.line]);
    expect(await lines(new Map())).toEqual([]);
    const planted = { line: 9, target: "plans/q.md", said: ["shipped" as const], now: "in-flight" as const, text: "x" };
    expect(await lines(new Map([["notes/mention.md", [planted]]]))).toEqual([["notes/mention.md", 9]]);
  });

  test("buckets for the changed page, as of a pinned day", async () => {
    const b = await linkingBuckets(index, "hub.md", { asOfMs });
    expect(b).not.toBeNull();
    expect(b!.changedAtMs).toBe(Date.parse("2026-06-18T10:00:00Z"));
    const by = Object.fromEntries(b!.linking.map((l) => [l.relPath, l.bucket]));
    expect(by).toEqual({
      "archive/old.md": "history",
      "notes/claim.md": "toCheck",
      "notes/later.md": "changedSince",
      "notes/mention.md": "mentions",
      "notes/pointer.md": "pointers",
    });
    expect(b!.counts).toEqual({ toCheck: 1, mentions: 1, pointers: 1, history: 1, changedSince: 1 });
    // Cached on the index: the same promise answers again.
    expect(linkingBuckets(index, "hub.md", { asOfMs })).toBe(linkingBuckets(index, "hub.md", { asOfMs }));
  });

  test("a reserved page is never a changed page", async () => {
    expect(await linkingBuckets(index, "index.md", { asOfMs })).toBeNull();
  });

  test("a page whose last change is over 14 days old gets no buckets", async () => {
    expect(await linkingBuckets(index, "notes/mention.md", { asOfMs })).toBeNull();
    // As of a later day, the hub is no longer a changed page either.
    expect(await linkingBuckets(index, "hub.md", { asOfMs: asOfMs + 20 * DAY })).toBeNull();
  });

  test("Moved with: the page committed with it, in the window only", () => {
    expect(movedWith(index, "hub.md", asOfMs).map((r) => [r.relPath, r.n])).toEqual([["plans/q.md", 1]]);
    // The seed commit touched 8 files — under the sweep threshold — but falls outside 28 days.
    expect(movedWith(index, "notes/mention.md", asOfMs)).toEqual([]);
  });

  test("the summary lists changed pages and pages with hits, with both counts", async () => {
    const s = await staleSummary(index, { asOfMs });
    const rows = Object.fromEntries(s.pages.map((p) => [p.relPath, [p.staleLines, p.toCheck, p.changed]]));
    expect(rows["hub.md"]).toEqual([1, 1, true]);
    expect(rows["notes/later.md"]).toEqual([0, 0, true]);
    expect(rows["notes/mention.md"]).toBeUndefined();
    expect(s.totals).toEqual({ staleLines: 1, toCheck: 1, changedPages: 3 });
    const r = await stalePageReport(index, index.resolveRelPath("hub.md")!, { asOfMs });
    expect(r.changed).toBe(true);
    expect(r.hits).toHaveLength(1);
    expect(r.movedWith.map((m) => m.relPath)).toEqual(["plans/q.md"]);
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe("pointer headings and markdown links, as the backlink graph reads them (F7c-e, F8)", () => {
  let root = "";
  let index: WikiIndex;
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");
  const long = "and its whole long description here";
  const FILL = "lorem ipsum dolor sit amet ".repeat(16);
  const HEADINGS = [
    ["sources", "Sources"],
    ["see-also", "See also"],
    ["related", "Related concepts"],
    ["references", "References"],
    ["kilder", "Kilder"],
    ["se-ogsa", "Se også"],
    ["relatert", "Relatert"],
    ["lenker", "Lenker"],
  ] as const;

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (iso: string, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso, "-m", msg);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-edges-"));
    await git(root, "init", "-q", "-b", "main");
    await write("hub.md", page("Hub", "Body."));
    await write("notes/x,y.md", page("XY", "Body."));
    // F7c: a subheading stays under the pointer heading; a same-level one ends it.
    await write("notes/subhead.md", page("Subhead", `## Sources\n\n### Plans\n\n- [[hub]] ${long}`));
    await write("notes/reset.md", page("Reset", "## See also\n\n- [[x,y]]\n\n## Notes\n\nThe pin in [[hub]] landed on 23.05."));
    // F7d: an indented heading is a heading.
    await write("notes/indented.md", page("Indented", `Body.\n\n   ## See also\n\n- [[hub]] ${long}`));
    // F7e: «Relaterte» is a pointer heading.
    await write("notes/relaterte.md", page("Relaterte", `## Relaterte\n\n- [[hub]] ${long}`));
    // F8: a titled markdown link counts, an image does not, `%2C` decodes.
    await write("notes/titled.md", page("Titled", 'The pin in [Hub](../hub.md "the hub") landed on 23.05.'));
    await write("notes/image.md", page("Image", "The fixtures live in [[hub]].\n\n![shot](../hub.md) taken 23.05."));
    await write("notes/comma.md", page("Comma", "The pin in [XY](x%2Cy.md) landed on 23.05."));
    // B4-2: every pointer heading name, each over a claim-bearing line (a
    // non-pointer heading would make it To check); «Related concepts» is a prefix word.
    for (const [slug, heading] of HEADINGS) await write(`notes/h-${slug}.md`, page(slug, `## ${heading}\n\n- [[hub]] pinned 23.05 ${long}`));
    // B4-2: a link only on an exempt line (a blockquote) leaves no passage: a Mention.
    await write("notes/quoted.md", page("Quoted", "Body.\n\n> The pin in [[hub]] landed on 23.05."));
    // B4-2: a frontmatter link is a Pointer, whatever its line says.
    await write("notes/fm.md", page("Fm", "Body.", 'up: "[[hub]] pinned 23.05"\n'));
    // A17: a passage line past the cap keeps the link and the claim, whichever comes first.
    await write("notes/longtail.md", page("Longtail", `${FILL}The pin in [[hub]] landed on 23.05, see the log.`));
    await write("notes/longhead.md", page("Longhead", `Shown in PR #812, ${FILL}${FILL}and the fixtures sit in [[hub]].`));
    await write("notes/longmd.md", page("Longmd", `Pinned 23.05: ${FILL}${FILL}the details sit in [Hub](../hub.md).`));
    await commitAt("2026-05-01T10:00:00Z", "seed");
    await write("hub.md", page("Hub", "Body two."));
    await write("notes/x,y.md", page("XY", "Body two."));
    await commitAt("2026-06-18T10:00:00Z", "hub and xy");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("the buckets of the hub", async () => {
    const b = await linkingBuckets(index, "hub.md", { asOfMs });
    const by = Object.fromEntries(b!.linking.map((l) => [l.relPath, l.bucket]));
    expect(by).toEqual({
      "notes/subhead.md": "pointers",
      "notes/reset.md": "toCheck",
      "notes/indented.md": "pointers",
      "notes/relaterte.md": "pointers",
      "notes/titled.md": "toCheck",
      "notes/image.md": "mentions",
      ...Object.fromEntries(HEADINGS.map(([slug]) => [`notes/h-${slug}.md`, "pointers"])),
      "notes/quoted.md": "mentions",
      "notes/fm.md": "pointers",
      "notes/longtail.md": "toCheck",
      "notes/longhead.md": "toCheck",
      "notes/longmd.md": "toCheck",
    });
    expect(b!.linking.find((l) => l.relPath === "notes/quoted.md")!.passages).toEqual([]);
    const titled = b!.linking.find((l) => l.relPath === "notes/titled.md")!;
    expect(titled.passages.map((p) => [p.line, p.claim])).toEqual([[5, "date"]]);
  });

  test("A17: a long passage line's text holds the link and the claim, each piece verbatim from the line", async () => {
    const b = await linkingBuckets(index, "hub.md", { asOfMs });
    const lines = (rel: string) => Bun.file(path.join(root, rel)).text().then((t) => t.split("\n"));
    const cases = [
      ["notes/longtail.md", "[[hub]]", "23.05", "date"],
      ["notes/longhead.md", "[[hub]]", "PR #812", "PR"],
      ["notes/longmd.md", "[Hub](../hub.md)", "23.05", "date"],
    ] as const;
    for (const [rel, link, claimText, claim] of cases) {
      const [p] = b!.linking.find((l) => l.relPath === rel)!.passages;
      expect(p!.claim).toBe(claim);
      expect(p!.text).toContain(link);
      expect(p!.text).toContain(claimText);
      expect(p!.text.length).toBeLessThanOrEqual(365);
      const source = (await lines(rel))[p!.line - 1]!;
      for (const piece of p!.text.split("…")) expect(source).toContain(piece.trim());
    }
  });

  test("a %2C-escaped markdown link reaches its page", async () => {
    const b = await linkingBuckets(index, "notes/x,y.md", { asOfMs });
    const comma = b!.linking.find((l) => l.relPath === "notes/comma.md");
    expect(comma?.bucket).toBe("toCheck");
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

// Fix round 2 batch 1: the window's link is found with the backlink graph's
// own grammar, so a link whose text holds inline code is found (mimir
// `overview.md:15`), and on a line with several links it is the one to the
// changed page, not the line's first link.
describe("a passage line's window holds the link to the changed page (fix round 2)", () => {
  let root = "";
  let index: WikiIndex;
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");
  const FILL = "lorem ipsum dolor sit amet ".repeat(16);
  const CASES = [
    // [page, line body, the link to hub as written]
    ["code-text", `Pinned 23.05: ${FILL}${FILL}the details sit in [the \`ci_*\` tables](../hub.md).`, "[the `ci_*` tables](../hub.md)"],
    ["code-title", `Pinned 23.05: ${FILL}${FILL}see [the \`hub\`](../hub.md "the \`hub\` page").`, '[the `hub`](../hub.md "the `hub` page")'],
    ["other-first-md", `[[x,y]] pinned 23.05, ${FILL}${FILL}and the details sit in [the \`x\` table](../hub.md).`, "[the `x` table](../hub.md)"],
    ["other-first-wiki", `[[x,y]] pinned 23.05, ${FILL}${FILL}and the details sit in [[hub|the hub]].`, "[[hub|the hub]]"],
    ["other-md-first", `[the \`x\` notes](x%2Cy.md) pinned 23.05, ${FILL}${FILL}see [[hub#Body]].`, "[[hub#Body]]"],
    ["two-to-hub", `[[x,y]] pinned 23.05, [[hub]] ${FILL}${FILL}and [Hub](../hub.md) again.`, "[[hub]]"],
    ["embed", `Pinned 23.05: ${FILL}${FILL}![[hub]]`, "![[hub]]"],
  ] as const;

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-span-"));
    await git(root, "init", "-q", "-b", "main");
    await write("hub.md", page("Hub", "## Body\n\nBody."));
    await write("notes/x,y.md", page("XY", "Body."));
    for (const [slug, body] of CASES) await write(`notes/${slug}.md`, page(slug, body));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-05-01T10:00:00Z", "-m", "seed");
    await write("hub.md", page("Hub", "## Body\n\nBody two."));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", "2026-06-18T10:00:00Z", "-m", "hub");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("every case's window holds its link to the hub and the claim, each piece verbatim", async () => {
    const b = await linkingBuckets(index, "hub.md", { asOfMs });
    for (const [slug, body, link] of CASES) {
      const lp = b!.linking.find((l) => l.relPath === `notes/${slug}.md`);
      expect([slug, lp?.bucket]).toEqual([slug, "toCheck"]);
      const [p] = lp!.passages;
      expect([slug, p!.text.includes(link)]).toEqual([slug, true]);
      expect([slug, p!.text.includes("23.05")]).toEqual([slug, true]);
      for (const piece of p!.text.split("…")) expect([slug, body.includes(piece.trim())]).toEqual([slug, true]);
    }
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe("asOf steps back past metadata-only commits (D29, F3)", () => {
  let root = "";
  let index: WikiIndex;
  // The stamp commit (06-18) is inside 14 days of asOf; the last edit before it (06-01) is not.
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (iso: string, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso, "-m", msg);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-asof-"));
    await git(root, "init", "-q", "-b", "main");
    await write("notes/a.md", page("A", "First text."));
    await write("notes/b.md", page("B", "Links [[a]]."));
    await commitAt("2026-05-01T10:00:00Z", "seed");
    await write("notes/a.md", page("A", "Edited text."));
    await commitAt("2026-06-01T10:00:00Z", "edit a");
    // Metadata only: a series and a prs stamp, body unchanged.
    await write("notes/a.md", page("A", "Edited text.", "series: s1\nprs: [12]\n"));
    await commitAt("2026-06-18T10:00:00Z", "stamp a");
    // A real edit after asOf, so the step-back runs.
    await write("notes/a.md", page("A", "Edited again.", "series: s1\nprs: [12]\n"));
    await commitAt("2026-06-25T10:00:00Z", "edit a again");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("the stamp commit is no change: as of 06-20 the page last changed 06-01, so it is not changed", async () => {
    const a = index.resolveRelPath("notes/a.md")!;
    expect(a.gitTouchedMs).toBe(Date.parse("2026-06-25T10:00:00Z"));
    const r = await stalePageReport(index, a, { asOfMs });
    expect(r.lastChangeMs).toBe(Date.parse("2026-06-01T10:00:00Z"));
    expect(r.changed).toBe(false);
    expect(await linkingBuckets(index, "notes/a.md", { asOfMs })).toBeNull();
    // Without asOf the newest edit stands.
    expect((await stalePageReport(index, a)).lastChangeMs).toBe(Date.parse("2026-06-25T10:00:00Z"));
  });

  test("each asOf steps back on its own: a second, earlier asOf on the same index is not the first's answer (B4-2)", async () => {
    const a = index.resolveRelPath("notes/a.md")!;
    expect((await stalePageReport(index, a, { asOfMs })).lastChangeMs).toBe(Date.parse("2026-06-01T10:00:00Z"));
    expect((await stalePageReport(index, a, { asOfMs: Date.parse("2026-05-15T23:59:59.999Z") })).lastChangeMs).toBe(Date.parse("2026-05-01T10:00:00Z"));
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe("the summary's counts-only path (F6)", () => {
  let root = "";
  let index: WikiIndex;
  const asOfMs = Date.parse("2026-06-20T23:59:59.999Z");

  const write = async (rel: string, text: string) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const commitAt = async (iso: string, msg: string) => {
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "--date", iso, "-m", msg);
  };

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-counts-"));
    await git(root, "init", "-q", "-b", "main");
    // Older pages linking BOTH changed pages: one claim-bearing, one mention, one pointer.
    await write("notes/claim.md", page("Claim", "[[a]] landed on 23.05.\n\n[[b]] has 3 of 5 done."));
    await write("notes/mention.md", page("Mention", "See [[a]] and [[b]]."));
    await write("notes/pointer.md", page("Pointer", "Body.\n\n## See also\n\n- [[a]]\n- [[b]]"));
    // History, whatever its passages say.
    await write("archive/old.md", page("Old", "[[a]] was shipped on 01.05, [[b]] on 02.05."));
    await write("plans/done.md", page("Done", "[[a]] on 03.05.", "plan_status: shipped\n"));
    await write("notes/later.md", page("Later", "Draft of [[a]] and [[b]]."));
    await write("a.md", page("A", "Body."));
    await write("b.md", page("B", "Body."));
    await commitAt("2026-05-01T10:00:00Z", "seed");
    await write("a.md", page("A", "Body two."));
    await write("b.md", page("B", "Body two."));
    await commitAt("2026-06-12T10:00:00Z", "a and b");
    // A linking page changed after both did, and one inside the 2-day margin.
    await write("notes/later.md", page("Later", "Draft of [[a]] and [[b]], 12.06."));
    await commitAt("2026-06-19T10:00:00Z", "later");
    await write("notes/near.md", page("Near", "[[a]] on 11.06."));
    await commitAt("2026-06-11T10:00:00Z", "near");
    index = await buildWikiIndex(root);
  }, 30_000);

  test("it reads only the older, non-history linking pages, each once across changed pages", async () => {
    const reads: string[] = [];
    const readFile = async (abs: string) => {
      reads.push(path.relative(root, abs));
      return Bun.file(abs).text();
    };
    await staleSummary(index, { asOfMs, readFile });
    expect(reads.sort()).toEqual(["notes/claim.md", "notes/mention.md", "notes/pointer.md"]);
  });

  test("its counts are exactly the full path's, page by page", async () => {
    const s = await staleSummary(index, { asOfMs });
    const changed = s.pages.filter((p) => p.changed);
    expect(changed.map((p) => p.relPath).sort()).toEqual(["a.md", "b.md", "notes/later.md", "notes/near.md"]);
    for (const row of changed) {
      const full = await linkingBuckets(index, row.relPath, { asOfMs });
      expect([row.relPath, row.toCheck]).toEqual([row.relPath, full!.counts.toCheck]);
      // A readFile bypasses both caches, so these are the counts path's own.
      expect(await linkingCounts(index, row.relPath, { asOfMs, readFile: (a) => Bun.file(a).text() })).toEqual(full!.counts);
    }
    expect((await linkingBuckets(index, "a.md", { asOfMs }))!.counts).toEqual({ toCheck: 1, mentions: 2, pointers: 1, history: 2, changedSince: 1 });
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe("a culled page and its attachment hold no hits, in the index and in lint alike (B4-1)", () => {
  let root = "";
  let index: WikiIndex;

  test("setup", async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-stale-culled-"));
    const write = async (rel: string, text: string) => {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    };
    await write("plans/p.md", page("P", "Body.", "plan_status: shipped\n"));
    await write("notes/old.md", page("Old", "[[p]] is in-flight\n\n<Embed src=\"./old-x.html\" />", "signal: none\n"));
    await write("notes/old.html", "<html><body><p>[[p]] is in-flight</p></body></html>");
    await write("notes/old-x.html", "<html><body><p>[[p]] is in-flight</p></body></html>");
    await write("notes/live.md", page("Live", "[[p]] is in-flight"));
    // B4-2: history pages say the same and hold nothing.
    await write("archive/arc.md", page("Arc", "[[p]] is in-flight"));
    await write("notes/src.md", page("Src", "[[p]] is in-flight", "type: source\n"));
    await write("plans/gone.md", page("Gone", "[[p]] is in-flight", "plan_status: superseded\n"));
    index = await buildWikiIndex(root);
  }, 30_000);

  test("the attachments inherit the cull, and only the live page holds a hit", async () => {
    expect(["notes/old.md", "notes/old.html", "notes/old-x.html"].map((r) => index.resolveRelPath(r)?.culled)).toEqual([true, true, true]);
    expect([...(index.statusLineHits ?? new Map()).keys()]).toEqual(["notes/live.md"]);
    const lint = (await lintWiki(index)).findings.filter((x) => x.check === "status-line").map((x) => x.relPath);
    expect(lint).toEqual(["notes/live.md"]);
  });

  test("teardown", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

// ── The claim rules, enumerated (class check, PR #748) ─────────────────────
// Oracles written from the rule sentences in `src/wiki/CLAUDE.md` (Stale
// check), as plain string logic: they share no regex with `stale.ts`, so the
// cross product below compares two independent readings of one rule.

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c);
const isWordChar = (c: string | undefined) => isLetter(c) || isDigit(c) || (c !== undefined && /\p{N}/u.test(c));
const isUpper = (c: string | undefined) => c !== undefined && /\p{Lu}/u.test(c);
const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c);
const HYPHENS = ["-", "‐", "‑"];
const DASHES = ["–", "—", "-"];
const VERSION_WORDS = ["version", "versjon", "ver", "v", "section", "seksjon", "kapittel", "kap.", "art.", "artikkel"];
const UNITS = ["%", "×", "x", "ms", "s", "sek", "sec", "min", "minutter", "minutes", "h", "t", "timer", "hours", "kB", "KB", "MB", "GB", "TB", "k", "oz", "px", "pt", "em", "rem"];

/** Rule 3's tail: does `after` (what follows the D.M, or a range's end) exclude it? */
function oracleTailExcludes(after: string, singleDigit: boolean): boolean {
  const c = after[0];
  if (c === "%" || c === "+" || c === "×") return true;
  if (isLetter(c)) return true;
  if (singleDigit && HYPHENS.includes(c!) && isLetter(after[1])) return true;
  let i = 0;
  while (isSpace(after[i])) i++;
  if (i > 0) {
    for (const u of UNITS) if (after.startsWith(u, i) && !isWordChar(after[i + u.length])) return true;
  }
  return false;
}

/** Rule 3's range: optional space, a dash, optional space, a number; returns what follows it. */
function oracleRangeEnd(after: string): string | undefined {
  let i = 0;
  while (isSpace(after[i])) i++;
  if (!DASHES.includes(after[i]!)) return undefined;
  i++;
  while (isSpace(after[i])) i++;
  if (!isDigit(after[i])) return undefined;
  while (isDigit(after[i])) i++;
  if ((after[i] === "." || after[i] === ",") && isDigit(after[i + 1])) {
    i++;
    while (isDigit(after[i])) i++;
  }
  return after.slice(i);
}

/** Rules 1–5 for one numeric token `parts` (a maximal run of digit groups joined by single dots). */
function oracleTokenIsDate(text: string, start: number, end: number, parts: string[]): boolean {
  const year = parts.length === 3 && parts[2]!.length === 4;
  if (parts.length !== 2 && !year) return false; // `1.2.3`, `3.10.5`: a `.digit` other than a year
  const [d, m] = parts as [string, string];
  if (d.length > 2 || m.length > 2) return false;
  if (+d < 1 || +d > 31 || +m < 1 || +m > 12) return false; // rule 1
  if (year) return true; // rule 2
  const singleDigit = d.length === 1 || m.length === 1;
  const after = text.slice(end);
  if (oracleTailExcludes(after, singleDigit)) return false; // rule 3
  const rangeRest = oracleRangeEnd(after);
  if (rangeRest !== undefined && oracleTailExcludes(rangeRest, singleDigit)) return false;
  const before = text.slice(0, start);
  const p1 = before[before.length - 1];
  if (isLetter(p1)) return false; // rule 4: glued to a letter
  if (HYPHENS.includes(p1!) && isLetter(before[before.length - 2])) return false; // `GPT‑5.6`
  if (p1 === " ") {
    const lower = before.toLowerCase();
    for (const w of VERSION_WORDS) {
      if (lower.endsWith(`${w} `) && !isWordChar(before[before.length - w.length - 2])) return false;
    }
    if (d.length === 1 && m.length === 1) { // rule 5
      let k = before.length - 1;
      while (k > 0 && isWordChar(before[k - 1])) k--;
      const word = before.slice(k, before.length - 1);
      const allCapsDigits = [...word].every((c) => isUpper(c) || isDigit(c)) && [...word].some(isUpper);
      if (word && (isUpper(word[0]) || allCapsDigits)) return false;
    }
  }
  return true;
}

function oracleHasDateDM(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text[i])) { i++; continue; }
    const start = i;
    const parts: string[] = [];
    for (;;) {
      let k = i;
      while (isDigit(text[k])) k++;
      parts.push(text.slice(i, k));
      i = k;
      if (text[k] === "." && isDigit(text[k + 1])) { i = k + 1; continue; }
      break;
    }
    // A token right after a `.` continues a dotted name (`D.2.1`, `type.2.4.a`): no D.M.
    if (text[start - 1] !== "." && oracleTokenIsDate(text, start, i, parts)) return true;
  }
  return false;
}

const DM_LEFTS = ["", "den ", "på ", "(", "| ", "model: ", "Rune ", "Godkjent av Rune ", "NAV ", "S1 ", "Opus ", "Gemini ", "macOS ", "iPhone ", "over ", "server ", "Oliver ", "however ", "version ", "Version ", "versjon ", "Versjon ", "ver ", "v", "v ", "art. ", "Art. ", "artikkel ", "kap. ", "section ", "seksjon ", "kapittel ", "sedVer ", "sedVer", "§", "x", "5",
  // Beyond the brief's minimum: the left-side arms the mutation check found unreached.
  "GPT-", "GPT‑", "5G ", "e-", "D.", "type."];
const DM_DAYS = ["0", "3", "03", "13", "31", "32"];
const DM_MONTHS = ["0", "9", "09", "10", "12", "13"];
const DM_RIGHTS = ["", " ", ". ", ".", ".2026", ".5", "5", "%", " %", "+", "×", " min", "min", " s", " GB", "x", "–10.6 min", "-sakene", "-versjon", "a", ")", ",",
  // Beyond the minimum: a year form's own tail, and a unit's word edge.
  ".2026 min", ".2026a", " x", " xyz"];

/** Every (left, D, M, right) string the cross product builds, with both readings. */
export function dmCrossProduct(): { text: string; code: boolean; oracle: boolean }[] {
  const out: { text: string; code: boolean; oracle: boolean }[] = [];
  for (const l of DM_LEFTS) for (const d of DM_DAYS) for (const m of DM_MONTHS) for (const r of DM_RIGHTS) {
    const text = `${l}${d}.${m}${r}`;
    out.push({ text, code: hasDateDM(text), oracle: oracleHasDateDM(text) });
  }
  return out;
}

const PR_IN_FLIGHT_FORMS = ["open PR", "open PRs", "åpen PR", "åpen PR-er", "åpne PR-er", "åpne PR-ene"];
/** Whether `text` names an in-flight PR word: a form, any case, edged by a non-word character. */
function oraclePrInFlight(text: string): boolean {
  const lower = text.toLowerCase();
  for (const f of PR_IN_FLIGHT_FORMS.map((x) => x.toLowerCase())) {
    for (let i = lower.indexOf(f); i >= 0; i = lower.indexOf(f, i + 1)) {
      const b = text[i - 1], a = text[i + f.length];
      if (!isWordChar(b) && b !== "_" && !isWordChar(a) && a !== "_") return true;
    }
  }
  return false;
}
const PR_FORMS = [...PR_IN_FLIGHT_FORMS, "åpne PR", "åpne PR-en", "Åpne PR", "Åpne PR-en", "Åpne PR-er", "Åpne PR-ene", "ÅPEN PR", "Open PRs", "åpen PR-en", "open PRsx", "åpne PR-erne", "åpenPR", "gjenåpne PR-er"];
const PR_LEFTS = ["", "9 ", "de ", "sjekk ", "kan ", "for å "];
const PR_RIGHTS = ["", ".", " for", ","];

/** Every (left, form, right) string, read by the status words and by the prefiltered line parse. */
export function prCrossProduct(): { text: string; code: boolean; line: boolean; oracle: boolean }[] {
  const out: { text: string; code: boolean; line: boolean; oracle: boolean }[] = [];
  for (const l of PR_LEFTS) for (const f of PR_FORMS) for (const r of PR_RIGHTS) {
    const text = `${l}${f}${r}`;
    const line = statusLineCandidates(`[[x]] ${text}\n`).some((c) => c.said.includes("in-flight"));
    out.push({ text, code: statusWordsIn(text).includes("in-flight"), line, oracle: oraclePrInFlight(text) });
  }
  return out;
}

describe("the claim rules, enumerated against an oracle (class check)", () => {
  test("hasDateDM agrees with the rule-sentence oracle over the whole cross product", () => {
    const all = dmCrossProduct();
    expect(all.length).toBe(DM_LEFTS.length * DM_DAYS.length * DM_MONTHS.length * DM_RIGHTS.length);
    expect(all.filter((x) => x.code !== x.oracle).map((x) => `${JSON.stringify(x.text)} code=${x.code}`)).toEqual([]);
  });
  test("the oracle itself reads the hand-picked anchors as the rule says", () => {
    const yes = ["Rune 24.9", "Godkjent av Rune 24.10", "NAV 23.10", "macOS 2.3", "iPhone 1.2", "over 3.9", "server 3.9", "however 3.9", "sedVer 4.4", "v3.10.2026", "fra 1.11.", "08.09-sakene", "§3.9", "x. 3.10"];
    const no = ["Opus 4.6", "CDM 4.4", "S4 2.1", "Oliver 3.9", "version 3.10", "Art. 13.1", "v1.2", "GPT‑5.6", "4.4-versjon", "9.5–10.6 min", "12.5 %", "3.10+", "1.2.3", "5.3.10", "D.2.1", "cvc-complex-type.2.4.a", "x.3.10.2026"];
    expect({ yes: yes.filter((t) => !oracleHasDateDM(t)), no: no.filter(oracleHasDateDM) }).toEqual({ yes: [], no: [] });
  });
  test("the in-flight PR words agree with the oracle, and the prefilter rejects no line the rule accepts", () => {
    const all = prCrossProduct();
    expect(all.length).toBe(PR_LEFTS.length * PR_FORMS.length * PR_RIGHTS.length);
    expect(all.filter((x) => x.code !== x.oracle || x.line !== x.oracle).map((x) => `${JSON.stringify(x.text)} code=${x.code} line=${x.line}`)).toEqual([]);
  });
});
