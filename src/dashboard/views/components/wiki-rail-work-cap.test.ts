/**
 * The five-card cap's rule (plan `muninn-wiki-work-thread-grouping`, D20) as
 * properties over seeded synthetic scenarios (`wiki-rail-work-cap-gen.ts`):
 * random threads, pages, hubs, evidence, splits, kept-apart anchors, pins and
 * a facet, each at Threads, Related and Areas.
 *
 *  (i)   The cards break down into BASE cards — the cards the stop draws with
 *        no manual boundary — exactly the boundary-free top five, in order,
 *        each base card's pieces contiguous and holding exactly its pages; a
 *        drawn pinned piece is the first card.
 *  (ii)  Any one boundary click on what is drawn (Make own thread or Return on
 *        a focus row, Keep separate or Allow grouping on a card) leaves the
 *        set of focus pages the section draws unchanged.
 *  (iii) No page is drawn twice.
 *  (iv)  With no boundaries, the cards are origin/main's (97faaeec) byte for
 *        byte, PR 4's boundary fields aside: `wiki-rail-work-cap.fixture.json`
 *        holds that build's digests (`scripts/wiki-work-cap-freeze.ts`).
 *
 * The 5,100-case run reads the cap's two placement functions, every click on
 * every case; a 900-case run reads `openWorkCards` itself, one click a case.
 */

import { describe, expect, test } from "bun:test";
import { groupCardPieces, openThreadCards, openWorkCards, threadCardPieces, workBoundariesOf } from "./wiki-rail-input.ts";
import { isRailGroupCard, normalizeFoldKey, THREAD_CARDS_MAX, type RailThreadCard, type RailWorkCard } from "./wiki-recents.ts";
import { rowBoundaryAction, type WorkBoundaries } from "./wiki-work-boundaries.ts";
import { groupWorkThreads } from "./wiki-work-groups.ts";
import type { WorkGroupSplit } from "./wiki-work-group-prefs.ts";
import { CAP_FIXTURE_SCENARIOS, CAP_FIXTURE_START, CAP_NOW, CAP_STOPS, CapRandom, capCardsDigest, nextCapScenario, type CapScenario } from "./wiki-rail-work-cap-gen.ts";
import fixture from "./wiki-rail-work-cap.fixture.json";

type Stop = (typeof CAP_STOPS)[number];
interface Bounds {
  splits: WorkGroupSplit[];
  keptApart: string[];
}
/** One drawn card as the properties read it. */
interface Piece {
  pages: string[];
  pinned: boolean;
  /** Its thread cards: key, rows, and the card ⋯ `openWorkCards` gives it. */
  threads: { key: string; rows: string[]; menu?: { keep: string } | { allow: string[] } }[];
}
interface Click {
  label: string;
  page?: string;
  after: Bounds;
}

const NONE: Bounds = { splits: [], keptApart: [] };
const sorted = (xs: Iterable<string>) => [...xs].sort();
const boundsOf = (s: CapScenario, b: Bounds) => workBoundariesOf(s.world.work, s.world.pages, b);

const baseMemo = new WeakMap<CapScenario, Map<Stop, ReturnType<typeof groupWorkThreads>>>();

/** The cap's placement at `stop`: one list of drawn pieces per base card. */
function place(s: CapScenario, stop: Stop, b: Bounds): Piece[][] {
  const { work, pages } = s.world;
  const bounds = boundsOf(s, b);
  if (stop === "threads") {
    return threadCardPieces(work.threads, pages, s.filters, s.pin, CAP_NOW, pages, work.asOfMs, THREAD_CARDS_MAX, bounds).map((block) =>
      block.map((c) => {
        const rows = c.focus.map((p) => p.relPath);
        return { pages: rows, pinned: c.pinned, threads: [{ key: c.key, rows }] };
      }),
    );
  }
  // The base grouping reads no boundary: one per scenario and stop.
  const memo = baseMemo.get(s) ?? baseMemo.set(s, new Map()).get(s)!;
  const base =
    memo.get(stop) ??
    memo.set(stop, groupWorkThreads({ work, allPages: pages, now: CAP_NOW, stop, toggles: s.evidence[CAP_STOPS.indexOf(stop)]!, pin: s.pin })).get(stop)!;
  return groupCardPieces(base, work, pages, s.filters, s.pin, CAP_NOW, pages, bounds, THREAD_CARDS_MAX).map((block) =>
    block.map((v) => {
      const threads = v.children.map((cv) => {
        const u = cv.child.unit;
        const rows = cv.focus.map((p) => p.relPath);
        // `openWorkCards`' card ⋯ rule (`decorate`): Return on a split, Allow on a kept-apart thread, else Keep.
        return { key: u.key, rows, ...(u.split ? {} : { menu: u.keptApart ? { allow: u.keptApart } : { keep: cv.child.pinAnchor } }) };
      });
      return { pages: threads.flatMap((t) => t.rows), pinned: v.children.some((cv) => cv.child.pinned), threads };
    }),
  );
}

