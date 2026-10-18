/**
 * The five-card cap's rule (plan `muninn-wiki-work-thread-grouping`, D20) as
 * properties over seeded synthetic scenarios (`wiki-rail-work-cap-gen.ts`):
 * random threads, pages, hubs, evidence, splits, kept-apart anchors, pins and
 * a facet, each at Threads, Related and Areas.
 *
 *  (i)   The cards break down into BASE cards — the cards the stop draws with
 *        no manual boundary — exactly the boundary-free top five, in order,
 *        each base card's pieces contiguous and holding exactly its pages.
 *  (ii)  Any one boundary click on what is drawn (Make own thread or Return on
 *        a focus row, Keep separate or Allow grouping on a card) leaves the
 *        set of focus pages the section draws unchanged.
 *  (iii) No page is drawn twice.
 *  (iv)  With no boundaries, the cards are origin/main's (97faaeec) byte for
 *        byte, PR 4's boundary fields aside: `wiki-rail-work-cap.fixture.json`
 *        holds that build's digests (`scripts/wiki-work-cap-freeze.ts`).
 *  (v)   No fold key is drawn twice.
 *  (vi)  The pin follows its page: the drawn piece holding the pinned page's
 *        thread after the boundaries is the one pinned piece, first in its
 *        block, and its block is first when its base card held the pin (S1).
 *  (vii) With `+ N more` pressed on the groups drawn (and no other), one
 *        click hides no row an expanded group showed.
 *
 * The 5,100-case run reads the cap's two placement functions, up to four
 * clicks a case, (i), (iii), (v) and (vi) before and after each; a 900-case
 * run reads `openWorkCards` itself, one click a case.
 */

import { describe, expect, test } from "bun:test";
import { groupCardPieces, openThreadCards, openWorkCards, rankThreadCards, threadCardPieces, workBoundariesOf } from "./wiki-rail-input.ts";
import { isRailGroupCard, normalizeFoldKey, THREAD_CARDS_MAX, type RailThreadCard, type RailWorkCard } from "./wiki-recents.ts";
import { rowBoundaryAction, type WorkBoundaries } from "./wiki-work-boundaries.ts";
import { groupWorkThreads } from "./wiki-work-groups.ts";
import { threadHoldsPin, usableThreads } from "./wiki-thread-core.ts";
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
  /** Every fold key it draws: a group's, then each of its thread cards'. */
  keys: string[];
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
        return { pages: rows, pinned: c.pinned, keys: [c.foldKey], threads: [{ key: c.key, rows }] };
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
      const keys = v.children.map((cv) => cv.child.foldKey);
      return { pages: threads.flatMap((t) => t.rows), pinned: v.children.some((cv) => cv.child.pinned), keys: v.group.kind === "group" ? [v.group.foldKey, ...keys] : keys, threads };
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

/** The derived thread holding the pin after the boundaries (`threadHoldsPin`), or null. */
function pinHolder(s: CapScenario, bounds: WorkBoundaries): string | null {
  if (!s.pin) return null;
  const byRel = new Map(s.world.pages.map((p) => [p.relPath, p] as const));
  return usableThreads(bounds.derived).find((t) => threadHoldsPin(t, byRel, s.pin!))?.key ?? null;
}

/** (i), (iii), (v) and (vi) over drawn pieces against the base cards
 *  (`basePinned`: each base card's pin flag); failures as text. */
