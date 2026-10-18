/**
 * PR 4's markup (plan `muninn-wiki-work-thread-grouping`): the boundary
 * chips, the card ⋯ stacked under the 📌, a Sessions-stop card without a 📌,
 * the row ⋯ on its own attribute, the ⋯ menus, `▸ split into N sessions`,
 * the `also in:` line, and the Group menu's Sessions stop and reset area.
 */

import { describe, expect, test } from "bun:test";
import {
  groupCardMenuHtml,
  saveSeriesConfirmHtml,
  threadAlsoInHtml,
  threadCardHeaderHtml,
  threadCardMenuHtml,
  threadRowMenuBtnHtml,
  threadRowMenuHtml,
  threadSessionsToggleHtml,
  workGroupMenuHtml,
} from "./wiki-thread-view.ts";
import type { RailGroupCard, RailThreadCard, RailWorkControl } from "./wiki-recents.ts";
import type { WikiListing } from "./wiki-filter.ts";
import type { SaveSeriesPlan } from "./wiki-work-series.ts";
import { WIKI_READONLY_BLOCKED_SELECTOR } from "./wiki-readonly-client.ts";

const NOW = Date.UTC(2026, 9, 17, 20, 0);
const card = (o: Partial<RailThreadCard> = {}): RailThreadCard => ({
  key: "plans/a.md",
  foldKey: "thread:plans/a.md",
  toggleKey: "thread:plans/a.md",
  name: "Alpha",
  open: false,
  pinned: false,
  pinAnchor: "plans/a.md",
  focus: [],
  created: [],
  touched: [],
  sessions: [{ id: "s1", provider: "claude", first: NOW - 7200_000, last: NOW - 3600_000, title: "t" }],
  movesYou: 0,
  score: 1,
  ...o,
});
const listing = (relPath: string): WikiListing => ({ relPath, name: relPath, title: `T ${relPath}`, type: "plan", domain: "ai", tags: [], aliases: [], linkCount: 0, backlinkCount: 0 }) as WikiListing;

describe("card headers", () => {
  test("a lone card with a boundary draws its chip on a third line; no ⋯ unless the card has a menu", () => {
    const own = threadCardHeaderHtml(card({ boundary: "split" }), true, NOW, false);
    expect(own).toContain('class="wiki-thread-chip wiki-thread-chip-own" title="You made this page its own thread">own thread</span>');
    expect(own).not.toContain("data-work-card-menu");
    expect(threadCardHeaderHtml(card({ boundary: "keptApart" }), true, NOW, false)).toContain(">kept separate</span>");
  });

  test("a card with a ⋯ stacks it under the 📌 in one column; a card without keeps today's markup", () => {
    const plain = threadCardHeaderHtml(card(), true, NOW, false);
    expect(plain).not.toContain("wiki-thread-acts");
    const withMenu = threadCardHeaderHtml(card({ menu: { action: "keep", anchor: "plans/a.md" } }), true, NOW, false);
    expect(withMenu).toMatch(/<div class="wiki-thread-acts"><button[^>]*wiki-thread-pin[^>]*>📌<\/button><button[^>]*data-work-card-menu="thread:plans\/a\.md"[^>]*aria-label="More for the thread Alpha"/);
  });

  test("a Sessions-stop card has no 📌 and no ⋯", () => {
    const html = threadCardHeaderHtml(card({ session: { ref: "claude-code:s1" }, menu: { action: "keep", anchor: "x" } }), true, NOW, false);
    expect(html).not.toContain("data-thread-pin");
    expect(html).not.toContain("data-work-card-menu");
    expect(html).toContain("wiki-thread-session-card");
  });
});

