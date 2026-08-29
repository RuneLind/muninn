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
 * Every table `db/init.sql` declares, read out of the file itself.
 *
 * DERIVED, never a remembered list: a hand-kept one is a single migration away
 * from calling a complete database incomplete.
 *
 * ONE PASS, and that is the design. Three earlier versions stripped the
 * non-code and then ran a regex over what was left, and that seam is where the
 * defects lived — the strip and the match disagreed about what a token was. The
 * last of them emitted quoted identifiers verbatim so the regex could read the
 * name, which meant the regex also read INSIDE them (`t ("CREATE TABLE ghost"
 * int)` declared `ghost`), and an unterminated `"` emitted the whole rest of the
 * file as code. Recognising the statement while scanning removes the seam:
 * nothing is emitted, so nothing is re-lexed.
 *
 * The scan walks Postgres's LEXER STATES. Each is pinned by a test, and the
 * list is the design — earlier versions added the state whose absence had just
 * been measured, three times running:
 *
 *   `-- …`            line comment, to the newline
 *   block comment    `/*` … its closing marker, NESTED (Postgres nests these)
 *   `'…'`             standard literal; `''` is an escaped quote
 *   `E'…'`            escape-string; `\'` escapes too. Only the E form — with
 *                     the default `standard_conforming_strings=on`, a backslash
 *                     in a plain literal is an ordinary character
 *   `"…"`             quoted IDENTIFIER; `""` is one literal quote, so
 *                     `"a""b"` names the table `a"b`. Everything else inside —
 *                     `'`, `--`, `$$` — is ordinary
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
 * An unterminated anything — literal, identifier, dollar body, block comment —
 * ends the scan there. That under-matches, which is the right way round for a
 * truncated file: there is nothing trustworthy after the break, and
 * `classifySchemaState` refuses an empty result outright.
 *
 * `TEMP`/`TEMPORARY` declarations are deliberately NOT collected: a temp table
 * lives in `pg_temp_N` and never appears under `table_schema = 'public'`
 * (measured), so counting one makes it a permanent phantom — the over-match
 * failure by another door.
 */
