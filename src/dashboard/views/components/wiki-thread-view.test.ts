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
  threadDiscloseLabel,
  threadInstantLabel,
  threadMetaLine,
  threadSpanLabel,
  threadTouchedHtml,
  threadGroupDiscloseLabel,
  threadGroupEndHtml,
  threadGroupHeaderHtml,
  threadGroupTally,
  workGroupMenuHtml,
  workReasonLabel,
  workSectionHeaderHtml,
} from "./wiki-thread-view.ts";
import type { RailGroupCard, RailThreadCard, RailWorkControl } from "./wiki-recents.ts";
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
  test("sessions · span · ✋, the ✋ only where it is personal and non-zero; the meta drops the weekday", () => {
    expect(threadMetaLine(card(), NOW, true)).toBe("2 sessions · 12.10 15:04 → yesterday 21:26 · ✋ 18");
    expect(threadMetaLine(card(), NOW, false)).toBe("2 sessions · 12.10 15:04 → yesterday 21:26");
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
  test("the 📌's hover says its state: a pinned one says a click unpins", () => {
    const title = (html: string) => /class="wiki-thread-pin[^>]*title="([^"]*)"/.exec(html)![1];
    expect(title(threadCardHeaderHtml(card(), false, NOW, true))).toBe("Pin this work thread first");
    expect(title(threadCardHeaderHtml(card({ pinned: true }), false, NOW, true))).toBe("Pinned first. Click to unpin");
  });
  test("the fold carries no aria-label, so its name is its content: the name and every meta part", () => {
    const html = threadCardHeaderHtml(card(), false, NOW, true);
    const fold = /<button[^>]*class="wiki-thread-fold[^>]*>/.exec(html)![0];
    expect(fold).not.toContain("aria-label");
    // Two lines, `N sessions · ✋ M` over `first → last`; each part its own
    // span, a space between parts so a narrow rail breaks only there.
    // A visually hidden ` · ` between the name, the two lines and the
    // disclose line, so a screen reader hears four parts, not one run.
    expect(html).toContain(
      '<span class="wiki-thread-name">Alpha &lt;work&gt;</span><span class="wiki-sr-only"> · </span>' +
        '<small class="wiki-thread-meta"><span class="wiki-thread-line wiki-thread-tally">' +
        '<span class="wiki-thread-count">2 sessions</span> <span class="wiki-thread-moves">· ✋ 18</span></span>' +
        '<span class="wiki-sr-only"> · </span>' +
        ' <span class="wiki-thread-line wiki-thread-span"><span class="wiki-thread-from">12.10 15:04</span>' +
        ' <span class="wiki-thread-to">→ yesterday 21:26</span></span></small><span class="wiki-sr-only"> · </span>' +
        '<span class="wiki-thread-disclose"><span aria-hidden="true">▾ </span>Hide pages</span>',
    );
    // No ✋ (hidden where it is not personal): the tally line is the count alone.
    expect(threadCardHeaderHtml(card(), false, NOW, false)).toContain(
      '<span class="wiki-thread-line wiki-thread-tally"><span class="wiki-thread-count">2 sessions</span></span>',
    );
    // The hover (the fold's description) does not repeat the meta the name
    // already speaks; its session lines carry every start and end.
    const title = /title="([^"]*)"/.exec(fold)![1]!;
    expect(title).not.toContain("2 sessions");
    expect(title).not.toContain("✋");
    expect(title).toContain("mon 12.10 15:04 → mon 12.10 16:00");
    expect(title).toContain("yesterday 20:00 → yesterday 21:26");
  });
});

