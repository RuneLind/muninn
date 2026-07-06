import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import type { Watcher } from "../types.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The Haiku gate and snapshot store are mocked so the gate/Tier-2 paths can run
// without a real `claude -p` spawn or a live DB. The Phase-1 tests don't touch
// either, so the mocks are inert for them.

let gateResult = "[]";
let gateThrow = false;
let lastGatePrompt = ""; // captured so the body-excerpt threading can be asserted
mock.module("../scheduler/executor.ts", () => ({
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  spawnHaiku: async (prompt: string) => {
    lastGatePrompt = prompt;
    if (gateThrow) throw new Error("haiku down");
    return { result: gateResult, inputTokens: 0, outputTokens: 0, model: "claude-haiku-4-5-20251001" };
  },
}));

const snapStore = new Map<string, unknown>();
const setCalls: { key: string; value: unknown }[] = [];
mock.module("../db/watchers.ts", () => ({
  getWatcherSnapshot: async (_id: string, key: string) =>
    snapStore.has(key) ? snapStore.get(key) : null,
  setWatcherSnapshot: async (_id: string, key: string, value: unknown) => {
    snapStore.set(key, value);
    setCalls.push({ key, value });
  },
}));

// Candidate inbox: capture is a no-op recorder; getCandidateBySourceUrl serves rows
// from a controllable map so the auto-promote dedup gate (status === 'new') can be
// exercised without a live DB.
const upsertCalls: { url: string; score: number; kind?: string | null }[] = [];
const candidateRows = new Map<string, { id: string; title: string; url: string; status: string }>();
mock.module("../db/summary-candidates.ts", () => ({
  upsertCandidate: async (p: { url: string; score: number; kind?: string | null }) => {
    upsertCalls.push({ url: p.url, score: p.score, kind: p.kind });
  },
  getCandidateBySourceUrl: async (_source: string, url: string) => candidateRows.get(url) ?? null,
}));

// Auto-promote kick: record the candidate refs, return a fake job id (the real
// summarizer + Claude spawn are out of scope for the watcher unit test).
const autoPromoted: Array<{ id: string; title: string; url: string }> = [];
mock.module("../anthropic/summarizer.ts", () => ({
  autoPromoteCandidate: async (c: { id: string; title: string; url: string }) => {
    autoPromoted.push(c);
    return "job-" + c.id;
  },
}));

const {
  parseAtomEntries,
  parseLlmsTxtDocs,
  parseBlogSlugs,
  checkAnthropic,
  formatCandidateList,
  DEFAULT_ANTHROPIC_FEEDS,
  candidateKind,
  isShelfWorthy,
  captureFloor,
} = await import("./anthropic.ts");

const C1 = "https://github.com/anthropics/claude-code/commit/01f1617";
const C2 = "https://github.com/anthropics/claude-code/commit/f0919a1";

// Real-shaped GitHub Atom samples (trimmed). Note the attribute-order difference:
// commits feeds put `type` before `rel`; releases feeds put `rel` first — the parser
// must handle both. Commit entries carry only <updated> (no <published>).
const COMMITS_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:/anthropics/claude-code/commits/main</id>
  <link type="text/html" rel="alternate" href="https://github.com/anthropics/claude-code/commits/main"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/anthropics/claude-code/commits/main.atom"/>
  <title>Recent Commits to claude-code:main</title>
  <updated>2026-06-26T21:29:36Z</updated>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/01f1617</id>
    <link type="text/html" rel="alternate" href="${C1}"/>
    <title>
        feat: add CLAUDE_CODE_DISABLE_MOUSE_CLICKS &amp; keep wheel scroll
    </title>
    <updated>2026-06-26T21:29:36Z</updated>
    <media:thumbnail height="30" width="30" url="https://avatars.githubusercontent.com/u/1?s=30&amp;v=4"/>
    <content type="html">&lt;pre&gt;feat: add ...&lt;/pre&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/f0919a1</id>
    <link type="text/html" rel="alternate" href="${C2}"/>
    <title>chore: Update CHANGELOG.md</title>
    <updated>2026-06-25T10:00:00Z</updated>
    <content type="html">&lt;pre&gt;chore&lt;/pre&gt;</content>
  </entry>
</feed>`;

const RELEASES_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:.../releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/anthropics/claude-code/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/anthropics/claude-code/releases.atom"/>
  <title>Release notes from claude-code</title>
  <updated>2026-06-26T21:29:36Z</updated>
  <entry>
    <id>tag:github.com,2008:Repository/937253475/v2.1.195</id>
    <updated>2026-06-26T21:29:42Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/anthropics/claude-code/releases/tag/v2.1.195"/>
    <title>v2.1.195</title>
    <content type="html">&lt;h2&gt;What&#39;s changed&lt;/h2&gt;</content>
  </entry>
</feed>`;

// Tier-2 fixtures. llms.txt is markdown links; the `.txt` link must be excluded.
const D1 = "https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md";
const D2 = "https://platform.claude.com/docs/en/agents-and-tools/agent-skills/quickstart.md";
const LLMS_SAMPLE = `# Anthropic Developer Documentation
- [Overview](${D1}) - Agent Skills
- [Quickstart](${D2})
- [Full text](https://platform.claude.com/llms-full.txt)
`;
const NEWS_HTML =
  `<a href="/news/claude-opus-4-8">x</a>` +
  `<a href="/news/some-post">y</a>` +
  `<a href="/news/claude-opus-4-8#hero">dup</a>` +
  `<a href="/news">section root</a>` +
  `<a href="/about">unrelated</a>`;

