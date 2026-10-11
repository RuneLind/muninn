import { describe, expect, test } from "bun:test";
import {
  LAST_VISIT_KEY,
  LAST_VISIT_MAX_PER_WIKI,
  localIsoDay,
  markNewItems,
  NEW_ITEM_CLASS,
  readLastVisit,
  tabBaseline,
  VISIT_BASELINE_KEY,
  visitDateText,
  visitKey,
  writeLastVisit,
} from "./wiki-new-since.ts";
import { ITEM_DATE_ATTR } from "../../../format/item-dates.ts";
import { PEEK_CLASS } from "./wiki-ref-links.ts";

// The DOM half (marks, the head line) is driven in e2e/wiki-new-since.spec.ts;
// `markNewItems`' peek rule is pinned here on a minimal fake DOM, because the
// reader never re-marks while a peek card is open.

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

describe("last visit store", () => {
  test("a first visit reads null, then the stored time", () => {
    const s = memory();
    const key = visitKey("w", "plans/a.mdx");
    expect(readLastVisit(s, key)).toBeNull();
    writeLastVisit(s, key, 1_000);
    expect(readLastVisit(s, key)).toBe(1_000);
    expect(readLastVisit(s, visitKey("w", "plans/b.mdx"))).toBeNull();
    expect(readLastVisit(s, visitKey("other", "plans/a.mdx"))).toBeNull();
  });

  test("garbage, a wrong shape and bad values read as no visit", () => {
    const s = memory();
    s.data.set(LAST_VISIT_KEY, "{not json");
    expect(readLastVisit(s, "k")).toBeNull();
    s.data.set(LAST_VISIT_KEY, "[1,2]");
    expect(readLastVisit(s, "0")).toBeNull();
    s.data.set(LAST_VISIT_KEY, JSON.stringify({ k: "12", j: -1, n: Number.NaN }));
    expect(readLastVisit(s, "k")).toBeNull();
    expect(readLastVisit(s, "j")).toBeNull();
    // Inherited keys are not visits.
    expect(readLastVisit(s, "toString")).toBeNull();
  });

  test("a throwing or missing storage is no visit and no throw", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLastVisit(throwing, "k")).toBeNull();
    expect(() => writeLastVisit(throwing, "k", 1)).not.toThrow();
    expect(readLastVisit(undefined, "k")).toBeNull();
  });

  test("keeps the newest visits of each wiki at the cap", () => {
    const s = memory();
    const n = LAST_VISIT_MAX_PER_WIKI;
    writeLastVisit(s, visitKey("small", "a.md"), 1);
    for (let i = 2; i <= n + 6; i++) writeLastVisit(s, visitKey("big", `p${i}.md`), i);
    const stored = JSON.parse(s.data.get(LAST_VISIT_KEY)!);
    expect(Object.keys(stored).length).toBe(n + 1);
    // The big wiki dropped its oldest; the small wiki's older visit stays.
    expect(readLastVisit(s, visitKey("big", "p2.md"))).toBeNull();
    expect(readLastVisit(s, visitKey("big", `p${n + 6}.md`))).toBe(n + 6);
    expect(readLastVisit(s, visitKey("small", "a.md"))).toBe(1);
  });
});

describe("the tab's baseline", () => {
  test("the first render in a tab records the stored visit; later ones reuse it", () => {
    const session = memory();
    const key = visitKey("w", "plans/tab.mdx");
    let reads = 0;
    expect(tabBaseline(session, key, () => (reads++, 5_000))).toBe(5_000);
    expect(session.data.get(`${VISIT_BASELINE_KEY}\n${key}`)).toBe("5000");
    // The stored visit has moved on, but this tab keeps its baseline.
    expect(tabBaseline(session, key, () => (reads++, 9_000))).toBe(5_000);
    expect(reads).toBe(1);
  });

  test("a first visit is a recorded null, not a fresh read", () => {
    const session = memory();
    const key = visitKey("w", "plans/first.mdx");
    expect(tabBaseline(session, key, () => null)).toBeNull();
    expect(tabBaseline(session, key, () => 7_000)).toBeNull();
  });

  test("after F5 the tab's sessionStorage baseline beats this document's memory", () => {
    const key = visitKey("w", "plans/two-tabs.mdx");
    expect(tabBaseline(memory(), key, () => 1_000)).toBe(1_000);
    // F5 gives a new document whose sessionStorage holds the baseline the
    // earlier document recorded; it wins over anything memory holds. (A new
    // tab, whose sessionStorage and memory are both empty, is driven in
    // e2e/wiki-new-since.spec.ts.)
    const reloaded = memory();
    reloaded.data.set(`${VISIT_BASELINE_KEY}\n${key}`, "2000");
    expect(tabBaseline(reloaded, key, () => 3_000)).toBe(2_000);
  });

  test("a first visit's null baseline is recorded in sessionStorage, so F5 keeps it", () => {
    const key = visitKey("w", "plans/first-f5.mdx");
    const session = memory();
    expect(tabBaseline(session, key, () => null)).toBeNull();
    // Memory would answer this document; F5 starts a new one, which only
    // sessionStorage reaches.
    expect(session.data.get(`${VISIT_BASELINE_KEY}\n${key}`)).toBe("null");
    const fresh = visitKey("w", "plans/first-f5-reloaded.mdx");
    const reloaded = memory();
    reloaded.data.set(`${VISIT_BASELINE_KEY}\n${fresh}`, "null");
    expect(tabBaseline(reloaded, fresh, () => 7_000)).toBeNull();
  });

  test("a throwing sessionStorage falls back to memory for this document", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const key = visitKey("w", "plans/blocked.mdx");
    expect(tabBaseline(throwing, key, () => 4_000)).toBe(4_000);
    expect(tabBaseline(throwing, key, () => 8_000)).toBe(4_000);
  });
});

