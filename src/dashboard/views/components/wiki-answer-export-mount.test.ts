import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mountAnswerExport, unmountAnswerExport, ANSWER_EXPORT_ID } from "./wiki-answer-export.ts";
import type { AnswerCardsHandle } from "./wiki-answer-cards.ts";
import type { AnswerWire } from "./wiki-answer-card-model.ts";
import { exportStamp } from "../../../wiki/answer-export.ts";

/**
 * The export controls' click and fetch sequence (answer cards PR 4, fix round
 * 1), over a minimal hand-rolled DOM: the repo has no browser test env. What
 * the button looks like and the real clipboard are
 * `e2e/wiki-answer-export.spec.ts`; these cases pin the orderings a browser run
 * cannot hold still — a prefetch landing during a confirm, a refresh that
 * fails, a root detached under a live subscription.
 */

// ── Minimal DOM ───────────────────────────────────────────────────────────────

class El {
  id = "";
  className = "";
  type = "";
  title = "";
  textContent = "";
  disabled = false;
  hidden = false;
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  /** Only the host is connected on its own. */
  connected = false;
  listeners = new Map<string, (() => void)[]>();
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  append(...els: El[]) {
    for (const e of els) this.appendChild(e);
  }
  appendChild(e: El) {
    e.parent = this;
    this.children.push(e);
    return e;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get isConnected(): boolean {
    return this.connected || (this.parent?.isConnected ?? false);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
}

let host: El;
const realDocument = (globalThis as { document?: unknown }).document;

function find(root: El, pred: (e: El) => boolean): El | null {
  if (pred(root)) return root;
  for (const c of root.children) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

beforeEach(() => {
  host = new El();
  host.connected = true;
  (globalThis as { document?: unknown }).document = {
    createElement: () => new El(),
    getElementById: (id: string) => find(host, (e) => e.id === id),
  };
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

const newBtn = () => find(host, (e) => e.getAttribute("data-answer-export") === "new")!;
const orphanBtn = () => find(host, (e) => e.getAttribute("data-answer-export") === "orphans")!;
const msg = () => find(host, (e) => e.className === "wiki-answer-export-msg")!;
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// ── Fakes ─────────────────────────────────────────────────────────────────────

const wire = (answerId: string, version: number, over: Partial<AnswerWire> = {}): AnswerWire => ({
  answerId,
  questionId: "O1",
  version,
  authorName: "Synne Testdal",
  choice: null,
  body: "x",
  createdAt: 0,
  firstCreatedAt: 0,
  exported: false,
  redacted: false,
  versionCount: version,
  mine: true,
  ...over,
});

/** A card handle the test drives: its answers, its load state, its refresh. */
function fakeHandle(answers: AnswerWire[], opts: { loaded?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const h = {
    list: answers,
    isLoaded: opts.loaded ?? true,
    refreshes: 0,
    /** What the next refresh does: load these answers, or fail (null). */
    nextLoad: undefined as AnswerWire[] | null | undefined,
    listeners,
    notify() {
      for (const cb of [...listeners]) cb();
    },
    handle: null as unknown as AnswerCardsHandle,
  };
  h.handle = {
    answers: () => h.list,
    unexportedCount: () => h.list.filter((a) => !a.exported && !a.redacted).length,
    loaded: () => h.isLoaded,
    refresh: async () => {
      h.refreshes++;
      if (h.nextLoad === null) return; // a failed reload: no change notice
      if (h.nextLoad !== undefined) h.list = h.nextLoad;
      h.isLoaded = true;
      h.notify();
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as AnswerCardsHandle;
  return h;
}

/** The header the server stamped at fetch time. */
const OLD_HEADER = "<!-- answers · w · plans/p.mdx · exported 2026-01-01 00:00 -->";
const blockFor = (rows: [string, number][]) =>
  rows.length ? [OLD_HEADER, ...rows.map(([id, v]) => `### O1 — ${id} v${v}`), "", "<!-- orphaned answers in w: 0 -->", ""].join("\n") : "";

const ORPHAN_HEADER = "<!-- orphaned answers · w · exported 2026-01-01 00:00 -->";
const orphanBlockFor = (rows: [string, number][]) =>
  rows.length ? [ORPHAN_HEADER, ...rows.map(([id, v]) => `### O1 — ${id} v${v} · plans/gone.mdx, page gone`), ""].join("\n") : "";

/** A fetch that answers the export GET (plain and `again=1`) from `state`, and
 *  the confirm; every call is recorded, and a GET can be held by the test.
 *  `orphans` are the wiki's orphans: a page confirm marks one that is also in
 *  `rows` (an orphan on this page), an orphan confirm marks only orphans. */
function fakeServer(state: { rows: [string, number][]; orphanCount?: number; orphans?: [string, number][]; failGet?: boolean }) {
  const calls: { url: string; body?: unknown }[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/wiki/answers/export/confirm")) {
      const body = calls.at(-1)!.body as { rows: [string, number][]; orphans?: boolean };
      const marked = new Set(body.rows.map(([id, v]) => `${id}:${v}`));
      if (!body.orphans) state.rows = state.rows.filter(([id, v]) => !marked.has(`${id}:${v}`));
      state.orphans = (state.orphans ?? []).filter(([id, v]) => !marked.has(`${id}:${v}`));
      return json({ marked: marked.size });
    }
    // Snapshot NOW: a held GET answers what the server had when it was asked.
    const rows = [...state.rows];
    const orphans = [...(state.orphans ?? [])];
    if (hold) await new Promise<void>((r) => held.push(r));
    if (state.failGet) return new Response("{}", { status: 500 });
    const one = { block: blockFor(rows), rows, count: rows.length };
    const again = { block: "", rows: [], count: 0 };
    const orphanCount = state.orphanCount ?? orphans.length;
    const orphanExport = { block: orphanBlockFor(orphans), rows: orphans, count: orphans.length };
    return json(url.includes("again=1") ? { ...again, orphanCount } : { ...one, orphanCount, again, orphanExport });
  }) as unknown as typeof fetch;
  return {
    calls,
    fetchFn,
    gets: () => calls.filter((c) => !c.url.includes("/confirm")).length,
    confirms: () => calls.filter((c) => c.url.includes("/confirm")),
    hold: (on: boolean) => {
      hold = on;
    },
    release: () => held.splice(0).forEach((r) => r()),
  };
}

function mount(h: ReturnType<typeof fakeHandle>, srv: ReturnType<typeof fakeServer>, over: { copy?: (t: string) => Promise<boolean>; now?: () => number; canExport?: boolean } = {}) {
  mountAnswerExport(host as unknown as HTMLElement, h.handle, { answerable: true, canExport: over.canExport ?? true }, {
    wiki: "w",
    relPath: "plans/p.mdx",
    lang: "en",
    fetchFn: srv.fetchFn,
    copy: over.copy ?? (async () => true),
    now: over.now,
  });
}

// ── Cases ─────────────────────────────────────────────────────────────────────

describe("answer export fix round 1: the click", () => {
  test("the copied header carries the click's time, not the prefetch's", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]] });
    const copies: string[] = [];
    const click = Date.parse("2026-10-08T07:14:30Z"); // 09:14 Oslo
    mount(h, srv, { copy: async (t) => (copies.push(t), true), now: () => click });
    await tick();
    newBtn().click();
    await tick();
    expect(copies.length).toBe(1);
    expect(copies[0]!.split("\n")[0]).toBe(`<!-- answers · w · plans/p.mdx · exported ${exportStamp(click)} -->`);
    expect(exportStamp(click)).toBe("2026-10-08 09:14");
    expect(copies[0]!.split("\n").slice(1)).toEqual(blockFor([["a", 1]]).split("\n").slice(1));
  });

  test("the confirm names the page it confirms for", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]] });
    mount(h, srv);
    await tick();
    newBtn().click();
    await tick();
    expect(srv.confirms().map((c) => c.body)).toEqual([{ wiki: "w", relPath: "plans/p.mdx", rows: [["a", 1]] }]);
  });

  test("cards behind the server: a stale click reloads the cards, and the next click copies", async () => {
    // The server already has b (another tab answered); the cards do not.
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1], ["b", 1]] });
    const copies: string[] = [];
    mount(h, srv, { copy: async (t) => (copies.push(t), true) });
    await tick();
    h.nextLoad = [wire("a", 1), wire("b", 1)];
    newBtn().click();
    await tick();
    expect(h.refreshes).toBe(1);
    expect(copies).toEqual([]);
    newBtn().click();
    await tick();
    expect(copies.length).toBe(1);
  });

  test("a prefetch started before the confirm landing after it, then a failed card reload: no second copy or confirm", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]] });
    let releaseCopy!: (ok: boolean) => void;
    let copies = 0;
    const copy = () => {
      copies++;
      return copies === 1 ? new Promise<boolean>((r) => (releaseCopy = r)) : Promise.resolve(true);
    };
    mount(h, srv, { copy });
    await tick();
    newBtn().click();
    // While the copy is in flight a card change starts a prefetch; the server
    // still has `a` unexported, and the answer is held until after the confirm.
    srv.hold(true);
    h.notify();
    await tick();
    h.nextLoad = null; // the reload after the confirm fails
    releaseCopy(true);
    await tick(10);
    expect(srv.confirms().length).toBe(1);
    srv.hold(false);
    srv.release();
    await tick(10);
    expect(newBtn().disabled).toBe(true);
    newBtn().click();
    await tick(10);
    expect(copies).toBe(1);
    expect(srv.confirms().length).toBe(1);
  });
});