describe("parseAtomEntries", () => {
  test("parses commits-feed entries (type-first link order, entity in title)", () => {
    const entries = parseAtomEntries(COMMITS_ATOM);
    expect(entries.length).toBe(2);
    expect(entries[0]!.id).toBe(C1);
    expect(entries[0]!.url).toBe(entries[0]!.id);
    // extractTag decodes &amp; and trims the surrounding whitespace/newlines
    expect(entries[0]!.title).toBe("feat: add CLAUDE_CODE_DISABLE_MOUSE_CLICKS & keep wheel scroll");
    expect(entries[0]!.feedTitle).toBe("Recent Commits to claude-code:main");
    expect(entries[0]!.updated).toBe(new Date("2026-06-26T21:29:36Z").getTime());
  });

  test("parses releases-feed entries (rel-first link order)", () => {
    const entries = parseAtomEntries(RELEASES_ATOM);
    expect(entries.length).toBe(1);
    expect(entries[0]!.url).toBe("https://github.com/anthropics/claude-code/releases/tag/v2.1.195");
    expect(entries[0]!.title).toBe("v2.1.195");
    expect(entries[0]!.feedTitle).toBe("Release notes from claude-code");
  });

  test("returns [] on RSS-2.0 (the gap that motivated a new parser)", () => {
    const rss = `<rss version="2.0"><channel><item><title>x</title>` +
      `<link>https://example.com/a</link><pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
    expect(parseAtomEntries(rss)).toEqual([]);
  });

  test("the default feed catalog is non-empty and all https", () => {
    expect(DEFAULT_ANTHROPIC_FEEDS.length).toBeGreaterThan(5);
    expect(DEFAULT_ANTHROPIC_FEEDS.every((u) => u.startsWith("https://"))).toBe(true);
  });

  // --- Alert depth (§10): body excerpt from <content>/<summary> ---

  test("captures a plain-text body excerpt from <content> (HTML stripped, decoded)", () => {
    const entries = parseAtomEntries(COMMITS_ATOM);
    // <content>&lt;pre&gt;feat: add ...&lt;/pre&gt;</content> → decode → strip <pre>
    expect(entries[0]!.excerpt).toBe("feat: add ...");
    expect(entries[1]!.excerpt).toBe("chore");
    // releases feed carries <h2>What's changed</h2>
    expect(parseAtomEntries(RELEASES_ATOM)[0]!.excerpt).toBe("What's changed");
  });

  test("hard-truncates a long body to ~300 chars with an ellipsis", () => {
    const long = "word ".repeat(200).trim(); // ~999 chars
    const xml =
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>` +
      `<entry><id>i</id><link rel="alternate" type="text/html" href="https://e.test/a"/>` +
      `<title>t</title><content type="html">${long}</content></entry></feed>`;
    const e = parseAtomEntries(xml)[0]!;
    expect(e.excerpt!.length).toBeLessThanOrEqual(301); // 300 + the ellipsis char
    expect(e.excerpt!.endsWith("…")).toBe(true);
  });

  test("no <content>/<summary> → no excerpt (gate falls back to title-only)", () => {
    const xml =
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>` +
      `<entry><id>i</id><link rel="alternate" type="text/html" href="https://e.test/a"/>` +
      `<title>Bare entry</title><updated>2026-06-26T21:29:36Z</updated></entry></feed>`;
    expect(parseAtomEntries(xml)[0]!.excerpt).toBeUndefined();
  });

  test("prefers <summary> when there is no <content>", () => {
    const xml =
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>` +
      `<entry><id>i</id><link rel="alternate" type="text/html" href="https://e.test/a"/>` +
      `<title>t</title><summary>a short summary</summary></entry></feed>`;
    expect(parseAtomEntries(xml)[0]!.excerpt).toBe("a short summary");
  });
});

describe("formatCandidateList (Alert depth §10)", () => {
  const withExcerpt = {
    id: "1",
    sourceLabel: "Docs (llms.txt)",
    label: "Agent Skills",
    url: "https://platform.claude.com/docs/en/x.md",
    excerpt: "Agent Skills let you package reusable instructions.",
  };
  const noExcerpt = {
    id: "2",
    sourceLabel: "Recent Commits",
    label: "feat: thing",
    url: "https://github.com/anthropics/x/commit/abc",
  };

  test("gate path (withExcerpt) appends the excerpt on its own line", () => {
    const out = formatCandidateList([withExcerpt], { withExcerpt: true });
    expect(out).toBe(
      "1. [Docs (llms.txt)] Agent Skills\n   https://platform.claude.com/docs/en/x.md\n   Agent Skills let you package reusable instructions.",
    );
  });

  test("falls back to title-only when a candidate has no excerpt", () => {
    const out = formatCandidateList([noExcerpt], { withExcerpt: true });
    expect(out).toBe("1. [Recent Commits] feat: thing\n   https://github.com/anthropics/x/commit/abc");
  });

  test("digest path (default) omits excerpts even when present", () => {
    const out = formatCandidateList([withExcerpt]);
    expect(out).not.toContain("reusable instructions");
    expect(out).toBe("1. [Docs (llms.txt)] Agent Skills\n   https://platform.claude.com/docs/en/x.md");
  });
});

