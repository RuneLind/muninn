import { expect, test } from "bun:test";
import path from "node:path";
import { componentLine, componentReference, runComponentReference } from "./component-reference.ts";
import { COMPONENT_NAMES, COMPONENT_SPEC, type AttrSpec, type ComponentName } from "../src/format/component-spec.ts";

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
