import { describe, expect, test } from "bun:test";
import {
  candidateIsListed,
  cleanPageTitle,
  insertFoundLinks,
  labelPage,
  linksBaseHash,
  parseCandidates,
  parseManifest,
  runFindLinks,
  titleTokens,
  type FindLinksEvent,
  type LinkCandidate,
} from "./find-links.ts";
import { findLinksSection, parseLinksSection, renderLinksSection } from "./links-section.ts";
import { buildSummarySaveBody, readStoredCapture, requireSaveDescriptor } from "./summary-save.ts";
import { checkedSha256OfRaw } from "./factcheck-body.ts";
import { buildSummaryFactcheckBlock, insertSummaryFactcheckBlock } from "./factcheck-block.ts";
import type { SafePage } from "./safe-fetch.ts";

// Invented fixtures in the shape of the real pages (public repo: no live corpus).
const HALLIE: LinkCandidate = {
  title: null,
  author: "Lydia Hallie",
  topic: "Lydia Hallie's article on Claude Code effort levels",
  kind: "post",
};

function html(title: string, body: string, meta = ""): SafePage {
  return {
    finalUrl: "https://claude.example/resources/articles/effort",
    contentType: "text/html; charset=utf-8",
    text: `<html><head><title>${title}</title>${meta}</head><body><article>${body}</article></body></html>`,
  };
}

describe("titleTokens", () => {
  test("lowercases, strips possessives and punctuation, drops stop words, folds plurals, dedupes", () => {
    expect(titleTokens("Lydia Hallie's article on Claude Code effort levels")).toEqual([
      "lydia", "hallie", "article", "claude", "code", "effort", "level",
    ]);
    expect(titleTokens("Claude Code effort level and model selection")).toEqual([
      "claude", "code", "effort", "level", "model", "selection",
    ]);
    expect(titleTokens("Practices, practices: PROCESS")).toEqual(["practice", "process"]);
  });
});

describe("cleanPageTitle", () => {
  test("strips a trailing ` | site`, ` - site`, ` — site` and ` / site` suffix", () => {
    expect(cleanPageTitle("Effort levels | Anthropic")).toBe("Effort levels");
    expect(cleanPageTitle("Effort levels - Anthropic")).toBe("Effort levels");
    expect(cleanPageTitle("Effort levels — Anthropic")).toBe("Effort levels");
    expect(cleanPageTitle("Effort levels / claude.dev Blog")).toBe("Effort levels");
  });
  test("drops a leading `Series: ` prefix only when at least 2 tokens follow it", () => {
    expect(cleanPageTitle("Using Claude Code: Spending your effort / claude.dev Blog")).toBe("Spending your effort");
    expect(cleanPageTitle("Release notes: Opus")).toBe("Release notes: Opus");
  });
});

describe("labelPage — the design's three fixtures", () => {
  test("a summary-derived topic against its page comes out matched (4 of 6, Hallie in the text)", () => {
    const page = html("Claude Code effort level and model selection", "<p>By Lydia Hallie. Pick an effort level per task.</p>");
    expect(labelPage(HALLIE, page, "")).toBe("matched");
  });

  test("the same candidate against «Claude Code best practices» is reachable (2 of 4) when the quote is on the page", () => {
    const page = html("Claude Code best practices", "<p>Lydia Hallie writes that effort is a dial you set per task.</p>");
    expect(labelPage(HALLIE, page, "effort is a dial you set per task")).toBe("reachable");
    expect(labelPage(HALLIE, page, "a sentence the page never says at all")).toBeNull();
  });

  test("«Spending your effort» against the claude.dev shape comes out matched", () => {
    const c: LinkCandidate = { title: "Spending your effort", author: null, topic: "the blog post on spending effort wisely", kind: "post" };
    const page = html("Using Claude Code: Spending your effort / claude.dev Blog", "<p>Text.</p>");
    expect(labelPage(c, page, "")).toBe("matched");
  });

  test("og:title wins over <title>, and the byline metadata satisfies the author", () => {
    const page = html(
      "Unrelated tab title",
      "<p>No name in the visible text.</p>",
      '<meta property="og:title" content="Claude Code effort level and model selection"><meta name="author" content="Lydia Hallie">',
    );
    expect(labelPage(HALLIE, page, "")).toBe("matched");
  });

  test("a matching title without the author's surname anywhere is not matched", () => {
    const page = html("Claude Code effort level and model selection", "<p>Anonymous docs page.</p>");
    expect(labelPage(HALLIE, page, "")).toBeNull();
  });

  test("a page whose title matches the agent's MANIFEST but not the candidate is labelled reachable (D15)", async () => {
    // The agent names the page by its own title, which the page carries; the
    // candidate is something else. The label scores the candidate, so this is
    // reachable (the quote is there), never matched.
    const c: LinkCandidate = { title: "Spending your effort", author: null, topic: "the post on spending effort", kind: "post" };
    const page = html("Claude Code best practices for large repositories", "<p>Keep your CLAUDE.md short and specific to the repo.</p>");
    const manifest = JSON.stringify({
      results: [{ url: page.finalUrl, title: "Claude Code best practices for large repositories", quote: "Keep your CLAUDE.md short and specific to the repo." }],
    });
    const events: FindLinksEvent[] = [];
    await runFindLinks([c], { agent: async () => manifest, fetchPage: async () => page }, (e) => events.push(e));
    const result = events.find((e) => e.type === "result");
    expect(result).toMatchObject({ outcome: "found", results: [{ label: "reachable" }] });
  });

  test("a quote copied from WebFetch's markdown finds the HTML it came from (measured shape)", () => {
    // The real smoke's miss: the agent quoted `**Start with `high`, the default, for most tasks**`.
    const page = html("Effort", "<p><strong>Start with <code>high</code>, the default, for most tasks</strong>, then step down.</p>");
    expect(labelPage({ ...HALLIE, author: null }, page, "**Start with `high`, the default, for most tasks**, then step down.")).toBe("reachable");
    expect(labelPage({ ...HALLIE, author: null }, page, "See [the docs](https://x.example/d) for most tasks, then step down")).toBeNull();
  });

  test("a non-text answer that resolves is unread", () => {
    expect(labelPage(HALLIE, { finalUrl: "https://x.example/a.pdf", contentType: "application/pdf", text: null }, "")).toBe("unread");
  });
});