describe("shelf-capture policy (candidateKind / isShelfWorthy / captureFloor)", () => {
  test("classifies candidate URLs by shape", () => {
    expect(candidateKind("https://github.com/anthropics/claude-code/commit/01f1617")).toBe("commit");
    expect(candidateKind("https://github.com/anthropics/claude-code/releases/tag/v2.1.195")).toBe("release");
    expect(candidateKind(D1)).toBe("doc");
    expect(candidateKind("https://www.anthropic.com/news/claude-sonnet-5")).toBe("blog");
  });

  test("merge/rollup commits are never shelf-worthy; feature commits are", () => {
    const url = "https://github.com/modelcontextprotocol/modelcontextprotocol/commit/abc";
    expect(isShelfWorthy({ label: "Merge pull request #2513 from devcrocod/kotlin-tier", url })).toBe(false);
    expect(isShelfWorthy({ label: "Merge branch 'main' into next", url })).toBe(false);
    // git's plural/tag default merge messages are covered too
    expect(isShelfWorthy({ label: "Merge branches 'ide-release' and 'main'", url })).toBe(false);
    expect(isShelfWorthy({ label: "Merge remote-tracking branches 'x' and 'y'", url })).toBe(false);
    expect(isShelfWorthy({ label: "Merge tag 'v1.2.0'", url })).toBe(false);
    expect(isShelfWorthy({ label: "feat(schema): add subscriptions/listen response (#2953)", url })).toBe(true);
    // Kind-scoped: a doc/blog title that happens to start with "Merge" is not filtered.
    expect(isShelfWorthy({ label: "Merge pull request semantics", url: D1 })).toBe(true);
  });

  test("built-in floors: commits 0.7, releases 0.8, docs/blog at the base floor", () => {
    const config = { candidateMinScore: 0.5 };
    expect(captureFloor("commit", config)).toBe(0.7);
    expect(captureFloor("release", config)).toBe(0.8);
    expect(captureFloor("doc", config)).toBe(0.5);
    expect(captureFloor("blog", config)).toBe(0.5);
  });

  test("a raised base floor is never undercut by a kind default (max semantics)", () => {
    expect(captureFloor("commit", { candidateMinScore: 0.8 })).toBe(0.8);
    expect(captureFloor("release", { candidateMinScore: 0.9 })).toBe(0.9);
  });

  test("an explicit per-kind override wins outright (can lower below the default)", () => {
    const config = { candidateMinScore: 0.5, candidateMinScoreByKind: { commit: 0.6, release: 0.7 } };
    expect(captureFloor("commit", config)).toBe(0.6);
    expect(captureFloor("release", config)).toBe(0.7);
  });
});

describe("parseLlmsTxtDocs", () => {
  test("extracts /docs/*.md links with titles, excluding non-doc and .txt links", () => {
    const map = parseLlmsTxtDocs(LLMS_SAMPLE);
    expect(map.size).toBe(2);
    expect([...map.keys()].sort()).toEqual([D1, D2].sort());
    expect(map.get(D1)).toBe("Overview");
    // llms-full.txt is a .txt link → excluded
    expect([...map.keys()].some((u) => u.endsWith(".txt"))).toBe(false);
  });

  test("dedupes repeated doc URLs", () => {
    const map = parseLlmsTxtDocs(`- [A](${D1})\n- [A again](${D1})\n`);
    expect(map.size).toBe(1);
  });
});

describe("parseBlogSlugs", () => {
  test("extracts /section/<slug> hrefs, skipping the section root and fragments", () => {
    const map = parseBlogSlugs(NEWS_HTML, "news");
    expect([...map.keys()].sort()).toEqual([
      "https://www.anthropic.com/news/claude-opus-4-8",
      "https://www.anthropic.com/news/some-post",
    ]);
    // prettified slug label
    expect(map.get("https://www.anthropic.com/news/claude-opus-4-8")).toBe("Claude Opus 4 8");
  });

  test("returns empty map when no section hrefs are present", () => {
    expect(parseBlogSlugs(`<a href="/about">x</a>`, "news").size).toBe(0);
  });
});

