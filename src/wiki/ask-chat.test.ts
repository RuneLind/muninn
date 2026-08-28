import { test, expect, describe } from "bun:test";
import {
  articleThreadTagMatches,
  ASK_CHAT_ANSWER_MIN,
  ASK_CHAT_ARTICLE_DESC_MAX,
  ASK_CHAT_SEED_MAX,
  ASK_CHAT_SOURCES_MAX,
  ASK_CHAT_TITLE_MAX,
  buildArticleChatSeed,
  buildArticleThreadDescription,
  buildAskChatSeed,
  buildDirectChatSeed,
  DECLINE_REASONS,
  deriveAskThreadTitle,
  deriveAskThreadTitleOrNull,
  parseArticleThreadTag,
  uniqueAskThreadTitle,
} from "./ask-chat.ts";

describe("deriveAskThreadTitle", () => {
  test("lowercases and keeps a short question verbatim", () => {
    expect(deriveAskThreadTitle("How does the Gardener cluster?")).toBe(
      "how does the gardener cluster?",
    );
  });

  test("truncates to the createThread 50-char limit with an ellipsis", () => {
    const long = "what exactly happens when the wiki gardener drains the ingest backlog";
    const title = deriveAskThreadTitle(long);
    expect(title.length).toBeLessThanOrEqual(ASK_CHAT_TITLE_MAX);
    expect(title.endsWith("...")).toBe(true);
    expect(title).toBe(long.slice(0, ASK_CHAT_TITLE_MAX - 3) + "...");
  });

  test("flattens the newlines and tabs createThread rejects", () => {
    const title = deriveAskThreadTitle("line one\nline\ttwo\r\nthree");
    expect(title).toBe("line one line two three");
    expect(/[\n\r\t]/.test(title)).toBe(false);
  });

  test("falls back to a stable name when the question flattens to nothing", () => {
    expect(deriveAskThreadTitle("\n\t  ")).toBe("wiki ask");
    expect(deriveAskThreadTitle("")).toBe("wiki ask");
  });

  test("the …OrNull variant reports 'no name here' instead of the fallback", () => {
    // A caller with a SECOND source (the route's typed threadName, falling back to
    // the question) needs to tell an empty name from one that names the fallback —
    // otherwise a control-character name silently pins the thread to "wiki ask".
    expect(deriveAskThreadTitleOrNull("\n\t  ")).toBeNull();
    expect(deriveAskThreadTitleOrNull("")).toBeNull();
    expect(deriveAskThreadTitleOrNull("Real Name")).toBe("real name");
  });
});

describe("uniqueAskThreadTitle", () => {
  const now = new Date(2026, 7, 3, 9, 5); // 2026-08-03 09:05, local

  test("appends a timestamp suffix", () => {
    expect(uniqueAskThreadTitle("short question", now)).toBe("short question-2026-08-03-0905");
  });

  test("stays within the 50-char limit for an already-max-length base", () => {
    const base = "x".repeat(ASK_CHAT_TITLE_MAX);
    const out = uniqueAskThreadTitle(base, now);
    expect(out.length).toBe(ASK_CHAT_TITLE_MAX);
    expect(out.endsWith("-2026-08-03-0905")).toBe(true);
  });

  test("an attempt > 1 adds a disambiguator and still fits", () => {
    const base = "x".repeat(ASK_CHAT_TITLE_MAX);
    const second = uniqueAskThreadTitle(base, now, 2);
    const tenth = uniqueAskThreadTitle(base, now, 10);
    expect(second).toBe(uniqueAskThreadTitle(base, now, 2)); // deterministic
    expect(second).not.toBe(uniqueAskThreadTitle(base, now, 1));
    expect(second.endsWith("-2026-08-03-0905-2")).toBe(true);
    expect(tenth.endsWith("-2026-08-03-0905-10")).toBe(true);
    expect(second.length).toBe(ASK_CHAT_TITLE_MAX);
    expect(tenth.length).toBe(ASK_CHAT_TITLE_MAX);
  });
});

