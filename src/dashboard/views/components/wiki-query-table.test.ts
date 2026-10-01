import { test, expect, describe, afterEach } from "bun:test";
import { enhanceQueryTables, isNumericColumn, parseCellNumber, sortOrder } from "./wiki-query-table.ts";

/**
 * The repo has no DOM test environment, so `enhanceQueryTables` runs here over
 * a fake carrying exactly the members it touches — enough to call it twice on
 * one table and count what it built.
 */
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  listeners: Array<() => void> = [];
  text = "";
  className = "";
  type = "";
  title = "";
  constructor(public tag: string) {}
  get childNodes() { return [...this.children]; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.text = v; this.children = []; }
  get classList() { return { add: (c: string) => this.classes.add(c) }; }
  append(...nodes: FakeNode[]) {
    for (const n of nodes) {
      if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = this;
      this.children.push(n);
    }
  }
  addEventListener(_t: string, fn: () => void) { this.listeners.push(fn); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  all(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): FakeNode[] {
    if (sel === "table.query-table") return this.all().filter((n) => n.tag === "table");
    if (sel === ".query-sort-mark") return this.all().filter((n) => n.className === "query-sort-mark");
    throw new Error(`fake DOM: unsupported selector ${sel}`);
  }
  get rows() { return this.children.filter((c) => c.tag === "tr").map(rowView); }
  get tHead() { const h = this.children.find((c) => c.tag === "thead"); return h ? { rows: h.rows } : null; }
  get tBodies() { return this.children.filter((c) => c.tag === "tbody"); }
  click() { for (const fn of this.listeners) fn(); }
}
const rowView = (tr: FakeNode) => Object.assign(tr, { cells: tr.children });
const el = (tag: string, ...kids: (FakeNode | string)[]) => {
  const n = new FakeNode(tag);
  for (const k of kids) {
    if (typeof k === "string") n.text = k;
    else n.append(k);
  }
  return n;
};
const fakeTable = (header: string[], rows: string[][]) =>
  el(
    "article",
    el(
      "table",
      el("thead", el("tr", ...header.map((h) => el("th", h)))),
      el("tbody", ...rows.map((r) => el("tr", ...r.map((c) => el("td", c))))),
    ),
  );

const realDocument = (globalThis as { document?: unknown }).document;
afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

describe("enhanceQueryTables", () => {
  test("idempotent: a second run adds no buttons, and one click sorts once", () => {
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => new FakeNode(t) };
    const root = fakeTable(["N"], [["10"], ["9"], ["100"]]);
    enhanceQueryTables(root as unknown as ParentNode);
    enhanceQueryTables(root as unknown as ParentNode);
    const th = root.all().find((n) => n.tag === "th")!;
    const buttons = th.all().filter((n) => n.tag === "button");
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    const firstCell = () => root.all().filter((n) => n.tag === "td")[0]!.textContent;
    expect(firstCell()).toBe("9");
  });

  test("a numeric column's header and cells are marked query-num; a text column is not", () => {
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => new FakeNode(t) };
    const root = fakeTable(["SAK", "N"], [["MEL-1", "1 000"], ["MEL-2", "NULL"]]);
    enhanceQueryTables(root as unknown as ParentNode);
    const ths = root.all().filter((n) => n.tag === "th");
    const tds = root.all().filter((n) => n.tag === "td");
    expect(ths.map((t) => t.classes.has("query-num"))).toEqual([false, true]);
    expect(tds.map((t) => t.classes.has("query-num"))).toEqual([false, true, false, true]);
  });
});

