/**
 * The work-thread card's markup (`wiki-thread-view.ts`): the header's span and
 * meta line, the escaping of every interpolated string, and the touched line.
 * Placement and the lift are `buildRail`'s, tested in `wiki-recents.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  threadCardHeaderHtml,
  threadInstantLabel,
  threadMetaLine,
  threadSpanLabel,
  threadTouchedHtml,
} from "./wiki-thread-view.ts";
import type { RailThreadCard } from "./wiki-recents.ts";
import type { WikiListing } from "./wiki-filter.ts";

/** A local Thursday 15 Oct 2026, 10:00 — every label below is in the process zone. */
const NOW = new Date(2026, 9, 15, 10, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

const card = (over: Partial<RailThreadCard> = {}): RailThreadCard => ({
  key: "plans/a.mdx",
  foldKey: "thread:plans/a.mdx",
  toggleKey: "closed:thread:plans/a.mdx",
  name: "Alpha <work>",
  open: true,
  pinned: false,
  pinAnchor: "plans/a.mdx",
  focus: [],
  created: [],
  touched: [],
  sessions: [
    { id: "s2", provider: "claude", first: at(14, 20), last: at(14, 21, 26), title: "Second" },
    { id: "s1", provider: "opencode", first: at(12, 15, 4), last: at(12, 16), title: "" },
  ],
  movesYou: 18,
  score: 3,
  ...over,
});

describe("threadInstantLabel / threadSpanLabel", () => {
  test("today, yesterday, else weekday and day.month", () => {
    expect(threadInstantLabel(at(15, 8, 1), NOW)).toBe("today 08:01");
    expect(threadInstantLabel(at(14, 21, 26), NOW)).toBe("yesterday 21:26");
    expect(threadInstantLabel(at(12, 15, 4), NOW)).toBe("mon 12.10 15:04");
  });
  test("the span runs from the oldest session start to the newest session end", () => {
    expect(threadSpanLabel(card(), NOW)).toBe("mon 12.10 15:04 → yesterday 21:26");
    expect(threadSpanLabel(card({ sessions: [] }), NOW)).toBe("");
  });
  test("a span inside one day names the day once", () => {
    const sameDay = card({ sessions: [{ id: "s", provider: "claude", first: at(15, 8, 1), last: at(15, 9, 30), title: "" }] });
    expect(threadSpanLabel(sameDay, NOW)).toBe("today 08:01 → 09:30");
    const older = card({ sessions: [{ id: "s", provider: "claude", first: at(12, 8, 1), last: at(12, 9, 30), title: "" }] });
    expect(threadSpanLabel(older, NOW)).toBe("mon 12.10 08:01 → 09:30");
  });
});

describe("threadMetaLine", () => {
  test("sessions · span · ✋, the ✋ only where it is personal and non-zero", () => {
    expect(threadMetaLine(card(), NOW, true)).toBe("2 sessions · mon 12.10 15:04 → yesterday 21:26 · ✋ 18");
    expect(threadMetaLine(card(), NOW, false)).toBe("2 sessions · mon 12.10 15:04 → yesterday 21:26");
    expect(threadMetaLine(card({ movesYou: 0, sessions: card().sessions.slice(0, 1) }), NOW, true)).toBe(
      "1 session · yesterday 20:00 → 21:26",
    );
  });
});

describe("threadCardHeaderHtml", () => {
  test("a fold button writing toggleKey and a 📌 carrying the key and its state, every string escaped", () => {
    const html = threadCardHeaderHtml(card(), false, NOW, true);
    expect(html).toContain('data-fold-key="closed:thread:plans/a.mdx"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-thread-pin="plans/a.mdx" data-thread-pinned="0" aria-pressed="false"');
    expect(html).toContain("Alpha &lt;work&gt;");
    expect(html).not.toContain("<work>");
    // The hover lists the sessions; one with no title falls back to its id.
    expect(html).toContain("• Second (claude)");
    expect(html).toContain("• s1 (opencode)");
    const pinned = threadCardHeaderHtml(card({ pinned: true }), true, NOW, true);
    expect(pinned).toContain('data-thread-pinned="1" aria-pressed="true"');
    expect(pinned).toContain('aria-expanded="false"');
    expect(pinned).toContain("wiki-thread-card pinned");
  });
  test("the 📌's label is the same pinned or not; aria-pressed alone says which", () => {
    const label = (html: string) => /class="wiki-thread-pin[^>]*aria-label="([^"]*)"/.exec(html)![1];
    expect(label(threadCardHeaderHtml(card(), false, NOW, true))).toBe("Pin this work thread first");
    expect(label(threadCardHeaderHtml(card({ pinned: true }), false, NOW, true))).toBe("Pin this work thread first");
  });
  test("the fold carries no aria-label, so its name is its content: the name and every meta part", () => {
    const html = threadCardHeaderHtml(card(), false, NOW, true);
    const fold = /<button[^>]*class="wiki-thread-fold[^>]*>/.exec(html)![0];
    expect(fold).not.toContain("aria-label");
    expect(html).toContain(
      '<small class="wiki-thread-meta"><span class="wiki-thread-count">2 sessions</span>' +
        '<span class="wiki-thread-span"> · mon 12.10 15:04 → yesterday 21:26</span>' +
        '<span class="wiki-thread-moves"> · ✋ 18</span></small>',
    );
    // The hover keeps the whole meta line too, for the span the rail truncates.
    expect(fold).toContain("2 sessions · mon 12.10 15:04 → yesterday 21:26 · ✋ 18");
  });
});

describe("threadTouchedHtml", () => {
  const p = (relPath: string, title: string) => ({ relPath, name: relPath, title, type: "note", domain: "ai", tags: [], aliases: [], linkCount: 0, backlinkCount: 0 }) as WikiListing;
  test("one link per page, carrying data-relpath for the nav delegate; nothing for none", () => {
    const html = threadTouchedHtml("thread:x", [p("a.md", "A & co"), p("b.md", "B")], (rel) => `/wiki?relPath=${rel}`);
    expect(html.match(/class="wiki-thread-link"/g)!.length).toBe(2);
    expect(html).toContain('data-relpath="a.md"');
    expect(html).toContain("A &amp; co");
    expect(html).toContain('href="/wiki?relPath=b.md"');
    expect(threadTouchedHtml("thread:x", [], () => "")).toBe("");
  });
});
