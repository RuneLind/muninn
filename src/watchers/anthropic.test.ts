import { test, expect, describe, afterEach } from "bun:test";
import { parseAtomEntries, checkAnthropic, DEFAULT_ANTHROPIC_FEEDS } from "./anthropic.ts";
import type { Watcher } from "../types.ts";

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
    <link type="text/html" rel="alternate" href="https://github.com/anthropics/claude-code/commit/01f1617"/>
    <title>
        feat: add CLAUDE_CODE_DISABLE_MOUSE_CLICKS &amp; keep wheel scroll
    </title>
    <updated>2026-06-26T21:29:36Z</updated>
    <media:thumbnail height="30" width="30" url="https://avatars.githubusercontent.com/u/1?s=30&amp;v=4"/>
    <content type="html">&lt;pre&gt;feat: add ...&lt;/pre&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/f0919a1</id>
    <link type="text/html" rel="alternate" href="https://github.com/anthropics/claude-code/commit/f0919a1"/>
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

describe("parseAtomEntries", () => {
  test("parses commits-feed entries (type-first link order, entity in title)", () => {
    const entries = parseAtomEntries(COMMITS_ATOM);
    expect(entries.length).toBe(2);
    expect(entries[0]!.id).toBe("https://github.com/anthropics/claude-code/commit/01f1617");
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

describe("checkAnthropic", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
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

  test("cold start returns a single silent baseline carrying every entry id", async () => {
    stub(COMMITS_ATOM);
    const alerts = await checkAnthropic(baseWatcher({ lastNotifiedIds: [] }));
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.silent).toBe(true);
    expect(alerts[0]!.trackingIds?.length).toBe(2);
    expect(alerts[0]!.trackingIds).toContain(
      "https://github.com/anthropics/claude-code/commit/01f1617",
    );
  });

  test("steady state emits one non-silent alert per entry", async () => {
    stub(COMMITS_ATOM);
    const alerts = await checkAnthropic(baseWatcher({ lastNotifiedIds: ["already-seen"] }));
    expect(alerts.length).toBe(2);
    expect(alerts.every((a) => !a.silent)).toBe(true);
    expect(alerts[0]!.id).toBe("https://github.com/anthropics/claude-code/commit/01f1617");
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
});