describe("Query table sorting", () => {
  test("numbers: integers, decimals (dot or comma), signs, exponents; not ids or dates", () => {
    expect(parseCellNumber(" 42 ")).toBe(42);
    expect(parseCellNumber("-1.5")).toBe(-1.5);
    expect(parseCellNumber("1,5")).toBe(1.5);
    expect(parseCellNumber("1e3")).toBe(1000);
    for (const s of ["MEL-1", "2026-09-30", "", "0x10", "Infinity"]) expect(parseCellNumber(s)).toBeNull();
  });

  test("a column is numeric when every non-empty cell is a number", () => {
    expect(isNumericColumn(["10", "", "9"])).toBe(true);
    expect(isNumericColumn(["10", "x"])).toBe(false);
    expect(isNumericColumn(["", " "])).toBe(false);
  });

  test("numeric sort compares values, not text", () => {
    expect(sortOrder(["10", "9", "100"], "ascending")).toEqual([1, 0, 2]);
    expect(sortOrder(["10", "9", "100"], "descending")).toEqual([2, 0, 1]);
  });

  test("text sort uses Norwegian collation (æ ø å after z)", () => {
    const cells = ["å", "z", "æ", "a", "ø"];
    expect(sortOrder(cells, "ascending").map((i) => cells[i])).toEqual(["a", "z", "æ", "ø", "å"]);
  });

  test("text sort is natural: the number inside a key compares as a number", () => {
    const cells = ["MEL-1172008", "MEL-368918", "MEL-1018756", "MEL-232147"];
    expect(sortOrder(cells, "ascending").map((i) => cells[i])).toEqual([
      "MEL-232147",
      "MEL-368918",
      "MEL-1018756",
      "MEL-1172008",
    ]);
  });

  test("NULL, [NULL] and null read as empty: a column of numbers and NULLs is numeric, NULLs last", () => {
    const cells = ["10", "NULL", "9", "[NULL]", "null", "100"];
    expect(isNumericColumn(cells)).toBe(true);
    expect(sortOrder(cells, "ascending").map((i) => cells[i])).toEqual(["9", "10", "100", "NULL", "[NULL]", "null"]);
  });

  test("number shapes: Unicode minus, space-grouped thousands, comma-grouped thousands, decimal comma", () => {
    expect(parseCellNumber("−5")).toBe(-5);
    expect(parseCellNumber("1 000")).toBe(1000);
    expect(parseCellNumber("1\u00a0000")).toBe(1000);
    expect(parseCellNumber("12\u202f345,5")).toBe(12345.5);
    expect(parseCellNumber("1,500")).toBe(1500);
    expect(parseCellNumber("1,234,567")).toBe(1234567);
    expect(parseCellNumber("1,234,567.25")).toBe(1234567.25);
    expect(parseCellNumber("2,5")).toBe(2.5);
    expect(parseCellNumber("2211.7")).toBe(2211.7);
    expect(parseCellNumber("-16422")).toBe(-16422);
    expect(parseCellNumber("1,23")).toBe(1.23);
    for (const s of ["1 00", "1,5,0", "12 345 6", "1 000,000,5"]) expect(parseCellNumber(s), s).toBeNull();
  });

  test("stable in both directions; empty cells last in both", () => {
    const cells = ["b", "", "a", "b", "a"];
    expect(sortOrder(cells, "ascending")).toEqual([2, 4, 0, 3, 1]);
    expect(sortOrder(cells, "descending")).toEqual([0, 3, 2, 4, 1]);
  });
});

