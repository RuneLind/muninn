import { test, expect, describe } from "bun:test";
import {
  applyAmplification,
  articleOwnerHandle,
  buildArticleGroups,
  normalizeArticleUrl,
  resolveAmplificationConfig,
  DEFAULT_AMPLIFICATION_MIN_AUTHORS,
  DEFAULT_AMPLIFICATION_MAX_PROMOTIONS,
  type RankedDoc,
} from "./x-amplification.ts";
// The REAL 2026-07-25 two-day x-feed window (476 docs, 100% listing-score coverage),
// score-descending — the same window the campaign was calibrated against. Fields are the
// amplification-relevant slice of a fetched doc: id, handle, combined_score, `**Type:**`
// marker, and the `- **Article:**` footer permalink.
import xWindow from "./__fixtures__/x-feed-2026-07-25-window.json";

const ART = "https://x.com/owner/article/111";

function doc(over: Partial<RankedDoc> & { docId: string }): RankedDoc {
  return {
    handle: "@someone",
    rankScore: 0.5,
    docType: null,
    articleUrl: null,
    ...over,
  };
}

/** N filler docs at descending scores, so a topN band exists to displace out of. */
function filler(n: number, from = 0.9): RankedDoc[] {
  return Array.from({ length: n }, (_, i) =>
    doc({ docId: `fill-${String(i).padStart(3, "0")}.md`, handle: `@f${i}`, rankScore: from - i * 0.001 }),
  );
}

const CFG = { minAuthors: DEFAULT_AMPLIFICATION_MIN_AUTHORS, maxPromotions: DEFAULT_AMPLIFICATION_MAX_PROMOTIONS };

// ── URL normalization + owner parsing ───────────────────────────────

describe("normalizeArticleUrl", () => {
  test("lowercases, strips query/fragment and trailing slashes", () => {
    const canonical = "https://x.com/trq212/article/2080710971228918066";
    for (const raw of [
      canonical,
      `${canonical}/`,
      `${canonical}///`,
      `${canonical}?s=20`,
      `${canonical}#top`,
      `  ${canonical.toUpperCase()}  `,
    ]) {
      expect(normalizeArticleUrl(raw)).toBe(canonical);
    }
  });
});

describe("articleOwnerHandle", () => {
  test("reads the owner out of the permalink", () => {
    expect(articleOwnerHandle("https://x.com/trq212/article/2080710971228918066")).toBe("trq212");
    expect(articleOwnerHandle("https://twitter.com/MushtaqBilalPhD/article/1")).toBe("mushtaqbilalphd");
  });

  test("null for a URL that isn't an article permalink", () => {
    expect(articleOwnerHandle("https://x.com/trq212/status/123")).toBeNull();
    expect(articleOwnerHandle("not a url")).toBeNull();
  });
});

// ── Grouping ────────────────────────────────────────────────────────