describe("answer export fix round 1: Copy again after a copy", () => {
  test("a prefetch started before the confirm cannot replace the batch just copied", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]] });
    const copies: string[] = [];
    let releaseCopy!: (ok: boolean) => void;
    const copy = (t: string) => {
      copies.push(t);
      return copies.length === 1 ? new Promise<boolean>((r) => (releaseCopy = r)) : Promise.resolve(true);
    };
    mount(h, srv, { copy });
    await tick();
    newBtn().click();
    srv.hold(true);
    h.notify(); // answers "nothing copied before" once released
    await tick();
    h.nextLoad = null;
    releaseCopy(true);
    await tick(10);
    srv.hold(false);
    srv.release();
    await tick(10);
    const again = find(host, (e) => e.getAttribute("data-answer-export") === "again")!;
    expect(again.disabled).toBe(false);
    again.click();
    await tick();
    expect(copies.length).toBe(2);
    expect(copies[1]).toBe(copies[0]);
  });
});

describe("answer export fix round 1: status, mount and teardown", () => {
  test("a load-failure message clears on the next successful prefetch", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const state = { rows: [["a", 1]] as [string, number][], failGet: true };
    const srv = fakeServer(state);
    mount(h, srv);
    await tick();
    expect(msg().textContent).not.toBe("");
    state.failGet = false;
    h.notify();
    await tick();
    expect(msg().textContent).toBe("");
  });

  test("one mount sends the export GET once, after the cards' first load", async () => {
    const h = fakeHandle([wire("a", 1)], { loaded: false });
    const srv = fakeServer({ rows: [["a", 1]] });
    mount(h, srv);
    await tick();
    expect(srv.gets()).toBe(0);
    h.isLoaded = true;
    h.notify(); // the cards' first load
    await tick();
    expect(srv.gets()).toBe(1);
  });

  test("a detached root lets go of the cards on the next change notice", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]] });
    mount(h, srv);
    await tick();
    expect(h.listeners.size).toBe(1);
    const before = srv.gets();
    // The reader navigated to an explainer: the breadcrumb row was rebuilt and
    // the controls are no longer in the document.
    host.connected = false;
    h.notify();
    await tick();
    expect(h.listeners.size).toBe(0);
    expect(srv.gets()).toBe(before);
  });

  test("re-mounting the same cards for a viewer who may not export removes the controls", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]] });
    mount(h, srv);
    await tick();
    expect(find(host, (e) => e.id === ANSWER_EXPORT_ID)).not.toBeNull();
    mount(h, srv, { canExport: false });
    expect(find(host, (e) => e.id === ANSWER_EXPORT_ID)).toBeNull();
    expect(h.listeners.size).toBe(0);
  });
});