describe("checkAnthropic", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    gateResult = "[]";
    gateThrow = false;
    lastGatePrompt = "";
    snapStore.clear();
    setCalls.length = 0;
    upsertCalls.length = 0;
    autoPromoted.length = 0;
    candidateRows.clear();
  });

  function stub(body: string | ((url: string) => string)) {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      const text = typeof body === "function" ? body(url) : body;
      return { ok: true, status: 200, text: async () => text } as unknown as Response;
    }) as typeof fetch;
  }

  const baseWatcher = (over: Partial<Watcher>): Watcher => ({
    id: "w1",
    userId: "u1",
    botName: "jarvis",
    name: "Anthropic Updates",
    type: "anthropic",
    // Large lookback so the fixed fixture dates always pass regardless of run date.
    config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000 },
    intervalMs: 7_200_000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  // --- Phase 1: Tier-1 only, no gate ---

  test("cold start returns a single silent baseline carrying every entry id", async () => {
    stub(COMMITS_ATOM);
    const alerts = await checkAnthropic(baseWatcher({ lastNotifiedIds: [] }));
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.silent).toBe(true);
    expect(alerts[0]!.trackingIds?.length).toBe(2);
    expect(alerts[0]!.trackingIds).toContain(C1);
  });

  test("steady state (no gate) emits one non-silent alert per entry", async () => {
    stub(COMMITS_ATOM);
    const alerts = await checkAnthropic(baseWatcher({ lastNotifiedIds: ["already-seen"] }));
    expect(alerts.length).toBe(2);
    expect(alerts.every((a) => !a.silent)).toBe(true);
    expect(alerts[0]!.id).toBe(C1);
    expect(alerts[0]!.source).toBe("anthropic");
    expect(alerts[0]!.summary).toContain("Recent Commits to claude-code:main");
  });

  test("one feed failing does not drop the others", async () => {
    stub((url) => {
      if (url.includes("bad")) throw new Error("network down");
      return COMMITS_ATOM;
    });
    const alerts = await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: ["already-seen"],
        config: {
          feeds: ["https://bad.test/x.atom", "https://feed.test/commits.atom"],
          lookbackDays: 100000,
        },
      }),
    );
    expect(alerts.length).toBe(2); // the healthy feed still yields its entries
  });

  // --- Phase 3: Haiku gate (Tier-1 candidates) ---

  test("gate surfaces high-scored entries with their why, silences the rest", async () => {
    stub(COMMITS_ATOM);
    gateResult = JSON.stringify([{ n: 1, score: 0.9, why: "ships a real Claude Code feature" }]);
    const alerts = await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: ["already-seen"],
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, gate: true },
      }),
    );
    const visible = alerts.filter((a) => !a.silent);
    const silent = alerts.filter((a) => a.silent);
    expect(visible.length).toBe(1);
    expect(visible[0]!.id).toBe(C1);
    expect(visible[0]!.summary).toContain("ships a real Claude Code feature");
    expect(visible[0]!.urgency).toBe("high"); // 0.9 >= 0.85
    expect(silent.length).toBe(1);
    expect(silent[0]!.trackingIds).toContain(C2);
  });

  test("gate returning [] silences all candidates (one silent alert, no visible)", async () => {
    stub(COMMITS_ATOM);
    gateResult = "[]";
    const alerts = await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: ["already-seen"],
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, gate: true },
      }),
    );
    expect(alerts.filter((a) => !a.silent).length).toBe(0);
    expect(alerts.filter((a) => a.silent).length).toBe(1);
    expect(alerts[0]!.trackingIds?.sort()).toEqual([C1, C2].sort());
  });

  test("quietMode SKIP suppresses the whole batch silently", async () => {
    stub(COMMITS_ATOM);
    gateResult = "SKIP";
    const alerts = await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: ["already-seen"],
        config: {
          feeds: ["https://feed.test/commits.atom"],
          lookbackDays: 100000,
          gate: true,
          quietMode: true,
        },
      }),
    );
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.silent).toBe(true);
    expect(alerts[0]!.trackingIds?.length).toBe(2);
  });

  test("minScore drops borderline scores below the threshold", async () => {
    stub(COMMITS_ATOM);
    gateResult = JSON.stringify([
      { n: 1, score: 0.9, why: "high" },
      { n: 2, score: 0.3, why: "meh" },
    ]);
    const alerts = await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: ["already-seen"],
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, gate: true, minScore: 0.5 },
      }),
    );
    const visible = alerts.filter((a) => !a.silent);
    expect(visible.length).toBe(1); // only n=1 clears 0.5
    expect(visible[0]!.id).toBe(C1);
    expect(alerts.filter((a) => a.silent)[0]!.trackingIds).toContain(C2);
  });

  test("gate failure suppresses everything this run (returns [])", async () => {
    stub(COMMITS_ATOM);
    gateThrow = true;
    const alerts = await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: ["already-seen"],
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, gate: true },
      }),
    );
    expect(alerts).toEqual([]);
  });

  // --- Alert depth (§10): the gate scores off content, not just titles ---

  test("gate prompt includes the Tier-1 body excerpt parsed from <content>", async () => {
    stub(COMMITS_ATOM);
    await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: ["already-seen"],
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, gate: true },
      }),
    );
    // C1's <content> body rides into the gate prompt alongside the title.
    expect(lastGatePrompt).toContain("feat: add ...");
    expect(lastGatePrompt).toContain("Recent Commits to claude-code:main");
  });

  test("a Tier-2 doc candidate is enriched with a .md body slice in the gate prompt", async () => {
    const docBody = "# Quickstart\n\nThis guide shows how to build agent skills with the SDK.";
    stub((url) => {
      if (url.includes("feed.test")) return COMMITS_ATOM;
      if (url.endsWith("llms.txt")) return LLMS_SAMPLE;
      if (url === D2) return docBody; // the enrichment fetch for the new doc
      if (url.includes("/news")) return NEWS_HTML;
      if (url.includes("/engineering")) return `<a href="/engineering/eng-post">e</a>`;
      if (url.includes("/research")) return `<a href="/research/res-paper">r</a>`;
      return "";
    });
    await checkAnthropic(tier2Watcher()); // baseline every Tier-2 source
    snapStore.set("tier2:llms", [D1]); // D2 is now a new doc candidate
    gateResult = "[]";
    await checkAnthropic(tier2Watcher());
    // The .md body slice (heading/frontmatter softened) is fed to the gate.
    expect(lastGatePrompt).toContain("build agent skills with the SDK");
    expect(lastGatePrompt).toContain(D2);
  });

  test("a Tier-2 doc .md fetch failure degrades to title-only (no crash, gate still runs)", async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url === D2) throw new Error("doc fetch down"); // enrichment fetch fails
      let text = "";
      if (url.includes("feed.test")) text = COMMITS_ATOM;
      else if (url.endsWith("llms.txt")) text = LLMS_SAMPLE;
      else if (url.includes("/news")) text = NEWS_HTML;
      else if (url.includes("/engineering")) text = `<a href="/engineering/eng-post">e</a>`;
      else if (url.includes("/research")) text = `<a href="/research/res-paper">r</a>`;
      return { ok: true, status: 200, text: async () => text } as unknown as Response;
    }) as typeof fetch;
    await checkAnthropic(tier2Watcher()); // baseline
    snapStore.set("tier2:llms", [D1]); // D2 new
    gateResult = JSON.stringify([{ n: 1, score: 0.8, why: "new doc" }]);
    const alerts = await checkAnthropic(tier2Watcher());
    // The doc still gates on its title (no body) and surfaces — the failed fetch
    // didn't break the run.
    const visible = alerts.filter((a) => !a.silent);
    expect(visible.length).toBe(1);
    expect(visible[0]!.id).toBe(`an:${D2}`);
    expect(lastGatePrompt).toContain(D2);
  });

  // --- Phase 3: Tier-2 snapshot-and-diff ---

  function tier2Stub() {
    stub((url) => {
      if (url.includes("feed.test")) return COMMITS_ATOM;
      if (url.includes("llms.txt")) return LLMS_SAMPLE;
      if (url.includes("/news")) return NEWS_HTML;
      if (url.includes("/engineering")) return `<a href="/engineering/eng-post">e</a>`;
      if (url.includes("/research")) return `<a href="/research/res-paper">r</a>`;
      return "";
    });
  }

  const tier2Watcher = () =>
    baseWatcher({
      // All Tier-1 commit ids already seen → 0 Tier-1 candidates, isolating Tier-2.
      lastNotifiedIds: ["seen", C1, C2],
      config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, tier2: true, gate: true },
    });

  test("Tier-2 first run baselines every source silently (no alerts, snapshots written)", async () => {
    tier2Stub();
    const alerts = await checkAnthropic(tier2Watcher());
    expect(alerts).toEqual([]);
    // llms + 3 blog sections all baselined
    expect(setCalls.map((c) => c.key).sort()).toEqual(
      ["tier2:blog:engineering", "tier2:blog:news", "tier2:blog:research", "tier2:llms"].sort(),
    );
    expect((snapStore.get("tier2:llms") as string[]).sort()).toEqual([D1, D2].sort());
  });

  test("a doc that appears after the baseline becomes a gated Tier-2 candidate", async () => {
    tier2Stub();
    // Baseline run, then simulate D2 being NEW by removing it from the snapshot.
    await checkAnthropic(tier2Watcher());
    snapStore.set("tier2:llms", [D1]);

    gateResult = JSON.stringify([{ n: 1, score: 0.8, why: "new agent-skills guide" }]);
    const alerts = await checkAnthropic(tier2Watcher());
    const visible = alerts.filter((a) => !a.silent);
    expect(visible.length).toBe(1);
    expect(visible[0]!.id).toBe(`an:${D2}`);
    expect(visible[0]!.summary).toContain("new agent-skills guide");
    expect(visible[0]!.summary).toContain(D2);
    // snapshot advanced back to the full set so it won't re-alert next run
    expect((snapStore.get("tier2:llms") as string[]).sort()).toEqual([D1, D2].sort());
  });

  test("gate failure does NOT advance Tier-2 snapshots (addition retries next run)", async () => {
    tier2Stub();
    await checkAnthropic(tier2Watcher());
    snapStore.set("tier2:llms", [D1]); // D2 is now a pending addition
    setCalls.length = 0;

    gateThrow = true;
    const alerts = await checkAnthropic(tier2Watcher());
    expect(alerts).toEqual([]);
    // snapshot left untouched → D2 still missing → it re-surfaces next run
    expect(setCalls.find((c) => c.key === "tier2:llms")).toBeUndefined();
    expect((snapStore.get("tier2:llms") as string[])).toEqual([D1]);
  });

  test("an empty/garbage 200 body is NOT baselined (guards against a recovery burst)", async () => {
    // All blog sections return empty bodies; only llms yields docs.
    stub((url) => {
      if (url.includes("feed.test")) return COMMITS_ATOM;
      if (url.includes("llms.txt")) return LLMS_SAMPLE;
      return ""; // every blog section → 0 slugs
    });
    const alerts = await checkAnthropic(tier2Watcher());
    expect(alerts).toEqual([]);
    expect(snapStore.has("tier2:llms")).toBe(true);
    // empty fetches are skipped, not baselined → a later healthy fetch is a cold
    // start (silent baseline) rather than a flood of "new" slugs
    expect(snapStore.has("tier2:blog:news")).toBe(false);
    expect(snapStore.has("tier2:blog:engineering")).toBe(false);
  });

  test("a drastically shrunken doc set does not advance the snapshot", async () => {
    tier2Stub(); // llms fetch yields D1, D2 (2 docs)
    snapStore.set("tier2:llms", [D1, D2, "x3", "x4", "x5"]); // baseline of 5
    // pre-seed blog snapshots so they don't produce candidates/persist noise
    snapStore.set("tier2:blog:news", [
      "https://www.anthropic.com/news/claude-opus-4-8",
      "https://www.anthropic.com/news/some-post",
    ]);
    snapStore.set("tier2:blog:engineering", ["https://www.anthropic.com/engineering/eng-post"]);
    snapStore.set("tier2:blog:research", ["https://www.anthropic.com/research/res-paper"]);
    setCalls.length = 0;

    const alerts = await checkAnthropic(tier2Watcher());
    // 2 fresh < 5/2 → suspicious shrink → skipped; no llms candidates, snapshot kept
    expect(alerts.filter((a) => !a.silent).length).toBe(0);
    expect(setCalls.find((c) => c.key === "tier2:llms")).toBeUndefined();
    expect((snapStore.get("tier2:llms") as string[]).length).toBe(5);
  });

  test("Tier-2 additions still flow through the gate during a Tier-1 cold start", async () => {
    // Fresh watcher (empty last_notified_ids) but Tier-2 snapshots already exist
    // (e.g. an earlier run baselined them while Tier-1 was failing). A new doc must
    // not be swallowed by the cold-start path.
    tier2Stub();
    snapStore.set("tier2:llms", [D1]); // D2 is a pending addition
    snapStore.set("tier2:blog:news", [
      "https://www.anthropic.com/news/claude-opus-4-8",
      "https://www.anthropic.com/news/some-post",
    ]);
    snapStore.set("tier2:blog:engineering", ["https://www.anthropic.com/engineering/eng-post"]);
    snapStore.set("tier2:blog:research", ["https://www.anthropic.com/research/res-paper"]);
    gateResult = JSON.stringify([{ n: 1, score: 0.8, why: "new guide" }]);

    const alerts = await checkAnthropic(
      baseWatcher({
        lastNotifiedIds: [], // cold Tier-1
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, tier2: true, gate: true },
      }),
    );
    // Tier-1 baseline recorded silently, AND the Tier-2 addition is gated + surfaced
    expect(alerts.some((a) => a.silent && (a.trackingIds?.length ?? 0) >= 2)).toBe(true); // tier1 baseline
    const visible = alerts.filter((a) => !a.silent);
    expect(visible.length).toBe(1);
    expect(visible[0]!.id).toBe(`an:${D2}`);
    expect(visible[0]!.summary).toContain("new guide");
  });

  // --- Phase 4: digest mode (Daily/Weekly rows) ---

  const digestWatcher = (over: Partial<Watcher>): Watcher =>
    baseWatcher({
      config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, digest: true },
      ...over,
    });

  test("digest mode rolls steady-state candidates into ONE digest alert (trackingIds = all)", async () => {
    stub(COMMITS_ATOM);
    gateResult = "**Top**\n- claude-code shipped a thing";
    const alerts = await checkAnthropic(digestWatcher({ lastNotifiedIds: ["already-seen"] }));
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.silent).toBeFalsy();
    expect(alerts[0]!.id).toMatch(/^anthropic:digest:/);
    expect(alerts[0]!.summary).toBe("**Top**\n- claude-code shipped a thing");
    // Both feed entries are tracked so they aren't re-digested next run.
    expect(alerts[0]!.trackingIds?.sort()).toEqual([C1, C2].sort());
  });

  test("digest cold start records a silent baseline and emits NO digest", async () => {
    stub(COMMITS_ATOM);
    gateResult = "must-not-be-used";
    const alerts = await checkAnthropic(digestWatcher({ lastNotifiedIds: [] }));
    // Only the silent Tier-1 baseline — the digest branch is never reached (0 candidates).
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.silent).toBe(true);
    expect(alerts[0]!.trackingIds?.length).toBe(2);
    expect(alerts.some((a) => a.id.startsWith("anthropic:digest:"))).toBe(false);
  });

  test("digest with no new candidates sends nothing", async () => {
    stub(COMMITS_ATOM);
    const alerts = await checkAnthropic(digestWatcher({ lastNotifiedIds: ["seen", C1, C2] }));
    expect(alerts).toEqual([]);
  });

  test("digest quietMode SKIP suppresses the message but tracks the ids", async () => {
    stub(COMMITS_ATOM);
    gateResult = "SKIP";
    const alerts = await checkAnthropic(
      digestWatcher({
        lastNotifiedIds: ["already-seen"],
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, digest: true, quietMode: true },
      }),
    );
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.silent).toBe(true);
    expect(alerts[0]!.trackingIds?.sort()).toEqual([C1, C2].sort());
  });

  test("digest LLM error returns [] and leaves the Tier-2 snapshot unadvanced (retry)", async () => {
    tier2Stub();
    snapStore.set("tier2:llms", [D1]); // D2 is a pending addition
    // Pre-seed the blog snapshots so they don't produce candidates.
    snapStore.set("tier2:blog:news", [
      "https://www.anthropic.com/news/claude-opus-4-8",
      "https://www.anthropic.com/news/some-post",
    ]);
    snapStore.set("tier2:blog:engineering", ["https://www.anthropic.com/engineering/eng-post"]);
    snapStore.set("tier2:blog:research", ["https://www.anthropic.com/research/res-paper"]);
    setCalls.length = 0;
    gateThrow = true;
    const alerts = await checkAnthropic(
      digestWatcher({
        lastNotifiedIds: ["seen", C1, C2], // 0 Tier-1 candidates → isolates the Tier-2 addition
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, tier2: true, digest: true },
      }),
    );
    expect(alerts).toEqual([]);
    // snapshot NOT advanced → D2 re-surfaces next run
    expect(setCalls.find((c) => c.key === "tier2:llms")).toBeUndefined();
    expect(snapStore.get("tier2:llms") as string[]).toEqual([D1]);
  });

  test("digest with an empty/blank model result is treated as failure (no message, snapshot unadvanced)", async () => {
    tier2Stub();
    snapStore.set("tier2:llms", [D1]); // D2 pending
    snapStore.set("tier2:blog:news", [
      "https://www.anthropic.com/news/claude-opus-4-8",
      "https://www.anthropic.com/news/some-post",
    ]);
    snapStore.set("tier2:blog:engineering", ["https://www.anthropic.com/engineering/eng-post"]);
    snapStore.set("tier2:blog:research", ["https://www.anthropic.com/research/res-paper"]);
    setCalls.length = 0;
    gateResult = "   \n  "; // exit 0 but no content — must NOT send a header-only digest
    const alerts = await checkAnthropic(
      digestWatcher({
        lastNotifiedIds: ["seen", C1, C2],
        config: { feeds: ["https://feed.test/commits.atom"], lookbackDays: 100000, tier2: true, digest: true },
      }),
    );
    expect(alerts).toEqual([]);
    // empty result is a failure → snapshot NOT advanced → D2 re-surfaces next run
    expect(setCalls.find((c) => c.key === "tier2:llms")).toBeUndefined();
    expect(snapStore.get("tier2:llms") as string[]).toEqual([D1]);
  });

  test("digest caps Tier-1 at DIGEST_MAX_TIER1 but NEVER truncates Tier-2 additions", async () => {
    // 13 feeds × MAX_PER_FEED(20) = 260 Tier-1 entries > the 240 cap; the 13th feed's
    // entries are dropped from trackingIds, while the Tier-2 doc addition is always kept.
    const FEEDS = Array.from({ length: 13 }, (_, f) => `https://feed.test/f${f}.atom`);
    const atomFor = (f: number) => {
      const entries = Array.from({ length: 20 }, (_, i) => {
        const url = `https://github.com/anthropics/f${f}/commit/c${i}`;
        return `<entry><id>tag:f${f}-c${i}</id>` +
          `<link rel="alternate" type="text/html" href="${url}"/>` +
          `<title>commit f${f}-c${i}</title><updated>2026-06-26T21:29:36Z</updated></entry>`;
      }).join("");
      return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Feed f${f}</title>${entries}</feed>`;
    };
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      const m = url.match(/\/f(\d+)\.atom$/);
      let text = "";
      if (m) text = atomFor(Number(m[1]));
      else if (url.includes("llms.txt")) text = LLMS_SAMPLE; // D1, D2
      else if (url.includes("/news")) text = NEWS_HTML;
      else if (url.includes("/engineering")) text = `<a href="/engineering/eng-post">e</a>`;
      else if (url.includes("/research")) text = `<a href="/research/res-paper">r</a>`;
      return { ok: true, status: 200, text: async () => text } as unknown as Response;
    }) as typeof fetch;

    snapStore.set("tier2:llms", [D1]); // D2 is a Tier-2 addition
    snapStore.set("tier2:blog:news", [
      "https://www.anthropic.com/news/claude-opus-4-8",
      "https://www.anthropic.com/news/some-post",
    ]);
    snapStore.set("tier2:blog:engineering", ["https://www.anthropic.com/engineering/eng-post"]);
    snapStore.set("tier2:blog:research", ["https://www.anthropic.com/research/res-paper"]);
    gateResult = "weekly digest md";

    const alerts = await checkAnthropic(
      digestWatcher({
        lastNotifiedIds: ["seen"], // not cold; matches no feed url → all 260 Tier-1 are new
        config: { feeds: FEEDS, lookbackDays: 100000, tier2: true, digest: true },
      }),
    );
    expect(alerts.length).toBe(1);
    const ids = alerts[0]!.trackingIds!;
    // 240 capped Tier-1 + 1 Tier-2 = 241
    expect(ids.length).toBe(241);
    // Tier-2 addition is ALWAYS retained
    expect(ids).toContain(`an:${D2}`);
    // The 13th feed (f12) was dropped by the cap
    expect(ids).not.toContain("https://github.com/anthropics/f12/commit/c0");
    // The first feed survived
    expect(ids).toContain("https://github.com/anthropics/f0/commit/c0");
  });

  // --- Phase B.3 / D-button: candidate capture + auto-promote ---

  const captureWatcher = (over: Partial<Watcher>): Watcher =>
    baseWatcher({
      lastNotifiedIds: ["already-seen"], // steady state — both C1/C2 are new candidates
      config: {
        feeds: ["https://feed.test/commits.atom"],
        lookbackDays: 100000,
        gate: true,
        captureCandidates: true,
        candidateMinScore: 0.5,
      },
      ...over,
    });

  test("captureCandidates upserts every gated candidate at/above its kind's capture floor", async () => {
    stub(COMMITS_ATOM);
    gateResult = JSON.stringify([
      { n: 1, score: 0.95, why: "headliner" },
      { n: 2, score: 0.8, why: "solid commit" },
    ]);
    await checkAnthropic(captureWatcher({}));
    expect(upsertCalls.map((u) => u.url).sort()).toEqual([C1, C2].sort());
    // Both are /commit/ URLs → stamped kind 'commit'.
    expect(upsertCalls.map((u) => u.kind)).toEqual(["commit", "commit"]);
  });

  test("a commit below the 0.7 commit floor still alerts but is NOT captured", async () => {
    stub(COMMITS_ATOM);
    gateResult = JSON.stringify([
      { n: 1, score: 0.65, why: "keyword-relevant churn" }, // ≥ minScore 0.5 → alerts; < 0.7 → no inbox slot
      { n: 2, score: 0.8, why: "shelf-worthy" },
    ]);
    const alerts = await checkAnthropic(captureWatcher({}));
    expect(upsertCalls.map((u) => u.url)).toEqual([C2]);
    // The alert path is untouched by the capture floors.
    expect(alerts.filter((a) => !a.silent).map((a) => a.id).sort()).toEqual([C1, C2].sort());
  });

  test("a merge commit is never captured, whatever the gate scored it", async () => {
    const M1 = "https://github.com/modelcontextprotocol/modelcontextprotocol/commit/m1";
    const M2 = "https://github.com/modelcontextprotocol/modelcontextprotocol/commit/m2";
    const MERGE_ATOM =
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Recent Commits to modelcontextprotocol:main</title>` +
      `<entry><id>m1</id><link rel="alternate" type="text/html" href="${M1}"/>` +
      `<title>Merge pull request #2513 from devcrocod/kotlin-tier</title><updated>2026-06-26T21:29:36Z</updated></entry>` +
      `<entry><id>m2</id><link rel="alternate" type="text/html" href="${M2}"/>` +
      `<title>feat(schema): add subscriptions/listen response (#2953)</title><updated>2026-06-26T21:29:36Z</updated></entry>` +
      `</feed>`;
    stub(MERGE_ATOM);
    gateResult = JSON.stringify([
      { n: 1, score: 0.95, why: "keywords look great" }, // merge commit — filtered regardless
      { n: 2, score: 0.8, why: "real schema feature" },
    ]);
    const alerts = await checkAnthropic(captureWatcher({}));
    expect(upsertCalls.map((u) => u.url)).toEqual([M2]);
    // Capture-only filter: the merge commit still alerts on its score.
    expect(alerts.filter((a) => !a.silent).map((a) => a.id)).toContain(M1);
  });

  test("a version-stub release below the 0.8 release floor is not captured", async () => {
    stub(RELEASES_ATOM); // one release: v2.1.195
    gateResult = JSON.stringify([{ n: 1, score: 0.75, why: "routine SDK release" }]);
    await checkAnthropic(captureWatcher({}));
    expect(upsertCalls).toHaveLength(0);
  });

  test("candidateMinScoreByKind overrides the built-in kind floor (can lower it)", async () => {
    stub(RELEASES_ATOM);
    // 0.7 is below the built-in release floor (0.8) — only the explicit override captures it.
    gateResult = JSON.stringify([{ n: 1, score: 0.7, why: "release this user wants shelved" }]);
    await checkAnthropic(
      captureWatcher({
        config: {
          feeds: ["https://feed.test/releases.atom"],
          lookbackDays: 100000,
          gate: true,
          captureCandidates: true,
          candidateMinScore: 0.5,
          candidateMinScoreByKind: { release: 0.6 },
        },
      }),
    );
    expect(upsertCalls.map((u) => u.url)).toEqual([
      "https://github.com/anthropics/claude-code/releases/tag/v2.1.195",
    ]);
    expect(upsertCalls.map((u) => u.kind)).toEqual(["release"]);
  });

  test("a mid-band Tier-2 doc candidate is captured at the base floor (no kind floor)", async () => {
    tier2Stub();
    const docCaptureWatcher = () =>
      baseWatcher({
        lastNotifiedIds: ["seen", C1, C2], // Tier-1 all seen → isolates the Tier-2 doc
        config: {
          feeds: ["https://feed.test/commits.atom"],
          lookbackDays: 100000,
          tier2: true,
          gate: true,
          captureCandidates: true,
          candidateMinScore: 0.5,
        },
      });
    await checkAnthropic(docCaptureWatcher()); // baseline every Tier-2 source
    snapStore.set("tier2:llms", [D1]); // D2 is now a new doc candidate
    gateResult = JSON.stringify([{ n: 1, score: 0.6, why: "useful new guide" }]);
    await checkAnthropic(docCaptureWatcher());
    // 0.6 would fail the commit (0.7) and release (0.8) floors — docs capture at 0.5.
    expect(upsertCalls.map((u) => u.url)).toEqual([D2]);
    expect(upsertCalls.map((u) => u.kind)).toEqual(["doc"]);
  });

  test("auto-promote summarizes a ≥ autoPromoteScore candidate in-process, leaving the mid-band", async () => {
    stub(COMMITS_ATOM);
    gateResult = JSON.stringify([
      { n: 1, score: 0.95, why: "must-see Claude Code feature" }, // ≥ 0.9 → auto-promote
      { n: 2, score: 0.6, why: "relevant but not urgent" }, // < 0.9 → stays in inbox
    ]);
    // The persisted C1 row is still `new`, so it's eligible.
    candidateRows.set(C1, { id: "cand-c1", title: "C1 title", url: C1, status: "new" });

    await checkAnthropic(
      captureWatcher({
        config: {
          feeds: ["https://feed.test/commits.atom"],
          lookbackDays: 100000,
          gate: true,
          captureCandidates: true,
          candidateMinScore: 0.5,
          autoPromoteScore: 0.9,
        },
      }),
    );

    expect(autoPromoted).toHaveLength(1);
    expect(autoPromoted[0]).toEqual({ id: "cand-c1", title: "C1 title", url: C1 });
  });

  test("auto-promote dedup: a candidate whose row is already summarizing is NOT re-kicked", async () => {
    stub(COMMITS_ATOM);
    gateResult = JSON.stringify([{ n: 1, score: 0.95, why: "headliner" }]);
    // Row exists but is already in flight (a prior run kicked it) → skip.
    candidateRows.set(C1, { id: "cand-c1", title: "C1 title", url: C1, status: "summarizing" });

    await checkAnthropic(
      captureWatcher({
        config: {
          feeds: ["https://feed.test/commits.atom"],
          lookbackDays: 100000,
          gate: true,
          captureCandidates: true,
          candidateMinScore: 0.5,
          autoPromoteScore: 0.9,
        },
      }),
    );

    expect(autoPromoted).toHaveLength(0);
  });

  test("auto-promote is a no-op when autoPromoteScore is unset (inbox just fills)", async () => {
    stub(COMMITS_ATOM);
    gateResult = JSON.stringify([{ n: 1, score: 0.99, why: "headliner" }]);
    candidateRows.set(C1, { id: "cand-c1", title: "C1 title", url: C1, status: "new" });

    await checkAnthropic(captureWatcher({})); // config has no autoPromoteScore

    expect(autoPromoted).toHaveLength(0);
    // …but it was still captured into the inbox.
    expect(upsertCalls.map((u) => u.url)).toContain(C1);
  });
});
