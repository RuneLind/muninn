import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWikiIndex, __resetWikiCacheForTest } from "../wiki/store.ts";
import {
  buildFactcheckRider,
  correctableClaims,
  FACTCHECK_RIDER_MAX,
  pageCarriesFactcheck,
  proposalFactcheckFlag,
  sourceKindNoun,
  stripReproducedFactcheck,
  withFactcheckAppendix,
} from "./factcheck-carry.ts";
import {
  buildSourceDraftPrompt,
  draftSourcePage,
  type DraftSourcePageDeps,
  type SourceDraftInput,
} from "./source-drafter.ts";
import { FACTCHECK_SENTINEL_START, findLiveSentinelBlocks } from "../wiki/factcheck-context.ts";
import * as factchecks from "../db/summary-factchecks.ts";
import type { SummaryFactcheck } from "../db/summary-factchecks.ts";
const countCorrectableClaims = (claims: unknown) => factchecks.countCorrectableClaims(claims);
import type { InsertWikiProposalParams, WikiProposal } from "../db/wiki-proposals.ts";
import { sha256 } from "./util.ts";

const URL = "https://www.tiktok.com/@coach/video/7550000000000000000";
const CHECKED_AT = Date.UTC(2026, 9, 6, 10, 0, 0);

const ANSWER = [
  "Two of three claims hold.",
  "",
  "### ❌ Claim 1/3 — Morning affirmations raise cortisol",
  "",
  "Studies of self-affirmation find it LOWERS cortisol responses to stress, not raises them.",
  "",
  "Confidence: 80/100",
  "",
  "Sources: [pubmed](https://pubmed.ncbi.nlm.nih.gov/1/)",
  "",
  "### ⚠️ Claim 2/3 — Habits form in 21 days",
  "",
  "The median in Lally et al. (2010) was 66 days, with a range of 18–254 days.",
  "",
  "Confidence: 70/100",
  "",
  "Sources: [ucl](https://example.org/lally)",
  "",
  "### ✅ Claim 3/3 — Sleep supports memory consolidation",
  "",
  "Well supported.",
  "",
  "Confidence: 90/100",
  "",
  "Sources: [nih](https://example.org/sleep)",
].join("\n");

function saved(over: Partial<SummaryFactcheck> = {}): SummaryFactcheck {
  return {
    collection: "tiktok-summaries",
    docId: "health/5 Powerful Words.md",
    url: URL,
    bodySha256: "a".repeat(64),
    answer: ANSWER,
    claims: [
      { index: 1, title: "Morning affirmations raise cortisol", quote: "Saying these words raises your cortisol and wakes you up.", verdict: "❌", outcome: "verified", sources: [] },
      { index: 2, title: "Habits form in 21 days", quote: "It takes 21 days to form a habit.", verdict: "⚠️", outcome: "verified", sources: [] },
      { index: 3, title: "Sleep supports memory consolidation", verdict: "✅", outcome: "verified", sources: [] },
    ],
    botName: "jarvis",
    createdAt: CHECKED_AT,
    ...over,
  };
}

const okOnly = (): SummaryFactcheck =>
  saved({
    answer: "### ✅ Claim 1/2 — A\n\nFine.\n\n### ❓ Claim 2/2 — B\n\nUnknown.",
    claims: [
      { index: 1, title: "A", verdict: "✅", outcome: "verified", sources: [] },
      { index: 2, title: "B", verdict: "❓", outcome: "unverifiable", sources: [] },
    ],
  });

const BODY =
  "The creator lists five words to say each morning. Saying these words raises your cortisol and wakes you up. It takes 21 days to form a habit, so repeat them for three weeks. Sleep supports memory consolidation, so the words stick better after a night's rest. The video frames this as rewiring the mind and asks viewers to commit to the practice every day without fail, ideally before checking a phone.";

function page(body: string): string {
  return `---\ntype: source\ntitle: Morning Affirmations\naliases: []\ncreated: 2026-10-06\nupdated: 2026-10-06\ntags: [habits]\nurl: ${URL}\nsources: [${URL}]\n---\n\n# Morning Affirmations\n\n${body}`;
}

