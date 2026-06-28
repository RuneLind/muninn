import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import type { Watcher } from "../types.ts";

// --- Module mocks (registered before the dynamic import below) ---
// The Haiku gate and snapshot store are mocked so the gate/Tier-2 paths can run
// without a real `claude -p` spawn or a live DB. The Phase-1 tests don't touch
// either, so the mocks are inert for them.

let gateResult = "[]";
let gateThrow = false;
mock.module("../scheduler/executor.ts", () => ({
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  spawnHaiku: async () => {
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

const { parseAtomEntries, parseLlmsTxtDocs, parseBlogSlugs, checkAnthropic, DEFAULT_ANTHROPIC_FEEDS } =
  await import("./anthropic.ts");

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
    snapStore.clear();
    setCalls.length = 0;
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
    // 11 feeds × MAX_PER_FEED(20) = 220 Tier-1 entries > the 200 cap; the 11th feed's
    // entries are dropped from trackingIds, while the Tier-2 doc addition is always kept.
    const FEEDS = Array.from({ length: 11 }, (_, f) => `https://feed.test/f${f}.atom`);
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
        lastNotifiedIds: ["seen"], // not cold; matches no feed url → all 220 Tier-1 are new
        config: { feeds: FEEDS, lookbackDays: 100000, tier2: true, digest: true },
      }),
    );
    expect(alerts.length).toBe(1);
    const ids = alerts[0]!.trackingIds!;
    // 200 capped Tier-1 + 1 Tier-2 = 201
    expect(ids.length).toBe(201);
    // Tier-2 addition is ALWAYS retained
    expect(ids).toContain(`an:${D2}`);
    // The 11th feed (f10) was dropped by the cap
    expect(ids).not.toContain("https://github.com/anthropics/f10/commit/c0");
    // The first feed survived
    expect(ids).toContain("https://github.com/anthropics/f0/commit/c0");
  });
});
