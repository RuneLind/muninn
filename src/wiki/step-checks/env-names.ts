/**
 * The state of each key NAME a `.env` file assigns, for the `env` probe. Pure.
 * A value is read only far enough to tell empty from non-empty and to find
 * where it ends; no value, nor any part of one, leaves this function.
 *
 * The reader owns only the lines it reads the way Bun 1.3.10's loader does
 * (held to a child `bun --env-file` by a differential test and a seeded fuzz,
 * `env-names.test.ts`). `set`: the last assignment has a value that is
 * non-empty once trimmed (the probe's `processHasEnv` rule); `unset`: it is
 * empty; `unsure`: a `$` anywhere in the value (Bun expands it, single quotes
 * included). `lostTrack`: from some line on, the reader cannot tell what Bun
 * reads, so a later line may be no key or a hidden one; it stops there and
 * marks every key it read `unsure`. That is any non-blank, non-comment line
 * that is not `[export ]KEY=value`: every colon form (measured: `K: v` sets K,
 * `K:v` sets nothing, an empty `K:` takes the whole next line as its value), a
 * BOM, a line with no `=`. Inside an assignment it is a quote that never
 * closes (Bun reads it raw and goes on), a backslash inside a quoted value
 * (Bun reads `\"` as an escaped quote), and the opening quote character again
 * before the close (Bun closes only on a quote followed by spaces, `#` or the
 * line's end).
 */

export type EnvKeyState = "set" | "unset" | "unsure";

export interface EnvKeyStates {
  keys: ReadonlyMap<string, EnvKeyState>;
  lostTrack: boolean;
}

/** Bun accepts `-` and `.` in a key and a leading digit: tracked so a quote they open is followed. */
const ASSIGN = /^[ \t]*(?:export[ \t]+)?([A-Za-z0-9_.-]+)[ \t]*=(.*)$/;
const QUOTES = new Set(['"', "'", "`"]);
/** A closing quote: spaces, then a comment or the line's end. */
const AFTER_CLOSE = /^[ \t]*(?:#.*)?$/;

export function envFileKeyStates(text: string): EnvKeyStates {
  const keys = new Map<string, EnvKeyState>();
  const lines = text.split(/\r\n|\r|\n/);
  // Every key read so far is unsure too: a line past this point may assign it again.
  const lost = (key?: string): EnvKeyStates => {
    if (key) keys.set(key, "unsure");
    for (const k of keys.keys()) keys.set(k, "unsure");
    return { keys, lostTrack: true };
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const m = ASSIGN.exec(line);
    if (!m) return lost();
    const key = m[1]!;
    const rest = m[2]!.replace(/^[ \t]+/, "");
    let value: string;
    const q = rest[0];
    if (q !== undefined && QUOTES.has(q)) {
      // The quoted region: from after the opening quote to the first `q`, across lines.
      let region = rest.slice(1);
      let at = region.indexOf(q);
      let j = i;
      while (at < 0 && j + 1 < lines.length) {
        j++;
        region += "\n" + lines[j]!;
        at = region.indexOf(q);
      }
      if (at < 0) return lost(key);
      value = region.slice(0, at);
      if (value.includes("\\") || !AFTER_CLOSE.test(region.slice(at + 1).split("\n")[0]!)) return lost(key);
      i = j;
    } else value = rest.split("#")[0]!; // a backslash here is literal to Bun too
    keys.set(key, value.includes("$") ? "unsure" : value.trim() === "" ? "unset" : "set");
  }
  return { keys, lostTrack: false };
}