describe("buildArticleGroups", () => {
  test("groups the article doc and its amplifiers under one normalized key", () => {
    const docs = [
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.6, docType: "article", articleUrl: ART }),
      doc({ docId: "amp1.md", handle: "@alice", rankScore: 0.5, docType: "note", articleUrl: `${ART}?s=20` }),
      doc({ docId: "amp2.md", handle: "@bob", rankScore: 0.4, articleUrl: `${ART}/` }),
      doc({ docId: "other.md", handle: "@carol", rankScore: 0.3 }),
    ];
    const groups = buildArticleGroups(docs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(ART);
    expect(groups[0]!.owner).toBe("owner");
    expect(groups[0]!.docs.map((d) => d.docId)).toEqual(["art.md", "amp1.md", "amp2.md"]);
    expect(groups[0]!.representative.docId).toBe("art.md");
    expect(groups[0]!.collapsed.map((d) => d.docId)).toEqual(["amp1.md", "amp2.md"]);
    expect(groups[0]!.amplifierAuthors).toBe(2);
  });

  test("the SAME article promoted twice (two discovery dates) is one group", () => {
    const groups = buildArticleGroups([
      doc({ docId: "2026-07-24_owner_1.md", handle: "@owner", rankScore: 0.6, docType: "article", articleUrl: ART }),
      doc({ docId: "2026-07-18_owner_1.md", handle: "@owner", rankScore: 0.4, docType: "article", articleUrl: ART }),
    ]);
    expect(groups).toHaveLength(1);
    // The higher-scoring copy represents; the older duplicate is collapsed out of the digest.
    expect(groups[0]!.representative.docId).toBe("2026-07-24_owner_1.md");
    expect(groups[0]!.collapsed.map((d) => d.docId)).toEqual(["2026-07-18_owner_1.md"]);
    expect(groups[0]!.amplifierAuthors).toBe(0);
  });

  test("one account quote-tweeting three times counts as ONE author", () => {
    const groups = buildArticleGroups([
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.6, docType: "article", articleUrl: ART }),
      doc({ docId: "a1.md", handle: "@Alice", rankScore: 0.5, articleUrl: ART }),
      doc({ docId: "a2.md", handle: "@alice", rankScore: 0.4, articleUrl: ART }),
      doc({ docId: "a3.md", handle: "alice", rankScore: 0.3, articleUrl: ART }),
    ]);
    expect(groups[0]!.amplifierAuthors).toBe(1);
    expect(groups[0]!.collapsed).toHaveLength(3);
  });

  test("the article's OWN author never amplifies their own article", () => {
    const groups = buildArticleGroups([
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.6, docType: "article", articleUrl: ART }),
      doc({ docId: "self.md", handle: "@Owner", rankScore: 0.5, articleUrl: ART }),
    ]);
    expect(groups[0]!.amplifierAuthors).toBe(0);
  });

  test("with no article doc in the window the best AMPLIFIER represents", () => {
    const groups = buildArticleGroups([
      doc({ docId: "amp1.md", handle: "@alice", rankScore: 0.5, docType: "note", articleUrl: ART }),
      doc({ docId: "amp2.md", handle: "@bob", rankScore: 0.4, articleUrl: ART }),
    ]);
    expect(groups[0]!.representative.docId).toBe("amp1.md");
    expect(groups[0]!.collapsed.map((d) => d.docId)).toEqual(["amp2.md"]);
    // Owner still comes off the permalink, so neither amplifier is mistaken for the author.
    expect(groups[0]!.owner).toBe("owner");
    expect(groups[0]!.amplifierAuthors).toBe(2);
  });

  test("unknown handles are not counted as authors", () => {
    const groups = buildArticleGroups([
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.6, docType: "article", articleUrl: ART }),
      doc({ docId: "u1.md", handle: "unknown", rankScore: 0.5, articleUrl: ART }),
      doc({ docId: "u2.md", handle: "", rankScore: 0.4, articleUrl: ART }),
    ]);
    expect(groups[0]!.amplifierAuthors).toBe(0);
  });

  test("docs without an articleUrl are in no group", () => {
    expect(buildArticleGroups([doc({ docId: "a.md" }), doc({ docId: "b.md" })])).toEqual([]);
  });
});

// ── Collapse ────────────────────────────────────────────────────────

describe("applyAmplification — collapse", () => {
  test("one article takes ONE digest slot, not N+1", () => {
    const docs = [
      doc({ docId: "amp1.md", handle: "@alice", rankScore: 0.61, docType: "note", articleUrl: ART }),
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.60, docType: "article", articleUrl: ART }),
      doc({ docId: "amp2.md", handle: "@bob", rankScore: 0.59, docType: "note", articleUrl: ART }),
      doc({ docId: "plain.md", handle: "@carol", rankScore: 0.58 }),
    ];
    const out = applyAmplification(docs, 30, CFG);
    // The ARTICLE doc is kept even though an amplifier outscored it.
    expect(out.listing.map((d) => d.docId)).toEqual(["art.md", "plain.md"]);
    expect(out.collapsed.map((d) => d.docId)).toEqual(["amp1.md", "amp2.md"]);
  });

  test("collapse keeps the best amplifier when the article doc is absent", () => {
    const out = applyAmplification(
      [
        doc({ docId: "amp1.md", handle: "@alice", rankScore: 0.6, docType: "note", articleUrl: ART }),
        doc({ docId: "amp2.md", handle: "@bob", rankScore: 0.5, docType: "note", articleUrl: ART }),
      ],
      30,
      CFG,
    );
    expect(out.listing.map((d) => d.docId)).toEqual(["amp1.md"]);
  });

  test("collapse still runs with promotion disabled (maxPromotions 0)", () => {
    const out = applyAmplification(
      [
        doc({ docId: "art.md", handle: "@owner", rankScore: 0.6, docType: "article", articleUrl: ART }),
        doc({ docId: "amp.md", handle: "@alice", rankScore: 0.5, articleUrl: ART }),
      ],
      30,
      { minAuthors: 3, maxPromotions: 0 },
    );
    expect(out.listing.map((d) => d.docId)).toEqual(["art.md"]);
    expect(out.promotions).toEqual([]);
  });

  test("non-article docs and their order are untouched", () => {
    const docs = filler(5);
    const out = applyAmplification(docs, 30, CFG);
    expect(out.listing).toEqual(docs);
    expect(out.collapsed).toEqual([]);
    expect(out.promotions).toEqual([]);
  });

  test("the input array is never mutated", () => {
    const docs = [
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.6, docType: "article", articleUrl: ART }),
      doc({ docId: "amp.md", handle: "@alice", rankScore: 0.5, articleUrl: ART }),
    ];
    const before = [...docs];
    applyAmplification(docs, 30, CFG);
    expect(docs).toEqual(before);
  });
});

