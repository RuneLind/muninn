/**
 * The Pick up strip and the cards' age chip (plan `muninn-wiki-pick-up`,
 * PR 3): the strip's rows (focus rows only, newest first, one per family,
 * the cut and outside-the-threads fallbacks, facets and the query), each
 * row's target and the jump's steps, the age chip on a whole card, a group,
 * a remainder, a split page and a cut thread, and the strip in `buildRail`
 * (pointers, not rows). Synthetic threads only.
 */

import { describe, expect, test } from "bun:test";
import { openWorkCards, railInputFor, type RailWikiFacts, type RailViewer } from "./wiki-rail-input.ts";
import { buildRail, isRailGroupCard, SECTION_PICKUP_FOLD_KEY, type RailGroupCard, type RailThreadCard, type RailWorkCard } from "./wiki-recents.ts";
import { pickUpMetaLine, pickUpRows, pickUpStep, pickUpTarget, workAgeSource, workCardAgeMs } from "./wiki-pick-up.ts";
import { DEFAULT_ACTIVITY_WEIGHTS } from "./wiki-activity-rank.ts";
import { pickUpStripHtml } from "./wiki-thread-view.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { WorkGroupEvidenceToggles, WorkGroupSplit } from "./wiki-work-group-prefs.ts";
import { WORK_EVIDENCE_VERSION, WORK_FOCUS_EVENTS_MAX, type IndexWork, type WorkContribution, type WorkEvent, type WorkThread } from "../../../wiki/work-focus.ts";

const NOW = Date.UTC(2026, 9, 24, 7, 5);
const H = 3_600_000;
const DAY = 24 * H;
const ALL: WorkGroupEvidenceToggles = { series: true, related: true, issue: true };
const INERT: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };

/** A page whose page-level work is the focus events given (`[hours ago, edits]`). */
function page(relPath: string, s: { focus?: [number, number][]; state?: "F" | "T"; series?: string; parent?: string; type?: string } = {}): WikiListing {
  const events: WorkEvent[] = (s.focus ?? []).map(([ago, edits]) => [NOW - ago * H, edits, "focus"]);
  const state = s.state ?? (events.length ? "F" : "T");
  return {
    relPath,
    name: relPath,
    title: `T ${relPath}`,
    type: s.type ?? "plan",
    domain: "ai",
    tags: [],
    aliases: [],
    linkCount: 0,
    backlinkCount: 0,
    gitCreatedMs: NOW - 40 * DAY,
    ...(s.series ? { series: s.series } : {}),
    ...(s.parent ? { parent: s.parent, pairedBy: "stem" } : {}),
    work: {
      sinceMs: NOW - 8 * DAY,
      state,
      ...(state === "F" ? { focusMs: Math.max(...events.map((e) => e[0])) } : {}),
      events: state === "F" ? events : [[NOW - 30 * H, 1, "touch"]],
    },
  } as WikiListing;
}
const sess = (id: string, ago: number) => ({ id, provider: "claude", first: NOW - (ago + 1) * H, last: NOW - ago * H, title: `title ${id}` });
const row = (id: string, p: string, t: string, ago: number, edits: number, kind: "focus" | "touch" = "focus"): WorkContribution => [
  `claude-code:${id}`,
  p,
  t,
  kind,
  edits,
  NOW - (ago + 1) * H,
  NOW - ago * H,
];

/**
 * By recency of focus: k (1h, a 4th alpha child, behind `+ 1 more`), h (2h,
 * a lone thread past the five-card cap), z (3h, a focus page in no shipped
 * thread, with its `.html` attachment), a (4h, two sessions; `a.html` is its
 * attachment), b (6h; its second session TOUCHED b.md at 0.5h and ctx.md at
 * 0.25h), c (7h, a cut thread), then d (two pages, d2 focused by its second
 * session, which also touched d.md at 2.5h), e, f, g.
 *
 * Cards at Related (by work score): the alpha SERIES group (a, b, c, k),
 * then d, e, f, g; h is sixth.
 */
