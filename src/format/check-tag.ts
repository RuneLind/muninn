/**
 * `<Check …/>` on a `you` step's line (mimir plan muninn-wiki-owner-step-checks,
 * PR 1): the typed read of its attributes, the one check a step names, and the
 * reader's empty slot. Server-only: nothing in the `/wiki` or chat bundle
 * imports this file (`renderWikiHtml` hands `checkSlotHtml` to `formatWebHtml`
 * as its `checkSlot` option). Placement is `check-trailing.ts`.
 */

import { parseAttrs } from "./markdown-ast.ts";
import { escapeHtml } from "./markdown-core.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { pairSource, trailingCheck } from "./check-trailing.ts";

/** The attributes that each name one probe, in spec order. `on` is not one. */
export const CHECK_PROBES = ["env", "migration", "checkout", "pushed", "restart"] as const;
export type CheckProbeKind = (typeof CHECK_PROBES)[number];

const REPO = /^[A-Za-z0-9][\w.-]*$/;
const PROBE_SHAPE: Record<CheckProbeKind, { re: RegExp; accepts: string }> = {
  env: { re: /^[A-Za-z_][A-Za-z0-9_]*$/, accepts: "an env key (letters, digits, _; not starting with a digit)" },
  // schema_migrations.version is the file's zero-padded prefix: `086`, never `86`.
  migration: { re: /^\d{3,}$/, accepts: "a schema_migrations version, zero-padded to at least 3 digits (086)" },
  checkout: { re: REPO, accepts: "a repo name" },
  pushed: { re: REPO, accepts: "a repo name" },
  restart: { re: /^\d{1,5}$/, accepts: "a port (1 to 5 digits)" },
};
const MACHINE = /^[a-z0-9][\w.-]*$/;

export interface CheckProbe {
  kind: CheckProbeKind;
  value: string;
}

export interface CheckAttrs {
  /** The usable probes, in spec order. */
  probes: CheckProbe[];
  /** The machines that must hold it, lower-cased and deduped; null means the
   *  reader's own machine. */
  on: string[] | null;
  /** Why an attribute was not used: one line per attribute. Empty when all were. */
  problems: string[];
}

/**
 * A `<Check>`'s attributes (as `parseAttrs` whitelisted them) read into probes.
 * A value of the wrong shape is dropped with one problem line, so a typo never
 * becomes a probe that reads the wrong fact. "Names no probe" is only for a tag
 * with no probe attribute at all: a dropped one already has its line.
 */
export function parseCheckAttrs(attrs: Readonly<Record<string, string>>): CheckAttrs {
  const probes: CheckProbe[] = [];
  const problems: string[] = [];
  let named = false;
  for (const kind of CHECK_PROBES) {
    const raw = attrs[kind];
    if (raw === undefined) continue;
    named = true;
    const shape = PROBE_SHAPE[kind];
    if (shape.re.test(raw)) probes.push({ kind, value: raw });
    else problems.push(`${kind}=${JSON.stringify(raw)} is not ${shape.accepts}; the probe is dropped`);
  }
  let on: string[] | null = null;
  if (attrs.on !== undefined) {
    const names = attrs.on.split(",").map((s) => s.trim().toLowerCase());
    const good = [...new Set(names.filter((n) => MACHINE.test(n)))];
    if (names.some((n) => !MACHINE.test(n))) {
      problems.push(`on=${JSON.stringify(attrs.on)} is not a comma-separated list of machine names; ${good.length ? `only ${good.join(", ")} counts` : "the check holds for the reader's machine"}`);
    }
    on = good.length ? good : null;
  }
  if (!named) problems.push(`names no probe: give one of ${CHECK_PROBES.join(", ")}`);
  return { probes, on, problems };
}

const CHECK_ATTR_NAMES: readonly string[] = [...CHECK_PROBES, "on"];
const PAIR = new RegExp(pairSource(true), "y");

/**
 * A raw attribute run read against a closed grammar: in full, `name="value"`
 * pairs led by spaces or tabs, in placement's own alphabet ({@link pairSource}:
 * no `"`, backtick or newline in a value), each name one of the six spec attributes, each at most
 * once. Anything else gives a problem line, so the step can never read `ok`:
 * one line per repeated spec name, however often it repeats, one line per
 * unread pair (an unknown name repeated is named each time), one for leftover
 * text. Without them `parseAttrs` would drop an unknown name and let a repeated one overwrite in
 * silence. A repeated name keeps its last value, as the renderer and lint do.
 */
export function readCheckRun(raw: string): { attrs: Record<string, string>; problems: string[] } {
  const attrs: Record<string, string> = {};
  const problems: string[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  let at = 0;
  let m: RegExpExecArray | null;
  PAIR.lastIndex = 0;
  while ((m = PAIR.exec(raw)) !== null) {
    at = PAIR.lastIndex;
    const name = m[1]!;
    const value = m[2]!;
    if (!CHECK_ATTR_NAMES.includes(name)) {
      problems.push(`${name}=${JSON.stringify(value)} is not a Check attribute; it is not read`);
      continue;
    }
    // One line per repeated name, however often it repeats.
    if (seen.has(name) && !repeated.has(name)) {
      repeated.add(name);
      problems.push(`${name} is given more than once; only the last is read`);
    }
    seen.add(name);
    attrs[name] = value;
  }
  const rest = raw.slice(at).replace(/^[ \t]+|[ \t]+$/g, "");
  if (rest) problems.push(`${JSON.stringify(rest)} is not a name="value" pair; it is not read`);
  return { attrs, problems };
}

/** The one validly placed check on a step's first line, or null: the tag must
 *  be the last thing on that line (`check-trailing.ts`). An earlier tag on the
 *  line, or one on a later line, is no check (lint `check-placement`). Its
 *  problems: the run's grammar lines ({@link readCheckRun}), then
 *  `parseCheckAttrs`'s; `checkedSteps` appends `ANOTHER_CHECK` after both. */
export function stepCheck(stepFirstLine: string): CheckAttrs | null {
  const t = trailingCheck(stepFirstLine.split("\n")[0]!);
  if (!t) return null;
  const run = readCheckRun(t[1]);
  const read = parseCheckAttrs(run.attrs);
  return { ...read, problems: [...run.problems, ...read.problems] };
}

/** The reader's empty slot for a trailing tag's raw attribute run: only the
 *  six spec attributes, values escaped, for the probe chip to fill. */
export function checkSlotHtml(rawAttrs: string): string {
  const data = Object.entries(parseAttrs(rawAttrs, "Check"))
    .map(([k, v]) => ` data-check-${k}="${escapeHtml(v)}"`)
    .join("");
  return `<span class="step-check" ${READER_ONLY_ATTR}${data}></span>`;
}
