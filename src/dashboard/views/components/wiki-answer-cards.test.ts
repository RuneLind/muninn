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