function fixture(o: { truncated?: boolean } = {}) {
  const pages = [
    page("plans/a.md", { focus: [[4, 40], [5, 40]], series: "alpha" }),
    page("plans/a.html", { focus: [[4, 1]], parent: "plans/a.md", type: "explainer" }),
    page("plans/b.md", { focus: [[6, 60]], series: "alpha" }),
    page("plans/c.md", { focus: [[7, 50]], series: "alpha" }),
    page("plans/k.md", { focus: [[1, 30]], series: "alpha" }),
    page("notes/d.md", { focus: [[8, 40]], type: "note" }),
    page("notes/d2.md", { focus: [[8.5, 4]], type: "note" }),
    page("plans/e.md", { focus: [[9, 30]] }),
    page("plans/f.md", { focus: [[10, 20]] }),
    page("plans/g.md", { focus: [[11, 10]] }),
    page("plans/h.md", { focus: [[2, 5]] }),
    page("plans/z.md", { focus: [[3, 2]] }),
    page("plans/z.html", { focus: [[3, 1]], parent: "plans/z.md", type: "explainer" }),
    page("plans/ctx.md", { state: "T" }),
  ];
  const t = (key: string, ps: string[], sessions: ReturnType<typeof sess>[]): WorkThread => ({ key, pages: ps, touched: [], sessions });
  const threads = [
    t("plans/a.md", ["plans/a.md"], [sess("sa2", 4), sess("sa1", 5)]),
    t("plans/b.md", ["plans/b.md"], [sess("sb2", 0.25), sess("sb1", 6)]),
    t("plans/c.md", ["plans/c.md"], [sess("sc", 7)]),
    t("plans/k.md", ["plans/k.md"], [sess("sk", 1)]),
    t("notes/d.md", ["notes/d.md", "notes/d2.md"], [sess("sd2", 2.5), sess("sd1", 8)]),
    t("plans/e.md", ["plans/e.md"], [sess("se", 9)]),
    t("plans/f.md", ["plans/f.md"], [sess("sf", 10)]),
    t("plans/g.md", ["plans/g.md"], [sess("sg", 11)]),
    t("plans/h.md", ["plans/h.md"], [sess("sh", 2)]),
  ];
  const rows: WorkContribution[] = [
    row("sa2", "plans/a.md", "plans/a.md", 4, 2),
    row("sa1", "plans/a.md", "plans/a.md", 5, 3),
    row("sb2", "plans/b.md", "plans/b.md", 0.5, 1, "touch"),
    row("sb2", "plans/ctx.md", "plans/b.md", 0.25, 1, "touch"),
    row("sb1", "plans/b.md", "plans/b.md", 6, 4),
    // c's rows are cut.
    row("sk", "plans/k.md", "plans/k.md", 1, 6),
    row("sd2", "notes/d.md", "notes/d.md", 2.5, 1, "touch"),
    row("sd2", "notes/d2.md", "notes/d.md", 8.5, 4),
    row("sd1", "notes/d.md", "notes/d.md", 8, 5),
    row("se", "plans/e.md", "plans/e.md", 9, 3),
    row("sf", "plans/f.md", "plans/f.md", 10, 3),
    row("sg", "plans/g.md", "plans/g.md", 11, 3),
    row("sh", "plans/h.md", "plans/h.md", 2, 3),
  ];
  const reasons = [...(o.truncated ? ["ledger-truncated" as const] : []), "contributions-cap" as const];
  const work: IndexWork = {
    asOfMs: NOW - 0.1 * H,
    sinceMs: NOW - 8 * DAY,
    threads,
    evidence: {
      version: WORK_EVIDENCE_VERSION,
      threads: { candidates: threads.length + 1, shipped: threads.length },
      relations: { complete: true, reasons: [], series: { "plans/a.md": "alpha", "plans/b.md": "alpha", "plans/c.md": "alpha", "plans/k.md": "alpha" }, projects: {}, related: [], issues: [], ambiguousIssues: [], relatedSkipped: { skipped: 0, ambiguous: 0 } },
      contributions: { complete: false, reasons, cut: ["plans/c.md"], rows },
    },
  };
  return { pages, work };
}

