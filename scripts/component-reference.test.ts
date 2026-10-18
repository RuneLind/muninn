import { describe, expect, test } from "bun:test";
import path from "node:path";
import { attrSignature, componentLine, componentReference, runComponentReference } from "./component-reference.ts";
import { COMPONENT_NAMES, COMPONENT_SPEC, FACT_VERDICT_GLYPHS, type AttrSpec, type AttrType, type ComponentName } from "../src/format/component-spec.ts";
import { COMPONENT_DOCS } from "../src/format/component-docs.ts";
import { DELTA_DECIMALS, DELTA_DIRECTIONS, parseDeltaAttrs } from "../src/format/delta-table.ts";
import { parseEmbedAttrs } from "../src/format/embed.ts";
import { FOLD_FOR_CLASSES, formatWebHtml } from "../src/web/web-format.ts";

const SCRIPT = path.join(import.meta.dir, "component-reference.ts");
const namesIn = (lines: string[]) => lines.filter((l) => /^[A-Z]/.test(l)).map((l) => l.slice(0, l.indexOf("(")));

test("the Callout line, as the plan writes it", () => {
  expect(componentLine("Callout", "wiki")).toBe(
    'Callout(tone?: "info"|"warn"|"good"|"bad" = "info", title?: string, resolved?: iso-date) — Boxed aside. At most about 3 per section; never the page summary.',
  );
});

test("typed and required attributes", () => {
  expect(componentLine("Meter", "wiki")).toStartWith('Meter(value: number, max?: positive-number = 5, tone?: "default"|"good"|"warn"|"bad" = "default") — ');
  expect(componentLine("Lane", "wiki")).toContain("since?: iso-date|DD.MM.YYYY)");
});

test("wiki lists every component but Fact and FactCheck; chat the six the prompt names", () => {
  expect(namesIn(componentReference("wiki")).sort()).toEqual(COMPONENT_NAMES.filter((n) => n !== "Fact" && n !== "FactCheck").sort());
  expect(namesIn(componentReference("chat")).sort()).toEqual(["Callout", "ComparisonTable", "Figure", "FileRef", "Pill", "Verdict"]);
});

test("chat leaves out an attribute taught only to the wiki", () => {
  expect(componentLine("Callout", "chat")).not.toContain("resolved");
});

test("the inline group holds exactly the inline components", () => {
  const lines = componentReference("wiki");
  const start = lines.findIndex((l) => l.startsWith("# Inline"));
  expect(start).toBeGreaterThan(0);
  expect(namesIn(lines.slice(start))).toEqual(["Verdict", "Pill"]);
});

