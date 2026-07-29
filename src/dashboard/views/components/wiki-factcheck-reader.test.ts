import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  buildCard,
  chipVerdict,
  enhanceFactCheck,
  resolveInsertionPoint,
  toggleLabelText,
} from "./wiki-factcheck-reader.ts";

/**
 * The repo has no browser test env (no jsdom/happy-dom), so — exactly like the
 * sibling `code-tabs.test.ts` — the DOM is a minimal hand-rolled shim and the
 * real render path is left to `e2e/wiki-factcheck-reader.spec.ts`.
 *
 * What is locked here is the logic a headless smoke can only sample: where the
 * evidence card is spliced (the case that matters is the INLINE one —
 * `formatWebHtml` emits no `<p>`, so top-level prose is bare text nodes and a
 * naive "block containing the chip" walk lands mid-sentence), what the clone
 * strips and demotes, that re-enhancing never double-binds, and the toggle's
 * label mapping (the label is the toggle's ONLY state signal — it deliberately
 * carries no `aria-pressed`).
 *
 * The shim is installed as `globalThis.document` per test and removed after, so
 * it can't leak into sibling files sharing the bun process.
 */

// ── Minimal DOM ───────────────────────────────────────────────────────────────

type Sel = { tag?: string; classes: string[]; attrs: string[] };

/** Parse a comma-separated selector list into compound selectors, each an
 *  optional `A > B` descendant-of-parent pair. Enough for this module's usage. */
function parseSelector(sel: string): Array<{ parent?: Sel; own: Sel }> {
  return sel.split(",").map((part) => {
    const [a, b] = part.trim().split(">").map((s) => s.trim());
    const compile = (s: string): Sel => ({
      tag: /^[a-zA-Z]/.test(s) ? (s.match(/^[a-zA-Z0-9]+/)?.[0] ?? "").toUpperCase() : undefined,
      classes: Array.from(s.matchAll(/\.([\w-]+)/g)).map((m) => m[1]!),
      attrs: Array.from(s.matchAll(/\[([\w-]+)\]/g)).map((m) => m[1]!),
    });
    return b ? { parent: compile(a!), own: compile(b) } : { own: compile(a!) };
  });
}

class FNode {
  nodeType = 3;
  childNodes: FNode[] = [];
  parent: FNode | null = null;
  constructor(public data = "") {}
  get parentNode(): FNode | null {
    return this.parent;
  }
  get parentElement(): FEl | null {
    return this.parent && this.parent.nodeType === 1 ? (this.parent as FEl) : null;
  }
  get nextSibling(): FNode | null {
    if (!this.parent) return null;
    const i = this.parent.childNodes.indexOf(this);
    return this.parent.childNodes[i + 1] ?? null;
  }
  get isConnected(): boolean {
    let n: FNode | null = this;
    while (n.parent) n = n.parent;
    return (n as FEl).isRoot === true;
  }
  cloneNode(_deep = false): FNode {
    return new FNode(this.data);
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.childNodes.indexOf(this);
    if (i >= 0) this.parent.childNodes.splice(i, 1);
    this.parent = null;
  }
  get textContent(): string {
    return this.data;
  }
}

