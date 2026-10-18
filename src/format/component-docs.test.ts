import { describe, expect, test } from "bun:test";
import { COMPONENT_DOCS, attrAliasFor, attrTeach, hintFor, suggestFor, type ComponentDoc } from "./component-docs.ts";
import { COMPONENT_ATTRS, COMPONENT_NAMES, COMPONENT_SPEC, type AttrSpec, type ComponentName } from "./component-spec.ts";
import { COMPONENT_VOCABULARY_RULES } from "../research/answer.ts";

const docs = COMPONENT_DOCS as Record<ComponentName, ComponentDoc>;
const attrSpec = (name: ComponentName, attr: string) => (COMPONENT_SPEC[name].attrs as Record<string, AttrSpec>)[attr]!;

const runtimeImports = async (file: string) =>
  new Bun.Transpiler({ loader: "ts" }).scanImports(await Bun.file(`${import.meta.dir}/${file}`).text()).map((i) => i.path).sort();

// component-spec.ts is bundled for the browser and imported by markdown-ast.ts,
// so a runtime import back into the renderer would be a cycle. Type-only
// imports are erased and `scanImports` leaves them out.
test("component-spec.ts imports only calendar-day.ts at runtime", async () => {
  expect(await runtimeImports("component-spec.ts")).toEqual(["./calendar-day.ts"]);
  expect(await runtimeImports("calendar-day.ts")).toEqual([]);
});

test("component-docs.ts imports nothing at runtime but component-spec.ts", async () => {
  for (const path of await runtimeImports("component-docs.ts")) expect(path).toBe("./component-spec.ts");
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

// The prompt string is hand-written (it is not generated from the spec), so this
// pins every value it shows: a tone renamed in the spec turns this red.
test("every value COMPONENT_VOCABULARY_RULES shows parses with fellBack false", () => {
  const shown: { name: string; attr: string; value: string }[] = [];
  for (const m of COMPONENT_VOCABULARY_RULES.matchAll(/<([A-Z][A-Za-z]*)([^>]*)>/g)) {
    for (const a of m[2]!.matchAll(/([a-z]+)="([^"]*)"/g)) {
      for (const value of a[2]!.split("|")) shown.push({ name: m[1]!, attr: a[1]!, value });
    }
  }
  expect(shown.length).toBeGreaterThanOrEqual(10);
  for (const { name, attr, value } of shown) {
    const fellBack = attrSpec(name as ComponentName, attr).parse(value).fellBack;
    expect({ name, attr, value, fellBack }).toEqual({ name, attr, value, fellBack: false });
  }
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

  test("a raw value that names an Object.prototype member finds nothing", () => {
    expect(suggestFor("Callout", "tone", "caution")).toBe("warn");
    expect(hintFor("Verdict", "value", "maybe")).toContain("warn Callout");
    expect(attrAliasFor("Callout", "type")).toBe("tone");
    for (const raw of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect({ raw, at: suggestFor("Callout", "tone", raw) }).toEqual({ raw, at: undefined });
      expect({ raw, at: hintFor("Verdict", "value", raw) }).toEqual({ raw, at: undefined });
      expect({ raw, at: attrAliasFor("Callout", raw) }).toEqual({ raw, at: undefined });
    }
  });
});

describe("the accepted-value and fallback text", () => {
  const checked = COMPONENT_NAMES.flatMap((name) =>
    Object.entries(COMPONENT_SPEC[name].attrs as Record<string, AttrSpec>)
      .filter(([, spec]) => spec.parse("\u0001not-a-value").fellBack)
      .map(([attr, spec]) => ({ name, attr, spec })),
  );

  test("every attribute that can fall back names what it accepts", () => {
    expect(checked.length).toBeGreaterThan(0);
    for (const { name, attr, spec } of checked) {
      const d = docs[name].attrs?.[attr as never] as { accepts?: string } | undefined;
      expect({ name, attr, named: spec.enum !== undefined || d?.accepts !== undefined }).toEqual({ name, attr, named: true });
    }
  });

  test("accepts is only for non-enum attributes, alsoAccepts only beside an enum", () => {
    for (const name of COMPONENT_NAMES) {
      for (const [attr, d] of Object.entries(docs[name].attrs ?? {})) {
        const spec = attrSpec(name, attr);
        if (d?.accepts !== undefined) expect({ name, attr, enum: spec.enum }).toEqual({ name, attr, enum: undefined });
        if (d?.alsoAccepts !== undefined) {
          expect(spec.enum).toBeDefined();
          for (const v of d.alsoAccepts) expect({ name, attr, v, fellBack: spec.parse(v).fellBack }).toEqual({ name, attr, v, fellBack: false });
        }
        if (d?.onFallback?.includes("{default}")) expect(spec.default).toBeDefined();
        if (d?.onFallbackWhen) expect(COMPONENT_ATTRS[name]).toContain(d.onFallbackWhen.attr);
      }
    }
  });

  // The reference generator prints `type`, not `accepts`; an attribute with
  // only `accepts` would print as a bare string.
  test("an attribute with accepts has a type", () => {
    for (const name of COMPONENT_NAMES) {
      for (const [attr, d] of Object.entries(docs[name].attrs ?? {})) {
        if (d?.accepts !== undefined) expect({ name, attr, type: attrSpec(name, attr).type !== undefined }).toEqual({ name, attr, type: true });
      }
    }
  });

  test("Fact v's alsoAccepts is the spec's glyph list, in its order", () => {
    expect(docs.Fact.attrs!.v!.alsoAccepts).toEqual(Object.keys(COMPONENT_SPEC.Fact.attrs.v.aliases));
  });

  test("a component with a required attribute says what it renders without it, and only then", () => {
    for (const name of COMPONENT_NAMES) {
      const required = Object.values(COMPONENT_SPEC[name].attrs as Record<string, AttrSpec>).some((s) => s.required);
      expect({ name, has: docs[name].onMissingRequired !== undefined }).toEqual({ name, has: required });
    }
  });
});
