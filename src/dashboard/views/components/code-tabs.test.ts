import { test, expect, describe } from "bun:test";
import { enhanceCodeTabs } from "./code-tabs.ts";

/**
 * The repo has no browser test env (no jsdom/happy-dom), so — like the mermaid
 * enhancer — the DOM render path is left to the orchestrator's headless smoke.
 * Here we drive `enhanceCodeTabs` against a minimal hand-rolled DOM to lock the
 * behavior that matters: a tab click moves `.is-active` onto that tab + its
 * index-matched panel, and re-enhancing the same container never double-binds.
 */

class FakeClassList {
  private set: Set<string>;
  constructor(initial: string[]) {
    this.set = new Set(initial);
  }
  toggle(cls: string, on: boolean) {
    if (on) this.set.add(cls);
    else this.set.delete(cls);
  }
  contains(cls: string) {
    return this.set.has(cls);
  }
}

class FakeEl {
  classList: FakeClassList;
  private listeners: Array<() => void> = [];
  private attrs: Record<string, string> = {};
  constructor(
    public className: string,
    private kids: FakeEl[] = [],
  ) {
    this.classList = new FakeClassList(className.split(/\s+/).filter(Boolean));
  }
  addEventListener(_type: string, cb: () => void) {
    this.listeners.push(cb);
  }
  click() {
    this.listeners.forEach((l) => l());
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const cls = sel.replace(/^\./, "");
    return this.descendants().filter((e) => e.classList.contains(cls));
  }
  private descendants(): FakeEl[] {
    return this.kids.flatMap((k) => [k, ...k.descendants()]);
  }
}

function makeContainer(labels: string[]) {
  const tabs = labels.map((l) => new FakeEl("code-tabs-tab" + (l === labels[0] ? " is-active" : "")));
  const panels = labels.map((l) => new FakeEl("code-tabs-panel" + (l === labels[0] ? " is-active" : "")));
  const container = new FakeEl("code-tabs", [...tabs, ...panels]);
  const root = new FakeEl("root", [container]);
  return { root, container, tabs, panels };
}

describe("enhanceCodeTabs", () => {
  test("clicking a tab activates that tab + its index-matched panel", () => {
    const { root, tabs, panels } = makeContainer(["A", "B", "C"]);
    enhanceCodeTabs(root as unknown as ParentNode);
    tabs[1]!.click();
    expect(tabs[0]!.classList.contains("is-active")).toBe(false);
    expect(tabs[1]!.classList.contains("is-active")).toBe(true);
    expect(panels[1]!.classList.contains("is-active")).toBe(true);
    expect(panels[0]!.classList.contains("is-active")).toBe(false);
    expect(panels[2]!.classList.contains("is-active")).toBe(false);
  });

  test("re-enhancing the same container does not double-bind listeners", () => {
    const { root, container, tabs, panels } = makeContainer(["A", "B"]);
    enhanceCodeTabs(root as unknown as ParentNode);
    expect(container.getAttribute("data-code-tabs-enhanced")).toBe("1");
    enhanceCodeTabs(root as unknown as ParentNode); // second pass: guarded, no new listeners
    tabs[1]!.click(); // exactly one handler ran → clean single-toggle
    expect(panels[1]!.classList.contains("is-active")).toBe(true);
    expect(panels[0]!.classList.contains("is-active")).toBe(false);
  });

  test("a root without .code-tabs is a no-op", () => {
    const root = new FakeEl("root", [new FakeEl("something-else")]);
    expect(() => enhanceCodeTabs(root as unknown as ParentNode)).not.toThrow();
  });
});