describe("row ⋯ and the menus", () => {
  test("the row ⋯ has its own attribute, never the series opener's (which the read-only blocker refuses)", () => {
    const btn = threadRowMenuBtnHtml("plans/a.html");
    expect(btn).toContain('data-thread-row-menu="plans/a.html"');
    expect(btn).not.toContain("data-series-menu");
    const host = `<div>${btn}</div>`;
    expect(WIKI_READONLY_BLOCKED_SELECTOR.split(",").some((sel) => sel.trim() === "[data-thread-row-menu]")).toBe(false);
    expect(WIKI_READONLY_BLOCKED_SELECTOR).toContain("[data-work-save-series]");
    expect(host).toContain('aria-label="Page menu"');
  });

  test("Make own thread, its disabled form with a described reason, and Return to its thread", () => {
    expect(threadRowMenuHtml("plans/p.md", { kind: "split", available: true })).toContain('data-thread-split="plans/p.md"');
    const off = threadRowMenuHtml("plans/p.md", { kind: "split", available: false, reason: "unattributed" });
    expect(off).toContain('aria-disabled="true" aria-describedby="wikiWorkPopWhy"');
    expect(off).toContain("Unavailable: no session&#39;s focus on this page is on record");
    expect(threadRowMenuHtml("plans/p.md", { kind: "return", id: "sp" })).toContain('data-work-return="sp" data-work-return-page="plans/p.md"');
  });

  test("a conflict page: Make own thread disabled, its reason naming the Group menu's reset area", () => {
    const off = threadRowMenuHtml("plans/p.md", { kind: "split", available: false, reason: "conflict" });
    expect(off).toContain('aria-disabled="true" aria-describedby="wikiWorkPopWhy"');
    expect(off).toContain("Unavailable: two of your splits name this page; repair them under Reset your splits and groups in the Work threads ▾ menu");
  });

  test("a card's ⋯: Keep separate, Allow grouping (all its anchors), Return to its thread", () => {
    expect(threadCardMenuHtml({ action: "keep", anchor: "a.md" })).toContain('data-work-keep="a.md"');
    expect(threadCardMenuHtml({ action: "allow", anchors: ["a.md", "b.md"] })).toContain('data-work-allow="[&quot;a.md&quot;,&quot;b.md&quot;]"');
    expect(threadCardMenuHtml({ action: "return", id: "x", page: "p.md" })).toContain("Return to its thread");
  });

  test("a group's ⋯: Save as series, its disabled reason, and the confirm view per child", () => {
    const plan: SaveSeriesPlan = {
      available: true,
      mode: "coin",
      key: "living",
      children: [
        { name: "Living", key: "a", write: [{ relPath: "plans/a.md", title: "A" }], joined: [], skipped: [{ relPath: "o.md", title: "Overview", why: "not-narrative" }] },
        { name: "Lenses", key: "b", write: [{ relPath: "plans/b.md", title: "B" }], joined: [], skipped: [] },
      ],
      writes: [{ relPath: "plans/a.md", title: "A" }, { relPath: "plans/b.md", title: "B" }],
      taken: [],
    };
    const g = { group: true, foldKey: "group:anchor:a", name: "Living", series: plan } as RailGroupCard;
    expect(groupCardMenuHtml(g)).toContain("Writes series: on 2 pages");
    const blocked = { ...g, series: { ...plan, available: false, block: { kind: "several-series", labels: ["A", "B"] } } } as RailGroupCard;
    expect(groupCardMenuHtml(blocked)).toContain("Unavailable: Its pages are in several series (A, B)");
    const confirm = saveSeriesConfirmHtml(g, plan);
    expect(confirm).toContain('data-work-series-key="1" value="living"');
    expect(confirm).toContain("writes:</span> A");
    expect(confirm).toContain("skips:</span> Overview (a reference page)");
    expect(confirm).toContain("Write 2 pages");
  });
});

describe("split into sessions, also in:, the Group menu", () => {
  test("▸ split into N sessions: a button with its state, disabled with a reason when the data is incomplete", () => {
    const on = threadSessionsToggleHtml(card({ sessionSplit: { count: 3, available: true, open: true, sessions: [] } }));
    expect(on).toContain('data-thread-sessions="thread:plans/a.md" aria-expanded="true"');
    expect(on).toContain("split into 3 sessions");
    const off = threadSessionsToggleHtml(card({ sessionSplit: { count: 3, available: false, reason: "contributions-cap", open: false, sessions: [] } }));
    expect(off).toContain('aria-disabled="true" title="Unavailable: the contribution rows hit their limit"');
  });

  test("also in: links, never rows", () => {
    const html = threadAlsoInHtml("session:x", [listing("plans/p.md")], (r) => `/w/${r}`);
    expect(html).toContain("also in:</span>");
    expect(html).toContain('class="wiki-thread-link"');
    expect(html).not.toContain("wiki-list-item");
  });

  test("the Group menu draws Sessions first and the reset area with every definition that does not apply", () => {
    const control: RailWorkControl = {
      requested: "related",
      stop: "related",
      evidence: { series: true, related: true, issue: true },
      evidenceApplies: true,
      stops: [
        { stop: "sessions", available: false, reasons: ["contributions-cap"], cards: 0 },
        { stop: "threads", available: true, reasons: [], cards: 4 },
        { stop: "related", available: true, reasons: [], cards: 3 },
        { stop: "areas", available: true, reasons: [], cards: 2 },
      ],
      reset: { count: 2, entries: [{ kind: "split", title: "Old page", state: "dormant" }] },
    };
    const html = workGroupMenuHtml(control, false);
    expect(html.indexOf('data-work-stop="sessions"')).toBeLessThan(html.indexOf('data-work-stop="threads"'));
    expect(html).toContain("Unavailable: the contribution rows hit their limit");
    expect(html).toContain("Reset your splits and groups (2)");
    expect(html).toContain("Own thread: Old page — no recent work on it");
  });
});