class FClassList {
  constructor(private el: FEl) {}
  private list(): string[] {
    return (this.el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
  private write(v: string[]): void {
    this.el.setAttribute("class", v.join(" "));
  }
  contains(c: string): boolean {
    return this.list().includes(c);
  }
  add(c: string): void {
    if (!this.contains(c)) this.write([...this.list(), c]);
  }
  remove(c: string): void {
    this.write(this.list().filter((x) => x !== c));
  }
  toggle(c: string): boolean {
    if (this.contains(c)) {
      this.remove(c);
      return false;
    }
    this.add(c);
    return true;
  }
}

class FEl extends FNode {
  override nodeType = 1;
  tagName: string;
  isRoot = false;
  type = "";
  attrs: Record<string, string> = {};
  listeners: Array<{ type: string; cb: (e: unknown) => void }> = [];
  classList = new FClassList(this);
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get className(): string {
    return this.attrs.class ?? "";
  }
  set className(v: string) {
    this.attrs.class = v;
  }
  get id(): string {
    return this.attrs.id ?? "";
  }
  set id(v: string) {
    this.attrs.id = v;
  }
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs[n] = v;
  }
  removeAttribute(n: string): void {
    delete this.attrs[n];
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.push({ type, cb });
  }
  focus(_opts?: unknown): void {
    doc.activeElement = this;
  }
  get firstChild(): FNode | null {
    return this.childNodes[0] ?? null;
  }
  appendChild<T extends FNode>(n: T): T {
    n.remove();
    n.parent = this;
    this.childNodes.push(n);
    return n;
  }
  append(...nodes: FNode[]): void {
    nodes.forEach((n) => this.appendChild(n));
  }
  insertBefore<T extends FNode>(n: T, ref: FNode | null): T {
    n.remove();
    n.parent = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return n;
  }
  replaceChild(next: FNode, old: FNode): void {
    const i = this.childNodes.indexOf(old);
    if (i < 0) return;
    next.remove();
    next.parent = this;
    this.childNodes[i] = next;
    old.parent = null;
  }
  contains(n: FNode | null): boolean {
    let cur: FNode | null = n;
    while (cur) {
      if (cur === (this as FNode)) return true;
      cur = cur.parent;
    }
    return false;
  }
  matches(sel: string): boolean {
    return parseSelector(sel).some((s) => this.matchOne(s.own) && (!s.parent || (this.parentElement ? this.parentElement.matchOne(s.parent) : false)));
  }
  matchOne(s: Sel): boolean {
    if (s.tag && s.tag !== this.tagName) return false;
    if (!s.classes.every((c) => this.classList.contains(c))) return false;
    return s.attrs.every((a) => this.getAttribute(a) !== null);
  }
  closest(sel: string): FEl | null {
    let cur: FEl | null = this;
    while (cur) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  descendants(): FEl[] {
    return this.childNodes.flatMap((k) =>
      k.nodeType === 1 ? [k as FEl, ...(k as FEl).descendants()] : [],
    );
  }
  querySelectorAll(sel: string): FEl[] {
    return this.descendants().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): FEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  override cloneNode(deep = false): FEl {
    const c = new FEl(this.tagName);
    c.attrs = { ...this.attrs };
    if (deep) this.childNodes.forEach((k) => c.appendChild(k.cloneNode(true)));
    return c;
  }
  override get textContent(): string {
    return this.childNodes.map((k) => k.textContent).join("");
  }
  override set textContent(v: string) {
    this.childNodes.forEach((k) => (k.parent = null));
    this.childNodes = [];
    if (v) this.appendChild(new FNode(v));
  }
}

const doc = {
  activeElement: null as FEl | null,
  root: null as FEl | null,
  listeners: [] as Array<{ type: string; cb: (e: unknown) => void }>,
  createElement(tag: string): FEl {
    return new FEl(tag);
  },
  getElementById(id: string): FEl | null {
    return doc.root?.querySelectorAll("[id]").find((e) => e.id === id) ?? null;
  },
  addEventListener(type: string, cb: (e: unknown) => void): void {
    doc.listeners.push({ type, cb });
  },
};

function el(tag: string, cls = "", attrs: Record<string, string> = {}): FEl {
  const e = new FEl(tag);
  if (cls) e.className = cls;
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
}
const txt = (s: string) => new FNode(s);

/** A wrap → `.wiki-article` layer holding the given children, marked connected. */
function makeLayer(children: FNode[]): { wrap: FEl; layer: FEl } {
  const layer = el("div", "wiki-article");
  children.forEach((c) => layer.appendChild(c));
  const wrap = el("div", "wrap");
  wrap.isRoot = true;
  wrap.appendChild(layer);
  doc.root = wrap;
  return { wrap, layer };
}

function chip(n: string, verdict = "ok"): FEl {
  const c = el("button", `fc-chip fc-chip-${verdict}`, { "data-fact": n, "aria-expanded": "false" });
  c.appendChild(el("span", "fc-chip-label"));
  return c;
}

/** The appendix shape `web-format.ts` renders: one `#fc-claim-N` per claim. */
function appendix(ns: string[]): FEl {
  const block = el("details", "fc-block");
  const strip = el("summary", "fc-strip");
  strip.appendChild(txt("Fact-checked 2026-07-29"));
  block.appendChild(strip);
  const body = el("div", "fc-block-body");
  ns.forEach((n) => {
    const s = el("section", "fc-claim", { id: "fc-claim-" + n, "data-claim": n });
    const h = el("h3");
    h.textContent = "❌ Claim " + n + "/8 — a title";
    s.appendChild(h);
    body.appendChild(s);
  });
  block.appendChild(body);
  return block;
}

beforeEach(() => {
  doc.activeElement = null;
  doc.root = null;
  doc.listeners = [];
  (globalThis as unknown as { document: unknown }).document = doc;
});
afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveInsertionPoint", () => {
  test("an inline chip advances past the rest of its run to the next block", () => {
    // The real top-level shape: bare text, an inline mark + chip, more text,
    // then a heading. The card must land BEFORE the heading, never mid-sentence.
    const c = chip("1");
    const mark = el("span", "fc-mark fc-mark-ok");
    const head = el("h3");
    const { layer } = makeLayer([txt("Creatine loading is "), mark, c, txt(" — designed to …"), head]);

    const point = resolveInsertionPoint(c as unknown as Element, layer as unknown as Element);
    expect(point).not.toBeNull();
    expect(point!.before).toBe(head as unknown as Node);
  });

  test("a chip inside a list resolves to after the whole list", () => {
    const c = chip("4", "bad");
    const li = el("li");
    li.appendChild(c);
    const ul = el("ul");
    ul.appendChild(li);
    const after = el("h3");
    const { layer } = makeLayer([ul, after]);

    const point = resolveInsertionPoint(c as unknown as Element, layer as unknown as Element);
    expect(point!.before).toBe(after as unknown as Node);
  });

  test("an inline run at the very end of the layer appends (no block follows)", () => {
    const c = chip("1");
    const { layer } = makeLayer([txt("prose "), c, txt(" tail")]);
    const point = resolveInsertionPoint(c as unknown as Element, layer as unknown as Element);
    expect(point!.before).toBeNull();
  });

  test("a chip outside the layer resolves to nothing", () => {
    const c = chip("1");
    const { layer } = makeLayer([txt("prose")]);
    const orphan = el("div");
    orphan.appendChild(c);
    expect(resolveInsertionPoint(c as unknown as Element, layer as unknown as Element)).toBeNull();
  });
});

