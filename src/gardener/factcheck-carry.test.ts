import { test, expect, describe } from "bun:test";
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
import type { SummaryFactcheck } from "../db/summary-factchecks.ts";
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

  test("a ❌ heading the saved claims lack still counts", () => {
    const claims = correctableClaims(saved({ claims: [] }));
    expect(claims.map((c) => c.index)).toEqual([1, 2]);
  });
});

describe("buildFactcheckRider", () => {
  test("no row, or a ✅/❓-only check, is no rider", () => {
    expect(buildFactcheckRider(null, "tiktok-summaries")).toBe("");
    expect(buildFactcheckRider(okOnly(), "tiktok-summaries")).toBe("");
  });

  test("attributes each ❌/⚠️ claim to the source kind and states the two rules", () => {
    const rider = buildFactcheckRider(saved(), "tiktok-summaries");
    expect(rider).toContain('the video claims "Saying these words raises your cortisol and wakes you up."');
    expect(rider).toContain("Sources say: Studies of self-affirmation find it LOWERS cortisol");
    expect(rider).toContain("the video claims \"It takes 21 days to form a habit.\"");
    expect(rider).toContain("Never state one of these claims as fact");
    expect(rider).toContain('"The video claims X; sources say Y."');
    expect(rider).toContain("Do not reproduce the fact-check section; it is added for you.");
    expect(rider).toContain("2026-10-06");
    // The ✅ claim is not a finding.
    expect(rider).not.toContain("Sleep supports memory");
    expect(buildFactcheckRider(saved(), "vimeo-summaries")).toContain("the talk claims");
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
    expect(pageCarriesFactcheck(page("Body.\n\n### Fact-check notes\n\nx"))).toBe(true);
    expect(pageCarriesFactcheck(page("Body."))).toBe(false);
  });
});

describe("proposalFactcheckFlag (the gate flag)", () => {
  const draftBefore = {
    kind: "source",
    mode: "create",
    status: "draft",
    createdAt: CHECKED_AT - 86_400_000,
    draft: page("Body."),
  };
  const mark = { checkedAt: CHECKED_AT, bad: 1, warn: 1 };

  test("a create draft older than a check with ❌/⚠️ is flagged drafted-before", () => {
    expect(proposalFactcheckFlag(draftBefore, mark)).toEqual({ ...mark, draftedBefore: true, missingBlock: true });
    expect(proposalFactcheckFlag(draftBefore, { checkedAt: CHECKED_AT, bad: 0, warn: 1 })!.draftedBefore).toBe(true);
  });

  test("a ✅/❓-only check flags nothing", () => {
    expect(proposalFactcheckFlag(draftBefore, { checkedAt: CHECKED_AT, bad: 0, warn: 0 })).toBeNull();
  });

  test("no check, another kind, or a terminal row flags nothing", () => {
    expect(proposalFactcheckFlag(draftBefore, undefined)).toBeNull();
    expect(proposalFactcheckFlag({ ...draftBefore, kind: "concept" }, mark)).toBeNull();
    for (const status of ["applied", "rejected", "stale", "error"]) {
      expect(proposalFactcheckFlag({ ...draftBefore, status }, mark)).toBeNull();
    }
  });

  test("a draft made after the check with its block flags nothing; without one it is the at-apply note only", () => {
    const after = { ...draftBefore, createdAt: CHECKED_AT + 1000, draft: withFactcheckAppendix(page("Body."), saved()) };
    expect(proposalFactcheckFlag(after, mark)).toBeNull();
    expect(proposalFactcheckFlag({ ...after, draft: page("Body.") }, mark)).toEqual({
      ...mark,
      draftedBefore: false,
      missingBlock: true,
    });
    // An approved row is mid-apply: the note, never the Redraft lock.
    expect(proposalFactcheckFlag({ ...draftBefore, status: "approved" }, mark)!.draftedBefore).toBe(false);
    // An update-mode draft gets the note only; Redraft is create mode.
    expect(proposalFactcheckFlag({ ...draftBefore, mode: "update" }, mark)!.draftedBefore).toBe(false);
  });
});