function baseCardFailures(base: readonly string[][], drawn: readonly Piece[][], blocksOf: (pages: string[]) => number[], basePinned: readonly boolean[], holder: string | null): string[] {
  const out: string[] = [];
  const pieces = drawn.flat();
  const pages = pieces.flatMap((p) => p.pages);
  if (new Set(pages).size !== pages.length) out.push("(iii) a page drawn twice");
  const seq = pieces.map((p) => blocksOf(p.pages));
  const flatSeq = seq.map((b) => (new Set(b).size === 1 ? b[0]! : -1));
  const contiguous = flatSeq.every((v, j) => v >= 0 && (j === 0 ? v === 0 : v === flatSeq[j - 1] || v === flatSeq[j - 1]! + 1)) && (base.length ? flatSeq.at(-1) === base.length - 1 : !flatSeq.length);
  if (!contiguous) out.push(`(i) the pieces are not the ${base.length} base cards in order: ${JSON.stringify(flatSeq)}`);
  if (sorted(pages).join() !== sorted(base.flat()).join()) out.push("(i) the pages drawn are not the base cards' pages");
  const keys = pieces.flatMap((p) => p.keys);
  if (new Set(keys).size !== keys.length) out.push(`(v) a fold key drawn twice: ${keys.filter((k, j) => keys.indexOf(k) !== j).join(" ")}`);
  const pinned = pieces.flatMap((p, j) => (p.pinned ? [j] : []));
  const holding = pieces.findIndex((p) => p.threads.some((t) => t.key === holder));
  if (pinned.length > 1) out.push("(vi) two pinned pieces");
  if ((pinned[0] ?? -1) !== holding) out.push(`(vi) the pinned piece ${pinned[0] ?? "none"} is not the piece holding the pin ${holding}`);
  if (contiguous && pinned.length === 1) {
    const j = pinned[0]!;
    const block = flatSeq[j]!;
    if (j > 0 && flatSeq[j - 1] === block) out.push("(vi) the pinned piece is not first in its block");
    if (basePinned[block] && j !== 0) out.push("(vi) the pinned base card's pinned piece is not the first card");
  }
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
    const basePinned = free.map((block) => block[0]!.pinned);
    for (const f of baseCardFailures(base, drawn, baseIndex(base), basePinned, pinHolder(s, boundsOf(s, b)))) fail(f);
    const before = sorted(drawn.flat().flatMap((p) => p.pages)).join();
    for (const ck of pick(clicksOn(s, boundsOf(s, b), drawn.flat().flatMap((p) => p.threads), b))) {
      tally.clicks++;
      const placed = place(s, stop, ck.after);
      // The state after the click is a state too: (i), (iii), (v) and (vi) hold there.
      for (const f of baseCardFailures(base, placed, baseIndex(base), basePinned, pinHolder(s, boundsOf(s, ck.after)))) fail(`after ${ck.label}: ${f}`);
      const after = sorted(placed.flat().flatMap((p) => p.pages)).join();
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
          const keys = ts.map((t) => t.foldKey);
          // The pinned THREAD card: a group keeps its 📌 when a facet hides its
          // pinned child (origin's rule, frozen by (iv)), so (vi) reads the child.
          return { pages: threads.flatMap((t) => t.rows), pinned: ts.some((t) => t.pinned), keys: isRailGroupCard(c) ? [c.foldKey, ...keys] : keys, threads };
        };
        const freeCards = draw(NONE);
        const base = freeCards.map((c) => asPiece(c).pages);
        const drawn = draw(b).map(asPiece);
        for (const f of baseCardFailures(base, [drawn], baseIndex(base), freeCards.map((c) => asPiece(c).pinned), pinHolder(s, boundsOf(s, b))))
          if (failures.length < 8) failures.push(`seed ${s.seed} ${stop}: ${f}`);
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

  test("(v) under name pressure: two stars of threads, each breaking into two groups, one named by a series both share — no fold key twice (Related)", () => {
    // The generator's names rarely collide across two broken base cards, so
    // each scenario's threads are rewired: the top two by rank anchor a star
    // each (the rest alternate between them), each star's members form two
    // cliques by `related:`, and the second clique of both is in series sx.
    // Keep separate on both anchors breaks each star into its two cliques.
    const r = new CapRandom(CAP_FIXTURE_START);
    const failures: string[] = [];
    let cases = 0;
    let named = 0;
    const toggles = { series: false, related: true, issue: true };
    for (let i = 0; i < CAP_FIXTURE_SCENARIOS; i++) {
      const s = nextCapScenario(r);
      const { pages, work: w0 } = s.world;
      const order = rankThreadCards(w0.threads, pages, null, CAP_NOW, w0.asOfMs).map((x) => x.t.key);
      if (order.length < 6) continue;
      const [a, b, ...rest] = order;
      const related: [string, string][] = [];
      const series: Record<string, string> = {};
      [a!, b!].forEach((anchor, side) => {
        const mine = rest.filter((_, j) => j % 2 === side);
        mine.forEach((m, j) => {
          related.push([anchor, m]);
          for (let k = j + 2; k < mine.length; k += 2) related.push([m, mine[k]!]);
        });
        for (const t of w0.threads) if (mine.indexOf(t.key) % 2 === 1) for (const p of t.pages) series[p] = "sx";
      });
      const work = { ...w0, evidence: { ...w0.evidence!, relations: { ...w0.evidence!.relations, related, series } } };
      cases++;
      const cards = openWorkCards(work, pages, s.filters, [], s.pin, CAP_NOW, pages, { stop: "related", evidence: toggles, keptApart: [a!, b!] }).cards;
      const keys = cards.flatMap((c) => (isRailGroupCard(c) ? [c.foldKey, ...c.children.map((t) => t.foldKey)] : [c.foldKey]));
      if (keys.includes("group:series:sx")) named++;
      const twice = keys.filter((k, j) => keys.indexOf(k) !== j);
      if (twice.length && failures.length < 8) failures.push(`seed ${s.seed}: ${twice.join(" ")}`);
    }
    expect(cases).toBeGreaterThan(800);
    expect(named).toBeGreaterThan(150);
    expect(failures).toEqual([]);
  }, 60_000);

  test("(vii) + N more pressed on the groups drawn: 500 scenarios at Related and Areas, one click of each kind offered, hide no row an expanded group showed", () => {
    const r = new CapRandom(CAP_FIXTURE_START);
    const failures: string[] = [];
    let clicks = 0;
    let broken = 0;
    for (let i = 0; i < 500; i++) {
      const s = nextCapScenario(r);
      const { work, pages } = s.world;
      const b: Bounds = { splits: s.splits, keptApart: s.keptApart };
      const pick = new CapRandom(s.seed ^ 0x2545f491);
      CAP_STOPS.forEach((stop, k) => {
        if (stop === "threads") return;
        const draw = (x: Bounds, moreOpen: string[]) => openWorkCards(work, pages, s.filters, [], s.pin, CAP_NOW, pages, { stop, evidence: s.evidence[k]!, ...x, moreOpen }).cards;
        const shown = (cards: readonly RailWorkCard[], groupsOnly: boolean) =>
          new Set(cards.flatMap((c) => (isRailGroupCard(c) ? c.children : groupsOnly ? [] : [c])).flatMap((t) => t.focus.map((p) => p.relPath)));
        // The reader pressed `+ N more` on every group drawn, and on no other key.
        const pressed = draw(b, []).filter(isRailGroupCard).map((c) => c.foldKey);
        const before = draw(b, pressed);
        const expanded = shown(before, true);
        const options = clicksOn(s, boundsOf(s, b), before.flatMap((c) => (isRailGroupCard(c) ? c.children : [c])).map((t) => ({
          key: t.key,
          rows: t.focus.map((p) => p.relPath),
          ...(t.menu?.action === "keep" ? { menu: { keep: t.menu.anchor } } : t.menu?.action === "allow" ? { menu: { allow: t.menu.anchors } } : {}),
        })), b);
        const kinds = new Map<string, Click>();
        for (const c of [...options].sort(() => pick.next() - 0.5)) if (!kinds.has(c.label.split(" ")[0]!)) kinds.set(c.label.split(" ")[0]!, c);
        for (const ck of kinds.values()) {
          clicks++;
          const after = draw(ck.after, pressed);
          if (after.length > before.length) broken++;
          const visible = shown(after, false);
          const lost = [...expanded].filter((p) => !visible.has(p));
          if (lost.length && failures.length < 8) failures.push(`seed ${s.seed} ${stop}: ${ck.label} hid ${lost.join(" ")}`);
        }
      });
    }
    expect(clicks).toBeGreaterThan(2000);
    expect(broken).toBeGreaterThan(100);
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
