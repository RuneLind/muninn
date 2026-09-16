import { describe, expect, test } from "bun:test";
import type { WikiProposal } from "../db/wiki-proposals.ts";
import type { BlockRetention } from "./code-block-retention.ts";
import {
  appliedSourcePages,
  backfillOutcomeLabel,
  judgeBackfill,
  MIN_PROSE_RETENTION,
  proseRetention,
  proseSentences,
  retentionScore,
} from "./source-backfill.ts";

function proposal(over: Partial<WikiProposal>): WikiProposal {
  return {
    id: "p1",
    botName: "jarvis",
    wikiName: null,
    topicKey: "source:youtube-summaries:ai/a.md",
    kind: "source",
    mode: "create",
    targetPath: "sources/A.mdx",
    baseHash: null,
    draft: "---\ntype: source\n---\nbody",
    sourceDocs: [{ collection: "youtube-summaries", docId: "ai/a.md", title: "A", url: "https://x/1" }],
    rationale: null,
    containedLinks: null,
    relatedPages: [],
    status: "applied",
    createdAt: 1_000,
    resolvedAt: 2_000,
    ...over,
  } as WikiProposal;
}

function blocks(spec: { found: number; lines: number }[]): BlockRetention[] {
  return spec.map((s, index) => ({
    index,
    lang: "",
    lines: s.lines,
    found: s.found,
    verdict: s.found / s.lines >= 0.8 ? "kept" : s.found / s.lines >= 0.3 ? "partial" : "lost",
  }));
}

