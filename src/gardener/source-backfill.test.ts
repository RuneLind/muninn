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

  test("the prose floor leaves room for the one sentence a good revision splits", () => {
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

  test("a dry run says dry run, not refused", () => {
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
