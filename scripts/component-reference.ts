#!/usr/bin/env bun
/**
 * The component reference: one signature line per component taught to a
 * target, read off `COMPONENT_SPEC` and `COMPONENT_DOCS`, so the reference a
 * writer reads cannot drift from what the renderer accepts.
 *
 *   bun --no-env-file scripts/component-reference.ts --teach wiki|chat
 *
 * The mdx-explainer skill runs it at authoring time; there is no snapshot file.
 * Chat's prompt (`COMPONENT_VOCABULARY_RULES`) stays hand-written and has its
 * own drift test in `src/format/component-docs.test.ts`.
 *
 * Exit codes: 0 on success, 2 on a usage error.
 */

import { COMPONENT_NAMES, COMPONENT_SPEC, type AttrSpec, type AttrType, type ComponentName, type ComponentSpec } from "../src/format/component-spec.ts";
import { COMPONENT_DOCS, attrDoc, attrTeach, type TeachTarget } from "../src/format/component-docs.ts";

const USAGE = "usage: bun --no-env-file scripts/component-reference.ts --teach wiki|chat";
const TARGETS: readonly TeachTarget[] = ["wiki", "chat"];

const TYPE_TEXT: Record<AttrType, string> = {
  "iso-date": "iso-date",
  date: "iso-date|DD.MM.YYYY",
  number: "number",
  "positive-number": "positive-number",
};

const spec = (name: ComponentName): ComponentSpec => COMPONENT_SPEC[name];

/** One attribute as `name?: type = default`. */
function attrSignature(name: ComponentName, attr: string, a: AttrSpec): string {
  const doc = attrDoc(name, attr);
  const values = a.enum ? [...a.enum, ...(doc?.alsoAccepts ?? [])].map((v) => `"${v}"`).join("|") : undefined;
  const type = values ?? (a.type ? TYPE_TEXT[a.type] : (doc?.printType ?? "string"));
  const def = a.default === undefined ? "" : ` = ${typeof a.default === "string" ? `"${a.default}"` : a.default}`;
  return `${attr}${a.required || doc?.printRequired ? "" : "?"}: ${type}${def}`;
}

/** One component's signature line, with only the attributes taught to `teach`. */
export function componentLine(name: ComponentName, teach: TeachTarget): string {
  const attrs = Object.entries(spec(name).attrs)
    .filter(([attr]) => attrTeach(name, attr).includes(teach))
    .map(([attr, a]) => attrSignature(name, attr, a));
  return `${name}(${attrs.join(", ")}) — ${COMPONENT_DOCS[name].doc}`;
}

const inlineFor = (s: ComponentSpec, teach: TeachTarget): boolean => s.inline === true && teach !== "chat";

// Chat gets no inline group: `COMPONENT_VOCABULARY_RULES` teaches all six as block-only.
const GROUPS: readonly { heading: string; has: (s: ComponentSpec, teach: TeachTarget) => boolean }[] = [
  { heading: "Block: opening and closing tags each on a line of their own, flush left.", has: (s, t) => !inlineFor(s, t) && !s.selfClosing },
  { heading: "Block, may also self-close: <Name … /> on a line of its own.", has: (s, t) => !inlineFor(s, t) && s.selfClosing === true },
  { heading: "Inline: mid-sentence or on a line of their own; may also self-close.", has: (s, t) => inlineFor(s, t) },
];

/** The reference for one target: each group's heading, then its components in spec order. */
export function componentReference(teach: TeachTarget): string[] {
  const taught = COMPONENT_NAMES.filter((n) => COMPONENT_DOCS[n].teach.includes(teach));
  const out: string[] = [];
  for (const g of GROUPS) {
    const names = taught.filter((n) => g.has(spec(n), teach));
    if (names.length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(`# ${g.heading}`, ...names.map((n) => componentLine(n, teach)));
  }
  return out;
}

/** The exit code and the lines to print for one invocation. */
export function runComponentReference(args: readonly string[]): { code: number; out: string[]; err: string[] } {
  const teach = args.length === 2 && args[0] === "--teach" ? TARGETS.find((t) => t === args[1]) : undefined;
  if (!teach) return { code: 2, out: [], err: [USAGE] };
  return { code: 0, out: componentReference(teach), err: [] };
}

if (import.meta.main) {
  const { code, out, err } = runComponentReference(process.argv.slice(2));
  for (const line of out) process.stdout.write(`${line}\n`);
  for (const line of err) process.stderr.write(`${line}\n`);
  process.exit(code);
}