// ── Threshold ───────────────────────────────────────────────────────

/**
 * A below-the-bar article at rank `topN + 10`, quoted by `amplifiers` distinct authors
 * (each amplifier doc sits even lower, so nothing but the threshold can lift the article).
 */
function scenario(amplifiers: number, over: Partial<{ minAuthors: number; maxPromotions: number }> = {}) {
  const topN = 30;
  const docs: RankedDoc[] = [
    ...filler(topN + 9),
    doc({ docId: "art.md", handle: "@owner", rankScore: 0.40, docType: "article", articleUrl: ART }),
    ...Array.from({ length: amplifiers }, (_, i) =>
      doc({ docId: `amp-${i}.md`, handle: `@amp${i}`, rankScore: 0.30 - i * 0.001, docType: "note", articleUrl: ART }),
    ),
  ];
  return { topN, out: applyAmplification(docs, topN, { ...CFG, ...over }) };
}

describe("applyAmplification — threshold", () => {
  test("ONE amplifier gets no boost", () => {
    const { topN, out } = scenario(1);
    expect(out.promotions).toEqual([]);
    expect(out.listing.slice(0, topN).some((d) => d.docId === "art.md")).toBe(false);
  });

  test("TWO amplifiers get no boost", () => {
    const { topN, out } = scenario(2);
    expect(out.promotions).toEqual([]);
    expect(out.listing.slice(0, topN).some((d) => d.docId === "art.md")).toBe(false);
  });

  test("THREE distinct amplifiers earn the reserved slot", () => {
    const { topN, out } = scenario(3);
    expect(out.promotions).toHaveLength(1);
    expect(out.promotions[0]).toMatchObject({ docId: "art.md", amplifierAuthors: 3, toRank: topN });
    expect(out.promotions[0]!.fromRank).toBeGreaterThan(topN);
    // It enters at the BOTTOM of the band, never as the lead.
    expect(out.listing[topN - 1]!.docId).toBe("art.md");
    expect(out.listing[0]!.docId).toBe("fill-000.md");
  });

  test("three quote-tweets from ONE account do NOT reach the threshold", () => {
    const topN = 30;
    const docs: RankedDoc[] = [
      ...filler(topN + 9),
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.4, docType: "article", articleUrl: ART }),
      doc({ docId: "a1.md", handle: "@alice", rankScore: 0.31, articleUrl: ART }),
      doc({ docId: "a2.md", handle: "@Alice", rankScore: 0.30, articleUrl: ART }),
      doc({ docId: "a3.md", handle: "@ALICE", rankScore: 0.29, articleUrl: ART }),
    ];
    const out = applyAmplification(docs, topN, CFG);
    expect(out.promotions).toEqual([]);
  });

  test("the threshold is configurable", () => {
    expect(scenario(2, { minAuthors: 2 }).out.promotions).toHaveLength(1);
    expect(scenario(3, { minAuthors: 4 }).out.promotions).toEqual([]);
  });

  test("a qualifying article ALREADY inside the band consumes no slot", () => {
    const topN = 3;
    const docs: RankedDoc[] = [
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.9, docType: "article", articleUrl: ART }),
      ...filler(10, 0.5),
      ...Array.from({ length: 3 }, (_, i) =>
        doc({ docId: `amp-${i}.md`, handle: `@amp${i}`, rankScore: 0.1 - i * 0.001, articleUrl: ART }),
      ),
    ];
    const out = applyAmplification(docs, topN, CFG);
    expect(out.promotions).toEqual([]);
    expect(out.listing[0]!.docId).toBe("art.md");
  });
});

