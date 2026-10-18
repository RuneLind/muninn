import { describe, expect, test } from "bun:test";
import { COMPONENT_DOCS, attrTeach, type ComponentDoc } from "./component-docs.ts";
import { COMPONENT_ATTRS, COMPONENT_NAMES, COMPONENT_SPEC, type AttrSpec, type ComponentName } from "./component-spec.ts";
import { COMPONENT_VOCABULARY_RULES } from "../research/answer.ts";

const docs = COMPONENT_DOCS as Record<ComponentName, ComponentDoc>;
const attrSpec = (name: ComponentName, attr: string) => (COMPONENT_SPEC[name].attrs as Record<string, AttrSpec>)[attr]!;

test("loads first in a fresh process without a ReferenceError", () => {
  // A fresh `bun` process, so the import order is this file's alone and no
  // other test file has loaded component-spec.ts first.
  const proc = Bun.spawnSync(
    ["bun", "-e", `const d = await import(${JSON.stringify(`${import.meta.dir}/component-docs.ts`)}); console.log(Object.keys(d.COMPONENT_DOCS).length);`],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe("30");
});

test("documents every component, and only spec attributes", () => {
  expect(Object.keys(docs)).toEqual([...COMPONENT_NAMES]);
  for (const name of COMPONENT_NAMES) {
    for (const attr of Object.keys(docs[name].attrs ?? {})) expect({ name, attr, ok: COMPONENT_ATTRS[name].includes(attr) }).toEqual({ name, attr, ok: true });
  }
});

test("wiki teach set is every component but Fact and FactCheck", () => {
  const wiki = COMPONENT_NAMES.filter((n) => docs[n].teach.includes("wiki"));
  expect(wiki).toEqual(COMPONENT_NAMES.filter((n) => n !== "Fact" && n !== "FactCheck"));
});

test("chat teach set is exactly what COMPONENT_VOCABULARY_RULES names", () => {
  const taughtNames = new Set([...COMPONENT_VOCABULARY_RULES.matchAll(/<([A-Z][A-Za-z]*)/g)].map((m) => m[1]!));
  const chat = COMPONENT_NAMES.filter((n) => docs[n].teach.includes("chat"));
  expect((chat as string[]).sort()).toEqual([...taughtNames].sort());
  // Attributes: every `attr="` the rules show on a tag, per component.
  const taughtAttrs = new Set<string>();
  for (const m of COMPONENT_VOCABULARY_RULES.matchAll(/<([A-Z][A-Za-z]*)([^>]*)>/g)) {
    for (const a of m[2]!.matchAll(/([a-z]+)="/g)) taughtAttrs.add(`${m[1]}.${a[1]}`);
  }
  const chatAttrs = chat.flatMap((n) => COMPONENT_ATTRS[n].filter((a) => attrTeach(n, a).includes("chat")).map((a) => `${n}.${a}`));
  expect(chatAttrs.sort()).toEqual([...taughtAttrs].sort());
});

describe("hints", () => {
  test("every suggest target parses with fellBack false; every source falls back", () => {
    let n = 0;
    for (const name of COMPONENT_NAMES) {
      for (const [attr, d] of Object.entries(docs[name].attrs ?? {})) {
        if (!d) continue;
        for (const [from, to] of Object.entries(d.suggest ?? {})) {
          expect({ name, attr, to, fellBack: attrSpec(name, attr).parse(to).fellBack }).toEqual({ name, attr, to, fellBack: false });
          expect({ name, attr, from, fellBack: attrSpec(name, attr).parse(from).fellBack }).toEqual({ name, attr, from, fellBack: true });
          n++;
        }
        for (const from of Object.keys(d.hint ?? {})) expect(attrSpec(name, attr).parse(from).fellBack).toBe(true);
      }
      for (const to of Object.values(docs[name].attrAliases ?? {})) expect(COMPONENT_ATTRS[name]).toContain(to);
    }
    expect(n).toBeGreaterThan(0);
  });

  test("the named hints", () => {
    const tone = docs.Callout.attrs!.tone!.suggest!;
    expect([tone.success, tone.ok, tone.pass, tone.caution, tone.note, tone.tip, tone.warning]).toEqual(["good", "good", "good", "warn", "info", "info", "warn"]);
    expect(docs.Callout.attrAliases).toEqual({ type: "tone" });
    expect(docs.Lane.attrs!.kind!.suggest).toEqual({ next: "waiting" });
    expect(docs.Verdict.attrs!.value!.hint!.maybe).toContain("warn Callout");
    expect(docs.Verdict.attrs!.value!.suggest).toBeUndefined();
  });
});