describe("appliedSourcePages", () => {
  test("keeps only applied source rows carrying a source doc", () => {
    const rows = appliedSourcePages([
      proposal({ id: "keep" }),
      proposal({ id: "draft-row", targetPath: "sources/B.mdx", status: "draft" }),
      proposal({ id: "concept", targetPath: "concepts/C.md", kind: "concept" }),
      proposal({ id: "no-docs", targetPath: "sources/D.mdx", sourceDocs: [] }),
    ]);
    expect(rows.map((r) => r.proposalId)).toEqual(["keep"]);
    expect(rows[0]).toMatchObject({ collection: "youtube-summaries", docId: "ai/a.md", url: "https://x/1" });
  });

  test("one row per path — the LATEST apply wins, which is the summary today's page came from", () => {
    // The backfill's own update proposal applies later against the same path; its
    // source doc is the one a re-measure must read.
    const rows = appliedSourcePages([
      proposal({ id: "first", resolvedAt: 2_000, sourceDocs: [{ collection: "c", docId: "old", title: "", url: "" }] }),
      proposal({ id: "second", resolvedAt: 9_000, sourceDocs: [{ collection: "c", docId: "new", title: "", url: "" }] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposalId).toBe("second");
    expect(rows[0]!.docId).toBe("new");
  });

  test("a row that never resolved is ordered by createdAt, not dropped", () => {
    const rows = appliedSourcePages([
      proposal({ id: "unresolved", resolvedAt: null, createdAt: 5_000 }),
      proposal({ id: "other", targetPath: "sources/B.mdx", resolvedAt: 1_000 }),
    ]);
    expect(rows.map((r) => r.proposalId)).toEqual(["unresolved", "other"]);
  });
});

const PAGE = [
  "---",
  "type: source",
  "title: Software Minimalism",
  "---",
  "",
  "# Software Minimalism",
  "",
  "Dependency injection frameworks are described as mostly harmless but rarely as necessary as their ubiquity suggests.",
  "",
  "## The critique",
  "",
  "The legitimate problem they solve is the testability of code that calls external services. Annotation-heavy solutions obscure execution order and side effects.",
  "",
  "```java",
  "@Component public class PersonService { }",
  "```",
  "",
  "## See also",
  "- [[Cognitive Debt]]",
].join("\n");

describe("proseSentences", () => {
  test("skips frontmatter, fenced code, headings and link lines", () => {
    const sentences = proseSentences(PAGE);
    expect(sentences).toEqual([
      "Dependency injection frameworks are described as mostly harmless but rarely as necessary as their ubiquity suggests.",
      // The second paragraph is TWO sentences and splits into two: a paragraph-level
      // split would return it whole, and then a reviser that inserts a block between
      // those sentences reads as having deleted the paragraph.
      "The legitimate problem they solve is the testability of code that calls external services.",
      "Annotation-heavy solutions obscure execution order and side effects.",
    ]);
  });

  test("a sentence split in two around a restored block still counts both halves", () => {
    // The shape a GOOD revision produces (measured on `sources/Software Minimalism.mdx`).
    const revised = PAGE.replace(
      "services. Annotation-heavy",
      "services.\n\nThe Java example shown buries the work:\n\n```java\n@Component public class Example { }\n```\n\nAnnotation-heavy",
    );
    expect(proseRetention(PAGE, revised)).toEqual({ total: 3, found: 3, ratio: 1 });
  });
});

/**
 * The class check (round 3 on this surface): every defect this guard has shipped was
 * one shape — the two sides of the comparison normalized differently — so the
 * property, not another per-finding fixture, is what is pinned here. A page always
 * retains itself, whatever markup it carries, because both sides run one pipeline
 * and the sentences are substrings of the text they were split out of.
 *
 * The corpus is synthetic rather than real pages (this repo is public). Two of the
 * shapes are the ones that actually broke it — a bold span crossing a sentence
 * boundary and a wikilink whose text contains sentence punctuation, which together
 * put 17 of 932 live source pages below the floor against themselves, the worst at
 * 0.750. The rest (a `?` inside a link, an abbreviation, a decimal, an ellipsis)
 * document the corpus: they pass against the broken version too, and are here
 * because they are what a reader would try first.
 */
describe("proseRetention is reflexive — the class check", () => {
  const shapes: [string, string][] = [
    ["a wikilink whose text ends a sentence", "The debate is covered in [[Coding vs. Software Engineering Distinction]] at length, with examples."],
    ["a bold span crossing a sentence boundary", "It matters here **because the running cost is entirely real. The claimed benefit is not** for most teams of this size."],
    ["a question mark inside a wikilink", "See [[Is Dependency Injection Worth It?]] for the argument, which is made at some length."],
    ["a piped wikilink spanning punctuation", "Read [[Hexagonal Architecture vs. Layers|hexagonal architecture vs. plain layers]] before choosing a structure for this."],
    ["an abbreviation mid-sentence", "The service is cheap, i.e. it costs almost nothing to run, and it is easy to operate."],
    ["a decimal number", "Throughput rose to 12.5 requests per second under the same hardware and the same load."],
    ["an ellipsis", "The answer is… complicated, and the rest of this page explains why it is complicated."],
    ["underscore emphasis", "The point is _that the page keeps its own sentences_ whatever emphasis style it uses."],
  ];

  for (const [name, sentence] of shapes) {
    test(name, () => {
      const page = `---\ntype: source\ntitle: T\n---\n\n# T\n\n${sentence}\n`;
      const r = proseRetention(page, page);
      expect(r.total).toBeGreaterThan(0);
      expect(r.ratio).toBe(1);
    });
  }

  test("a pilcrow in the page's own prose is text, not a paragraph break", () => {
    // The sentinel is spelled the same way on both sides; splitting on a BARE `¶`
    // would cut the page's sentence in two while the haystack kept it whole, and the
    // short fragment would then drop under the length floor — prose silently exempt
    // from the survival check. No live page contains a pilcrow; the spellings
    // disagreeing is the bug.
    const page = "---\ntype: source\ntitle: T\n---\n\n# T\n\nA sentence long enough to be measured¶by the guard here and then some more words.\n";
    const sentences = proseSentences(page);
    expect(sentences).toHaveLength(1);
    // The half before the pilcrow is 37 characters — under the length floor — so a
    // bare-pilcrow split drops it from the denominator and nothing checks whether
    // the reviser deleted it.
    expect(sentences[0]).toContain("A sentence long enough to be measured");
    expect(proseRetention(page, page).ratio).toBe(1);
  });

  test("a paragraph break the DRAFT introduces does not read as prose loss", () => {
    // The last member of the class, and the design's own output: a hard-wrapped
    // paragraph with the restored block inserted between its two lines. The page
    // side sees one paragraph, the draft side two — so the sentinel must not reach
    // the haystack.
    const page = "---\ntype: source\ntitle: T\n---\n\n# T\n\nA hard-wrapped paragraph whose first line runs on\nand whose second line finishes the same sentence.\n";
    const revised = "---\ntype: source\ntitle: T\n---\n\n# T\n\nA hard-wrapped paragraph whose first line runs on\n\n```yaml\nservices: { postgres: {} }\n```\n\nand whose second line finishes the same sentence.\n";
    expect(proseRetention(page, revised).ratio).toBe(1);
  });

  test("and a page of every shape at once, fenced code included", () => {
    const page = [
      "---",
      "type: source",
      "title: T",
      "---",
      "",
      "# T",
      "",
      ...shapes.map(([, sentence]) => `${sentence}\n`),
      "```yaml",
      "services:",
      "  postgres: { image: postgres:latest }",
      "```",
    ].join("\n");
    const r = proseRetention(page, page);
    // Some shapes split into two measurable sentences; every one of them is found.
    expect(r.total).toBeGreaterThanOrEqual(shapes.length);
    expect(r.found).toBe(r.total);
  });
});

describe("proseRetention", () => {
  test("a page against itself retains everything", () => {
    expect(proseRetention(PAGE, PAGE)).toEqual({ total: 3, found: 3, ratio: 1 });
  });

  test("a sentence survives the containment step delinking its wikilink", () => {
    // `containDraftBodyLinks` rewrites an unresolvable `[[Foo]]` to `**Foo**` at
    // persist time, INSIDE prose, and the score sees the contained draft. Compared
    // raw, the sentence reads as deleted and the guard refuses a revision that
    // changed nothing.
    const linked = PAGE.replace("external services.", "external services, per [[Hexagonal Architecture]].");
    const contained = linked.replace("[[Hexagonal Architecture]]", "**Hexagonal Architecture**");
    expect(proseRetention(linked, contained).ratio).toBe(1);

    // …and the piped form, which carries the LABEL into the page's prose.
    const piped = PAGE.replace("external services.", "external services, per [[Hexagonal Architecture|hex arch]].");
    expect(proseRetention(piped, piped.replace("[[Hexagonal Architecture|hex arch]]", "**hex arch**")).ratio).toBe(1);
  });

  test("a rewritten paragraph is a loss the code score cannot see", () => {
    const rewritten = PAGE.replace(
      "Dependency injection frameworks are described as mostly harmless",
      "DI frameworks are mostly harmless",
    );
    expect(proseRetention(PAGE, rewritten)).toMatchObject({ total: 3, found: 2 });
  });

  test("prose the reviser ADDS is invisible — every restored block gets a lead", () => {
    const withLead = PAGE.replace("## See also", "A lead sentence the prompt asks for, introducing the block above.\n\n## See also");
    expect(proseRetention(PAGE, withLead).ratio).toBe(1);
  });

  test("a page with no prose at all retains everything rather than dividing by zero", () => {
    expect(proseRetention("---\ntype: source\n---\n\n# Title\n", "anything")).toEqual({
      total: 0,
      found: 0,
      ratio: 1,
    });
  });
});

describe("judgeBackfill", () => {
  const twoLost = blocks([
    { found: 0, lines: 10 },
    { found: 0, lines: 6 },
  ]);
  /** Prose held constant, so each case below is about the code score alone. */
  const judge = (before: BlockRetention[], after: BlockRetention[]) =>
    judgeBackfill({ before, after, currentPage: PAGE, draft: PAGE });

  test("a recovered block passes", () => {
    const after = blocks([
      { found: 10, lines: 10 },
      { found: 0, lines: 6 },
    ]);
    expect(judge(twoLost, after)).toEqual({
      ok: true,
      reason: "1/2 kept, 10 lines (was 0/2, 0), prose 3/3",
    });
  });

  test("more lines of a still-partial block passes — progress the kept count can't see", () => {
    const after = blocks([
      { found: 4, lines: 10 },
      { found: 0, lines: 6 },
    ]);
    expect(judge(twoLost, after).ok).toBe(true);
  });

  test("an unchanged page is refused as a no-op, not queued for review", () => {
    const verdict = judge(twoLost, twoLost);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no block recovered");
  });

  test("dropping lines of a block refuses even when the kept count holds", () => {
    // Both sides score the same 1 kept block (9/10 and 8/10 are both ≥ 80%), so
    // only the line count can see the loss.
    const before = blocks([{ found: 9, lines: 10 }]);
    const after = blocks([{ found: 8, lines: 10 }]);
    expect(retentionScore(before).kept).toBe(retentionScore(after).kept);
    const verdict = judge(before, after);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("scores worse");
  });

  test("destroying a whole block refuses even when MORE lines are found overall", () => {
    // The case only the `kept` clause can see: one block whole plus one lost, for
    // two half-quoted blocks. Lines go UP, a whole quoted artefact is gone.
    const before = blocks([
      { found: 10, lines: 10 },
      { found: 0, lines: 10 },
    ]);
    const after = blocks([
      { found: 7, lines: 10 },
      { found: 5, lines: 10 },
    ]);
    expect(retentionScore(after).found).toBeGreaterThan(retentionScore(before).found);
    expect(judge(before, after).ok).toBe(false);
  });

  test("recovering every block still refuses when the prose was rewritten", () => {
    // The whole reason this backfill revises instead of re-drafting: a fresh
    // re-draft of `sources/Software Minimalism.mdx` measured 3/3 blocks kept and
    // 0 of 29 prose sentences surviving (2026-09-16).
    const verdict = judgeBackfill({
      before: twoLost,
      after: blocks([
        { found: 10, lines: 10 },
        { found: 6, lines: 6 },
      ]),
      currentPage: PAGE,
      draft: "---\ntype: source\ntitle: Software Minimalism\n---\n\n# Software Minimalism\n\nA completely different article about the same subject, saying none of the same sentences.\n",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("rewrote the page");
  });

  test("the prose floor sits between a re-draft and the sentence a good revision splits", () => {
    // Pins the VALUE, not only the clause that reads it. Deliberately loose: 0.8 and
    // 0.95 both satisfy it, because the floor separates "kept all but one sentence"
    // from "kept none" and no measurement justifies a tighter number.
    expect(MIN_PROSE_RETENTION).toBeGreaterThan(0.75);
    expect(MIN_PROSE_RETENTION).toBeLessThan(28 / 29);
  });
});

describe("retentionScore", () => {
  test("counts kept blocks and found lines", () => {
    expect(retentionScore(blocks([{ found: 10, lines: 10 }, { found: 1, lines: 8 }]))).toEqual({
      kept: 1,
      found: 11,
      blocks: 2,
    });
  });

  test("a partial block is NOT counted as kept — else judgeBackfill reads it as recovered", () => {
    expect(retentionScore(blocks([{ found: 5, lines: 10 }])).kept).toBe(0);
  });
});

/**
 * The operator's line for a page that produced no proposal. Three different things
 * mean "not persisted" and only one of them is the guard's doing.
 */
describe("backfillOutcomeLabel", () => {
  test("an inserted row is persisted", () => {
    expect(backfillOutcomeLabel({ proposalId: "row-1", dryRun: false, judgedOk: true })).toBe("persisted");
  });

  test("the score guard's refusal says refused", () => {
    expect(backfillOutcomeLabel({ proposalId: undefined, dryRun: false, judgedOk: false })).toBe(
      "refused, not persisted",
    );
  });

  test("a REFUSED dry run says refused — the verdict is what a dry run is for", () => {
    // The fourth state, and the one a branch-order swap silently flips: operator
    // step 2 dry-runs a batch of 5 before the real run.
    expect(backfillOutcomeLabel({ proposalId: undefined, dryRun: true, judgedOk: false })).toBe(
      "refused, not persisted",
    );
  });

  test("a dry run whose score passed says dry run, not refused", () => {
    expect(backfillOutcomeLabel({ proposalId: undefined, dryRun: true, judgedOk: true })).toBe(
      "dry-run, not persisted",
    );
  });


  test("a passing score with no row is an INSERT CONFLICT, never a refusal", () => {
    // `insertWikiProposal` answers null when a live draft/approved proposal already
    // exists for the doc. Reporting that as "refused" beside a passing score tells
    // the operator a working page was rejected by the guard.
    const label = backfillOutcomeLabel({ proposalId: undefined, dryRun: false, judgedOk: true });
    expect(label).toContain("conflict");
    expect(label).not.toContain("refused");
  });
});