/** Every click the drawn pieces offer, each as the boundaries after it. */
function clicksOn(s: CapScenario, bounds: WorkBoundaries, threads: Piece["threads"], b: Bounds): Click[] {
  const out: Click[] = [];
  for (const t of threads) {
    for (const page of t.rows) {
      const a = rowBoundaryAction(bounds, s.world.work, page);
      if (a?.kind === "split" && a.available) out.push({ label: `make own thread ${page}`, page, after: { ...b, splits: [...b.splits, { id: "click", page }] } });
      if (a?.kind === "return") out.push({ label: `return ${page}`, page, after: { ...b, splits: b.splits.filter((x) => x.id !== a.id) } });
    }
    const m = t.menu;
    if (m && "keep" in m) out.push({ label: `keep separate ${t.key}`, after: { ...b, keptApart: [...b.keptApart, m.keep] } });
    if (m && "allow" in m) out.push({ label: `allow grouping ${t.key}`, after: { ...b, keptApart: b.keptApart.filter((k) => !m.allow.includes(k)) } });
  }
  return out;
}

/** (i) and (iii) over drawn pieces against the base cards; failures as text. */
function baseCardFailures(base: readonly string[][], drawn: readonly Piece[][], blocksOf: (pages: string[]) => number[]): string[] {
  const out: string[] = [];
  const pieces = drawn.flat();
  const pages = pieces.flatMap((p) => p.pages);
  if (new Set(pages).size !== pages.length) out.push("(iii) a page drawn twice");
  const seq = pieces.map((p) => blocksOf(p.pages));
  const flatSeq = seq.map((b) => (new Set(b).size === 1 ? b[0]! : -1));
  const contiguous = flatSeq.every((v, j) => v >= 0 && (j === 0 ? v === 0 : v === flatSeq[j - 1] || v === flatSeq[j - 1]! + 1)) && (base.length ? flatSeq.at(-1) === base.length - 1 : !flatSeq.length);
  if (!contiguous) out.push(`(i) the pieces are not the ${base.length} base cards in order: ${JSON.stringify(flatSeq)}`);
  if (sorted(pages).join() !== sorted(base.flat()).join()) out.push("(i) the pages drawn are not the base cards' pages");
  if (pieces.findIndex((p) => p.pinned) > 0) out.push("(i) a drawn pinned piece is not the first card");
  return out;
}

const baseIndex = (base: readonly string[][]) => {
  const at = new Map<string, number>();
  base.forEach((pages, j) => pages.forEach((p) => at.set(p, j)));
  return (pages: string[]) => pages.map((p) => at.get(p) ?? -1);
};