function deps(over: Partial<DraftSourcePageDeps> & { prompts?: string[]; inserted?: InsertWikiProposalParams[] } = {}): DraftSourcePageDeps {
  const prompts = over.prompts ?? [];
  const inserted = over.inserted ?? [];
  const input: SourceDraftInput = {
    collection: "tiktok-summaries",
    docId: "health/5 Powerful Words.md",
    url: URL,
    body: BODY,
  };
  return {
    botName: "jarvis",
    wikiDir: "/tmp/wiki",
    input,
    index: null,
    today: "2026-10-06",
    callDrafter: async (prompt) => {
      prompts.push(prompt);
      return page("The video claims the words raise cortisol; sources say self-affirmation lowers it.\n\n## See also\n- [[Habits]]");
    },
    collectWikiRefs: async () => ({ urls: new Set(), idTokens: new Set() }),
    liveTopicKeys: async () => [],
    liveSourceDocUrls: async () => [],
    insertProposal: async (params) => {
      inserted.push(params);
      return { id: "row-1", ...params } as unknown as WikiProposal;
    },
    ...over,
  };
}

describe("sourceKindNoun", () => {
  test("one noun per capture vertical, a neutral fallback otherwise", () => {
    expect(sourceKindNoun("vimeo-summaries")).toBe("the talk");
    expect(sourceKindNoun("youtube-summaries")).toBe("the video");
    expect(sourceKindNoun("tiktok-summaries")).toBe("the video");
    expect(sourceKindNoun("x-articles")).toBe("the post");
    expect(sourceKindNoun("article-summaries")).toBe("the article");
    expect(sourceKindNoun("anthropic-summaries")).toBe("the article");
    expect(sourceKindNoun("something-else")).toBe("the source");
  });

  // Item 13: 3 of 12 article-summaries docs are a Vimeo talk and two YouTube
  // videos, so the URL's host speaks before the collection.
  test("the URL host decides before the collection", () => {
    expect(sourceKindNoun("article-summaries", "https://www.youtube.com/watch?v=abc")).toBe("the video");
    expect(sourceKindNoun("article-summaries", "https://youtu.be/abc")).toBe("the video");
    expect(sourceKindNoun("article-summaries", "https://vimeo.com/123456")).toBe("the talk");
    expect(sourceKindNoun("article-summaries", "https://player.vimeo.com/video/1")).toBe("the talk");
    expect(sourceKindNoun("article-summaries", "https://www.tiktok.com/@a/video/1")).toBe("the video");
    expect(sourceKindNoun("article-summaries", "https://x.com/a/status/1")).toBe("the post");
    expect(sourceKindNoun("article-summaries", "https://twitter.com/a/status/1")).toBe("the post");
    expect(sourceKindNoun("article-summaries", "https://example.org/essay")).toBe("the article");
    expect(sourceKindNoun("article-summaries", "")).toBe("the article");
    expect(sourceKindNoun("article-summaries", "not a url")).toBe("the article");
    // A look-alike host is not the platform.
    expect(sourceKindNoun("article-summaries", "https://notyoutube.com/x")).toBe("the article");
  });
});

describe("correctableClaims", () => {
  test("❌ and ⚠️ claims only, corrections from the answer without Confidence/Sources", () => {
    const claims = correctableClaims(saved());
    expect(claims.map((c) => [c.index, c.verdict])).toEqual([
      [1, "bad"],
      [2, "warn"],
    ]);
    expect(claims[0]!.correction).toBe(
      "Studies of self-affirmation find it LOWERS cortisol responses to stress, not raises them.",
    );
    expect(claims[1]!.correction).toContain("66 days");
    expect(claims[1]!.correction).not.toContain("Confidence");
    expect(claims[1]!.correction).not.toContain("Sources");
  });

  // Item 11: the gate counts the saved claims, so the rider does too — a claim
  // found only as an `answer` heading would ride a prompt the gate never locked.
  test("a ❌ heading the saved claims lack does not count", () => {
    expect(correctableClaims(saved({ claims: [] }))).toEqual([]);
    expect(buildFactcheckRider(saved({ claims: [] }), "tiktok-summaries")).toBe("");
  });

  test("the rider and the gate count with one predicate", () => {
    const claims = [
      { index: 1, title: "a", verdict: " ❌ ", outcome: "verified", sources: [] },
      { index: 2, title: "b", verdict: "⚠", outcome: "verified", sources: [] },
      { index: 3, title: "c", verdict: "BAD", outcome: "verified", sources: [] },
      { index: 4, title: "d", verdict: "✅", outcome: "verified", sources: [] },
    ];
    expect(correctableClaims(saved({ claims })).map((c) => [c.index, c.verdict])).toEqual([
      [1, "bad"],
      [2, "warn"],
      [3, "bad"],
    ]);
    expect(countCorrectableClaims(claims)).toEqual({ bad: 2, warn: 1 });
    // A malformed value counts nothing rather than throwing.
    expect(countCorrectableClaims({ x: 1 })).toEqual({ bad: 0, warn: 0 });
    expect(countCorrectableClaims([null, 7, { verdict: 3 }, { verdict: "❌" }])).toEqual({ bad: 1, warn: 0 });
  });
});