export function tablesDeclaredByInitSql(sql: string): string[] {
  const names: string[] = [];
  let i = 0;

  /** Consume a quote-delimited run, returning its CONTENT with the doubled
   *  quote un-escaped, or null if it never closed. `backslash` is the E-string
   *  escape; a plain literal has none.
   *
   *  The doubled-quote branch is load-bearing in BOTH kinds. In an identifier
   *  it is what makes `"a""b"` the table `a"b`. In an E-string it is what keeps
   *  the run going — handing control back at the first quote of a `''` would
   *  re-enter as a PLAIN literal and disagree about every `\'` after it. */
  const readQuoted = (quote: string, backslash: boolean): string | null => {
    i++;
    let value = "";
    while (i < sql.length) {
      if (backslash && sql[i] === "\\") {
        value += sql.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        i++;
        return value;
      }
      value += sql[i];
      i++;
    }
    return null;
  };

  /** The next word: a bare identifier/keyword, or a quoted identifier. Quoting
   *  is recorded because a quoted name keeps its case and is never a keyword. */
  const readWord = (): { text: string; quoted: boolean } | null => {
    if (sql[i] === '"') {
      const value = readQuoted('"', false);
      return value === null ? null : { text: value, quoted: true };
    }
    const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (!m) return null;
    i += m[0].length;
    return { text: m[0], quoted: false };
  };

  /** Skip whitespace, comments and quoted runs, stopping at the first character
   *  that is none of those — punctuation included.
   *
   *  Distinct from `skipTrivia`, which additionally steps over punctuation to
   *  reach the next WORD. The difference is load-bearing exactly once, at the
   *  schema qualifier: `CREATE TABLE public . users` must see the `.` rather
   *  than skip it and take `public` for the table name, which is a table that
   *  can never exist and so refuses the database forever. Returns false when
   *  the file ran out. */
  const skipBlanks = (): boolean => {
    for (;;) {
      const ch = sql[i];
      if (ch === undefined) return false;
      if (ch === "-" && sql[i + 1] === "-") {
        const nl = sql.indexOf("\n", i);
        if (nl === -1) return false;
        i = nl + 1;
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
        if (depth > 0) return false;
        continue;
      }
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      return true;
    }
  };

  /** Skip everything that is not the start of a word. Returns false when the
   *  file ran out — including on an unterminated run, which stops the scan. */
  const skipTrivia = (): boolean => {
    for (;;) {
      const ch = sql[i];
      if (ch === undefined) return false;

      if (ch === "-" && sql[i + 1] === "-") {
        const nl = sql.indexOf("\n", i);
        if (nl === -1) return false;
        i = nl + 1;
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
        if (depth > 0) return false;
        continue;
      }
      if (ch === "'") {
        if (readQuoted("'", false) === null) return false;
        continue;
      }
      const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (dollar) {
        const tag = dollar[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) return false;
        i = close + tag.length;
        continue;
      }
      if (ch === '"' || /[A-Za-z_]/.test(ch)) return true;
      i++;
    }
  };

  /** After `CREATE`: true when a real, non-temporary TABLE follows. */
  const createsARealTable = (): boolean => {
    for (;;) {
      if (!skipTrivia()) return false;
      const w = readWord();
      if (!w || w.quoted) return false;
      const upper = w.text.toUpperCase();
      if (upper === "TABLE") return true;
      if (upper === "UNLOGGED") continue;
      // GLOBAL/LOCAL only ever precede TEMP/TEMPORARY, so they are abandoned
      // with it rather than skipped.
      return false;
    }
  };

  while (skipTrivia()) {
    const before = i;
    const word = readWord();
    if (!word) {
      // An unterminated quoted identifier. Stop, rather than resuming inside it.
      if (sql[before] === '"') break;
      i = before + 1;
      continue;
    }

    // An E-string opens with `E'` where the E is its OWN word — which is why
    // this is checked here, after skipTrivia put us at a word start, rather
    // than on the character. `value'x'` is the identifier `value` followed by a
    // PLAIN literal, and reading it as an escape-string would swallow the rest.
    if (!word.quoted && /^[Ee]$/.test(word.text) && sql[i] === "'") {
      if (readQuoted("'", true) === null) break;
      continue;
    }

    if (word.quoted || word.text.toUpperCase() !== "CREATE") continue;
    if (!createsARealTable()) continue;
    if (!skipTrivia()) break;

    let head = readWord();
    if (!head) break;

    // `IF NOT EXISTS`, PEEKED rather than consumed. `IF` is a non-reserved
    // keyword, so `CREATE TABLE if (i int)` is legal and names the table `if`
    // (measured). Consuming the lookahead and giving up on a mismatch abandoned
    // the rest of the FILE — a silently truncated declared set, which is the
    // under-match direction: a stump then classifies COMPLETE and the pod
    // migrates onto a half-schema.
    if (!head.quoted && head.text.toUpperCase() === "IF") {
      const beforeLookahead = i;
      let matched = true;
      for (const expected of ["NOT", "EXISTS"]) {
        if (!skipTrivia()) {
          matched = false;
          break;
        }
        const w = readWord();
        if (!w || w.quoted || w.text.toUpperCase() !== expected) {
          matched = false;
          break;
        }
      }
      if (matched) {
        if (!skipTrivia()) break;
        const named = readWord();
        if (!named) break;
        head = named;
      } else {
        // `IF` was the table's name after all.
        i = beforeLookahead;
      }
    }

    // A schema qualifier: in `public.users` the NAME is the last part. Trivia
    // is legal on either side of the dot — `public /*x*/ . users` — so it is
    // skipped WITHOUT stepping over the dot itself.
    let name = head;
    for (;;) {
      const beforeDot = i;
      if (!skipBlanks() || sql[i] !== ".") {
        i = beforeDot;
        break;
      }
      i++;
      if (!skipBlanks()) break;
      const next = readWord();
      if (!next) break;
      name = next;
    }
    // A zero-length quoted identifier is not a name — Postgres refuses `""`.
    const text = name.quoted ? name.text : name.text.toLowerCase();
    if (text !== "") names.push(text);
  }

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
