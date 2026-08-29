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
 * Strip everything Postgres would not read as code, so a `CREATE TABLE` inside
 * a comment, a plpgsql body or a string literal is not counted as a declaration.
 *
 * Not cosmetic. An OVER-match is the dangerous direction: one phantom table name
 * makes every complete, healthy production database report as incomplete and be
 * refused forever, with a `DROP SCHEMA public CASCADE` beside the refusal.
 * `db/init.sql` already carries ten `$$ … $$` bodies, so a `CREATE TEMP TABLE`
 * inside a trigger function is one edit away.
 *
 * Dollar-quoted bodies go FIRST: they can contain quotes and comment markers,
 * and stripping quotes first would tear them in half. Nested block comments
 * (which Postgres does support) are not handled — the non-greedy match ends at
 * the first closing marker; that under-strips rather than over-strips, and
 * init.sql has none.
 */
/** `$tag$ … $tag$` and the bare `$$ … $$`. Built with `RegExp` rather than a
 *  literal: a `\1` backreference inside a regex LITERAL is read by TypeScript as
 *  an octal escape and rejected outright. */
const DOLLAR_QUOTED = new RegExp("\\$([A-Za-z_][A-Za-z0-9_]*)?\\$[\\s\\S]*?\\$\\1?\\$", "g");

export function stripNonCode(sql: string): string {
  return sql
    .replace(DOLLAR_QUOTED, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ");
}

/**
 * Every table `db/init.sql` declares, read out of the file itself.
 *
 * DERIVED, never a remembered list: a hand-kept one is a single migration away
 * from calling a complete database incomplete. Names are folded to lower case
 * unless double-quoted, because that is what Postgres stores — an unquoted
 * `CREATE TABLE Users` becomes `users` in `information_schema`, and comparing
 * the spellings literally would make it permanently "missing".
 */
export function tablesDeclaredByInitSql(initSql: string): string[] {
  const code = stripNonCode(initSql);
  const pattern =
    /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/gi;
  const names = [...code.matchAll(pattern)].map((m) => {
    const raw = m[1]!;
    return raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase();
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
