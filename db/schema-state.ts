/**
 * "What state is this database's schema in?" — ONE predicate, for every caller.
 *
 * It lives in its own module because it had two implementations and they
 * disagreed about the only question that matters. `db/require-provisioned.ts`
 * (which the container entrypoint runs, and which PRINTS the remedies) asked
 * `to_regclass('public.users')`; `db/provision.ts` asked the same thing until it
 * was rewritten to compare the whole table set. That divergence is not a tidiness
 * problem, it is the unrepairable-pod path:
 *
 *   `users` is db/init.sql's FIRST table and `schema_migrations` its LAST. A
 *   `psql -f db/init.sql` that died mid-file — psql without `-1` is not atomic,
 *   and it is the remedy the applier replaces — therefore leaves `users` present
 *   and the ledger absent in almost every case. To a `users`-only predicate that
 *   reads as "provisioned but never baselined", whose remedy is
 *   `bun db/migrate.ts --baseline`. Measured end to end: that command SUCCEEDS,
 *   the entrypoint's check then PASSES, the pod boots on a one-table schema and
 *   dies at its first query — with every migration recorded as applied, so
 *   nothing can repair it.
 *
 * So: one function, one set of states, both consumers.
 */

/** The ledger table. Named once — three call sites reason about it specially,
 *  and it is the one table `db/migrate.ts` creates by itself. */
export const LEDGER_TABLE = "schema_migrations";

/**
 * Blank out everything Postgres would not read as executable code, leaving the
 * statement structure intact.
 *
 * A SCANNER over Postgres's LEXER STATES, and the enumeration is the design.
 * Two earlier versions each added the state whose absence had just been
 * measured — layered regexes, then a scanner that knew about comments,
 * standard literals and dollar quotes but not quoted identifiers or
 * escape-strings. Each gap is a defect of the same shape, so the states are
 * listed once, here, and each is pinned by a test:
 *
 *   `-- …`            line comment, to the newline
 *   `/* … *\u002f`   block comment, NESTED (Postgres nests these)
 *   `'…'`             standard literal; `''` is an escaped quote
 *   `E'…'`            escape-string; `\'` escapes too, and `\\` is a literal
 *                     backslash. Only the E form — with the default
 *                     `standard_conforming_strings=on`, a backslash in a plain
 *                     literal is an ordinary character
 *   `"…"`             quoted IDENTIFIER; `""` is an escaped quote. Everything
 *                     else inside — `'`, `--`, `$$` — is ordinary
 *   `$tag$ … $tag$`   dollar quote; the closing tag must MATCH
 *
 * `U&'…'`, `U&"…"`, `B'…'` and `X'…'` need no state of their own: the prefix is
 * ordinary characters and the quote that follows behaves as its own kind does.
 *
 * Both failure directions are dangerous, differently. An OVER-match invents a
 * table, so every healthy production database classifies incomplete and the boot
 * gate refuses it on every restart with a schema drop printed beside the
 * refusal. An UNDER-match drops one, so a database genuinely missing it
 * classifies COMPLETE, the gate passes, and the entrypoint runs the migration
 * runner onto a half-schema — the crash this module exists to prevent.
 *
 * Everything skipped is replaced by a space, so tokens on either side cannot
 * fuse into a keyword nobody wrote (`CREATE/*x*\u002fTABLE`).
 */
