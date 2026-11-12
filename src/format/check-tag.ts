/**
 * `<Check …/>` on a `you` step's line (mimir plan muninn-wiki-owner-step-checks,
 * PR 1): the typed read of its attributes, the checks one step names, and the
 * rule that makes the tag vanish from a text surface. Pure and server-side: the
 * web renderer only copies the whitelisted attributes into its empty slot, so
 * none of this rides the browser bundle.
 *
 * A check never writes and never removes a step: it names facts a probe can
 * read. The tag sits at the end of the step's own line (decision D4): on a line
 * of its own the list parser ends the list there and Done leaves the tag behind.
 */

import { scanInlineComponents, type InlineSegment } from "./markdown-ast.ts";
import { lineCodeSpanRanges } from "./code-spans.ts";

/** The attributes that each name one probe, in spec order. `on` is not one. */
export const CHECK_PROBES = ["env", "migration", "checkout", "pushed", "restart"] as const;
export type CheckProbeKind = (typeof CHECK_PROBES)[number];

const REPO = /^[A-Za-z0-9][\w.-]*$/;
const PROBE_SHAPE: Record<CheckProbeKind, { re: RegExp; accepts: string }> = {
  env: { re: /^[A-Za-z_][A-Za-z0-9_]*$/, accepts: "an env key name (letters, digits, _)" },
  migration: { re: /^\d{1,6}$/, accepts: "a schema_migrations version (digits)" },
  checkout: { re: REPO, accepts: "a repo name" },
  pushed: { re: REPO, accepts: "a repo name" },
  restart: { re: /^\d{1,5}$/, accepts: "a port number (digits)" },
};
const MACHINE = /^[A-Za-z0-9][\w.-]*$/;

export interface CheckProbe {
  kind: CheckProbeKind;
  value: string;
}

export interface StepCheck {
  /** The usable probes, in spec order. */
  probes: CheckProbe[];
  /** The machines that must hold it; null means the reader's own machine. */
  on: string[] | null;
  /** Why an attribute was not used: one line each. Empty when all were. */
  problems: string[];
}

/**
 * A `<Check>`'s attributes (as `parseAttrs` whitelisted them) read into probes.
 * A blank value is missing; a value of the wrong shape is dropped with a
 * problem line, so a typo never becomes a probe that reads the wrong fact.
 */
export function parseCheckAttrs(attrs: Readonly<Record<string, string>>): StepCheck {
  const probes: CheckProbe[] = [];
  const problems: string[] = [];
  for (const kind of CHECK_PROBES) {
    const raw = attrs[kind]?.trim();
    if (!raw) continue;
    const shape = PROBE_SHAPE[kind];
    if (shape.re.test(raw)) probes.push({ kind, value: raw });
    else problems.push(`${kind}=${JSON.stringify(attrs[kind])} is not ${shape.accepts}; the probe is dropped`);
  }
  let on: string[] | null = null;
  const rawOn = attrs.on?.trim();
  if (rawOn) {
    const names = rawOn.split(",").map((s) => s.trim());
    if (names.every((n) => MACHINE.test(n))) on = [...new Set(names)];
    else problems.push(`on=${JSON.stringify(attrs.on)} is not a comma-separated list of machine names; the check holds for the reader's machine`);
  }
  if (probes.length === 0) problems.push(`names no probe: give one of ${CHECK_PROBES.join(", ")}`);
  return { probes, on, problems };
}

/** The `<Check>` tags on one step's text, in order. A tag inside a code span
 *  is text, as the renderers read it. */
export function stepChecks(text: string): StepCheck[] {
  const out: StepCheck[] = [];
  for (const line of text.split("\n")) {
    let masked = line;
    for (const r of lineCodeSpanRanges(line)) masked = masked.slice(0, r.start) + " ".repeat(r.end - r.start) + masked.slice(r.end);
    for (const seg of scanInlineComponents(masked)) if (seg.kind === "component" && seg.name === "Check") out.push(parseCheckAttrs(seg.attrs));
  }
  return out;
}

/**
 * `segs` with every `<Check>` gone, for a text surface that prints nothing
 * for it. The spaces before the tag go with it (`restart. <Check …/>` reads
 * `restart.`); a tag with no text before it takes the spaces after it, so
 * no surface gets a doubled or a leading space where the tag was.
 */
export function withoutChecks(segs: readonly InlineSegment[]): InlineSegment[] {
  const out: InlineSegment[] = [];
  let dropLead = false;
  for (const seg of segs) {
    if (seg.kind === "component" && seg.name === "Check") {
      const prev = out[out.length - 1];
      if (prev?.kind === "text") prev.text = prev.text.replace(/[ \t]+$/, "");
      dropLead = prev === undefined || (prev.kind === "text" && prev.text === "");
      continue;
    }
    if (seg.kind === "text") {
      const text = dropLead ? seg.text.replace(/^[ \t]+/, "") : seg.text;
      dropLead = false;
      const prev = out[out.length - 1];
      if (prev?.kind === "text") prev.text += text;
      else out.push({ kind: "text", text });
      continue;
    }
    dropLead = false;
    out.push(seg);
  }
  return out;
}