describe("visit dates", () => {
  test("the local day; DD.MM on no, Mon D on en, with the year in another year", () => {
    const visit = new Date(2026, 9, 7, 23, 30).getTime();
    expect(localIsoDay(visit)).toBe("2026-10-07");
    expect(visitDateText(visit, new Date(2026, 9, 11), "no")).toBe("07.10");
    expect(visitDateText(visit, new Date(2027, 0, 2), "no")).toBe("07.10.2026");
    expect(visitDateText(visit, new Date(2026, 9, 11), "en")).toBe("Oct 7");
    expect(visitDateText(visit, new Date(2027, 0, 2), "en")).toBe("Oct 7, 2026");
  });
});

/** Just enough DOM for `markNewItems` on DecisionLog items. */
class FakeEl {
  readonly children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  private readonly cls: Set<string>;
  readonly classList = {
    add: (...c: string[]) => c.forEach((x) => this.cls.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.cls.delete(x)),
    contains: (c: string) => this.cls.has(c),
  };
  constructor(
    readonly tag: string,
    classes: string[] = [],
    private readonly attrs: Record<string, string> = {},
  ) {
    this.cls = new Set(classes);
  }
  append(...els: FakeEl[]): this {
    for (const el of els) {
      el.parentElement = this;
      this.children.push(el);
    }
    return this;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  /** `.c`, `tag.c` or `[attr]`. */
  matches(sel: string): boolean {
    const attr = /^\[([\w-]+)\]$/.exec(sel);
    if (attr) return attr[1]! in this.attrs;
    const [tag, ...classes] = sel.split(".");
    return (!tag || tag === this.tag) && classes.every((c) => this.cls.has(c));
  }
  closest(sel: string): FakeEl | null {
    for (let p: FakeEl | null = this; p; p = p.parentElement) if (p.matches(sel)) return p;
    return null;
  }
  private all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string): FakeEl[] {
    const parts = sel.split(",").map((x) => x.trim());
    return this.all().filter((el) => parts.some((p) => el.matches(p)));
  }
  compareDocumentPosition(other: FakeEl): number {
    let root: FakeEl = this;
    while (root.parentElement) root = root.parentElement;
    const order = [root, ...root.all()];
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
}

const decision = (id: string, day: string) =>
  new FakeEl("li", ["dl-item"], { id }).append(new FakeEl("span", ["dl-text"], { [ITEM_DATE_ATTR]: day }));

describe("markNewItems", () => {
  test("marks items dated after the visit day, never a peek card's copy", () => {
    (globalThis as { Node?: unknown }).Node ??= { DOCUMENT_POSITION_FOLLOWING: 4 };
    const fresh = decision("d2", "2026-10-09");
    const old = decision("d1", "2026-10-07");
    const peekCopy = decision("d2-copy", "2026-10-09");
    const article = new FakeEl("div", ["wiki-article"]).append(
      new FakeEl("ul").append(old, fresh),
      new FakeEl("div", [PEEK_CLASS]).append(new FakeEl("ul").append(peekCopy)),
    );
    const marked = markNewItems(article as unknown as HTMLElement, "2026-10-07");
    expect(marked as unknown[]).toEqual([fresh]);
    expect(fresh.classList.contains(NEW_ITEM_CLASS)).toBe(true);
    expect(old.classList.contains(NEW_ITEM_CLASS)).toBe(false);
    expect(peekCopy.classList.contains(NEW_ITEM_CLASS)).toBe(false);
  });
});