export function stripNonCode(sql: string): string {
  let out = "";
  let i = 0;

  /** Consume a quote-delimited run. The doubled quote (`''`, `""`) is the SQL
   *  escape; `backslash` adds the E-string one. Unterminated consumes to the
   *  end — for a truncated file that under-matches, which `classifySchemaState`
   *  then refuses outright rather than reading as a state.
   *
   *  ⚠️ The doubled-quote branch is NOT observable through this function's
   *  output, and no test pins it — measured, by mutation. `'a''b'` without it is
   *  two adjacent literals covering the same span, and a quoted identifier is
   *  emitted as a verbatim slice either way, so the text out is identical.
   *  It stays because this reads as a general "consume a quoted run" helper and
   *  the next caller — anything that wants the CONTENT rather than the span —
   *  would be silently wrong without it. Said out loud rather than covered by a
   *  test that could not fail. (The `""` that IS observable is the one in the
   *  NAME, handled by the capture below and pinned.) */
  const consumeQuoted = (quote: string, backslash: boolean): void => {
    i++;
    while (i < sql.length) {
      if (backslash && sql[i] === "\\") {
        i += 2;
        continue;
      }
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) i += 2;
        else {
          i++;
          return;
        }
      } else i++;
    }
  };

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      out += " ";
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) (depth++, (i += 2));
        else if (sql.startsWith("*/", i)) (depth--, (i += 2));
        else i++;
      }
      out += " ";
      continue;
    }

    // An E-string is `E'`/`e'` where the E is its own token — not the tail of an
    // identifier like `value'`. Checked against the preceding character rather
    // than assumed, since `CREATE'` would otherwise read as an escape-string.
    if ((ch === "E" || ch === "e") && sql[i + 1] === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? " ")) {
      i++;
      consumeQuoted("'", true);
      out += " '' ";
      continue;
    }

    if (ch === "'") {
      consumeQuoted("'", false);
      out += " '' ";
      continue;
    }

    // A quoted IDENTIFIER is code — it names the thing — so unlike the others it
    // is emitted rather than blanked, and the regex below accepts it. What
    // matters is that `'`, `--` and `$$` inside it are ordinary characters: with
    // no state here, `CREATE TABLE "it's"` opened a literal that ran to the next
    // apostrophe ANYWHERE in the file, swallowing every declaration between.
    if (ch === '"') {
      const start = i;
      consumeQuoted('"', false);
      out += sql.slice(start, i);
      continue;
    }

    // A dollar quote opens with `$$` or `$tag$`, tag being an identifier —
    // which is what separates it from a positional parameter like `$1`.
    const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (open) {
      const tag = open[0];
      const close = sql.indexOf(tag, i + tag.length);
      // The closing tag must MATCH: an optional backreference let a bare `$$`
      // close a `$tag$`, which is exactly the nesting idiom used when a body
      // itself contains `$$`.
      i = close === -1 ? sql.length : close + tag.length;
      out += " ";
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Every table `db/init.sql` declares, read out of the file itself.
 *
 * DERIVED, never a remembered list: a hand-kept one is a single migration away
 * from calling a complete database incomplete.
 *
 * `TEMP`/`TEMPORARY` tables are deliberately NOT counted. A temp table lives in
 * `pg_temp_N`, so it never appears under `table_schema = 'public'` — measured —
 * and counting one as declared makes it a permanent phantom, which is the
 * over-match failure by another door. Names are folded to lower case
 * unless double-quoted, because that is what Postgres stores — an unquoted
 * `CREATE TABLE Users` becomes `users` in `information_schema`, and comparing
 * the spellings literally would make it permanently "missing".
 */
export function tablesDeclaredByInitSql(initSql: string): string[] {
  const code = stripNonCode(initSql);
  const pattern =
    /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/gi;
  const names = [...code.matchAll(pattern)].map((m) => {
    const raw = m[1]!;
    // `""` inside a quoted identifier is ONE literal quote: Postgres names
    // `"a""b"` the table `a"b`. Capturing `"a"` instead reports the real table
    // as missing, which refuses a healthy database — the under-match direction
    // by way of a name rather than a count.
    return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase();
  });
  return [...new Set(names)];
}

export type SchemaState =
  /** Nothing in `public` at all. The only state that may be provisioned. */
  | { kind: "empty" }
  /** Every table init.sql declares is present. */
  | { kind: "complete" }
  /** Only the migration ledger — what `db/migrate.ts` leaves when it is pointed
   *  at an empty database, with or without rows. Its own state because the safe
   *  remedy is one line and the generic one is `DROP SCHEMA public CASCADE`. */
  | { kind: "lone-ledger" }
  /** Some of init.sql's tables, not all. The unrepairable-pod state. */
  | { kind: "incomplete"; present: string[]; missing: string[] }
  /** Tables, none of them ours. Somebody else's database. */
  | { kind: "foreign"; present: string[] };

/**
 * Classify, from the declared set and what is actually in `public`.
 *
 * Pure, so both consumers and the tests reason about the same function rather
 * than about two queries that happen to agree today.
 *
 * @throws if `declared` is empty — that is a parse failure, not a state. Left
 * unchecked it makes `missing.length === 0` vacuously true, so EVERY non-empty
 * database classifies as `complete` and the caller then queries a ledger that
 * may not exist. Schema-qualifying init.sql's CREATE TABLEs would be enough to
 * cause it, so it is asserted rather than assumed.
 */
export function classifySchemaState(declared: string[], present: Set<string>): SchemaState {
  if (declared.length === 0) {
    throw new Error(
      "No CREATE TABLE statements found in db/init.sql — the schema predicate cannot be built. " +
        "This is a parse failure in tablesDeclaredByInitSql, not a state of the database.",
    );
  }
  if (present.size === 0) return { kind: "empty" };

  const declaredSet = new Set(declared);
  const missing = declared.filter((t) => !present.has(t));
  if (missing.length === 0) return { kind: "complete" };

  const ours = [...present].filter((t) => declaredSet.has(t));
  if (ours.length === 0) return { kind: "foreign", present: [...present] };
  if (present.size === 1 && ours[0] === LEDGER_TABLE) return { kind: "lone-ledger" };
  return { kind: "incomplete", present: ours, missing };
}

/** `n table(s)`, said correctly. A refusal that reads "1 are missing" is read
 *  by someone who is already having a bad morning. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