describe("Query table sorting — the column rule (enumerated)", () => {
  const sorted = (cells: string[], dir: "ascending" | "descending" = "ascending") =>
    sortOrder(cells, dir).map((i) => cells[i]);
  const isBlank = (c: string) => c === "" || c === "NULL" || c === "[NULL]";
  /** Every value the sort's comparator returns during one `sortOrder` call,
   *  captured by wrapping `Array.prototype.sort` for that call only. */
  function comparatorResults(cells: string[], dir: "ascending" | "descending"): number[] {
    const seen: number[] = [];
    const real = Array.prototype.sort;
    Array.prototype.sort = function (this: unknown[], cmp?: (a: unknown, b: unknown) => number) {
      const wrapped = cmp && ((a: unknown, b: unknown) => {
        const r = cmp(a, b);
        seen.push(r);
        return r;
      });
      return real.call(this, wrapped);
    } as typeof real;
    try {
      sortOrder(cells, dir);
    } finally {
      Array.prototype.sort = real;
    }
    return seen;
  }
  const big = (d: string) => d.repeat(400);
  // Each row: input cells, expected ascending order. Descending is the reverse
  // of the non-empty cells, with the empty cells still last in input order.
  const TABLE: Array<[string, string[], string[]]> = [
    ["MEL ids", ["MEL-1018756", "MEL-100", "MEL-232147", "MEL-9", "MEL-10"],
      ["MEL-9", "MEL-10", "MEL-100", "MEL-232147", "MEL-1018756"]],
    ["IPv4 addresses", ["10.0.0.12", "10.0.0.9", "10.0.0.10"], ["10.0.0.9", "10.0.0.10", "10.0.0.12"]],
    ["host + IPv4", ["host 192.168.1.100", "host 192.168.1.20"], ["host 192.168.1.20", "host 192.168.1.100"]],
    ["dotted dates", ["1.10.2026", "1.9.2026"], ["1.9.2026", "1.10.2026"]],
    ["versions", ["v1.10", "v1.9", "v1.2"], ["v1.2", "v1.9", "v1.10"]],
    ["ISO datetimes with fractional seconds",
      ["2026-09-08 17:24:05.500", "2026-09-08 17:24:05.120", "2026-09-08 09:05:00.000", "2026-09-08 17:24:05.900"],
      ["2026-09-08 09:05:00.000", "2026-09-08 17:24:05.120", "2026-09-08 17:24:05.500", "2026-09-08 17:24:05.900"]],
    ["19-digit ids in text", ["ID-1234567890123456789", "ID-1234567890123456788"],
      ["ID-1234567890123456788", "ID-1234567890123456789"]],
    ["19-digit plain ids", ["1234567890123456789", "1234567890123456788"],
      ["1234567890123456788", "1234567890123456789"]],
    ["400-digit runs", [`x${big("9")}`, `x${big("1")}`, "x5"], ["x5", `x${big("1")}`, `x${big("9")}`]],
    ["plain numbers", ["10", "-1.5", "2,5", "1 000", "−5", "1,234.5", "0.25"],
      ["−5", "-1.5", "0.25", "2,5", "10", "1 000", "1,234.5"]],
    ["number + unit, decimals", ["0.5 kr", "0.25 kr", "0.125 kr"], ["0.125 kr", "0.25 kr", "0.5 kr"]],
    ["number + unit, negatives", ["-5 x", "-10 x", "3 x"], ["-10 x", "-5 x", "3 x"]],
    ["number + unit, grouped and decimal comma", ["1 500 NOK", "900 NOK", "-2,5 NOK"],
      ["-2,5 NOK", "900 NOK", "1 500 NOK"]],
    ["plain numbers with one shared unit", ["10 %", "9", "-1 %"], ["-1 %", "9", "10 %"]],
    ["mixed units fall to collation", ["0.25 x", "0.5 kr"], ["0.5 kr", "0.25 x"]],
    ["words with æøå", ["Ås", "Zebra", "Øst", "Ærlig", "Alfa"], ["Alfa", "Zebra", "Ærlig", "Øst", "Ås"]],
    ["empty and NULL cells", ["MEL-10", "", "MEL-9", "NULL", "[NULL]"], ["MEL-9", "MEL-10", "", "NULL", "[NULL]"]],
  ];
  for (const [name, cells, asc] of TABLE) {
    test(`${name}: ascending, then descending, every comparison finite`, () => {
      expect(sorted(cells)).toEqual(asc);
      const filled = asc.filter((c) => !isBlank(c));
      const empties = asc.filter(isBlank);
      expect(sorted(cells, "descending")).toEqual([...filled.reverse(), ...empties]);
      for (const dir of ["ascending", "descending"] as const) {
        expect(comparatorResults(cells, dir).every(Number.isFinite)).toBe(true);
      }
    });
  }

  test("a number + shared-unit column is right-aligned; a mixed-unit one is not", () => {
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => new FakeNode(t) };
    const root = fakeTable(["KR", "MIX"], [["0.5 kr", "5 kr"], ["0.25 kr", "3 x"]]);
    enhanceQueryTables(root as unknown as ParentNode);
    const ths = root.all().filter((n) => n.tag === "th");
    expect(ths.map((t) => t.classes.has("query-num"))).toEqual([true, false]);
  });
});
