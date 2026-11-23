/**
 * The state of each key NAME a `.env` file assigns, for the `env` probe. Pure.
 * A value is read only far enough to tell empty from non-empty; no value, nor
 * any part of one, leaves this function.
 *
 * It takes the file's raw BYTES, because Bun's loader parses raw bytes: a
 * decoded string hides what Bun sees. `Bun.file().text()` strips a leading
 * UTF-8 BOM (Bun then does not load the first line's key under its name),
 * decodes a UTF-16 file Bun loads nothing from, and turns ill-formed
 * UTF-8 into U+FFFD. Here each line (split on byte 0x0A, one trailing 0x0D
 * dropped) is decoded strictly (`fatal`, `ignoreBOM`): an ill-formed sequence
 * loses track on its line, and a BOM stays U+FEFF in the text.
 *
 * A closed grammar: the reader keeps track only when EVERY line is one of
 *   - empty;
 *   - `#` as the line's first character, then any of: tab, printable ASCII
 *     (0x20–0x7E), a Unicode scalar value at U+00A0 or above (U+FFFD and
 *     U+FEFF only where the file holds their own bytes);
 *   - `[export ]KEY=VALUE`: `export` and exactly one space, KEY
 *     `[A-Za-z_][A-Za-z0-9_]*`, no whitespace around `=`, and VALUE one of
 *     empty (`unset`); one or more SAFE characters (`set`); `"…"` or `'…'`
 *     closing at the line's end, its body SAFE characters and spaces (`set`
 *     with a SAFE character in it, `unset` when empty).
 * SAFE is 0x21–0x7E minus `"` `'` `` ` `` `\` `$` `#`. Anything else (ill-formed
 * UTF-8, a spaces-only quoted body, leading or trailing whitespace, a tab or
 * non-ASCII outside a comment, a C0 control but tab, DEL or a C1 control
 * anywhere, a BOM at the start of a line, so any file that starts with one,
 * an inline comment, a colon form) sets `lostTrack`: no key is claimed and the
 * probe answers `unknown`. Bun 1.3.10 kept every code point in a comment as
 * comment content; controls stay out because nothing needs them. The last
 * assignment of a key decides, as in Bun. `env-names.test.ts` holds every
 * production to a child `bun --env-file` (Bun 1.3.10) on the same bytes: every
 * character in eight positions, two-character values, code points in a
 * comment, byte-order marks in every place, UTF-16 and Latin-1 files, every
 * byte in seven places, two-byte and malformed sequences, and seeded files.
 */

export type EnvKeyState = "set" | "unset";

export type EnvKeyStates =
  | { keys: ReadonlyMap<string, EnvKeyState>; lostTrack: false }
  /** `lostLine`: the first line out of the grammar, 1-based. */
  | { keys: ReadonlyMap<string, EnvKeyState>; lostTrack: true; lostLine: number };

const SAFE = String.raw`\x21\x25\x26\x28-\x5B\x5D-\x5F\x61-\x7E`;
const COMMENT = /^#[\t\x20-\x7E\u00A0-\uD7FF\uE000-\u{10FFFF}]*$/u;
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

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The keys `bytes` (a `.env` file, undecoded) assigns, or `lostTrack` at the first line out of the grammar. */
export function envFileKeyStates(bytes: Uint8Array): EnvKeyStates {
  const keys = new Map<string, EnvKeyState>();
  let start = 0;
  for (let n = 1; start <= bytes.length; n++) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    const next = end + 1;
    if (end > start && bytes[end - 1] === 0x0d) end--;
    let line: string;
    try {
      // 0x0A never sits inside a well-formed sequence, so line by line is as strict as the whole file;
      // `ignoreBOM` keeps a mark at any line's start, which each `decode` call would otherwise strip.
      line = decoder.decode(bytes.subarray(start, end));
    } catch {
      return { keys: new Map(), lostTrack: true, lostLine: n };
    }
    start = next;
    if (line === "" || COMMENT.test(line)) continue;
    const m = ASSIGN.exec(line);
    const state = m ? valueState(m[2]!) : null;
    if (!m || !state) return { keys: new Map(), lostTrack: true, lostLine: n };
    keys.set(m[1]!, state);
  }
  return { keys, lostTrack: false };
}