const cardsAt = (fx: ReturnType<typeof fixture>, o: { folds?: string[]; more?: string[]; splits?: WorkGroupSplit[]; filters?: WikiFilters } = {}) =>
  openWorkCards(fx.work, fx.pages, o.filters ?? INERT, o.folds ?? [], null, NOW, fx.pages, { stop: "related", evidence: ALL, moreOpen: o.more, splits: o.splits ?? [], keptApart: [] }).cards;
const thread = (cards: readonly RailWorkCard[], key: string): RailThreadCard => {
  for (const c of cards) {
    if (!isRailGroupCard(c)) {
      if (c.key === key) return c;
      continue;
    }
    const ch = [...c.children, ...(c.hiddenChildren ?? [])].find((x) => x.key === key);
    if (ch) return ch;
  }
  throw new Error(`no card ${key}`);
};
const ago = (ms: number | undefined) => (ms === undefined ? undefined : (NOW - ms) / H);

describe("the fixture draws what the cases below assume", () => {
  test("Related: the alpha group (a, b, c shown, k behind + 1 more), then d, e, f, g; h past the cap", () => {
    const cards = cardsAt(fixture());
    expect(cards.map((c) => (isRailGroupCard(c) ? `${c.foldKey} [${c.children.map((x) => x.key)}] +${c.hidden}` : c.key))).toEqual([
      "group:series:alpha [plans/a.md,plans/b.md,plans/c.md] +1",
      "notes/d.md",
      "plans/e.md",
      "plans/f.md",
      "plans/g.md",
    ]);
    expect((cards[0] as RailGroupCard).hiddenChildren!.map((c) => c.key)).toEqual(["plans/k.md"]);
  });
});