describe("D20: the five-card cap counts base cards", () => {
  /** One case: (i) and (iii) on the drawn pieces, then (ii) on the clicks `pick` takes. */
  function placementCase(s: CapScenario, stop: Stop, pick: (all: Click[]) => Click[], tally: { clicks: number; failures: string[] }): void {
    const fail = (m: string) => {
      if (tally.failures.length < 8) tally.failures.push(`seed ${s.seed} ${stop}: ${m}`);
    };
    const free = place(s, stop, NONE);
    // With no boundary a base card is one piece.
    if (free.some((block) => block.length !== 1)) fail("a base card broke with no boundary");
    const base = free.map((block) => block.flatMap((p) => p.pages));
    const b: Bounds = { splits: s.splits, keptApart: s.keptApart };
    const drawn = place(s, stop, b);
    for (const f of baseCardFailures(base, drawn, baseIndex(base))) fail(f);
    const before = sorted(drawn.flat().flatMap((p) => p.pages)).join();
    for (const ck of pick(clicksOn(s, boundsOf(s, b), drawn.flat().flatMap((p) => p.threads), b))) {
      tally.clicks++;
      const after = sorted(place(s, stop, ck.after).flat().flatMap((p) => p.pages)).join();
      if (after !== before) fail(`(ii) ${ck.label} changed the pages drawn${ck.page && !after.split(",").includes(ck.page) ? " and lost the clicked page" : ""}`);
    }
  }

  test("placement, 5,100 cases, up to four clicks each (one of every kind offered): (i) base cards, (ii) a click moves no page, (iii) no page twice", () => {
    const r = new CapRandom(CAP_FIXTURE_START);
    const tally = { clicks: 0, failures: [] as string[] };
    let cases = 0;
    const started = performance.now();
    for (let i = 0; i < CAP_FIXTURE_SCENARIOS; i++) {
      const s = nextCapScenario(r);
      // The case's own stream picks its clicks, so the scenarios stay the fixture's.
      const pick = new CapRandom(s.seed ^ 0x5bd1e995);
      for (const stop of CAP_STOPS) {
        cases++;
        placementCase(s, stop, (all) => {
          const kinds = new Map<string, Click>();
          for (const c of [...all].sort(() => pick.next() - 0.5)) if (!kinds.has(c.label.split(" ")[0]!)) kinds.set(c.label.split(" ")[0]!, c);
          const chosen = [...kinds.values()];
          while (chosen.length < Math.min(4, all.length)) {
            const c = all[pick.int(all.length)]!;
            if (!chosen.includes(c)) chosen.push(c);
          }
          return chosen;
        }, tally);
      }
    }
    expect(cases).toBe(5100);
    expect(tally.clicks).toBeGreaterThan(15000);
    expect(tally.failures).toEqual([]);
    // Measured 2026-10-18 on the laptop: ~2 s; the bound is for a runner.
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 60_000);

  test("placement, 450 cases, every click", () => {
    const r = new CapRandom(CAP_FIXTURE_START);
    const tally = { clicks: 0, failures: [] as string[] };
    for (let i = 0; i < 150; i++) {
      const s = nextCapScenario(r);
      for (const stop of CAP_STOPS) placementCase(s, stop, (all) => all, tally);
    }
    expect(tally.clicks).toBeGreaterThan(8000);
    expect(tally.failures).toEqual([]);
  }, 60_000);

  test("openWorkCards, 900 cases, one click each: (i), (ii), (iii) on the drawn cards", () => {
    const r = new CapRandom(CAP_FIXTURE_START);
    const failures: string[] = [];
    let clicks = 0;
    for (let i = 0; i < 300; i++) {
      const s = nextCapScenario(r);
      const { work, pages } = s.world;
      // Every group's `+ N more threads` pressed: anchors are pages, names the generator's.
      const moreOpen = [...pages.map((p) => `group:anchor:${p.relPath}`), ...[0, 1, 2].flatMap((n) => [`group:series:ser${n}`, `group:project:proj${n}`])].map(normalizeFoldKey);
      const b: Bounds = { splits: s.splits, keptApart: s.keptApart };
      const pick = new CapRandom(s.seed);
      CAP_STOPS.forEach((stop, k) => {
        const draw = (x: Bounds) => openWorkCards(work, pages, s.filters, [], s.pin, CAP_NOW, pages, { stop, evidence: s.evidence[k]!, ...x, moreOpen }).cards;
        const asPiece = (c: RailWorkCard): Piece => {
          const ts: RailThreadCard[] = isRailGroupCard(c) ? c.children : [c];
          const threads = ts.map((t) => ({
            key: t.key,
            rows: t.focus.map((p) => p.relPath),
            ...(t.menu?.action === "keep" ? { menu: { keep: t.menu.anchor } } : t.menu?.action === "allow" ? { menu: { allow: t.menu.anchors } } : {}),
          }));
          return { pages: threads.flatMap((t) => t.rows), pinned: c.pinned, threads };
        };
        const base = draw(NONE).map((c) => asPiece(c).pages);
        const drawn = draw(b).map(asPiece);
        for (const f of baseCardFailures(base, [drawn], baseIndex(base))) if (failures.length < 8) failures.push(`seed ${s.seed} ${stop}: ${f}`);
        const options = clicksOn(s, boundsOf(s, b), drawn.flatMap((p) => p.threads), b);
        if (!options.length) return;
        clicks++;
        const ck = options[pick.int(options.length)]!;
        const before = sorted(drawn.flatMap((p) => p.pages)).join();
        const after = sorted(draw(ck.after).map(asPiece).flatMap((p) => p.pages)).join();
        if (after !== before && failures.length < 8) failures.push(`seed ${s.seed} ${stop}: (ii) ${ck.label} changed the pages drawn`);
      });
    }
    expect(clicks).toBeGreaterThan(600);
    expect(failures).toEqual([]);
  }, 60_000);

  test("(iv) no boundaries: origin/main's cards over 1,700 scenarios, with the Group control and without", () => {
    expect([fixture.start, fixture.scenarios, fixture.digests.length]).toEqual([CAP_FIXTURE_START, CAP_FIXTURE_SCENARIOS, CAP_FIXTURE_SCENARIOS]);
    const r = new CapRandom(CAP_FIXTURE_START);
    const differ: number[] = [];
    for (let i = 0; i < CAP_FIXTURE_SCENARIOS; i++) {
      const s = nextCapScenario(r);
      const { work, pages } = s.world;
      const lists: unknown[] = [openThreadCards(work.threads, pages, s.filters, [], s.pin, CAP_NOW, pages, work.asOfMs)];
      CAP_STOPS.forEach((stop, k) => lists.push(openWorkCards(work, pages, s.filters, [], s.pin, CAP_NOW, pages, { stop, evidence: s.evidence[k]! }).cards));
      if (capCardsDigest(lists.map(capCardsDigest)) !== fixture.digests[i]) differ.push(s.seed);
    }
    expect(differ.slice(0, 5)).toEqual([]);
  }, 60_000);
});