describe("the header says it is a thread and what a click does", () => {
  test("«Show N pages» closed, «Hide …» open; the count is the rail entry's, else the card's focus pages", () => {
    expect([0, 1, 3].map((n) => threadDiscloseLabel(true, n))).toEqual(["Show pages", "Show 1 page", "Show 3 pages"]);
    expect([0, 1, 3].map((n) => threadDiscloseLabel(false, n))).toEqual(["Hide pages", "Hide page", "Hide 3 pages"]);
    const disclose = (html: string) => /<span class="wiki-thread-disclose">(.*?)<\/span><\/span>/.exec(html)![1];
    expect(disclose(threadCardHeaderHtml(card(), true, NOW, true, 2))).toBe('<span aria-hidden="true">▸ </span>Show 2 pages');
    expect(disclose(threadCardHeaderHtml(card(), false, NOW, true, 2))).toBe('<span aria-hidden="true">▾ </span>Hide 2 pages');
    const focus = [{ relPath: "plans/a.mdx" }, { relPath: "plans/b.mdx" }] as WikiListing[];
    expect(disclose(threadCardHeaderHtml(card({ focus }), true, NOW, true))).toContain("Show 2 pages");
  });
  test("a thread glyph, hidden from the name, takes the caret's slot", () => {
    const html = threadCardHeaderHtml(card(), true, NOW, true);
    expect(html).toContain('<svg class="wiki-thread-glyph"');
    expect(/<svg class="wiki-thread-glyph"[^>]*aria-hidden="true"/.test(html)).toBe(true);
    expect(html).not.toContain("wiki-fold-caret");
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

// ── Grouped Work threads (plan `muninn-wiki-work-thread-grouping`, PR 3) ─────

const groupCard = (over: Partial<RailGroupCard> = {}): RailGroupCard => ({
  group: true,
  key: "plans/a.mdx",
  foldKey: "group:series:alpha",
  toggleKey: "closed:group:series:alpha",
  open: true,
  label: "series",
  name: "Alpha <series>",
  pinned: false,
  pinAnchor: "plans/a-two.mdx",
  anchorVisible: true,
  threads: 3,
  sessions: [
    { id: "s2", provider: "claude", first: at(14, 20), last: at(14, 21, 26), title: "Second" },
    { id: "s1", provider: "claude", first: at(12, 15, 4), last: at(12, 16), title: "" },
  ],
  movesYou: 26,
  children: [],
  hidden: 0,
  context: [],
  witnesses: ["series Alpha", "A ↔ B (related:)"],
  score: 1,
  ...over,
});

const control = (over: Partial<RailWorkControl> = {}): RailWorkControl => ({
  requested: "related",
  stop: "related",
  evidence: { series: true, related: false, issue: true },
  evidenceApplies: true,
  stops: [
    { stop: "threads", available: true, reasons: [], cards: 17 },
    { stop: "related", available: true, reasons: [], cards: 3 },
    { stop: "areas", available: true, reasons: [], cards: 2 },
  ],
  ...over,
});

describe("the group card", () => {
  test("kind label, escaped name, tally, span, disclose and a separate 📌 for the anchor", () => {
    const html = threadGroupHeaderHtml(groupCard(), false, NOW, true);
    expect(html).toContain(`class="wiki-thread-card wiki-thread-group open"`);
    expect(html).toContain(`data-thread-group="group:series:alpha"`);
    expect(html).toContain(`data-fold-key="closed:group:series:alpha" aria-expanded="true"`);
    expect(html).toContain(`<span class="wiki-thread-kind">series</span> Alpha &lt;series&gt;`);
    expect(html).toContain(`>3 threads</span> <span class="wiki-thread-count">· 2 sessions</span> <span class="wiki-thread-moves">· ✋ 26</span>`);
    expect(html).toContain(`12.10 15:04</span> <span class="wiki-thread-to">→ yesterday 21:26`);
    expect(html).toContain("Hide 3 threads");
    expect(html).toContain(`data-thread-pin="plans/a-two.mdx" data-thread-pinned="0" aria-pressed="false" aria-label="Pin this work group first"`);
    // The hover lists the witnesses.
    expect(html).toContain("series Alpha&#10;A ↔ B (related:)".replace("&#10;", "\n"));
    expect(html).not.toContain("anchor outside the filters");
  });

  test("closed, stacked; a hidden anchor says so; ✋ hides where it is not personal", () => {
    const html = threadGroupHeaderHtml(groupCard({ anchorVisible: false, open: false }), true, NOW, false);
    expect(html).toContain(`class="wiki-thread-card wiki-thread-group"`);
    expect(html).toContain("Show 3 threads");
    expect(html).toContain("anchor outside the filters");
    expect(html).not.toContain("✋");
  });

  test("tally and disclose words", () => {
    expect(threadGroupTally(groupCard({ threads: 1, sessions: [groupCard().sessions[0]!] }), true)).toBe("1 thread · 1 session · ✋ 26");
    expect(threadGroupDiscloseLabel(true, 1)).toBe("Show 1 thread");
    expect(threadGroupDiscloseLabel(false, 12)).toBe("Hide 12 threads");
  });
});

describe("the child card", () => {
  test("a third meta line: the why parts, then the also chip; the hover lists the witnesses", () => {
    const html = threadCardHeaderHtml(
      card({ child: { anchor: false, why: "↔ 5 links · ABC-1 · series", witnesses: ["A ↔ B (related:)"], also: ["Beta <b>", "Gamma"] } }),
      false,
      NOW,
      true,
    );
    expect(html).toContain(`class="wiki-thread-card wiki-thread-child open"`);
    expect(html).toContain(
      `<span class="wiki-thread-why-part">↔ 5 links</span> <span class="wiki-thread-why-part">· ABC-1</span> <span class="wiki-thread-why-part">· series</span>`,
    );
    expect(html).toContain(`>also Beta &lt;b&gt; +1</span>`);
    expect(html).toContain(`title="Some of its pages are also in: Beta &lt;b&gt;, Gamma"`);
    expect(html).toContain(`title="Joined by:\nA ↔ B (related:)"`);
  });

  test("the also chip cuts a long series label to 24 characters; the hover keeps it whole", () => {
    const long = "A long series label that names a whole piece of work";
    const html = threadCardHeaderHtml(card({ child: { anchor: false, why: "↔ series", witnesses: [], also: [long] } }), true, NOW, true);
    expect(html).toContain(`>also A long series label tha…</span>`);
    expect(html).toContain(`title="Some of its pages are also in: ${long}"`);
  });

  test("the anchor says anchor; a card with no child line is today's markup", () => {
    expect(threadCardHeaderHtml(card({ child: { anchor: true, why: "anchor", witnesses: [], also: [] } }), true, NOW, true)).toContain(
      `<span class="wiki-thread-why-part">anchor</span>`,
    );
    expect(threadCardHeaderHtml(card(), true, NOW, true)).not.toContain("wiki-thread-why");
  });
});

describe("the group's end", () => {
  const p = (rel: string, title: string) => ({ relPath: rel, name: rel, title }) as WikiListing;
  test("+ N more threads, then three shared-context links and +N", () => {
    const html = threadGroupEndHtml("group:series:alpha", 2, [p("a.md", "A"), p("b.md", "B"), p("c.md", "C"), p("d.md", "D <d>")], (r) => `/wiki?relPath=${r}`);
    expect(html).toContain(`<button type="button" class="wiki-thread-more" data-thread-more="group:series:alpha">+ 2 more threads</button>`);
    expect(html).toContain(`Shared context:</span> <a class="wiki-thread-link"`);
    expect((html.match(/wiki-thread-link/g) ?? []).length).toBe(3);
    expect(html).toContain(`title="D &lt;d&gt;">+1</span>`);
    expect(html.endsWith("</div></div>")).toBe(true);
  });
  test("nothing hidden and no context: only the body's close", () => {
    expect(threadGroupEndHtml("g", 0, [], (r) => r)).toBe("</div>");
  });
});

describe("the Group control and menu", () => {
  test("the button names the drawn stop and says when it fell back", () => {
    expect(workSectionHeaderHtml("Work threads", control(), false, false)).toContain(`aria-expanded="false" aria-controls="wikiWorkMenu" title="Choose how work threads are grouped">Related <span aria-hidden="true">▾</span>`);
    const fell = workSectionHeaderHtml(
      "Work threads",
      control({ stop: "threads", evidenceApplies: false, stops: [{ stop: "threads", available: true, reasons: [], cards: 17 }, { stop: "related", available: false, reasons: ["relations-cap"], cards: 0 }] }),
      true,
      true,
    );
    expect(fell).toContain("Related is unavailable (the relation lists hit their limit), so this shows Threads. Your choice is kept.");
    expect(fell).toContain(`>Threads ! <span aria-hidden="true">▾</span>`);
    expect(fell).toContain("this tab only");
  });

  test("the menu: the chosen stop checked with counts, the boxes with their values", () => {
    const html = workGroupMenuHtml(control(), false);
    expect(html).toContain(`role="menu"`);
    expect(html).toContain(`data-work-stop="related" aria-checked="true"`);
    expect(html).toContain(`data-work-stop="threads" aria-checked="false"`);
    expect(html).toContain(`<span class="wiki-work-n">17</span>`);
    expect(html).toContain(`data-work-evidence="related" aria-checked="false">`);
    expect(html).toContain(`data-work-evidence="series" aria-checked="true">`);
    expect(html).not.toContain("aria-disabled");
  });

  test("at Threads the boxes show disabled and keep their values", () => {
    const html = workGroupMenuHtml(control({ requested: "threads", stop: "threads", evidenceApplies: false }), false);
    expect(html).toContain(`data-work-evidence="related" aria-checked="false" aria-disabled="true"`);
    expect(html).toContain(`data-work-evidence="series" aria-checked="true" aria-disabled="true"`);
    expect(html).toContain("Applies to Related and Areas.");
  });

  test("an unknown reason is named, never undefined", () => {
    expect(workReasonLabel("relations-cap")).toBe("the relation lists hit their limit");
    expect(workReasonLabel("brand-new")).toBe("unknown reason (brand-new)");
    const html = workGroupMenuHtml(control({ stops: [{ stop: "areas", available: false, reasons: ["brand-new"], cards: 0 }] }), false);
    expect(html).toContain("Unavailable: unknown reason (brand-new)");
    expect(html).not.toContain("undefined");
  });
});