describe("the age chip (D5)", () => {
  test("a whole card: the newest row, focus or touch, of its sessions on its focus pages", () => {
    const cards = cardsAt(fixture());
    // b: sb2's touch on b.md (0.5h), not sb2's newer touch on ctx.md (0.25h),
    // which is not a focus page of b.
    expect(ago(thread(cards, "plans/b.md").ageMs)).toBe(0.5);
    // d: sd2's touch on d.md (2.5h) beats both focus rows.
    expect(ago(thread(cards, "notes/d.md").ageMs)).toBe(2.5);
    expect(ago(thread(cards, "plans/e.md").ageMs)).toBe(9);
  });
  test("a group: its newest child's, a child behind + N more included", () => {
    const cards = cardsAt(fixture());
    expect(ago((cards[0] as RailGroupCard).ageMs)).toBe(0.5);
    // Without b's touch the newest child is k, which is behind `+ 1 more`.
    const fx = fixture();
    fx.work.evidence!.contributions.rows = fx.work.evidence!.contributions.rows.filter((r) => r[0] !== "claude-code:sb2");
    fx.work.threads[1]!.sessions = [sess("sb1", 6)];
    expect(ago((cardsAt(fx)[0] as RailGroupCard).ageMs)).toBe(1);
  });
  test("a split page and its remainder: each its own sessions on its own pages", () => {
    const split = cardsAt(fixture(), { splits: [{ id: "x1", page: "notes/d2.md" }] });
    // The split page's card holds sd2, whose focus row on d2 is 8.5h old.
    expect(ago(thread(split, "notes/d2.md").ageMs)).toBe(8.5);
    // The remainder holds sd1 only, so sd2's 2.5h touch on d.md is not its.
    expect(ago(thread(split, "notes/d.md").ageMs)).toBe(8);
  });
  test("a remainder card reads its derived pages, not the server thread's: its session's newer row on the split page is not its", () => {
    const fx = fixture();
    // sd1, the remainder's session, also touched d2 (the split page) at 7h,
    // newer than its 8h focus row on d.md.
    fx.work.evidence!.contributions.rows.push(row("sd1", "notes/d2.md", "notes/d.md", 7, 1, "touch"));
    const split = cardsAt(fx, { splits: [{ id: "x1", page: "notes/d2.md" }] });
    expect(ago(thread(split, "notes/d.md").ageMs)).toBe(8);
    // Unsplit, the same row is the whole card's (d2 is its focus page), but
    // sd2's 2.5h touch on d.md is newer still.
    expect(ago(thread(cardsAt(fx), "notes/d.md").ageMs)).toBe(2.5);
  });
  test("a cut thread falls back to the newest page-level focus time of its pages", () => {
    const cards = cardsAt(fixture());
    expect(ago(thread(cards, "plans/c.md").ageMs)).toBe(7);
    const src = workAgeSource(fixture().work, fixture().pages);
    expect(ago(workCardAgeMs(src, ["plans/c.md"], [sess("sc", 7)], ["plans/c.md"]))).toBe(7);
    // Rows come first: a newer page-level time (another thread's session
    // focusing the page, a hub) never replaces the card's own rows.
    const hub = fixture();
    hub.pages.find((p) => p.relPath === "plans/e.md")!.work!.focusMs = NOW - 0.1 * H;
    expect(ago(workCardAgeMs(workAgeSource(hub.work, hub.pages), ["plans/e.md"], [sess("se", 9)], ["plans/e.md"]))).toBe(9);
    // No readable block at all: the same fallback.
    const fx = fixture();
    delete fx.work.evidence;
    expect(ago(workCardAgeMs(workAgeSource(fx.work, fx.pages), ["plans/b.md"], [sess("sb2", 0.25)], ["plans/b.md"]))).toBe(6);
  });
  test("a multi-page cut thread falls back to the NEWEST page-level focus time across its pages", () => {
    // c's thread, cut, also holds e (9h) and k (1h): the newest is k's, in
    // either page order.
    const fx = fixture();
    const src = workAgeSource(fx.work, fx.pages);
    const s = [sess("sc", 7)];
    expect(ago(workCardAgeMs(src, ["plans/c.md"], s, ["plans/c.md", "plans/k.md", "plans/e.md"]))).toBe(1);
    expect(ago(workCardAgeMs(src, ["plans/c.md"], s, ["plans/k.md", "plans/c.md", "plans/e.md"]))).toBe(1);
    // Through the rail: the cut thread drawn with two pages.
    fx.work.threads[2]!.pages = ["plans/c.md", "plans/e.md"];
    fx.work.threads = fx.work.threads.filter((t) => t.key !== "plans/e.md");
    fx.pages.find((p) => p.relPath === "plans/e.md")!.work!.focusMs = NOW - 0.75 * H;
    expect(ago(thread(cardsAt(fx), "plans/c.md").ageMs)).toBe(0.75);
  });
  test("the Threads stop and a Sessions-stop card carry one too", () => {
    const fx = fixture();
    const threads = openWorkCards(fx.work, fx.pages, INERT, [], null, NOW, fx.pages, { stop: "threads", evidence: ALL }).cards;
    expect(threads.every((c) => !isRailGroupCard(c) && c.ageMs !== undefined)).toBe(true);
    const sessions = openWorkCards(fx.work, fx.pages, INERT, [], null, NOW, fx.pages, { stop: "sessions", evidence: ALL }).cards;
    // The Sessions stop is unavailable while contributions are cut: it falls back to Threads.
    expect(sessions.every((c) => !isRailGroupCard(c) && c.ageMs !== undefined)).toBe(true);
    const whole = fixture();
    whole.work.evidence!.contributions = { complete: true, reasons: [], cut: [], rows: whole.work.evidence!.contributions.rows };
    const byS = openWorkCards(whole.work, whole.pages, INERT, [], null, NOW, whole.pages, { stop: "sessions", evidence: ALL }).cards as RailThreadCard[];
    expect(byS[0]!.session).toBeDefined();
    // sb2's card owns no focus page here (b.md's newest FOCUS session is sb1),
    // so the first card is sk's: its one row on k.md, 1h.
    expect(byS.map((c) => [c.name, ago(c.ageMs)])).toContainEqual(["title sk", 1]);
  });
  test("a Sessions-stop card that owns no focus page still carries one: its session's newest row on its owned and `also in:` pages", () => {
    const whole = fixture();
    whole.work.evidence!.contributions = { complete: true, reasons: [], cut: [], rows: whole.work.evidence!.contributions.rows };
    const cards = openWorkCards(whole.work, whole.pages, INERT, [], null, NOW, whole.pages, { stop: "sessions", evidence: ALL }).cards as RailThreadCard[];
    const named = (n: string) => cards.find((c) => c.name === n);
    // sa2 and sa1 both focus a.md: the newer, sa2, owns it; sa1 links it on `also in:`.
    const sa1 = named("title sa1")!;
    expect([sa1.focus.length, sa1.alsoIn?.map((p) => p.relPath)]).toEqual([0, ["plans/a.md"]]);
    expect(ago(sa1.ageMs)).toBe(5);
    expect(ago(named("title sa2")!.ageMs)).toBe(4);
    // A touched page does not count (D5: focus pages only): sd2 owns d2 (its
    // focus row 8.5h) and only touched d.md at 2.5h.
    const sd2 = named("title sd2")!;
    expect(sd2.touched.map((p) => p.relPath)).toContain("notes/d.md");
    expect(ago(sd2.ageMs)).toBe(8.5);
    // The Threads stop agrees for the same session and pages: d2 split into
    // its own thread holds sd2 alone.
    const split = openWorkCards(whole.work, whole.pages, INERT, [], null, NOW, whole.pages, { stop: "threads", evidence: ALL, splits: [{ id: "x1", page: "notes/d2.md" }], keptApart: [] }).cards;
    const d2 = thread(split, "notes/d2.md");
    expect(d2.sessions.map((s) => s.id)).toEqual(["sd2"]);
    expect(d2.focus.map((p) => p.relPath)).toEqual(["notes/d2.md"]);
    expect(sd2.ageMs).toBe(d2.ageMs!);
    expect(cards.every((c) => c.ageMs !== undefined)).toBe(true);
  });
  test("a Sessions-stop card's chip reads its session's unfiltered pages: a facet that hides one does not move it", () => {
    const whole = fixture();
    // sk also focuses d2 at 0.5h, newer than sd2's 8.5h row, so sk owns d2 too.
    whole.work.evidence!.contributions = { complete: true, reasons: [], cut: [], rows: [...whole.work.evidence!.contributions.rows, row("sk", "notes/d2.md", "plans/k.md", 0.5, 2)] };
    const at = (filters: WikiFilters) =>
      (openWorkCards(whole.work, whole.pages, filters, [], null, NOW, whole.pages, { stop: "sessions", evidence: ALL }).cards as RailThreadCard[]).find((c) => c.name === "title sk")!;
    const all = at(INERT);
    expect(all.focus.map((p) => p.relPath).sort()).toEqual(["notes/d2.md", "plans/k.md"]);
    expect(ago(all.ageMs)).toBe(0.5);
    // Under `plans`, d2 is not drawn, yet the chip still reads its 0.5h row.
    const plans = at({ ...INERT, folder: "plans" });
    expect(plans.focus.map((p) => p.relPath)).toEqual(["plans/k.md"]);
    expect(ago(plans.ageMs)).toBe(0.5);
  });
});