describe("buildFactcheckRider", () => {
  test("no row, or a ✅/❓-only check, is no rider", () => {
    expect(buildFactcheckRider(null, "tiktok-summaries")).toBe("");
    expect(buildFactcheckRider(okOnly(), "tiktok-summaries")).toBe("");
  });

  test("attributes each ❌/⚠️ claim to the source kind and states the two rules", () => {
    const rider = buildFactcheckRider(saved(), "tiktok-summaries");
    expect(rider).toContain("the video claims “Saying these words raises your cortisol and wakes you up”. Sources say: Studies of self-affirmation find it LOWERS cortisol");
    expect(rider).toContain("the video claims “It takes 21 days to form a habit”.");
    expect(rider).toContain("Never state one of these claims as fact");
    expect(rider).toContain("The video claims X; sources say Y.");
    expect(rider).toContain("Do not reproduce the fact-check section; it is added for you.");
    expect(rider).toContain("2026-10-06");
    // The ✅ claim is not a finding.
    expect(rider).not.toContain("Sleep supports memory");
    expect(buildFactcheckRider(saved({ url: null }), "vimeo-summaries")).toContain("the talk claims");
  });

  // Item 14: from six real drafter runs — 3/6 listed the ⚠️ claim as a bare
  // bullet among the speaker's points, 3/6 judged claims the check never covered.
  test("states the attribute-every-time and the say-nothing-else rules", () => {
    const rider = buildFactcheckRider(saved(), "tiktok-summaries");
    expect(rider).toContain(
      "Do not state a listed claim as fact anywhere, including in a list of the video's points: attribute it every time.",
    );
    expect(rider).toContain("Say nothing about the accuracy of claims not listed here.");
  });

  test("quoting: no nested straight quotes, no '.\".' run", () => {
    const quoted = saved({
      claims: [{ index: 1, title: "t", quote: 'He said "five words" fix stress.', verdict: "❌", outcome: "verified", sources: [] }],
    });
    const rider = buildFactcheckRider(quoted, "tiktok-summaries");
    const line = rider.split("\n").find((l) => l.startsWith("- Claim 1"))!;
    expect(line).toContain("the video claims “He said ‘five words’ fix stress”. Sources say:");
    expect(rider).not.toMatch(/[.!?]["”]\./);
    expect(rider).not.toContain('"');
  });
  test("the URL host picks the noun in the rider", () => {
    const rider = buildFactcheckRider(saved({ collection: "article-summaries", url: "https://vimeo.com/1" }), "article-summaries");
    expect(rider).toContain("the talk claims");
  });

  test("the findings are capped at FACTCHECK_RIDER_MAX chars and the rest is counted", () => {
    const many = Array.from({ length: 12 }, (_, i) => i + 1);
    const answer = many
      .map((n) => `### ❌ Claim ${n}/12 — Claim ${n}\n\n${"Wrong because evidence says otherwise. ".repeat(12)}\n\nConfidence: 80/100`)
      .join("\n\n");
    const claims = many.map((n) => ({
      index: n,
      title: `Claim ${n}`,
      quote: "q ".repeat(150),
      verdict: "❌",
      outcome: "verified",
      sources: [],
    }));
    const rider = buildFactcheckRider(saved({ answer, claims }), "tiktok-summaries");
    const findings = rider.split("--- BEGIN FACT-CHECK FINDINGS ---\n")[1]!.split("\n--- END")[0]!;
    const listed = findings.split("\n").filter((l) => l.startsWith("- Claim "));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(12);
    expect(listed.join("\n").length).toBeLessThanOrEqual(FACTCHECK_RIDER_MAX);
    expect(findings).toContain(`(${12 - listed.length} more corrected claim(s) not shown`);
  });
});

describe("buildSourceDraftPrompt — no saved row", () => {
  // The hash was taken from `buildSourceDraftPrompt` on origin/main (93bcf321),
  // before the rider existed, with exactly these inputs.
  const pinnedInput = {
    input: { collection: "tiktok-summaries", docId: "health/Words.md", url: "https://www.tiktok.com/@x/video/1", body: "A summary body. ".repeat(40) },
    today: "2026-10-06",
    existingPages: ["Sleep", "Creatine (aliases: Cr)"],
  };
  const PINNED = "45e89b2d6bbbda28a4c6b820e9013f840e27a19520f3924f494f4a358a21b20e";

  test("is byte-identical to the prompt before this change", () => {
    expect(sha256(buildSourceDraftPrompt(pinnedInput))).toBe(PINNED);
    expect(sha256(buildSourceDraftPrompt({ ...pinnedInput, factcheckRider: "" }))).toBe(PINNED);
  });

  test("the drafter sends that same prompt when the lookup finds no row, or throws", async () => {
    for (const getFactcheck of [async () => null, async () => Promise.reject(new Error("no table"))]) {
      const prompts: string[] = [];
      const inserted: InsertWikiProposalParams[] = [];
      const d = deps({ prompts, inserted, getFactcheck });
      const out = await draftSourcePage(d);
      expect(out.outcome).toBe("drafted");
      expect(prompts[0]).toBe(buildSourceDraftPrompt({ input: d.input, today: d.today, existingPages: [] }));
      expect(inserted[0]!.draft).not.toContain(FACTCHECK_SENTINEL_START);
    }
  });
});

describe("draftSourcePage with a saved check (stub drafter)", () => {
  test("keys the lookup by the input's collection + docId, rides the rider, appends the block", async () => {
    const prompts: string[] = [];
    const inserted: InsertWikiProposalParams[] = [];
    const asked: string[] = [];
    const out = await draftSourcePage(
      deps({
        prompts,
        inserted,
        getFactcheck: async (collection, docId) => {
          asked.push(`${collection}/${docId}`);
          return saved();
        },
      }),
    );
    expect(out.outcome).toBe("drafted");
    expect(asked).toEqual(["tiktok-summaries/health/5 Powerful Words.md"]);
    expect(prompts[0]).toContain(buildFactcheckRider(saved(), "tiktok-summaries"));
    // The rider sits ABOVE the untrusted summary fence.
    expect(prompts[0]!.indexOf("FACT-CHECK FINDINGS")).toBeLessThan(prompts[0]!.indexOf("--- BEGIN SOURCE SUMMARY ---"));
    const draft = inserted[0]!.draft;
    expect(findLiveSentinelBlocks(draft)).toHaveLength(1);
    expect(draft).toContain("<FactCheck date=\"2026-10-06\" ok=\"1\" warn=\"1\" bad=\"1\">");
    expect(draft).toContain("### ❌ Claim 1/3 — Morning affirmations raise cortisol");
    // The fixture's ❌ claim is never restated as true by the persisted page: the
    // only place the claim's wording appears is attributed, and its block says ❌.
    const prose = draft.slice(0, draft.indexOf(FACTCHECK_SENTINEL_START));
    expect(prose).not.toContain("Saying these words raises your cortisol");
    expect(prose).toContain("The video claims the words raise cortisol; sources say");
    expect(draft.endsWith("<!-- factcheck:end -->")).toBe(true);
  });

  test("a ✅-only check still appends its block but sends no rider", async () => {
    const prompts: string[] = [];
    const inserted: InsertWikiProposalParams[] = [];
    const d = deps({ prompts, inserted, getFactcheck: async () => okOnly() });
    await draftSourcePage(d);
    expect(prompts[0]).toBe(buildSourceDraftPrompt({ input: d.input, today: d.today, existingPages: [] }));
    expect(findLiveSentinelBlocks(inserted[0]!.draft)).toHaveLength(1);
  });

  test("update mode: no lookup, no rider, no append", async () => {
    const inserted: InsertWikiProposalParams[] = [];
    let looked = false;
    const current = page("The page as it stands.\n\n## See also\n- [[Habits]]");
    const out = await draftSourcePage(
      deps({
        inserted,
        callDrafter: async () => current,
        update: { relPath: "sources/Morning Affirmations.mdx", currentText: current },
        getFactcheck: async () => {
          looked = true;
          return saved();
        },
      }),
    );
    expect(out.outcome).toBe("drafted");
    expect(looked).toBe(false);
    expect(inserted[0]!.mode).toBe("update");
    expect(inserted[0]!.draft).not.toContain(FACTCHECK_SENTINEL_START);
  });

  test("no double block: a block and a Fact check section the model wrote are replaced by ONE", async () => {
    const inserted: InsertWikiProposalParams[] = [];
    const reproduced = page(
      [
        "The video claims the words raise cortisol; sources say otherwise.",
        "",
        "## Fact check",
        "",
        "- ❌ cortisol claim is wrong",
        "",
        "## See also",
        "- [[Habits]]",
        "",
        "<!-- factcheck:start -->",
        "<FactCheck date=\"2026-10-01\" bad=\"1\">",
        "",
        "### ❌ Claim 1/1 — model copy",
        "</FactCheck>",
        "<!-- factcheck:end -->",
      ].join("\n"),
    );
    await draftSourcePage(deps({ inserted, callDrafter: async () => reproduced, getFactcheck: async () => saved() }));
    const draft = inserted[0]!.draft;
    expect(findLiveSentinelBlocks(draft)).toHaveLength(1);
    expect(draft.split(FACTCHECK_SENTINEL_START)).toHaveLength(2);
    expect(draft).not.toContain("model copy");
    expect(draft).not.toContain("## Fact check");
    expect(draft).toContain("## See also\n- [[Habits]]");
  });
});

describe("stripReproducedFactcheck / pageCarriesFactcheck", () => {
  test("a fenced example is content, not a block or a heading", () => {
    const text = page("Intro.\n\n```md\n## Fact check\n<!-- factcheck:start -->\nx\n<!-- factcheck:end -->\n```\n\nEnd.");
    expect(pageCarriesFactcheck(text)).toBe(false);
    expect(stripReproducedFactcheck(text)).toBe(text);
  });

  test("withFactcheckAppendix on a page that already carries one keeps exactly one", () => {
    const once = withFactcheckAppendix(page("Body."), saved());
    const twice = withFactcheckAppendix(once, saved());
    expect(twice).toBe(once);
    expect(pageCarriesFactcheck(once)).toBe(true);
    expect(pageCarriesFactcheck(page("Body.\n\n### Fact-check\n\nx"))).toBe(true);
    expect(pageCarriesFactcheck(page("Body."))).toBe(false);
  });

  // Item 4: only a reproduced fact-check heading goes — h2–h6 whose whole text
  // is "Fact check", optionally a date or a parenthetical.
  test("strips exactly a reproduced Fact check heading section", () => {
    for (const heading of [
      "## Fact check",
      "## Fact-check",
      "## Factcheck",
      "### Fact Check",
      "## Fact check (2026-10-06)",
      "## Fact check — 2026-10-06",
      "## Fact check: 2026-10-06",
      "## Fact check 2026-10-06",
      "###### Fact check (from the summary)",
      "  ## Fact check ##",
    ]) {
      const text = page(`Intro.\n\n${heading}\n\n- ❌ wrong\n\n## See also\n- [[Habits]]`);
      const out = stripReproducedFactcheck(text);
      expect(out).not.toContain("❌ wrong");
      expect(out).toContain("## See also\n- [[Habits]]");
      expect(pageCarriesFactcheck(text)).toBe(true);
    }
  });

  test("keeps every heading that is not a bare reproduced Fact check", () => {
    for (const heading of [
      "## Fact check: the 2024 study",
      "## Fact checking in newsrooms",
      "## FactCheck.org",
      "## Fact-check notes",
      "## How FactCheck.org works",
      "## Fact check of the claims about sleep",
    ]) {
      const text = page(`Intro.\n\n${heading}\n\nReal section prose.\n\n## See also\n- [[Habits]]`);
      expect(stripReproducedFactcheck(text)).toBe(text);
      expect(pageCarriesFactcheck(text)).toBe(false);
    }
  });

  test("never strips an H1, even one titled Fact check", () => {
    const h1 = `---\ntype: source\ntitle: Fact check\n---\n\n# Fact check\n\nThe whole page body.\n\n## Details\n\nMore.`;
    expect(stripReproducedFactcheck(h1)).toBe(h1);
    const h1b = `---\ntype: source\ntitle: x\n---\n\n# Fact check (2026-10-06)\n\nBody.`;
    expect(stripReproducedFactcheck(h1b)).toBe(h1b);
    expect(pageCarriesFactcheck(h1b)).toBe(false);
  });
});

describe("draftSourcePage — strip order, digest, and what reads the persisted draft", () => {
  const reproducedTail = (extra = "") =>
    page(`The video claims the words raise cortisol; sources say otherwise.${extra}\n\n## Fact check\n\n- ❌ wrong, see [[Cortisol Myths]] and [[Habits]]`);

  // Item 3: a URL-less doc gets its callout appended after the body; a trailing
  // model "## Fact check" section must not take that callout with it.
  test("a URL-less doc keeps its Source pending ingestion callout", async () => {
    const inserted: InsertWikiProposalParams[] = [];
    const d = deps({ inserted, callDrafter: async () => reproducedTail(), getFactcheck: async () => saved() });
    d.input = { ...d.input, url: "" };
    const out = await draftSourcePage(d);
    expect(out.outcome).toBe("drafted");
    const draft = inserted[0]!.draft;
    expect(draft).toContain("> [!note] Source pending ingestion");
    expect(draft).toContain("`tiktok-summaries/health/5 Powerful Words.md` has no public URL yet.");
    expect(draft).not.toContain("❌ wrong, see");
    expect(findLiveSentinelBlocks(draft)).toHaveLength(1);
  });

  // Item 1: the row records WHICH check it was built with.
  test("the source doc records the digest of the check's answer; no check, no digest", async () => {
    const inserted: InsertWikiProposalParams[] = [];
    await draftSourcePage(deps({ inserted, getFactcheck: async () => saved() }));
    expect(inserted[0]!.sourceDocs[0]!.factcheckSha256).toBe(sha256(ANSWER));
    const plain: InsertWikiProposalParams[] = [];
    await draftSourcePage(deps({ inserted: plain, getFactcheck: async () => null }));
    expect("factcheckSha256" in plain[0]!.sourceDocs[0]!).toBe(false);
  });

  // Item 5: related pages and de-linked links are read off what is persisted,
  // not off a section the strip then removes.
  test("relatedPages and containedLinks ignore a stripped Fact check section", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fc-carry-related-"));
    await mkdir(path.join(root, "concepts"), { recursive: true });
    await writeFile(path.join(root, "index.md"), "# Index\n");
    await writeFile(path.join(root, "concepts", "Habits.md"), "---\ntype: concept\ntitle: Habits\n---\n\n# Habits\n\nBody.\n");
    __resetWikiCacheForTest();
    const index = await getWikiIndex({ root });
    const inserted: InsertWikiProposalParams[] = [];
    const d = deps({ inserted, index, wikiDir: root, callDrafter: async () => reproducedTail(), getFactcheck: async () => saved() });
    try {
      const out = await draftSourcePage(d);
      expect(out.outcome).toBe("drafted");
      expect(inserted[0]!.relatedPages ?? []).toEqual([]);
      expect(inserted[0]!.containedLinks).toBeNull();
      // Control: the same link in the kept body IS picked up.
      const kept: InsertWikiProposalParams[] = [];
      await draftSourcePage({
        ...d,
        insertProposal: async (params) => {
          kept.push(params);
          return { id: "row-2", ...params } as unknown as WikiProposal;
        },
        callDrafter: async () => reproducedTail(" See [[Habits]]."),
      });
      expect(kept[0]!.relatedPages).toEqual([{ title: "Habits", relPath: "concepts/Habits.md" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
      __resetWikiCacheForTest();
    }
  });
});

describe("proposalFactcheckFlag (the gate flag)", () => {
  const SHA = sha256(ANSWER);
  const doc = { collection: "tiktok-summaries", docId: "health/5 Powerful Words.md", title: "5 Powerful Words", url: URL };
  /** A live create draft that carries no record of any check. */
  const plain = {
    kind: "source",
    mode: "create",
    status: "draft",
    wikiName: null as string | null,
    draft: page("Body."),
    sourceDocs: [doc] as WikiProposal["sourceDocs"],
  };
  /** The same draft built with the current check: its digest and its block. */
  const carrying = {
    ...plain,
    draft: withFactcheckAppendix(page("Body."), saved()),
    sourceDocs: [{ ...doc, factcheckSha256: SHA }] as WikiProposal["sourceDocs"],
  };
  const mark = { checkedAt: CHECKED_AT, bad: 1, warn: 1, answerSha256: SHA };

  test("a live create draft that does not carry the current ❌/⚠️ check is locked", () => {
    expect(proposalFactcheckFlag(plain, mark)).toEqual({
      checkedAt: CHECKED_AT,
      bad: 1,
      warn: 1,
      needsRedraft: true,
      missingBlock: true,
    });
    expect(proposalFactcheckFlag(plain, { ...mark, bad: 0 })!.needsRedraft).toBe(true);
  });

  // Item 1: the drafter read "no check", the check was saved during the model
  // call, the row landed after it. No timestamp tells that apart; the digest does.
  test("a draft NEWER than the check that does not carry it is still locked", () => {
    // No createdAt on either input: the lock reads no timestamp at all.
    expect(proposalFactcheckFlag(plain, mark)!.needsRedraft).toBe(true);
    const otherCheck = { ...carrying, sourceDocs: [{ ...doc, factcheckSha256: sha256("an earlier answer") }] };
    expect(proposalFactcheckFlag(otherCheck, mark)!.needsRedraft).toBe(true);
  });

  test("a draft carrying the current check is not locked, however recent the check row", () => {
    expect(proposalFactcheckFlag(carrying, mark)).toBeNull();
    // A re-check that saved the same answer moves checkedAt only.
    expect(proposalFactcheckFlag(carrying, { ...mark, checkedAt: CHECKED_AT + 86_400_000 })).toBeNull();
  });

  test("a ✅/❓-only check flags nothing", () => {
    expect(proposalFactcheckFlag(plain, { ...mark, bad: 0, warn: 0 })).toBeNull();
  });

  test("no check, another kind, or a terminal row flags nothing", () => {
    expect(proposalFactcheckFlag(plain, undefined)).toBeNull();
    expect(proposalFactcheckFlag({ ...plain, kind: "concept" }, mark)).toBeNull();
    for (const status of ["applied", "rejected", "stale", "error"]) {
      expect(proposalFactcheckFlag({ ...plain, status }, mark)).toBeNull();
    }
  });

  // Item 2: the lock is `redraftRefusal`'s own predicate, so it never strands a
  // card whose only way out Redraft would refuse.
  test("a draft Redraft would refuse is never locked; it gets the note only", () => {
    const wikiKeyed = proposalFactcheckFlag({ ...plain, wikiName: "mimir" }, mark)!;
    expect(wikiKeyed.needsRedraft).toBe(false);
    expect(wikiKeyed.missingBlock).toBe(true);
    const noDoc = proposalFactcheckFlag({ ...plain, sourceDocs: [{ ...doc, docId: "" }] }, mark);
    expect(noDoc === null || noDoc.needsRedraft === false).toBe(true);
    // An approved row is mid-apply: the note, never the lock.
    expect(proposalFactcheckFlag({ ...plain, status: "approved" }, mark)!.needsRedraft).toBe(false);
  });

  // Item 12: update mode never appends and Redraft refuses it, so the note
  // would be one nothing can clear.
  test("an update-mode row gets no flag at all", () => {
    expect(proposalFactcheckFlag({ ...plain, mode: "update" }, mark)).toBeNull();
    expect(proposalFactcheckFlag({ ...plain, mode: "update", status: "approved" }, mark)).toBeNull();
  });
});
