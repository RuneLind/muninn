/**
 * The state of each key NAME a `.env` file assigns, for the `env` probe. Pure.
 * A value is read only far enough to tell empty from non-empty; no value, nor
 * any part of one, leaves this function.
 *
 * A closed grammar: the reader keeps track only when EVERY line (split on
 * `\n`, one trailing `\r` dropped) is one of
 *   - empty;
 *   - `#` then printable ASCII (0x20–0x7E);
 *   - `[export ]KEY=VALUE`: `export` and exactly one space, KEY
 *     `[A-Za-z_][A-Za-z0-9_]*`, no whitespace around `=`, and VALUE one of
 *     empty (`unset`); one or more SAFE characters (`set`); `"…"` or `'…'`
 *     closing at the line's end, its body SAFE characters and spaces (`set`
 *     with a SAFE character in it, `unset` when empty).
 * SAFE is 0x21–0x7E minus `"` `'` `` ` `` `\` `$` `#`. Anything else (a
 * spaces-only quoted body, leading or trailing whitespace, a tab, non-ASCII,
 * a control character, a BOM, an inline comment, a colon form) sets
 * `lostTrack`: no key is claimed and the probe answers `unknown`. The last
 * assignment of a key decides, as in Bun. `env-names.test.ts` holds every
 * production to a child `bun --env-file` (Bun 1.3.10): every character in
 * eight positions, two-character values, and seeded whole files.
 */

export type EnvKeyState = "set" | "unset";

export type EnvKeyStates =
  | { keys: ReadonlyMap<string, EnvKeyState>; lostTrack: false }
  /** `lostLine`: the first line out of the grammar, 1-based. */
  | { keys: ReadonlyMap<string, EnvKeyState>; lostTrack: true; lostLine: number };

const SAFE = String.raw`\x21\x25\x26\x28-\x5B\x5D-\x5F\x61-\x7E`;
const COMMENT = /^#[\x20-\x7E]*$/;
const ASSIGN = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const UNQUOTED = new RegExp(`^[${SAFE}]+$`);
const QUOTED = new RegExp(`^(?:"([${SAFE} ]*)"|'([${SAFE} ]*)')$`);
const HAS_SAFE = new RegExp(`[${SAFE}]`);

/** One assignment's value: its state, or null when the line is out of the grammar. */
function valueState(value: string): EnvKeyState | null {
  if (value === "") return "unset";
  if (UNQUOTED.test(value)) return "set";
  const q = QUOTED.exec(value);
  if (!q) return null;
  const body = q[1] ?? q[2]!;
  if (body === "") return "unset";
  return HAS_SAFE.test(body) ? "set" : null;
}

export function envFileKeyStates(text: string): EnvKeyStates {
  const keys = new Map<string, EnvKeyState>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || COMMENT.test(line)) continue;
    const m = ASSIGN.exec(line);
    const state = m ? valueState(m[2]!) : null;
    if (!m || !state) return { keys: new Map(), lostTrack: true, lostLine: i + 1 };
    keys.set(m[1]!, state);
  }
  return { keys, lostTrack: false };
}
