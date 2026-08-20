import { test, expect, describe, afterEach } from "bun:test";
import {
  installWikiReadonlyGuard,
  wikiReadonlyGuardPlan,
  WIKI_READONLY_BLOCKED_SELECTOR,
  WIKI_READONLY_DISABLED_INPUTS,
  WIKI_READONLY_MOUSEDOWN_SELECTOR,
} from "./wiki-readonly-client.ts";

/**
 * The readonly guard's LISTENER SET, driven through `installWikiReadonlyGuard`
 * against a hand-rolled DOM (the `code-tabs.test.ts` idiom — the repo has no
 * jsdom/happy-dom).
 *
 * The regression this exists for: the guard installed its `mousedown` and
 * `keydown` cancels unconditionally, so on a read-only INSTANCE a mousedown on
 * any write control `stopImmediatePropagation()`d at capture — and
 * `wiki-browser.ts`'s bubble-phase mousedown delegate, the one that dismisses
 * the Explain button, never ran. A pure selector assertion cannot see that:
 * the bug is in which listeners exist, and its symptom is another module's
 * listener not being reached. So the harness dispatches real events through
 * capture → bubble and asserts on the SECOND listener.
 */

type FakeEvent = {
  type: string;
  target: FakeEl;
  key?: string;
  prevented: boolean;
  immediateStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
};

/** An element that answers `closest` for the selectors it "is". */
class FakeEl {
  constructor(readonly selectors: string[]) {}
  closest(selector: string): FakeEl | null {
    const wanted = selector.split(",").map((s) => s.trim()).filter(Boolean);
    return wanted.some((w) => this.selectors.includes(w)) ? this : null;
  }
}

class FakeDoc {
  readonly listeners: { type: string; fn: (e: FakeEvent) => void; capture: boolean }[] = [];
  readonly body = {
    _classes: new Set<string>(),
    classList: {
      contains: (c: string) => this.body._classes.has(c),
      add: (c: string) => this.body._classes.add(c),
    },
    appendChild: () => {},
  };
  addEventListener(type: string, fn: (e: FakeEvent) => void, capture?: boolean) {
    this.listeners.push({ type, fn, capture: !!capture });
  }
  querySelector() {
    return null;
  }
  getElementById() {
    return null;
  }
  createElement() {
    return { id: "", className: "", textContent: "", classList: { add() {}, remove() {} } };
  }
  /** Capture listeners first, then bubble — stopping on stopImmediatePropagation. */
  dispatch(type: string, target: FakeEl, key?: string): FakeEvent {
    const e: FakeEvent = {
      type,
      target,
      key,
      prevented: false,
      immediateStopped: false,
      preventDefault() {
        e.prevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {
        e.immediateStopped = true;
      },
    };
    for (const phase of [true, false]) {
      for (const l of this.listeners) {
        if (l.type !== type || l.capture !== phase) continue;
        if (e.immediateStopped) return e;
        l.fn(e);
      }
    }
    return e;
  }
}

/** Install the guard against a fresh fake DOM with the two flags set. */
function install(flags: { instance?: boolean; wiki?: boolean }) {
  const doc = new FakeDoc();
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.window = { setTimeout: () => 0, clearTimeout: () => {} };
  g.__WIKI_READONLY__ = flags.instance === true;
  g.__WIKI_READONLY_WIKI__ = flags.wiki === true;
  installWikiReadonlyGuard();
  // The bubble-phase delegate `wiki-browser.ts` owns (hideExplainPill's home).
  const reached: string[] = [];
  doc.addEventListener("mousedown", (e) => reached.push(`mousedown:${e.target.selectors[0]}`), false);
  doc.addEventListener("click", (e) => reached.push(`click:${e.target.selectors[0]}`), false);
  return { doc, reached };
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.window;
  delete g.__WIKI_READONLY__;
  delete g.__WIKI_READONLY_WIKI__;
});