describe("the strip's rows (D2, D11, D12)", () => {
  test("five rows, newest focus first; a touch never counts, a family is one row", () => {
    const fx = fixture();
    const cards = cardsAt(fx);
    const rows = pickUpRows(fx.work, fx.pages, fx.pages, INERT, cards);
    expect(rows.map((r) => [r.page.relPath, ago(r.atMs), r.source])).toEqual([
      ["plans/k.md", 1, "rows"],
      ["plans/h.md", 2, "rows"],
      // In no shipped thread: the page-level time; its .html is the same row.
      ["plans/z.md", 3, "page"],
      ["plans/a.md", 4, "rows"],
      // b's 0.5h touch is not its time: its newest FOCUS row is.
      ["plans/b.md", 6, "rows"],
    ]);
    const a = rows[3]!;
    expect([a.edits, a.sessions, a.low]).toEqual([5, 2, false]);
    expect(rows.some((r) => r.page.relPath.endsWith(".html") || r.page.relPath === "plans/ctx.md")).toBe(false);
  });
  test("two rows at the same instant order by path, whatever order they were collected in", () => {
    const fx = fixture();
    // h's focus row moves to k's instant (1h); k's rows come first in the block.
    const rows = fx.work.evidence!.contributions.rows;
    rows[rows.findIndex((r) => r[0] === "claude-code:sh")] = row("sh", "plans/h.md", "plans/h.md", 1, 3);
    expect(pickUpRows(fx.work, fx.pages, fx.pages, INERT, cardsAt(fx)).slice(0, 2).map((r) => r.page.relPath)).toEqual(["plans/h.md", "plans/k.md"]);
    // Reversed collection order: the same answer.
    fx.work.evidence!.contributions.rows = [...rows].reverse();
    expect(pickUpRows(fx.work, fx.pages, fx.pages, INERT, cardsAt(fx)).slice(0, 2).map((r) => r.page.relPath)).toEqual(["plans/h.md", "plans/k.md"]);
  });
  test("a cut thread's page falls back to its page-level focus time", () => {
    const fx = fixture();
    const rows = pickUpRows(fx.work, fx.pages, fx.pages.filter((p) => !["plans/k.md", "plans/h.md"].includes(p.relPath)), INERT, cardsAt(fx));
    const c = rows.find((r) => r.page.relPath === "plans/c.md")!;
    expect([ago(c.atMs), c.source, c.edits, c.sessions]).toEqual([7, "page", 50, 1]);
  });
  test("each row points at the drawn card holding its page, or at none (D12)", () => {
    const fx = fixture();
    const cards = cardsAt(fx);
    const rows = pickUpRows(fx.work, fx.pages, fx.pages, INERT, cards);
    const to = (rel: string) => rows.find((r) => r.page.relPath === rel)!.target;
    expect(to("plans/k.md")).toEqual({
      card: { foldKey: "thread:plans/k.md", toggleKey: "thread:plans/k.md", open: false, name: "T plans/k.md" },
      group: { foldKey: "group:series:alpha", toggleKey: "closed:group:series:alpha", open: true, name: "alpha" },
      more: true,
    });
    expect(to("plans/a.md")).toMatchObject({ card: { foldKey: "thread:plans/a.md", open: true }, group: { foldKey: "group:series:alpha" } });
    expect(to("plans/a.md")!.more).toBeUndefined();
    // Past the five-card cap, and in no thread: no card.
    expect(to("plans/h.md")).toBeNull();
    expect(to("plans/z.md")).toBeNull();
    expect(pickUpMetaLine(rows[0]!)).toBe("6 edits · 1 session · in T plans/k.md");
    expect(pickUpMetaLine(rows[1]!)).toBe("3 edits · 1 session · not in Work threads");
  });
  test("line 2 counts whole edits: weighted edits round, `1 edit` is singular, the `+` stays", () => {
    const base = pickUpRows(fixture().work, fixture().pages, fixture().pages, INERT, cardsAt(fixture()))[1]!;
    const meta = (edits: number, low = false) => pickUpMetaLine({ ...base, edits, low });
    // An attachment's edits count at half weight, so a page's total can be fractional.
    expect(meta(36.5)).toBe("37 edits · 1 session · not in Work threads");
    expect(meta(6.5, true)).toBe("7+ edits · 1+ sessions · not in Work threads");
    expect(meta(6.4)).toBe("6 edits · 1 session · not in Work threads");
    expect(meta(1)).toBe("1 edit · 1 session · not in Work threads");
    expect(meta(0.5)).toBe("1 edit · 1 session · not in Work threads");
    expect(meta(1, true)).toBe("1+ edits · 1+ sessions · not in Work threads");
  });
  test("a row no drawn card holds says the page opens; the cards are below the strip, not above", () => {
    const fx = fixture();
    const html = pickUpStripHtml(pickUpRows(fx.work, fx.pages, fx.pages, INERT, cardsAt(fx)), NOW);
    expect(html).toContain(`\nOpen the page: no Work threads card draws it"`);
    expect(html).not.toContain("above");
  });
  test("a truncated ledger answer keeps the times and marks the counts as possibly low", () => {
    const fx = fixture({ truncated: true });
    const rows = pickUpRows(fx.work, fx.pages, fx.pages, INERT, cardsAt(fx));
    expect(rows.map((r) => ago(r.atMs))).toEqual([1, 2, 3, 4, 6]);
    expect(rows.filter((r) => r.source === "rows").every((r) => r.low)).toBe(true);
    expect(pickUpMetaLine(rows[0]!)).toBe("6+ edits · 1+ sessions · in T plans/k.md");
    // The page-level fallback too: a page in no thread (z) and a cut thread's (c).
    expect(rows.every((r) => r.low)).toBe(true);
    expect(rows.find((r) => r.page.relPath === "plans/z.md")!.source).toBe("page");
    expect(pickUpMetaLine(rows.find((r) => r.page.relPath === "plans/z.md")!)).toBe("2+ edits · 1+ sessions · not in Work threads");
    const cut = pickUpRows(fx.work, fx.pages, fx.pages.filter((p) => !["plans/k.md", "plans/h.md"].includes(p.relPath)), INERT, cardsAt(fx));
    const c = cut.find((r) => r.page.relPath === "plans/c.md")!;
    expect([c.source, c.low]).toEqual(["page", true]);
  });
  test("a low row's hover says the counts may be low; an exact row's does not", () => {
    const low = fixture({ truncated: true });
    const html = pickUpStripHtml(pickUpRows(low.work, low.pages, low.pages, INERT, cardsAt(low)), NOW);
    expect(html).toContain(`\n6+ edits · 1+ sessions · in T plans/k.md (counts may be low)\nShow it in`);
    const fx = fixture();
    expect(pickUpStripHtml(pickUpRows(fx.work, fx.pages, fx.pages, INERT, cardsAt(fx)), NOW)).not.toContain("counts may be low");
  });
  test("untruncated, a page-level row is low only when it holds the full WORK_FOCUS_EVENTS_MAX focus events", () => {
    const fx = fixture();
    const z = fx.pages.find((p) => p.relPath === "plans/z.md")!;
    const at = (n: number) => {
      z.work!.events = Array.from({ length: n }, (_, i) => [NOW - (3 + i) * H, 1, "focus"] as WorkEvent);
      return pickUpRows(fx.work, fx.pages, fx.pages, INERT, cardsAt(fx)).find((r) => r.page.relPath === "plans/z.md")!;
    };
    expect([at(WORK_FOCUS_EVENTS_MAX - 1).source, at(WORK_FOCUS_EVENTS_MAX - 1).low]).toEqual(["page", false]);
    expect(at(WORK_FOCUS_EVENTS_MAX).low).toBe(true);
  });
  test("the same pool and facets as the cards; none while a query is active", () => {
    const fx = fixture();
    const notes = { ...INERT, folder: "notes" };
    expect(pickUpRows(fx.work, fx.pages, fx.pages, notes, cardsAt(fx, { filters: notes })).map((r) => r.page.relPath)).toEqual(["notes/d.md", "notes/d2.md"]);
    expect(pickUpRows(fx.work, fx.pages, fx.pages, { ...INERT, q: "plan" }, cardsAt(fx))).toEqual([]);
    expect(pickUpRows(null, fx.pages, fx.pages, INERT, [])).toEqual([]);
  });
  test("no readable evidence: every row is the page-level fallback", () => {
    const fx = fixture();
    delete fx.work.evidence;
    const rows = pickUpRows(fx.work, fx.pages, fx.pages, INERT, []);
    expect(rows.map((r) => [r.page.relPath, ago(r.atMs), r.source])).toEqual([
      ["plans/k.md", 1, "page"],
      ["plans/h.md", 2, "page"],
      ["plans/z.md", 3, "page"],
      ["plans/a.md", 4, "page"],
      ["plans/b.md", 6, "page"],
    ]);
    expect([rows[3]!.edits, rows[3]!.sessions]).toEqual([80, 2]);
  });
});