describe("thread-name truncation is surrogate-safe", () => {
  test("an astral question never stores a replacement char and never exceeds 50", () => {
    const title = deriveAskThreadTitle("🧠".repeat(40));
    expect(title.length).toBeLessThanOrEqual(ASK_CHAT_TITLE_MAX);
    expect(title).not.toContain("�");
    // A half-pair would show up as a lone surrogate — assert the string is
    // well-formed by round-tripping it through the code-point iterator.
    expect([...title].join("")).toBe(title);
    expect(/[\uD800-\uDFFF]/.test(title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
  });
});

describe("buildAskChatSeed", () => {
  const base = {
    wikiName: "jarvis",
    question: "How does the gardener cluster summaries?",
    answer: "It clusters by topic key,\nthen drafts one page per cluster.",
    citations: [
      { pageName: "Wiki Gardener", title: "wiki-gardener.md" },
      { title: "Ingest backlog" },
    ],
  };

  test("carries the question, the quoted answer and the sources", () => {
    const seed = buildAskChatSeed(base);
    expect(seed).toContain(base.question);
    expect(seed).toContain("> It clusters by topic key,");
    expect(seed).toContain("> then drafts one page per cluster.");
    expect(seed).toContain("Sources cited by the wiki: Wiki Gardener · Ingest backlog");
    expect(seed).toContain('"jarvis" wiki');
  });

  test("frames the quoted answer as prior context, not a question to re-answer", () => {
    const seed = buildAskChatSeed(base);
    expect(seed).toContain("PRIOR CONTEXT");
    expect(seed.toLowerCase()).toContain("don't just repeat it back");
  });

  test("prefers pageName, dedupes and drops empty citation names", () => {
    const seed = buildAskChatSeed({
      ...base,
      citations: [
        { pageName: "A Page", title: "ignored" },
        { pageName: "A Page" },
        { title: "" },
        { title: "Second" },
      ],
    });
    expect(seed).toContain("Sources cited by the wiki: A Page · Second");
  });

  test("omits the sources line entirely when there are no citations", () => {
    const seed = buildAskChatSeed({ ...base, citations: [] });
    expect(seed).not.toContain("Sources cited by the wiki");
  });

  test("truncates an oversized answer and stays within the seed cap", () => {
    const seed = buildAskChatSeed({ ...base, answer: "z".repeat(20_000) });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("(answer truncated)");
    // The question and the sources survive the cut — they're what make the
    // continuation addressable.
    expect(seed).toContain(base.question);
    expect(seed).toContain("Sources cited by the wiki:");
  });

  test("a pasted-document question is truncated — the TOTAL seed is the bound", () => {
    // The cap used to budget only the answer, so an oversized question rode along
    // untruncated: a 200k-char question produced a 205k-char seed.
    const seed = buildAskChatSeed({ ...base, question: "q".repeat(200_000) });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("(question truncated)");
  });

  test("a question big enough to eat the budget still leaves the answer its share", () => {
    // ~5.7k of question used to zero the answer budget, so the seed carried
    // "(answer truncated)" and NONE of the answer — the one thing escalating is for.
    const answer = "the gardener clusters by topic key. ".repeat(200);
    const seed = buildAskChatSeed({ ...base, question: "q".repeat(5_700), answer });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("> the gardener clusters by topic key.");
    // The quoted answer keeps at least its guaranteed minimum share.
    const quotedLen = seed.split("\n").filter((l) => l.startsWith(">")).join("\n").length;
    expect(quotedLen).toBeGreaterThanOrEqual(ASK_CHAT_ANSWER_MIN);
  });

  test("a huge citation list is capped and reports the overflow", () => {
    const citations = Array.from({ length: 8 }, (_, i) => ({
      pageName: `Page ${i} ` + "n".repeat(200),
    }));
    const seed = buildAskChatSeed({ ...base, citations });
    const line = seed.split("\n").find((l) => l.startsWith("Sources cited by the wiki:"))!;
    expect(line.length).toBeLessThanOrEqual(ASK_CHAT_SOURCES_MAX);
    expect(line).toContain("more");
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
  });

  test("everything oversized at once still fits", () => {
    const seed = buildAskChatSeed({
      wikiName: "w".repeat(500),
      question: "q".repeat(50_000),
      answer: "a".repeat(50_000),
      citations: Array.from({ length: 20 }, (_, i) => ({ pageName: `P${i} ` + "x".repeat(300) })),
    });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
  });

  test("a non-string citation field can't throw out of the pure builder", () => {
    const seed = buildAskChatSeed({
      ...base,
      citations: [{ pageName: 123 }, { title: null }, { pageName: "Real Page" }] as never,
    });
    expect(seed).toContain("Sources cited by the wiki: Real Page");
  });
});

/**
 * `buildDirectChatSeed` — the seed for a question escalated WITHOUT asking the
 * wiki first ("New chat"). No answer to quote, so it is a separate builder rather
 * than the answer builder fed an empty string.
 */
describe("buildDirectChatSeed", () => {
  const base = { wikiName: "mimir", question: "How does the gardener cluster summaries?" };

  test("frames the question as fresh, naming the wiki, with no quoted answer", () => {
    const seed = buildDirectChatSeed({ ...base, webSearch: true });
    expect(seed).toContain('"mimir"');
    expect(seed).toContain("How does the gardener cluster summaries?");
    // Nothing quoted and no follow-up-to-nothing tail.
    expect(seed).not.toContain("\n>");
    expect(seed).not.toContain("What else should I know here?");
    expect(seed).not.toContain("Ask tab answered");
  });

  test("provenance is BRACKETED, never a first-person claim about the reader", () => {
    // The opening used to read "I'm reading the … wiki and want to dig into this",
    // and the memory extractor duly recorded a biographical fact about a user who
    // had only clicked a button (observed: a real memories row asserting the user
    // "maintains" a throwaway test wiki). Provenance, not autobiography.
    const seed = buildDirectChatSeed({ ...base, webSearch: true });
    expect(seed.startsWith('[Question asked from the "mimir" wiki reader]')).toBe(true);
    expect(seed).not.toContain("I'm reading");
    expect(seed).not.toContain("I maintain");
    // The instructions stay imperative.
    expect(seed).toContain("Answer it properly");
  });

  test("a wiki with NO collections is not told to search notes it cannot search", () => {
    // A `WIKI_EXTRA` entry without the collections segment has nothing behind the
    // Ask tab, so "search the wiki's own notes first" is an order that can only
    // fail — observed producing an answer that opened by apologizing for it.
    const without = buildDirectChatSeed({ ...base, webSearch: true, hasCollections: false });
    expect(without).not.toContain("wiki's own notes");
    expect(without).toContain("research it with");
    expect(without).toContain("cite what you find");
    // Provenance is still named — the bot should know where the question came from.
    expect(without).toContain('"mimir"');
    // Absent flag ⇒ the overwhelmingly common searchable shape, unchanged.
    expect(buildDirectChatSeed({ ...base, webSearch: true })).toContain("wiki's own notes");
    expect(buildDirectChatSeed({ ...base, webSearch: true, hasCollections: true })).toContain(
      "wiki's own notes",
    );
  });

  test("the collection-less framing still names web search only when it exists", () => {
    const on = buildDirectChatSeed({ ...base, webSearch: true, hasCollections: false });
    const off = buildDirectChatSeed({ ...base, webSearch: false, hasCollections: false });
    expect(on).toContain("including web search");
    expect(off).not.toContain("web search");
    expect(off).toContain("the tools you have");
  });

  test("names web search only when the effective connector can deliver it", () => {
    expect(buildDirectChatSeed({ ...base, webSearch: true })).toContain("including web search");
    const without = buildDirectChatSeed({ ...base, webSearch: false });
    expect(without).not.toContain("web search");
    // Still asks for real research — it just doesn't promise a tool that isn't there.
    expect(without).toContain("the tools you have");
  });

  test("a DECLINED question is not sent back to search the index that just failed", () => {
    // The decline hook's whole premise: muninn already ran this exact question
    // against the wiki's own index and got nothing solid. "Search the wiki's own
    // notes first" would order the one step known to fail, and an answer whose
    // finding is "the wiki has nothing" is the finding the reader already has.
    const seed = buildDirectChatSeed({ ...base, webSearch: true, declineReason: "no_hits" });
    expect(seed).not.toContain("wiki's own notes first");
    expect(seed).toContain("already been searched");
    expect(seed).toContain("nothing solid");
    expect(seed).toContain("research it with");
    // The capability conditioning is untouched by the new branch.
    expect(seed).toContain("including web search");
    expect(
      buildDirectChatSeed({ ...base, webSearch: false, declineReason: "no_hits" }),
    ).not.toContain("web search");
    // Absent ⇒ byte-identical to the pre-flag seed.
    expect(buildDirectChatSeed({ ...base, webSearch: true, declineReason: undefined })).toBe(
      buildDirectChatSeed({ ...base, webSearch: true }),
    );
  });

  test("a decline beats the collection-less clause — a wiki that declined HAS collections", () => {
    const seed = buildDirectChatSeed({
      ...base, webSearch: true, hasCollections: false, declineReason: "no_hits",
    });
    expect(seed).toContain("already been searched");
    expect(seed).not.toContain("wiki's own notes first");
  });

  test("the declined seed is bounded like every other", () => {
    const seed = buildDirectChatSeed({
      wikiName: "w".repeat(500),
      question: "q".repeat(200_000),
      webSearch: true,
      declineReason: "no_hits",
    });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
  });

  test("the WHOLE seed is bounded, however huge the inputs", () => {
    const seed = buildDirectChatSeed({
      wikiName: "w".repeat(500),
      question: "q".repeat(200_000),
      webSearch: true,
    });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("(question truncated)");
  });

  test("a blank/absent question degrades instead of throwing", () => {
    expect(buildDirectChatSeed({ wikiName: "", question: "   ", webSearch: false })).toContain(
      "knowledge",
    );
    expect(
      buildDirectChatSeed({ wikiName: 5, question: null, webSearch: true } as never),
    ).toBeString();
  });
});

/**
 * `buildArticleChatSeed` — the "💬 Discuss" button on an open article. Same
 * bracketed-provenance / capability-conditioning rules as the direct seed, plus
 * the one thing this mode exists for: the article's wiki-relative PATH, which is
 * what lets the bot pull the real page instead of re-searching for its title.
 */
describe("buildArticleChatSeed", () => {
  const base = {
    wikiName: "mimir",
    pageTitle: "Wiki gardener",
    pagePath: "projects/muninn/wiki-gardener.md",
    question: "Why does the cluster cap starve fresh arrivals?",
  };

  test("names the article and carries its PATH so the bot can pull the page", () => {
    const seed = buildArticleChatSeed({ ...base, webSearch: true });
    expect(seed).toContain('"mimir"');
    expect(seed).toContain("Wiki gardener");
    // The whole reason this mode has its own builder.
    expect(seed).toContain("projects/muninn/wiki-gardener.md");
    expect(seed).toContain("Why does the cluster cap starve fresh arrivals?");
    // Nothing quoted — there is no Ask answer behind this mode.
    expect(seed).not.toContain("\n>");
    expect(seed).not.toContain("Ask tab answered");
  });

  test("provenance is BRACKETED, never a first-person claim about the reader", () => {
    // Same failure the direct seed's opening was rewritten for: a first-person
    // line got recorded as a biographical fact about someone who clicked a button.
    const seed = buildArticleChatSeed({ ...base, webSearch: true });
    expect(
      seed.startsWith('[Question asked while reading the "mimir" wiki article "Wiki gardener"]'),
    ).toBe(true);
    expect(seed).not.toContain("I'm reading");
    expect(seed).not.toContain("I asked");
  });

  test("the description parenthetical is omitted entirely when empty", () => {
    // An empty `()` reads as a page whose summary IS the empty string.
    const withDesc = buildArticleChatSeed({
      ...base, webSearch: true, description: "How the weekly gardener clusters summaries.",
    });
    // The parenthetical owns the sentence-ending period, so the summary's own
    // trailing one is dropped (`(… summaries.).` read as a typo).
    expect(withDesc).toContain("(How the weekly gardener clusters summaries)");
    for (const description of ["", "   ", undefined]) {
      const seed = buildArticleChatSeed({ ...base, webSearch: true, description });
      expect(seed).not.toContain("()");
      expect(seed).toContain("wiki-gardener.md` in the \"mimir\" wiki.");
    }
  });

  test("names web search only when the effective connector can deliver it", () => {
    expect(buildArticleChatSeed({ ...base, webSearch: true })).toContain("including web search");
    const without = buildArticleChatSeed({ ...base, webSearch: false });
    expect(without).not.toContain("web search");
    expect(without).toContain("the tools you have");
  });

  test("the lookup is an ATTEMPT with a fallback, never a precondition", () => {
    // `hasCollections` is config-PRESENCE, not capability: mimir declares a
    // collection named `mimir` that doesn't exist in huginn, and a real turn on
    // this seed opened with "I can't pull up this article…" — the retrieval
    // failure became the answer. So the searchable branch has to say what to do
    // when the page isn't there.
    const seed = buildArticleChatSeed({ ...base, webSearch: true });
    expect(seed).toContain("Try to pull it up");
    expect(seed).toContain("isn't indexed");
    expect(seed).toContain("ONE line");
    expect(seed).toContain("never open with an apology");
    // …and it never becomes a reason to stop.
    expect(seed).toContain("cite what you find");
  });

  test("a >400-char description can't end the parenthetical in '.)' after the cut", () => {
    // The trailing-period strip used to run BEFORE truncation, so it only ever
    // cleaned the tail of a summary short enough not to be cut — a truncated one
    // whose cut landed just after a mid-sentence period read `(… pages.).` anyway.
    const description = "First sentence ends here." + " x".repeat(500);
    const seed = buildArticleChatSeed({ ...base, webSearch: true, description });
    expect(seed).not.toContain(".).");
    // Exactly the boundary case: the cut falls immediately after a period.
    const atCut = "y".repeat(ASK_CHAT_ARTICLE_DESC_MAX - 1) + "." + "z".repeat(50);
    expect(buildArticleChatSeed({ ...base, webSearch: true, description: atCut }))
      .not.toContain(".).");
  });

  test("a wiki with NO collections is not told to look the page up in them", () => {
    const without = buildArticleChatSeed({ ...base, webSearch: true, hasCollections: false });
    expect(without).not.toContain("knowledge tools");
    expect(without).toContain("research it with");
    // The path is still named — it is the reader's own reference, not just a
    // search instruction.
    expect(without).toContain("projects/muninn/wiki-gardener.md");
    // Absent/true ⇒ the common searchable shape.
    expect(buildArticleChatSeed({ ...base, webSearch: true })).toContain("knowledge tools");
    expect(buildArticleChatSeed({ ...base, webSearch: true, hasCollections: true })).toContain(
      "knowledge tools",
    );
  });

  test("the WHOLE seed is bounded, however huge the inputs", () => {
    const seed = buildArticleChatSeed({
      wikiName: "w".repeat(500),
      pageTitle: "t".repeat(5000),
      pagePath: "p".repeat(5000),
      description: "d".repeat(50_000),
      question: "q".repeat(200_000),
      webSearch: true,
    });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("(question truncated)");
  });

  test("blank/absent page fields degrade instead of throwing", () => {
    const seed = buildArticleChatSeed({
      wikiName: "", pageTitle: "", pagePath: "", question: "  ", webSearch: false,
    });
    expect(seed).toContain("knowledge");
    expect(
      buildArticleChatSeed({ wikiName: 5, pageTitle: null, pagePath: 7, question: null, webSearch: true } as never),
    ).toBeString();
  });
});

/**
 * The article thread's IDENTITY tag.
 *
 * An article thread is looked up by NAME, and a name is a lossy key: mimir +
 * jarvis carry 13 colliding title groups over 30 pages, two wikis owned by one
 * bot collide with each other (`repos/huginn.md` vs `entities/Huginn.md`), and an
 * ordinary `/topic` chat thread can hold the name outright. The description
 * carries `(<wiki>:<relPath>)` so the route can tell "this article's thread" from
 * "some thread that happens to have the same name" — without a schema migration.
 */
describe("article thread description tag", () => {
  const built = buildArticleThreadDescription({
    wikiName: "mimir",
    pageTitle: "Wiki gardener",
    relPath: "projects/muninn/wiki-gardener.md",
  });

  test("reads as prose AND round-trips as a tag", () => {
    expect(built).toBe(
      'Discussion of the wiki article "Wiki gardener" (mimir:projects/muninn/wiki-gardener.md)',
    );
    expect(parseArticleThreadTag(built)).toEqual({
      wiki: "mimir",
      relPath: "projects/muninn/wiki-gardener.md",
    });
    expect(articleThreadTagMatches(built, "mimir", "projects/muninn/wiki-gardener.md")).toBe(true);
  });

  test("the same TITLE on a different page (or in another wiki) does not match", () => {
    // The live collisions this exists for.
    expect(articleThreadTagMatches(built, "mimir", "repos/huginn.md")).toBe(false);
    expect(articleThreadTagMatches(built, "jarvis", "projects/muninn/wiki-gardener.md"))
      .toBe(false);
    // …while the wiki name itself matches case-insensitively, as the registry does.
    expect(articleThreadTagMatches(built, "MIMIR", "projects/muninn/wiki-gardener.md"))
      .toBe(true);
  });

  test("anything that is NOT an article tag reads as no match", () => {
    // A plain `/topic` thread, the direct/escalate descriptions, a pre-tag article
    // thread, an empty description: each means "not provably this article's",
    // which is the safe answer (start a new thread, never cross-seed).
    for (const description of [
      undefined,
      null,
      "",
      "   ",
      "Started from the mimir wiki",
      "Continued from the mimir wiki Ask tab",
      'Discussion of the wiki article "Wiki gardener" (mimir)',
      "Discussion of the wiki article without a tag",
    ]) {
      expect(parseArticleThreadTag(description)).toBeNull();
      expect(articleThreadTagMatches(description, "mimir", "projects/muninn/wiki-gardener.md"))
        .toBe(false);
    }
  });

  test("a hostile or awkward title cannot shadow the tag", () => {
    // Parsing anchors on the LAST `" (`, so quotes and parentheses in the title —
    // including a planted fake tag — are just characters.
    const evil = buildArticleThreadDescription({
      wikiName: "mimir",
      pageTitle: 'Sneaky" (mimir:other/page.md) — really',
      relPath: "real/page.md",
    });
    expect(articleThreadTagMatches(evil, "mimir", "real/page.md")).toBe(true);
    expect(articleThreadTagMatches(evil, "mimir", "other/page.md")).toBe(false);
    // A relPath carrying its own `)` or `:` still round-trips (the split is on the
    // FIRST colon and the tail is read to the final `)`).
    const odd = buildArticleThreadDescription({
      wikiName: "mimir",
      pageTitle: "Odd",
      relPath: "notes/plan (draft): v2.md",
    });
    expect(articleThreadTagMatches(odd, "mimir", "notes/plan (draft): v2.md")).toBe(true);
  });

  test("the title is flattened and bounded — it used to reach the column raw", () => {
    const desc = buildArticleThreadDescription({
      wikiName: "mimir",
      pageTitle: "Line one\nand\ttwo " + "x".repeat(500),
      relPath: "a/b.md",
    });
    expect(/[\n\r\t]/.test(desc)).toBe(false);
    expect(desc.length).toBeLessThan(260);
    // …and the tag tail survives the truncation intact, which is the point.
    expect(articleThreadTagMatches(desc, "mimir", "a/b.md")).toBe(true);
  });
});

/**
 * The class check at round 3: the decline verdict has to survive five hops
 * (assessCoverage → the wire → askDeclineReason → the persisted turn → the
 * consumers), and rounds 1–3 each lost it at a different one. These drive the
 * ENUMERATION rather than one more value, so a fourth reason fails loudly here.
 */
describe("buildDirectChatSeed — every decline reason, not just the two that existed", () => {
  const seed = (declineReason?: (typeof DECLINE_REASONS)[number]) =>
    buildDirectChatSeed({ question: "hva er 25%-regelen?", wikiName: "nav", webSearch: true, declineReason });

  test("an unreachable Ask must NOT tell the bot the index was searched", () => {
    // Nothing ran. Asserting "already been searched … had nothing solid" is the
    // same empty-corpus lie this PR exists to remove, on the button the decline
    // bar renders.
    const text = seed("unreachable");
    expect(text).not.toMatch(/already been searched/i);
    expect(text).not.toMatch(/nothing solid/i);
  });

  test("the two verdicts where the index DID run keep the clause", () => {
    for (const reason of ["no_hits", "low_confidence"] as const) {
      expect(seed(reason)).toMatch(/already been searched/i);
    }
  });

  test("only the reasons where the index RAN may claim it was searched", () => {
    // The previous form asserted non-empty + contains-the-question, which stayed
    // green while a fourth reason carried the "already been searched" lie.
    const ran = new Set(["no_hits", "low_confidence"]);
    for (const reason of DECLINE_REASONS) {
      const text = seed(reason);
      expect(text).toContain("hva er 25%-regelen?");
      expect(/already been searched/i.test(text)).toBe(ran.has(reason));
    }
  });

  test("an unknown reason does not claim the index was searched", () => {
    // The `never` arm's RUNTIME behaviour: it returned the reason string, which
    // is truthy, so an unclassified value took the searched-already branch.
    expect(seed("from_the_future" as never)).not.toMatch(/already been searched/i);
  });
});
