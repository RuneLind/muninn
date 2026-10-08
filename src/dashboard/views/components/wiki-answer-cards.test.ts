import { describe, expect, test } from "bun:test";
import { ANSWER_CARD_WIRED_ATTR, enhanceAnswerCards } from "./wiki-answer-cards.ts";

/**
 * The wiring half of the answer card, over a minimal hand-rolled stand-in for
 * the card sections: the repo has no browser test env, and these cases need no
 * rendering (a section that is not connected is never painted). What a card
 * looks like and does is `e2e/wiki-answer-card.spec.ts`.
 */

interface FakeSection {
  attrs: Map<string, string>;
  listeners: string[];
  isConnected: false;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  addEventListener(type: string): void;
}

function fakeSection(id: string): FakeSection {
  const attrs = new Map<string, string>([
    ["data-question-id", id],
    ["data-question-state", "open"],
    ["data-question-lang", "en"],
    ["data-wiki-answerable", "true"],
  ]);
  const listeners: string[] = [];
  return {
    attrs,
    listeners,
    isConnected: false,
    getAttribute: (n) => attrs.get(n) ?? null,
    setAttribute: (n, v) => void attrs.set(n, v),
    hasAttribute: (n) => attrs.has(n),
    addEventListener: (type) => void listeners.push(type),
  };
}

const rootOf = (sections: FakeSection[]) => ({ querySelectorAll: () => sections }) as unknown as HTMLElement;

const answersResponse = (answers: unknown[]) =>
  new Response(JSON.stringify({ answerable: true, answers }), { headers: { "content-type": "application/json" } });

const wire = (over: Record<string, unknown>) => ({
  answerId: "a1",
  questionId: "O1",
  version: 1,
  versionCount: 1,
  authorName: "Yvonne Jacobs",
  choice: null,
  body: "x",
  createdAt: 1,
  firstCreatedAt: 1,
  exported: false,
  redacted: false,
  mine: false,
  ...over,
});

describe("enhanceAnswerCards", () => {
  test("a second call wires nothing twice and returns the same handle", () => {
    const sections = [fakeSection("O1"), fakeSection("O2")];
    let fetches = 0;
    const fetchFn = (() => {
      fetches++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const opts = { wiki: "w", relPath: "plans/p.mdx", fetchFn };
    const first = enhanceAnswerCards(rootOf(sections), { answerable: true }, opts);
    const wired = sections.map((s) => s.listeners.length);
    const second = enhanceAnswerCards(rootOf(sections), { answerable: true }, opts);
    expect(sections.map((s) => s.listeners.length)).toEqual(wired);
    expect(wired.every((n) => n > 0)).toBe(true);
    expect(sections.map((s) => s.getAttribute(ANSWER_CARD_WIRED_ATTR))).toEqual(["wired", "wired"]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(fetches).toBe(1);
  });

  test("no answers flag, no handle and no fetch", () => {
    let fetches = 0;
    const fetchFn = (() => {
      fetches++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    expect(enhanceAnswerCards(rootOf([fakeSection("O1")]), undefined, { wiki: "w", relPath: "p.mdx", fetchFn })).toBeNull();
    expect(fetches).toBe(0);
  });

  test("the handle exposes the loaded answers, the export count and a change hook", async () => {
    let answers: unknown[] = [wire({}), wire({ answerId: "a2", redacted: true }), wire({ answerId: "a3", exported: true })];
    const fetchFn = (() => Promise.resolve(answersResponse(answers))) as unknown as typeof fetch;
    const handle = enhanceAnswerCards(rootOf([fakeSection("O1")]), { answerable: true }, { wiki: "w", relPath: "p.mdx", fetchFn })!;
    let changes = 0;
    const off = handle.onChange(() => changes++);
    await handle.refresh();
    expect(handle.answers().map((a) => a.answerId)).toEqual(["a1", "a2", "a3"]);
    expect(handle.unexportedCount()).toBe(1);
    expect(changes).toBeGreaterThan(0);
    answers = [];
    off();
    const before = changes;
    await handle.refresh();
    expect(handle.answers()).toEqual([]);
    expect(changes).toBe(before);
  });
});

/** A section the load-error line can be written into: connected, so
 *  `showLoadError` writes, and every write is recorded. */
function connectedSection(id: string): FakeSection & { inserted: string[] } {
  const base = fakeSection(id);
  const inserted: string[] = [];
  return Object.assign(base, {
    isConnected: true as unknown as false,
    inserted,
    querySelector: () => null,
    insertAdjacentHTML: (_where: string, html: string) => void inserted.push(html),
  });
}

/** A fetch whose calls each wait for the test to settle them. */
function heldFetch() {
  const calls: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const fetchFn = (() =>
    new Promise<Response>((resolve, reject) => calls.push({ resolve, reject }))) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("answer cards fix round 2: what a reload result does", () => {
  test("a reload answering answerable:false leaves the loaded answers in place", async () => {
    let body: unknown = { answerable: true, answers: [wire({})] };
    const fetchFn = (() =>
      Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;
    const handle = enhanceAnswerCards(rootOf([fakeSection("O1")]), { answerable: true }, { wiki: "w", relPath: "p.mdx", fetchFn })!;
    await handle.refresh();
    expect(handle.answers().map((a) => a.answerId)).toEqual(["a1"]);
    body = { answerable: false, answers: [] };
    await handle.refresh();
    expect(handle.answers().map((a) => a.answerId)).toEqual(["a1"]);
  });

  test("a first load that fails says so on the card", async () => {
    const { calls, fetchFn } = heldFetch();
    const section = connectedSection("O1");
    enhanceAnswerCards(rootOf([section]), { answerable: true }, { wiki: "w", relPath: "p.mdx", fetchFn });
    calls[0]!.reject(new Error("down"));
    await tick();
    expect(section.inserted.length).toBe(1);
    expect(section.inserted[0]).toContain("q-answers-error");
  });

  test("a failed load a newer request has overtaken writes nothing", async () => {
    const { calls, fetchFn } = heldFetch();
    const section = connectedSection("O1");
    const handle = enhanceAnswerCards(rootOf([section]), { answerable: true }, { wiki: "w", relPath: "p.mdx", fetchFn })!;
    // A second load goes out while the first is still out, and stays out.
    void handle.refresh();
    expect(calls.length).toBe(2);
    calls[0]!.reject(new Error("down"));
    await tick();
    expect(section.inserted).toEqual([]);
  });
});

describe("answer cards fix round 3: a failed reload after a good one", () => {
  test("a refresh that fails after a successful load writes no load-error line", async () => {
    const { calls, fetchFn } = heldFetch();
    // Not connected while the first load lands, so it paints nothing (the
    // stand-in has no DOM to paint into); connected when the refresh fails,
    // so a load-error line would be written.
    const section = connectedSection("O1");
    let connected = false;
    Object.defineProperty(section, "isConnected", { get: () => connected });
    const handle = enhanceAnswerCards(rootOf([section]), { answerable: true }, { wiki: "w", relPath: "p.mdx", fetchFn })!;
    calls[0]!.resolve(answersResponse([wire({})]));
    await tick();
    expect(handle.answers().map((a) => a.answerId)).toEqual(["a1"]);
    connected = true;
    const refreshed = handle.refresh();
    calls[1]!.reject(new Error("down"));
    await refreshed;
    expect(section.inserted).toEqual([]);
    expect(handle.answers().map((a) => a.answerId)).toEqual(["a1"]);
  });
});
