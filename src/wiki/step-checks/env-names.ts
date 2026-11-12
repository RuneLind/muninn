/**
 * The key NAMES a `.env` file sets, for the `env` probe. Pure. A value is read
 * only far enough to tell empty from non-empty and to skip the lines a quoted
 * value spans; no value, nor any part of one, leaves this function.
 *
 * The read follows dotenv as Bun loads it, and leans to "not set" where the two
 * could differ: a later line for the same key wins, `export KEY=` counts, a
 * value that is only quotes or starts with `#` is empty, and a quoted value
 * left open runs on to the line its quote closes, so a `KEY=` inside it is no
 * key. A value never runs on unquoted: `KEY=` with text on the next line is
 * an empty `KEY`.
 */

const LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

export interface EnvKeyNames {
  /** Keys whose last assignment has a non-empty value. */
  set: ReadonlySet<string>;
  /** Keys whose last assignment is empty. */
  blank: ReadonlySet<string>;
}

export function envFileKeyNames(text: string): EnvKeyNames {
  const last = new Map<string, boolean>();
  const lines = text.split(/\r?\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i]!);
    if (!m) continue;
    const rest = m[2]!.trim();
    const q = rest[0];
    let filled: boolean;
    if (q === '"' || q === "'" || q === "`") {
      const close = rest.indexOf(q, 1);
      if (close >= 0) filled = close > 1;
      else {
        // Open quote: the value runs to the line holding the closing quote.
        filled = rest.length > 1;
        let j = i + 1;
        for (; j < lines.length; j++) {
          if (lines[j]!.includes(q)) {
            filled = filled || lines[j]!.indexOf(q) > 0;
            break;
          }
          if (lines[j]!.trim() !== "") filled = true;
        }
        // Never closed: dotenv reads such a value inconsistently, so it counts as empty.
        if (j === lines.length) filled = false;
        i = j;
      }
    } else filled = rest !== "" && !rest.startsWith("#");
    last.set(m[1]!, filled);
  }
  const set = new Set<string>();
  const blank = new Set<string>();
  for (const [k, filled] of last) (filled ? set : blank).add(k);
  return { set, blank };
}