describe("parsers", () => {
  test("candidates: a fenced array, bounded, items without a topic or title dropped", () => {
    const raw = 'Here:\n```json\n[{"title":null,"author":"A B","topic":"x y","kind":"repo"},{"author":"nobody"},{"title":"T","topic":"","kind":"weird"}]\n```';
    expect(parseCandidates(raw)).toEqual([
      { title: null, author: "A B", topic: "x y", kind: "repo" },
      { title: "T", author: null, topic: "T", kind: "post" },
    ]);
    expect(parseCandidates("no list here")).toBeNull();
  });

  test("manifest: at most 3 http(s) URLs, non-http dropped", () => {
    const raw = JSON.stringify({
      results: [
        { url: "javascript:alert(1)", title: "x", quote: "q" },
        { url: "https://a.example/1", title: "1", quote: "q" },
        { url: "https://a.example/2" },
        { url: "https://a.example/3" },
        { url: "https://a.example/4" },
      ],
    });
    expect(parseManifest(`Sure: ${raw}`).map((m) => m.url)).toEqual(["https://a.example/1", "https://a.example/2", "https://a.example/3"]);
    expect(parseManifest("nothing")).toEqual([]);
  });

  test("a candidate an existing line's title already names is listed", () => {
    expect(candidateIsListed(HALLIE, ["Claude Code effort level and model selection"])).toBe(true);
    expect(candidateIsListed(HALLIE, ["Claude"])).toBe(false);
    expect(candidateIsListed(HALLIE, ["A different paper entirely"])).toBe(false);
  });
});