describe("the jump's steps", () => {
  test("a child behind + N more: press it, then open the child, then drawn", () => {
    const fx = fixture();
    expect(pickUpStep(cardsAt(fx), "plans/k.md")).toEqual({ kind: "open", toggle: [], more: "group:series:alpha" });
    const more = ["group:series:alpha"];
    expect(pickUpStep(cardsAt(fx, { more }), "plans/k.md")).toEqual({ kind: "open", toggle: ["thread:plans/k.md"] });
    expect(pickUpStep(cardsAt(fx, { more, folds: ["thread:plans/k.md"] }), "plans/k.md")).toEqual({ kind: "drawn" });
  });
  test("a closed group opens with its child; a closed lone card opens; past the cap opens the page", () => {
    const fx = fixture();
    expect(pickUpStep(cardsAt(fx, { folds: ["closed:group:series:alpha"] }), "plans/b.md")).toEqual({
      kind: "open",
      toggle: ["closed:group:series:alpha", "thread:plans/b.md"],
    });
    expect(pickUpStep(cardsAt(fx), "plans/a.md")).toEqual({ kind: "drawn" });
    expect(pickUpStep(cardsAt(fx), "notes/d2.md")).toEqual({ kind: "open", toggle: ["thread:notes/d.md"] });
    expect(pickUpStep(cardsAt(fx), "plans/h.md")).toEqual({ kind: "page" });
    expect(pickUpTarget([], "plans/a.md")).toBeNull();
  });
});

