/**
 * The work-thread card's markup (`wiki-thread-view.ts`): the header's span and
 * meta line, the escaping of every interpolated string, and the touched line.
 * Placement and the lift are `buildRail`'s, tested in `wiki-recents.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  railGhostHtml,
  railGhostNote,
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

// "yesterday" is the previous CALENDAR day, not `now - 24h`: after a 23-hour
// spring-forward day the two differ. The zone is set for this block alone and
// restored to an explicit zone (`delete process.env.TZ` does not reset it on Bun).
describe("threadInstantLabel across a DST change (Europe/Oslo)", () => {
  const PREV = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  beforeAll(() => {
    process.env.TZ = "Europe/Oslo";
  });
  afterAll(() => {
    process.env.TZ = PREV;
  });

  test("the zone really skips an hour on 28 March 2027, or this block proves nothing", () => {
    const d = new Date(2027, 2, 28, 2, 30);
    expect(d.getHours()).toBe(3);
  });

  test("after the 23-hour day, the day before is still yesterday", () => {
    const now = new Date(2027, 2, 29, 0, 30).getTime();
    expect(threadInstantLabel(new Date(2027, 2, 28, 0, 15).getTime(), now)).toBe("yesterday 00:15");
    expect(threadInstantLabel(new Date(2027, 2, 27, 23, 45).getTime(), now)).toBe("sat 27.03 23:45");
  });

  test("after the 25-hour day, the day before is yesterday and the one before that is not", () => {
    const now = new Date(2026, 9, 26, 23, 30).getTime();
    expect(threadInstantLabel(new Date(2026, 9, 25, 0, 15).getTime(), now)).toBe("yesterday 00:15");
    expect(threadInstantLabel(new Date(2026, 9, 24, 23, 45).getTime(), now)).toBe("sat 24.10 23:45");
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

describe("railGhostHtml", () => {
  // main (254aed2d)'s ghost row, verbatim — the markup a pin's ghost must keep
  // without a sessions memo (D11). Literal on purpose: built from a template it
  // would move with the code under test.
  const MAIN_PINNED =
    `<div class="wiki-list-ghost wiki-series-cont" data-ghost-relpath="plans/a&amp;b.mdx"` +
    ` title="A &lt;b&gt; &quot;x&quot;\npinned — its row is under Pinned, above">` +
    `<div class="wiki-list-ghost-title">A &lt;b&gt; &quot;x&quot;</div>` +
    `<div class="wiki-list-ghost-note">pinned above</div>` +
    `</div>`;

  test("a pin's ghost is byte-identical to main's markup (D11)", () => {
    expect(railGhostHtml("plans/a&b.mdx", 'A <b> "x"', "pinned")).toBe(MAIN_PINNED);
  });

  test("a work thread's ghost says so, and alone carries data-ghost-reason", () => {
    const html = railGhostHtml("plans/a.mdx", "A", "thread");
    expect(html).toContain(` data-ghost-reason="thread"`);
    expect(html).toContain(`<div class="wiki-list-ghost-note">in a work thread above</div>`);
    expect(html).toContain("its row is under Work threads, above");
    expect(railGhostNote("pinned")).toBe("pinned above");
  });
});
