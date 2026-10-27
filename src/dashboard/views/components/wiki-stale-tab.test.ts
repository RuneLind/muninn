/**
 * The STALE tab's pure half (`wiki-stale-tab.ts`): the two counts (D26), only
 * confirmed hits shown (D11), the buckets with To check open, Draft fix
 * read-only, and the hide rules on the read slice and a read-only instance.
 */
import { describe, expect, test } from "bun:test";
import { confirmedHits, draftFixHtml, staleBodyHtml, staleCounts, staleTabBadge, type StaleReportView } from "./wiki-stale-tab.ts";
import { WIKI_READ_SLICE_HIDDEN_SELECTOR } from "./wiki-read-slice.ts";
import {
  WIKI_READONLY_BLOCKED_SELECTOR,
  WIKI_READONLY_EGRESS_SELECTOR,
  WIKI_READONLY_INSTANCE_CLASS,
  WIKI_READONLY_INSTANCE_HIDDEN_SELECTOR,
  wikiReadonlyStyles,
} from "./wiki-readonly-client.ts";

const report: StaleReportView = {
  page: { relPath: "repos/x.md", title: "X" },
  changed: true,
  hits: [
    { line: 124, target: "plans/p.mdx", said: ["proposed"], now: "shipped", text: "- [[plans/p]] — forslag 22.10", confirmation: { verdict: "stale", reason: "shipped 22.10", edit: { old: "forslag 22.10", new: "levert 22.10", home: "" } } },
    { line: 128, target: "plans/q.mdx", said: ["proposed"], now: "in-flight", text: "UNCONFIRMED LINE", confirmation: "unconfirmed" },
    { line: 131, target: "plans/q.mdx", said: ["proposed"], now: "in-flight", text: "NOT A STATUS LINE", confirmation: { verdict: "not-status", reason: "two drafts" } },
  ],
  buckets: {
    counts: { toCheck: 2, mentions: 1, pointers: 0, history: 1, changedSince: 0 },
    linking: [
      { relPath: "repos/api.md", title: "API", bucket: "toCheck", passages: [{ line: 59, text: "merge queue since 03.10", claim: "date" }], verdict: { verdict: "stale", reason: "misses the pin rule", edit: { old: "merge queue", new: "merge queue and pins" } } },
      { relPath: "repos/console.md", title: "Console", bucket: "toCheck", passages: [{ line: 43, text: "ikke merget", claim: "in-flight" }] },
      { relPath: "notes/m.md", title: "M", bucket: "mentions", passages: [] },
      { relPath: "archive/a.md", title: "A", bucket: "history", passages: [] },
    ],
  },
};

describe("the STALE tab", () => {
  test("the two numbers count confirmed stale lines and the pages to check", () => {
    expect(staleCounts(report)).toEqual({ staleLines: 1, toCheck: 2 });
    expect(staleTabBadge(report)).toEqual({ text: "1 · 2", title: "1 stale status line · 2 linking pages to check" });
    expect(staleTabBadge({ hits: [report.hits![1]!], buckets: null })).toEqual({ text: "", title: "Nothing stale" });
    expect(staleCounts({ error: "x" })).toEqual({ staleLines: 0, toCheck: 0 });
  });

  test("an unconfirmed hit and a not-a-status hit are not shown; the confirmed one is, with its Draft fix", () => {
    expect(confirmedHits(report).map((h) => h.line)).toEqual([124]);
    const html = staleBodyHtml(report);
    expect(html).toContain("L124");
    expect(html).not.toContain("UNCONFIRMED LINE");
    expect(html).not.toContain("NOT A STATUS LINE");
    expect(html).toContain("⚠ 1 stale status line · 2 linking pages to check");
    expect(html).toContain('data-stale-verdict="true" data-kind="status-line" data-stale-page="repos/x.md" data-line="124" data-target="plans/p.mdx"');
  });

  test("buckets: To check open with passages, verdicts and Check; the rest folded", () => {
    const html = staleBodyHtml(report);
    expect(html).toContain('<details class="wiki-stale-bucket" data-bucket="toCheck" open><summary>To check (2)</summary>');
    expect(html).toContain('<details class="wiki-stale-bucket" data-bucket="mentions"><summary>Mentions (1)</summary>');
    expect(html).toContain("misses the pin rule");
    expect(html).toContain('data-stale-check data-stale-page="repos/x.md"');
    expect(html).toContain("Check 1 page");
    expect(html).toContain("1 of 2 checked");
    expect(staleBodyHtml(report, { checking: true, progress: "1 of 2 checked" })).toContain("Checking…");
  });

  test("a page that did not change has no buckets and no Check; nothing at all reads ✓", () => {
    const html = staleBodyHtml({ ...report, buckets: null, hits: [] });
    expect(html).toContain("✓ nothing stale");
    expect(html).toContain("Not changed in the last 14 days");
    expect(html).not.toContain("data-stale-check");
  });

  test("Draft fix shows both styles read-only and escapes the text", () => {
    const html = draftFixHtml({ old: "<b>x</b>", new: "y", home: "" });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Update the text");
    expect(html).toContain("Point to the home");
    expect(html).toContain("<em>(removed)</em>");
    expect(html).not.toContain("<button");
    expect(draftFixHtml(null)).toBe("");
  });

  test("hidden on the read slice and on a read-only instance; Check is egress, the verdicts are writes", () => {
    for (const sel of ['[data-conntab="stale"]', "#staleBody"]) {
      expect(WIKI_READ_SLICE_HIDDEN_SELECTOR.split(",")).toContain(sel);
      expect(WIKI_READONLY_INSTANCE_HIDDEN_SELECTOR.split(",")).toContain(sel);
    }
    expect(wikiReadonlyStyles()).toContain(`body.${WIKI_READONLY_INSTANCE_CLASS} [data-conntab="stale"]`);
    expect(WIKI_READONLY_EGRESS_SELECTOR.split(",")).toContain("[data-stale-check]");
    expect(WIKI_READONLY_BLOCKED_SELECTOR.split(",")).toContain("[data-stale-verdict]");
  });
});