// ── Boundedness ─────────────────────────────────────────────────────

describe("applyAmplification — boundedness", () => {
  test("worst case: many junk articles, each massively amplified, displace only maxPromotions docs", () => {
    const topN = 30;
    const baseline = filler(topN + 5);
    const junk: RankedDoc[] = [];
    for (let a = 0; a < 6; a++) {
      const url = `https://x.com/junk${a}/article/${a}`;
      junk.push(doc({ docId: `junk-${a}.md`, handle: `@junk${a}`, rankScore: 0.01, docType: "article", articleUrl: url }));
      for (let i = 0; i < 10; i++) {
        junk.push(doc({ docId: `junk-${a}-amp-${i}.md`, handle: `@j${a}x${i}`, rankScore: 0.005, articleUrl: url }));
      }
    }
    const out = applyAmplification([...baseline, ...junk], topN, CFG);
    // Exactly one reserved slot is spent, and it is the LAST slot of the band.
    expect(out.promotions).toHaveLength(1);
    expect(out.listing[topN - 1]!.docId).toBe("junk-0.md");
    // Everything above it is the untouched score ordering — 29 of the original top 30 survive.
    const kept = out.listing.slice(0, topN - 1).map((d) => d.docId);
    expect(kept).toEqual(baseline.slice(0, topN - 1).map((d) => d.docId));
    // Exactly ONE baseline doc was displaced out of the digest.
    const displaced = baseline.slice(0, topN).filter((d) => !out.listing.slice(0, topN).includes(d));
    expect(displaced.map((d) => d.docId)).toEqual([baseline[topN - 1]!.docId]);
  });

  test("maxPromotions 2 displaces exactly 2, ordered by amplifier count then score", () => {
    const topN = 30;
    const baseline = filler(topN + 5);
    const mk = (name: string, amps: number, score: number) => {
      const url = `https://x.com/${name}/article/1`;
      return [
        doc({ docId: `${name}.md`, handle: `@${name}`, rankScore: score, docType: "article", articleUrl: url }),
        ...Array.from({ length: amps }, (_, i) =>
          doc({ docId: `${name}-amp-${i}.md`, handle: `@${name}a${i}`, rankScore: 0.01, articleUrl: url }),
        ),
      ];
    };
    const out = applyAmplification(
      [...baseline, ...mk("low", 3, 0.2), ...mk("mid", 5, 0.1), ...mk("high", 5, 0.15)],
      topN,
      { minAuthors: 3, maxPromotions: 2 },
    );
    expect(out.promotions.map((p) => p.docId)).toEqual(["high.md", "mid.md"]);
    expect(out.listing.slice(topN - 2, topN).map((d) => d.docId)).toEqual(["high.md", "mid.md"]);
    expect(out.listing.slice(0, topN - 2).map((d) => d.docId)).toEqual(
      baseline.slice(0, topN - 2).map((d) => d.docId),
    );
  });

  test("no promotion when the whole listing already fits in topN", () => {
    const topN = 30;
    const docs: RankedDoc[] = [
      doc({ docId: "art.md", handle: "@owner", rankScore: 0.4, docType: "article", articleUrl: ART }),
      ...Array.from({ length: 3 }, (_, i) =>
        doc({ docId: `amp-${i}.md`, handle: `@amp${i}`, rankScore: 0.3, articleUrl: ART }),
      ),
    ];
    const out = applyAmplification(docs, topN, CFG);
    expect(out.promotions).toEqual([]);
  });

  test("the listing is a permutation of the input minus the collapsed docs", () => {
    const { out } = scenario(4);
    const seen = new Set([...out.listing, ...out.collapsed]);
    expect(out.listing.length + out.collapsed.length).toBe(seen.size);
    expect(new Set(out.listing).size).toBe(out.listing.length);
  });

  test("empty input is safe", () => {
    expect(applyAmplification([], 30, CFG)).toMatchObject({ listing: [], promotions: [], collapsed: [] });
  });
});

// ── Config validation ───────────────────────────────────────────────