describe("buildCard", () => {
  test("strips every id, the code-tabs marker, and demotes headings", () => {
    const section = el("section", "fc-claim", { id: "fc-claim-4" });
    const h = el("h3", "claim-head");
    h.textContent = "❌ Claim 4/8 — creatine";
    section.appendChild(h);
    const inner = el("div", "code-tabs", { id: "inner", "data-code-tabs-enhanced": "1" });
    section.appendChild(inner);

    const card = buildCard("4", section as unknown as Element, "bad") as unknown as FEl;

    expect(card.id).toBe("fc-card-4");
    expect(card.className).toContain("fc-card-bad");
    expect(card.getAttribute("data-fc-card")).toBe("4");
    // The appendix keeps the only addressable ids.
    expect(card.querySelectorAll("[id]").length).toBe(0);
    expect(card.querySelectorAll("[data-code-tabs-enhanced]").length).toBe(0);
    // Heading demoted, text + class preserved.
    expect(card.querySelectorAll("h3").length).toBe(0);
    const heading = card.querySelectorAll("[role]").find((e) => e.getAttribute("role") === "heading");
    expect(heading).toBeDefined();
    expect(heading!.getAttribute("aria-level")).toBe("3");
    expect(heading!.className).toBe("claim-head");
    expect(heading!.textContent).toContain("Claim 4/8");
    // The original section is untouched — the clone is what got rewritten.
    expect(section.getAttribute("id")).toBe("fc-claim-4");
  });
});

describe("chipVerdict", () => {
  test("reads the verdict suffix, defaulting to unknown", () => {
    expect(chipVerdict(chip("1", "ok") as unknown as Element)).toBe("ok");
    expect(chipVerdict(chip("2", "warn") as unknown as Element)).toBe("warn");
    expect(chipVerdict(chip("3", "bad") as unknown as Element)).toBe("bad");
    expect(chipVerdict(el("button", "fc-chip") as unknown as Element)).toBe("unknown");
  });
});

describe("toggleLabelText", () => {
  test("the label is the toggle's only state signal", () => {
    expect(toggleLabelText(false)).toBe("Hide fact-check layer");
    expect(toggleLabelText(true)).toBe("Show fact-check layer");
  });
});

describe("enhanceFactCheck", () => {
  test("builds the toolbar once and never double-binds", () => {
    const c = chip("1");
    const { wrap, layer } = makeLayer([txt("prose "), c, appendix(["1"])]);

    enhanceFactCheck(wrap as unknown as ParentNode);
    expect(layer.getAttribute("data-fc-enhanced")).toBe("1");
    expect(layer.querySelectorAll(".fc-toolbar").length).toBe(1);
    expect(layer.querySelectorAll(".fc-toolbar-summary").length).toBe(1);
    expect(layer.querySelector(".fc-toolbar-toggle")!.textContent).toBe("Hide fact-check layer");
    // The toggle's state lives in its label — no aria-pressed to contradict it.
    expect(layer.querySelector(".fc-toolbar-toggle")!.getAttribute("aria-pressed")).toBeNull();
    const listeners = layer.listeners.length;

    enhanceFactCheck(wrap as unknown as ParentNode);
    expect(layer.querySelectorAll(".fc-toolbar").length).toBe(1);
    expect(layer.listeners.length).toBe(listeners);
    // The Escape handler is registered once, on first enhance — never at import.
    expect(doc.listeners.filter((l) => l.type === "keydown").length).toBe(1);
  });

  test("a page with marks but no appendix still gets a toggle-only toolbar", () => {
    const { wrap, layer } = makeLayer([txt("prose "), chip("1")]);
    enhanceFactCheck(wrap as unknown as ParentNode);
    expect(layer.querySelectorAll(".fc-toolbar-toggle").length).toBe(1);
    expect(layer.querySelectorAll(".fc-toolbar-summary").length).toBe(0);
  });

  test("a page with no annotation at all is a no-op", () => {
    const { wrap, layer } = makeLayer([txt("just prose")]);
    enhanceFactCheck(wrap as unknown as ParentNode);
    expect(layer.getAttribute("data-fc-enhanced")).toBeNull();
    expect(layer.querySelectorAll(".fc-toolbar").length).toBe(0);
  });
});