describe("insertFoundLinks and linksBaseHash", () => {
  const FM = '---\ndate: 2026-03-22\nurl: "https://www.youtube.com/watch?v=abc"\n---\n';
  const SECTION = renderLinksSection({
    lines: [{ icon: "📄", title: "Spending your effort", url: "https://claude.example/blog/spending-your-effort", detail: "Anthropic", provenance: "from description" }],
    omitted: 7,
  })!;
  const FOUND = { url: "https://www.claude.example/resources/articles/effort?utm_source=x", title: "Claude Code [effort] level", detail: "Anthropic, Lydia Hallie" };

  test("a new line goes after the last link line, above the count line, its title escaped", () => {
    const body = `Summary.\n\n${SECTION}`;
    const out = insertFoundLinks(body, [FOUND]);
    expect(out.added).toBe(1);
    const range = findLinksSection(out.body)!;
    const section = out.body.slice(range.start, range.end);
    expect(section).toContain("- 🔎 [Claude Code \\[effort\\] level](https://www.claude.example/resources/articles/effort?utm_source=x) — Anthropic, Lydia Hallie · found by search\n\n_7 creator");
    expect(parseLinksSection(section).lines.map((l) => l.provenance)).toEqual(["from description", "found by search"]);
  });

  test("a URL already in the section, compared through normalizeDestinationUrl, is skipped", () => {
    const body = `Summary.\n\n${SECTION}`;
    const out = insertFoundLinks(body, [{ ...FOUND, url: "http://www.claude.example/blog/spending-your-effort/?utm_campaign=y" }]);
    expect(out).toEqual({ body, added: 0, skipped: 1 });
  });

  test("a URL with parentheses dedups against its percent-encoded stored form", () => {
    const first = insertFoundLinks("Summary.", [{ ...FOUND, url: "https://en.wikipedia.example/wiki/Effort_(physics)" }]);
    expect(first.body).toContain("Effort_%28physics%29");
    expect(insertFoundLinks(first.body, [{ ...FOUND, url: "https://en.wikipedia.example/wiki/Effort_(physics)" }]).skipped).toBe(1);
  });

  test("no section: one is created after the visual reference, and the hash does not move", () => {
    const body = "Summary.\n\n## Visual reference\n\n- slide";
    const raw = `${FM}\n${body}\n`;
    const out = insertFoundLinks(body, [FOUND]);
    expect(out.body).toMatch(/## Visual reference\n\n- slide\n\n## Links\n\n- 🔎 /);
    expect(linksBaseHash(`${FM}\n${out.body}\n`)).toBe(linksBaseHash(raw));
  });

  /** huginn's write restated: frontmatter re-quoted, a blank line, the summary string. */
  const huginnWrite = (raw: string, summary: string) => {
    const stored = readStoredCapture(raw);
    const { body } = buildSummarySaveBody({ descriptor: requireSaveDescriptor("youtube"), stored, title: "T", category: "ai", summary });
    const fm = Object.entries(body)
      .filter(([k]) => k === "date" || k === "url")
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    return `---\n${fm}\n---\n\n${String(body.summary)}`;
  };

  const shapes: Record<string, string> = {
    "section + transcript": `Summary.\n\n${SECTION}\n\n## Transcript\n\n### [00:00:00]\n\nWords.\n`,
    "no section, no transcript": "Summary only.\n",
    "no section + transcript": "Summary.\n\n## Transcript\n\nWords.\n",
    "fact-check block + visual reference + transcript": `${insertSummaryFactcheckBlock("Summary.\n\n## Visual reference\n\n- slide", buildSummaryFactcheckBlock("Checked.", "2026-10-25"))}\n\n## Transcript\n\nWords.\n`,
  };
  for (const [name, bodyText] of Object.entries(shapes)) {
    test(`${name}, legacy unquoted frontmatter: two saves keep the links hash and the fact-check hash`, () => {
      let raw = `${FM}\n${bodyText}`;
      const hash0 = linksBaseHash(raw);
      const checked0 = checkedSha256OfRaw(raw);
      for (const found of [FOUND, { ...FOUND, url: "https://b.example/2", title: "Second" }]) {
        const stored = readStoredCapture(raw);
        const out = insertFoundLinks(stored.body, [found]);
        expect(out.added).toBe(1);
        raw = huginnWrite(raw, out.body);
        expect(linksBaseHash(raw)).toBe(hash0);
        expect(checkedSha256OfRaw(raw)).toBe(checked0);
      }
      expect(raw).toContain('date: "2026-03-22"');
      expect(parseLinksSection(raw.slice(findLinksSection(raw)!.start, findLinksSection(raw)!.end)).lines.filter((l) => l.icon === "🔎")).toHaveLength(2);
    });
  }

  test("any other body write moves the hash", () => {
    const raw = `${FM}\nSummary.\n\n${SECTION}\n`;
    expect(linksBaseHash(raw.replace("Summary.", "Summary, re-run."))).not.toBe(linksBaseHash(raw));
  });
});

describe("runFindLinks", () => {
  const page = html("Claude Code effort level and model selection", "<p>Lydia Hallie</p>");
  const ok = JSON.stringify({ results: [{ url: page.finalUrl, title: "x", quote: "" }] });

  test("at most 3 agents at once; one result per candidate; not-found answers nothing shown", async () => {
    let live = 0;
    let peak = 0;
    const events: FindLinksEvent[] = [];
    const cands = Array.from({ length: 5 }, (_, i) => ({ ...HALLIE, topic: `${HALLIE.topic} ${i}` }));
    await runFindLinks(
      cands,
      {
        agent: async (_c, i) => {
          live++;
          peak = Math.max(peak, live);
          await Bun.sleep(5);
          live--;
          return i === 1 ? "{}" : ok;
        },
        fetchPage: async () => page,
      },
      (e) => events.push(e),
    );
    expect(peak).toBe(3);
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(5);
    expect(results.find((e) => e.index === 1)).toMatchObject({ outcome: "not_found", results: [] });
    expect(results.find((e) => e.index === 0)).toMatchObject({ outcome: "found", results: [{ label: "matched", url: page.finalUrl }] });
  });

  test("an agent past its timeout is a timeout; the run ends at its deadline with the rest skipped", async () => {
    const events: FindLinksEvent[] = [];
    const started = Date.now();
    await runFindLinks(
      [HALLIE, HALLIE, HALLIE],
      { agent: () => new Promise(() => {}), fetchPage: async () => page, concurrency: 1, agentTimeoutMs: 20, runTimeoutMs: 30 },
      (e) => events.push(e),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    const outcomes = events.filter((e) => e.type === "result").map((e) => (e.type === "result" ? `${e.index}:${e.outcome}` : ""));
    expect(outcomes[0]).toBe("0:timeout");
    expect(outcomes).toHaveLength(3);
    expect(outcomes.slice(1).every((o) => /:(timeout|skipped)$/.test(o))).toBe(true);
  });

  test("a refused fetch (null) is not found, never shown", async () => {
    const events: FindLinksEvent[] = [];
    await runFindLinks([HALLIE], { agent: async () => ok, fetchPage: async () => null }, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "not_found", results: [] });
  });
});