test("every enum value and default the reference prints parses with fellBack false", () => {
  for (const line of componentReference("wiki")) {
    if (!/^[A-Z]/.test(line)) continue;
    const name = line.slice(0, line.indexOf("(")) as ComponentName;
    for (const m of line.matchAll(/(\w+)\??: ((?:"[^"]*"\|?)+)(?: = "([^"]*)")?/g)) {
      const spec = (COMPONENT_SPEC[name].attrs as Record<string, AttrSpec>)[m[1]!]!;
      const values = [...m[2]!.matchAll(/"([^"]*)"/g)].map((v) => v[1]!);
      if (m[3] !== undefined) values.push(m[3]);
      for (const v of values) expect({ name, v, fellBack: spec.parse(v).fellBack }).toEqual({ name, v, fellBack: false });
    }
  }
});

// Samples per printed type: each `ok` must parse with fellBack false, each `off` must fall back.
const TYPE_SAMPLES: Record<AttrType, { ok: string[]; off: string[] }> = {
  "iso-date": { ok: ["2026-10-01"], off: ["abc", "01.10.2026"] },
  date: { ok: ["2026-10-01", "01.10.2026"], off: ["abc"] },
  number: { ok: ["-2", "3.5"], off: ["abc"] },
  "positive-number": { ok: ["0.5", "10"], off: ["abc", "0"] },
};

test("every spec default parses, and every typed attribute's parser agrees with its type", () => {
  let defaults = 0;
  let typed = 0;
  for (const name of COMPONENT_NAMES) {
    for (const [attr, a] of Object.entries(COMPONENT_SPEC[name].attrs as Record<string, AttrSpec>)) {
      if (a.default !== undefined) {
        const v = String(a.default);
        expect({ name, attr, v, fellBack: a.parse(v).fellBack }).toEqual({ name, attr, v, fellBack: false });
        defaults++;
      }
      if (a.type === undefined) continue;
      typed++;
      const { ok, off } = TYPE_SAMPLES[a.type];
      for (const v of ok) expect({ name, attr, v, fellBack: a.parse(v).fellBack }).toEqual({ name, attr, v, fellBack: false });
      for (const v of off) expect({ name, attr, v, fellBack: a.parse(v).fellBack }).toEqual({ name, attr, v, fellBack: true });
    }
  }
  expect(defaults).toBeGreaterThanOrEqual(7);
  expect(typed).toBeGreaterThanOrEqual(4);
});

test("the self-closing group prints its heading", () => {
  expect(componentReference("wiki")).toContain("# Block, may also self-close: <Name … /> on a line of its own.");
});

// Fact is taught to no target, so only a direct call reaches the alsoAccepts branch.
test("an enum attribute prints its alsoAccepts values after the enum", () => {
  const line = attrSignature("Fact", "v", COMPONENT_SPEC.Fact.attrs.v);
  const glyphs = Object.keys(FACT_VERDICT_GLYPHS);
  expect(glyphs.length).toBeGreaterThan(0);
  for (const g of glyphs) expect(line).toContain(`"${g}"`);
  expect(line).toEndWith(`|${glyphs.map((g) => `"${g}"`).join("|")} = "unknown"`);
});

test("a missing or unknown --teach is a usage error", () => {
  for (const args of [[], ["--teach"], ["--teach", "all"], ["wiki"], ["--teach", "wiki", "x"]]) {
    const r = runComponentReference(args);
    expect(r.code).toBe(2);
    expect(r.err[0]).toStartWith("usage:");
  }
});

test("the script prints the reference and exits non-zero on bad input", async () => {
  const ok = Bun.spawnSync(["bun", "--no-env-file", SCRIPT, "--teach", "chat"]);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toBe(`${componentReference("chat").join("\n")}\n`);
  const bad = Bun.spawnSync(["bun", "--no-env-file", SCRIPT, "--teach", "nope"]);
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain("usage:");
});

test("Embed prints src as required and height as pixels, as parseEmbedAttrs reads them", () => {
  expect(componentLine("Embed", "wiki")).toStartWith("Embed(src: string, height?: pixels (1–5 digits), title?: string) — ");
});

test("closed vocabularies the spec leaves unchecked print their accepted values", () => {
  expect(componentLine("DeltaTable", "wiki")).toStartWith(
    'DeltaTable(src?: string, better?: "lower"|"higher"|"<row>=lower|higher;…", decimal?: "comma"|"dot") — ',
  );
  expect(componentLine("Fold", "wiki")).toStartWith('Fold(title?: string, open?: "true", summary?: string, for?: "dev"|"agent") — ');
});

test("chat prints no inline group: its prompt teaches all six as block-only", () => {
  const lines = componentReference("chat");
  expect(lines.some((l) => l.startsWith("# Inline"))).toBe(false);
  expect(lines.filter((l) => l.startsWith("# ")).every((l) => l.startsWith("# Block"))).toBe(true);
  expect(namesIn(lines).sort()).toEqual(["Callout", "ComparisonTable", "Figure", "FileRef", "Pill", "Verdict"]);
});

// `printType` is hand-written display text the spec does not check (D9); these
// pin each one to the renderer code that decides the attribute.
describe("every printType names what the renderer accepts", () => {
  const printType = (name: "Fold" | "DeltaTable" | "Embed", attr: string) =>
    (COMPONENT_DOCS[name].attrs as Record<string, { printType?: string }>)[attr]!.printType!;
  const quoted = (t: string) => [...t.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const sorted = (xs: Iterable<string>) => [...xs].sort();

  test("Fold for: FOLD_FOR_CLASSES", () => {
    expect(sorted(quoted(printType("Fold", "for")))).toEqual(sorted(FOLD_FOR_CLASSES));
  });

  test("Fold open: the printed values expand the fold, and nothing else does", () => {
    const opened = (v: string) => formatWebHtml(`<Fold title="T" open="${v}">\n\nx\n\n</Fold>`).includes('<details class="fold" open>');
    const printed = quoted(printType("Fold", "open"));
    expect(printed.length).toBeGreaterThan(0);
    for (const v of printed) expect({ v, opened: opened(v) }).toEqual({ v, opened: true });
    for (const v of ["TRUE", "1", "yes", "open", ""]) expect({ v, opened: opened(v) }).toEqual({ v, opened: false });
  });

  test("DeltaTable decimal: DELTA_DECIMALS, each read without a warning", () => {
    const printed = quoted(printType("DeltaTable", "decimal"));
    expect(sorted(printed)).toEqual(sorted(DELTA_DECIMALS));
    for (const v of printed) expect(parseDeltaAttrs({ decimal: v })).toMatchObject({ decimal: v, decimalWarning: "" });
    expect(parseDeltaAttrs({ decimal: "point" }).decimalWarning).not.toBe("");
  });

  test("DeltaTable better: DELTA_DIRECTIONS, alone or per row", () => {
    const printed = quoted(printType("DeltaTable", "better"));
    const plain = printed.filter((v) => !v.includes("="));
    const perRow = printed.filter((v) => v.includes("="));
    expect(sorted(plain)).toEqual(sorted(DELTA_DIRECTIONS));
    for (const v of plain) expect(parseDeltaAttrs({ better: v })).toMatchObject({ better: v, warning: "" });
    expect(perRow).toEqual(["<row>=lower|higher;…"]);
    const rowDirections = perRow[0]!.slice(perRow[0]!.indexOf("=") + 1).replace(/;…$/, "").split("|");
    expect(sorted(rowDirections)).toEqual(sorted(DELTA_DIRECTIONS));
    const rows = parseDeltaAttrs({ better: rowDirections.map((d, i) => `Row ${i}=${d}`).join("; ") });
    expect({ warning: rows.warning, rows: rows.rows?.size }).toEqual({ warning: "", rows: rowDirections.length });
    expect(parseDeltaAttrs({ better: "up" }).warning).not.toBe("");
  });

  test("Embed height: parseEmbedAttrs accepts exactly the printed digit counts", () => {
    const m = printType("Embed", "height").match(/(\d+)–(\d+) digits/);
    expect(m).not.toBeNull();
    const [min, max] = [Number(m![1]), Number(m![2])];
    for (let n = Math.max(1, min - 1); n <= max + 1; n++) {
      const accepted = parseEmbedAttrs({ src: "x.html", height: "9".repeat(n) }) !== null;
      expect({ n, accepted }).toEqual({ n, accepted: n >= min && n <= max });
    }
    for (const v of ["-1", "1.5", "abc"]) expect({ v, accepted: parseEmbedAttrs({ src: "x.html", height: v }) !== null }).toEqual({ v, accepted: false });
  });
});