const APPEND = new FakeEl(["#wikiFactcheckAppendBtn"]);
const APPROVE = new FakeEl(['[data-action="approve"]']);
const EXPLAIN = new FakeEl(["#wikiExplainBtn"]);
const ASK_INPUT = new FakeEl(["#wikiAskInput"]);

describe("readonly guard — which events are cancelled", () => {
  test("a read-only INSTANCE installs the click cancel ONLY", () => {
    // Byte-identical to the pre-WIKI_READONLY_ROOTS behavior. A mousedown cancel
    // here kills `wiki-browser.ts`'s bubble mousedown → hideExplainPill.
    const plan = wikiReadonlyGuardPlan(true, false);
    expect(plan).toEqual([{ type: "click", selector: WIKI_READONLY_BLOCKED_SELECTOR }]);
  });

  test("a read-only instance lets a mousedown on a write control REACH the page's own delegate", () => {
    const { doc, reached } = install({ instance: true });
    const md = doc.dispatch("mousedown", APPEND);
    expect(md.prevented).toBe(false);
    expect(md.immediateStopped).toBe(false);
    expect(reached).toContain("mousedown:#wikiFactcheckAppendBtn");
    // …while the CLICK is still cancelled, which is what refuses the write.
    const click = doc.dispatch("click", APPEND);
    expect(click.prevented).toBe(true);
    expect(click.immediateStopped).toBe(true);
    expect(reached).not.toContain("click:#wikiFactcheckAppendBtn");
  });

  test("a read-only WIKI cancels mousedown only for the mousedown-ACTIVATED egress buttons", () => {
    const plan = wikiReadonlyGuardPlan(false, true);
    const md = plan.find((p) => p.type === "mousedown");
    expect(md?.selector).toBe(WIKI_READONLY_MOUSEDOWN_SELECTOR);
    for (const id of ["#wikiExplainBtn", "#wikiFactcheckBtn", "#wikiFactcheckArticleBtn"]) {
      expect(WIKI_READONLY_MOUSEDOWN_SELECTOR).toContain(id);
    }
    // Not the write controls: their click cancel already covers them, and
    // cancelling their mousedown is what broke hideExplainPill.
    expect(WIKI_READONLY_MOUSEDOWN_SELECTOR).not.toContain("data-action");

    const { doc, reached } = install({ wiki: true });
    // ✨ Explain is activated FROM mousedown — it must be stopped there.
    const onExplain = doc.dispatch("mousedown", EXPLAIN);
    expect(onExplain.prevented).toBe(true);
    expect(onExplain.immediateStopped).toBe(true);
    // A write control's mousedown still reaches the page.
    const onApprove = doc.dispatch("mousedown", APPROVE);
    expect(onApprove.immediateStopped).toBe(false);
    expect(reached).toContain('mousedown:[data-action="approve"]');
    // …and its click is refused.
    expect(doc.dispatch("click", APPROVE).prevented).toBe(true);
  });

  test("keydown is per-wiki only, and only for the two Enter-submitting inputs", () => {
    expect(wikiReadonlyGuardPlan(true, false).some((p) => p.type === "keydown")).toBe(false);
    const kd = wikiReadonlyGuardPlan(false, true).find((p) => p.type === "keydown");
    for (const id of WIKI_READONLY_DISABLED_INPUTS) expect(kd?.selector).toContain(id);

    const { doc } = install({ wiki: true });
    expect(doc.dispatch("keydown", ASK_INPUT, "Enter").prevented).toBe(true);
    // Cancelling Tab would trap focus; typing buys nothing.
    expect(doc.dispatch("keydown", ASK_INPUT, "Tab").prevented).toBe(false);
    expect(doc.dispatch("keydown", ASK_INPUT, "a").prevented).toBe(false);
  });

  test("neither flag installs no listener at all", () => {
    expect(wikiReadonlyGuardPlan(false, false)).toEqual([]);
    const { doc } = install({});
    expect(doc.listeners.filter((l) => l.capture).length).toBe(0);
  });
});