describe("resolveAmplificationConfig", () => {
  test("defaults when unset", () => {
    expect(resolveAmplificationConfig({})).toEqual({ minAuthors: 3, maxPromotions: 1 });
  });

  test("valid values are kept — including the falsy-but-valid 0", () => {
    expect(resolveAmplificationConfig({ amplificationMinAuthors: 5, amplificationMaxPromotions: 0 })).toEqual({
      minAuthors: 5,
      maxPromotions: 0,
    });
  });

  test("wrong types, non-integers and out-of-range values fall back to the default", () => {
    for (const bad of ["3", true, null, NaN, Infinity, 2.5, -1, {}, []] as unknown[]) {
      expect(
        resolveAmplificationConfig({
          amplificationMinAuthors: bad as number,
          amplificationMaxPromotions: bad as number,
        }),
      ).toEqual({ minAuthors: 3, maxPromotions: 1 });
    }
  });

  test("minAuthors 0 is out of range (a zero-author threshold would promote every article)", () => {
    expect(resolveAmplificationConfig({ amplificationMinAuthors: 0 }).minAuthors).toBe(3);
  });
});

// ── Replay over the REAL 2026-07-25 two-day window ──────────────────

describe("amplification replay — real x-feed corpus, 2026-07-25 2-day window", () => {
  const window: RankedDoc[] = xWindow as RankedDoc[];
  const TOP_N = 30; // DEFAULT_TOP_N

  test("fixture is the full 2-day window, score-descending", () => {
    expect(window.length).toBe(476);
    expect(window.every((d, i) => i === 0 || window[i - 1]!.rankScore >= d.rankScore)).toBe(true);
  });

  test("the measured digest bars (all computed from the replayed window, never hard-coded)", () => {
    expect(window[TOP_N - 1]!.rankScore).toBeCloseTo(0.6201, 4); // top-30 bar (Daily/Highlights topN)
    expect(window[9]!.rankScore).toBeCloseTo(0.6535, 4); // top-10 bar
    expect(window[0]!.rankScore).toBeCloseTo(0.7493, 4); // trq212's article — the day's top doc
  });

  test("organic census: 32 article-footer docs in 25 groups, NONE reaches 3 distinct amplifiers", () => {
    const groups = buildArticleGroups(window);
    expect(window.filter((d) => d.articleUrl).length).toBe(32);
    expect(groups.length).toBe(25);
    // 7 groups hold more than one doc — the collapse surface (each is an article doc plus
    // exactly one amplifier or one self-quote).
    expect(groups.filter((g) => g.docs.length > 1).length).toBe(7);
    expect(Math.max(...groups.map((g) => g.docs.length))).toBe(2);
    // The live maximum is ONE amplifier — the fetcher's article-footer change is days old,
    // so no organically-amplified article exists yet. The >=3 cases below are synthetic.
    expect(Math.max(...groups.map((g) => g.amplifierAuthors))).toBe(1);
  });

  test("organic window: collapse drops 7 duplicate slots, and NOTHING is promoted", () => {
    const out = applyAmplification(window, TOP_N, CFG);
    expect(out.promotions).toEqual([]);
    expect(out.collapsed).toHaveLength(7);
    expect(out.listing).toHaveLength(window.length - 7);
    // Every collapsed doc shares its article with a survivor that outranks it or is the
    // article's own doc — no article lost its digest representation.
    const keys = new Set(out.listing.filter((d) => d.articleUrl).map((d) => normalizeArticleUrl(d.articleUrl!)));
    for (const c of out.collapsed) expect(keys.has(normalizeArticleUrl(c.articleUrl!))).toBe(true);
  });

  test("collapse removes the near-identical adjacent pairs (the PR-1 reviewer's MED)", () => {
    // @alex_prompter (0.5756, rank 85) amplifies @free_ai_guides' article (0.5755, rank 86):
    // two ADJACENT, near-identical digest lines for one article. Same for @noisyb0y1's pair.
    const out = applyAmplification(window, TOP_N, CFG);
    const ids = new Set(out.listing.map((d) => d.docId));
    expect(ids.has("2026-07-25_alex_prompter_2080926039421911276.md")).toBe(false);
    expect(ids.has("2026-07-25_free_ai_guides_2073391903819608421.md")).toBe(true);
    // ...and @DataChaz's amplifier of @MushtaqBilalPhD's article goes, the article stays.
    const collapsedIds = new Set(out.collapsed.map((d) => d.docId));
    expect([...collapsedIds].some((id) => id.includes("_DataChaz_"))).toBe(true);
    expect(out.listing.some((d) => d.docId.includes("_MushtaqBilalPhD_") && d.docType === "article")).toBe(true);
    // alex_prompter's FOUR other (non-amplifier) docs are untouched — collapse is keyed on
    // the article group, never on the handle.
    expect(out.listing.filter((d) => d.docId.includes("_alex_prompter_"))).toHaveLength(4);
  });

  test("pre/post digest composition — a synthetically amplified mid-band article enters at slot 30", () => {
    // @MushtaqBilalPhD's "Claude Code 101 for Academic Researchers" sits at rank 67 (0.5903),
    // well under the 0.6201 bar. Its ONE organic amplifier (@DataChaz) is extended with two
    // more distinct authors — SYNTHETIC: no >=3-author group exists in the live corpus yet.
    const article = window.find((d) => d.docId.includes("_MushtaqBilalPhD_") && d.docType === "article")!;
    const extra = ["@ampA", "@ampB"].map((h, i) =>
      doc({ docId: `synthetic-amp-${i}.md`, handle: h, rankScore: 0.30, docType: "note", articleUrl: article.articleUrl! }),
    );
    const input = [...window, ...extra].sort((a, b) => b.rankScore - a.rankScore);

    const before = applyAmplification(input, TOP_N, { minAuthors: 3, maxPromotions: 0 });
    expect(before.listing.slice(0, TOP_N).includes(article)).toBe(false);
    const beforeTop = before.listing.slice(0, TOP_N);

    const after = applyAmplification(input, TOP_N, CFG);
    expect(after.promotions).toHaveLength(1);
    expect(after.promotions[0]!.amplifierAuthors).toBe(3);
    expect(after.promotions[0]!.articleUrl).toBe(article.articleUrl!);
    expect(after.promotions[0]!.toRank).toBe(TOP_N);
    expect(after.promotions[0]!.fromRank).toBeGreaterThan(TOP_N);
    // Composition delta: exactly one swap at the bottom of the band, lead untouched.
    const afterTop = after.listing.slice(0, TOP_N);
    expect(afterTop[TOP_N - 1]).toBe(article);
    expect(afterTop.slice(0, TOP_N - 1)).toEqual(beforeTop.slice(0, TOP_N - 1));
    expect(afterTop[0]!.docId).toBe(window[0]!.docId); // trq212 keeps the lead
  });

  test("the same article with only TWO distinct amplifiers stays out of the digest", () => {
    const article = window.find((d) => d.docId.includes("_MushtaqBilalPhD_") && d.docType === "article")!;
    const input = [
      ...window,
      doc({ docId: "synthetic-amp-0.md", handle: "@ampA", rankScore: 0.3, articleUrl: article.articleUrl! }),
    ].sort((a, b) => b.rankScore - a.rankScore);
    const out = applyAmplification(input, TOP_N, CFG);
    expect(out.promotions).toEqual([]);
    expect(out.listing.slice(0, TOP_N).includes(article)).toBe(false);
  });

  test("even the day's junkiest article, amplified sixfold, only reaches slot 30", () => {
    // @imryven's article is the window's LOWEST-scoring article doc (0.3392, rank 419) — the
    // trq212 six-amplifier shape applied to the worst candidate available.
    const article = window.find((d) => d.docId.includes("_imryven_") && d.docType === "article")!;
    const amps = Array.from({ length: 6 }, (_, i) =>
      doc({ docId: `synthetic-junk-amp-${i}.md`, handle: `@junk${i}`, rankScore: 0.2, articleUrl: article.articleUrl! }),
    );
    const input = [...window, ...amps].sort((a, b) => b.rankScore - a.rankScore);
    const out = applyAmplification(input, TOP_N, CFG);
    expect(out.promotions).toHaveLength(1);
    expect(out.listing[TOP_N - 1]).toBe(article);
    // The lead — and the entire rest of the band — is untouched score ordering.
    expect(out.listing.slice(0, TOP_N - 1).every((d) => d.rankScore >= window[TOP_N - 2]!.rankScore)).toBe(true);
  });
});