describe("the strip in buildRail: pointers, not rows", () => {
  const facts = (fx: ReturnType<typeof fixture>): RailWikiFacts => ({
    allPages: fx.pages,
    projects: {},
    activityWeights: DEFAULT_ACTIVITY_WEIGHTS,
    workedGate: null,
    work: fx.work,
  });
  const viewer = (over: Partial<RailViewer> = {}): RailViewer => ({
    mode: "updated",
    now: NOW,
    filters: INERT,
    showRetired: false,
    familiesOn: false,
    pins: [],
    openFolds: [],
    workGroup: { stop: "related", evidence: ALL },
    ...over,
  });
  test("above Work threads, open by default through the closed: spelling; it claims nothing and counts nothing", () => {
    const fx = fixture();
    const input = railInputFor(facts(fx), viewer());
    expect(input.pickUp!.map((r) => r.page.relPath)).toEqual(["plans/k.md", "plans/h.md", "plans/z.md", "plans/a.md", "plans/b.md"]);
    const rail = buildRail(input);
    const first = rail.entries.findIndex((e) => e.section === "threads");
    expect(rail.entries.slice(0, 2).map((e) => e.kind)).toEqual(["header", "pickup"]);
    expect(rail.entries[0]).toMatchObject({ section: "pickup", label: "Pick up", foldKey: SECTION_PICKUP_FOLD_KEY, toggleKey: `closed:${SECTION_PICKUP_FOLD_KEY}`, folded: false, count: 5 });
    expect(first).toBe(2);
    // Every page still has exactly one row, and the strip adds none.
    const without = buildRail({ ...input, pickUp: [] });
    expect(rail.shown).toBe(without.shown);
    const rels = rail.entries.flatMap((e) => (e.kind === "row" ? [e.page.relPath] : []));
    expect(rels).toEqual(without.entries.flatMap((e) => (e.kind === "row" ? [e.page.relPath] : [])));
    expect(new Set(rels).size).toBe(rels.length);
  });
  test("folded: the header keeps its count and draws no rows; a query draws no strip", () => {
    const fx = fixture();
    const folded = buildRail(railInputFor(facts(fx), viewer({ openFolds: [`closed:${SECTION_PICKUP_FOLD_KEY}`] })));
    expect(folded.entries[0]).toMatchObject({ section: "pickup", folded: true, count: 5 });
    expect(folded.entries.some((e) => e.kind === "pickup")).toBe(false);
    const q = buildRail(railInputFor(facts(fx), viewer({ filters: { ...INERT, q: "plans" } })));
    expect(q.entries.some((e) => e.section === "pickup")).toBe(false);
  });
});