describe("answer export fix round 2: Copy orphaned answers", () => {
  test("copies the orphan block with the click's time, confirms it as orphans, then fetches again", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]], orphans: [["g1", 1], ["g2", 3]] });
    const copies: string[] = [];
    const click = Date.parse("2026-10-08T07:14:30Z"); // 09:14 Oslo
    mount(h, srv, { copy: async (t) => (copies.push(t), true), now: () => click });
    await tick();
    expect([orphanBtn().hidden, orphanBtn().disabled, orphanBtn().textContent]).toEqual([false, false, "Copy orphaned answers (2)"]);
    const getsBefore = srv.gets();
    orphanBtn().click();
    await tick(10);
    expect(copies.length).toBe(1);
    expect(copies[0]!.split("\n")[0]).toBe(`<!-- orphaned answers · w · exported ${exportStamp(click)} -->`);
    expect(copies[0]!.split("\n").slice(1)).toEqual(orphanBlockFor([["g1", 1], ["g2", 3]]).split("\n").slice(1));
    expect(srv.confirms().map((c) => c.body)).toEqual([{ wiki: "w", orphans: true, rows: [["g1", 1], ["g2", 3]] }]);
    expect(srv.gets()).toBeGreaterThan(getsBefore);
    expect(msg().textContent).toBe("Copied 2 orphaned answers.");
    expect(orphanBtn().hidden).toBe(true);
    // The page's own answer was not touched.
    expect(newBtn().textContent).toBe("Copy new answers (1)");
  });

  test("a failed card reload after an orphan copy still fetches the block again", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]], orphans: [["g1", 1]] });
    mount(h, srv);
    await tick();
    h.nextLoad = null;
    const getsBefore = srv.gets();
    orphanBtn().click();
    await tick(10);
    expect(srv.gets()).toBe(getsBefore + 1);
    expect(orphanBtn().hidden).toBe(true);
  });

  test("an orphan that Copy new answers already confirmed is not copied again: the click fetches instead", async () => {
    // `a` is an answer on this page whose question is gone: both blocks hold it.
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]], orphans: [["a", 1]] });
    const copies: string[] = [];
    mount(h, srv, { copy: async (t) => (copies.push(t), true) });
    await tick();
    // Every later GET is held, and the card reload after the copy fails: the
    // orphan block on hand is still the one from before the copy.
    srv.hold(true);
    h.nextLoad = null;
    newBtn().click();
    await tick(10);
    expect(copies.length).toBe(1);
    expect(orphanBtn().hidden).toBe(false);
    const getsBefore = srv.gets();
    orphanBtn().click();
    await tick(10);
    expect(copies.length).toBe(1);
    expect(srv.confirms().length).toBe(1);
    expect(srv.gets()).toBe(getsBefore + 1);
    expect(msg().textContent).toBe("The answers changed. Loading the new ones; click again.");
    srv.hold(false);
    srv.release();
    await tick(10);
    expect(orphanBtn().hidden).toBe(true);
  });

  test("a failed clipboard write confirms nothing", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]], orphans: [["g1", 1]] });
    mount(h, srv, { copy: async () => false });
    await tick();
    orphanBtn().click();
    await tick(10);
    expect(srv.confirms()).toEqual([]);
    expect(msg().textContent).toBe("Could not copy to the clipboard. Nothing was marked as copied.");
    expect([orphanBtn().hidden, orphanBtn().disabled]).toEqual([false, false]);
  });
});

describe("answer export fix round 2: pins", () => {
  test("unmountAnswerExport takes the controls out of the document and lets go of the cards", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const srv = fakeServer({ rows: [["a", 1]] });
    mount(h, srv);
    await tick();
    expect(find(host, (e) => e.id === ANSWER_EXPORT_ID)).not.toBeNull();
    unmountAnswerExport();
    expect(find(host, (e) => e.id === ANSWER_EXPORT_ID)).toBeNull();
    expect(h.listeners.size).toBe(0);
  });

  test("a stale click whose card reload fails fetches the block itself, and the next click copies", async () => {
    const h = fakeHandle([wire("a", 1)]);
    const state = { rows: [["a", 1]] as [string, number][], failGet: true };
    const srv = fakeServer(state);
    const copies: string[] = [];
    mount(h, srv, { copy: async (t) => (copies.push(t), true) });
    await tick();
    // The first block never loaded; the server answers now, the cards do not.
    state.failGet = false;
    h.nextLoad = null;
    const getsBefore = srv.gets();
    newBtn().click();
    await tick(10);
    expect(copies).toEqual([]);
    expect(srv.gets()).toBe(getsBefore + 1);
    newBtn().click();
    await tick(10);
    expect(copies.length).toBe(1);
  });
});
