/**
 * The shared schema predicate — the one `db/provision.ts` and
 * `db/require-provisioned.ts` both classify with.
 *
 * Pure, so no database. It is here rather than folded into `provision.test.ts`
 * because the previous arrangement is what let a defect through: that file
 * re-implemented the regex locally, so a test NAMED for the predicate asserted
 * against its own copy and stayed green while the real one was reverted to a
 * single table.
 */
import { describe, expect, test } from "bun:test";
import {
  classifySchemaState,
  LEDGER_TABLE,
  plural,
  tablesDeclaredByInitSql,
} from "./schema-state.ts";

const initSqlPromise = Bun.file(new URL("./init.sql", import.meta.url)).text();

describe("tablesDeclaredByInitSql — the real file", () => {
  test("finds every table db/init.sql declares, first and last included", async () => {
    const declared = tablesDeclaredByInitSql(await initSqlPromise);
    expect(declared.length).toBeGreaterThan(20);
    // The fact the whole design rests on: `users` first, the ledger last. That
    // ordering is why a `users`-only predicate reads a half-applied file as
    // "provisioned but never baselined" and prescribes the one command that
    // makes the database unrepairable.
    expect(declared[0]).toBe("users");
    expect(declared.at(-1)).toBe(LEDGER_TABLE);
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("tablesDeclaredByInitSql — what must NOT be counted", () => {
  // An OVER-match is the dangerous direction: one phantom name makes every
  // healthy production database report incomplete and be refused forever, with
  // a `DROP SCHEMA public CASCADE` printed beside the refusal.
  const cases: [string, string, string[]][] = [
    ["a block comment", "/* CREATE TABLE ghost (x int); */ CREATE TABLE real (x int);", ["real"]],
    ["a line comment", "-- CREATE TABLE ghost (x int);\nCREATE TABLE real (x int);", ["real"]],
    [
      "a plpgsql body — db/init.sql has ten of them",
      "CREATE FUNCTION f() AS $$ BEGIN CREATE TEMP TABLE ghost (x int); END; $$ LANGUAGE plpgsql;\nCREATE TABLE real (x int);",
      ["real"],
    ],
    [
      "a dollar-quoted body with a tag",
      "CREATE FUNCTION f() AS $body$ CREATE TABLE ghost (x int); $body$ LANGUAGE plpgsql;\nCREATE TABLE real (x int);",
      ["real"],
    ],
    ["a string literal", "SELECT 'CREATE TABLE ghost (x int)';\nCREATE TABLE real (x int);", ["real"]],
  ];
  for (const [label, sql, expected] of cases) {
    test(`ignores ${label}`, () => {
      expect(tablesDeclaredByInitSql(sql)).toEqual(expected);
    });
  }
});

describe("tablesDeclaredByInitSql — what must be counted", () => {
  // An UNDER-match is the other failure: a table silently dropped from the
  // declared set makes `missing` short, and an empty set makes
  // `missing.length === 0` vacuously true for EVERY database.
  const cases: [string, string, string[]][] = [
    ["IF NOT EXISTS", "CREATE TABLE IF NOT EXISTS t (x int);", ["t"]],
    ["UNLOGGED", "CREATE UNLOGGED TABLE u (x int);", ["u"]],
    ["a schema qualifier", "CREATE TABLE public.users (x int);", ["users"]],
    ["no space before the paren", "CREATE TABLE t(x int);", ["t"]],
    ["extra whitespace and newlines", "CREATE   TABLE\n\n  t\n  (x int);", ["t"]],
    ["lower case keywords", "create table t (x int);", ["t"]],
  ];
  for (const [label, sql, expected] of cases) {
    test(`counts ${label}`, () => {
      expect(tablesDeclaredByInitSql(sql)).toEqual(expected);
    });
  }

  test("does NOT count a TEMP table — it can never be in `public` to be found", () => {
    // Measured: a temp table lives in `pg_temp_N`, so it never appears under
    // `table_schema = 'public'`. Counting one as declared makes it a permanent
    // phantom — the same "every healthy database refused, with a schema drop"
    // outcome as an over-match. The first version listed TEMP as a feature.
    expect(tablesDeclaredByInitSql("CREATE TEMP TABLE t (x int);")).toEqual([]);
    expect(tablesDeclaredByInitSql("CREATE TEMPORARY TABLE t (x int);")).toEqual([]);
    expect(tablesDeclaredByInitSql("CREATE GLOBAL TEMPORARY TABLE t (x int);")).toEqual([]);
  });

  test("folds an unquoted name to lower case, and keeps a quoted one verbatim", () => {
    // Postgres stores an unquoted identifier lower-cased, so `CREATE TABLE
    // Users` is `users` in information_schema — comparing the spellings
    // literally would make it permanently "missing" and refuse the database.
    expect(tablesDeclaredByInitSql("CREATE TABLE Users (x int);")).toEqual(["users"]);
    expect(tablesDeclaredByInitSql('CREATE TABLE "MixedCase" (x int);')).toEqual(["MixedCase"]);
  });
});

describe("the two inputs that broke the first parser", () => {
  test("a NESTED dollar-quoted body: a bare $$ must NOT close a tagged one", () => {
    // Nesting an outer tag BECAUSE the body contains `$$` is the standard
    // Postgres idiom, so this fires on the first nested function anyone adds to
    // db/init.sql. The first version used an OPTIONAL backreference, so the
    // inner `$$` closed the outer `$tag$` and everything after it was read as
    // code — a phantom table, and then every healthy production database
    // classifies incomplete and the boot gate refuses it forever with a schema
    // drop printed beside the refusal.
    const sql =
      "CREATE FUNCTION f() AS $tag$ a $$ b CREATE TABLE ghost (i int); $$ c $tag$;\n" +
      "CREATE TABLE real_one (i int);";
    expect(tablesDeclaredByInitSql(sql)).toEqual(["real_one"]);
  });

  test("two string literals that each contain a $tag$ must not swallow what is between them", () => {
    // The other direction, and the dangerous one for a boot gate: a declaration
    // silently dropped from the declared set makes `missing` short, so a
    // database genuinely missing that table classifies COMPLETE, the check
    // passes, and the entrypoint runs the migration runner onto a half-schema —
    // the crash this whole module exists to prevent.
    const sql =
      "INSERT INTO t VALUES ('cost $x$');\n" +
      "CREATE TABLE swallowed (i int);\n" +
      "INSERT INTO t VALUES ('also $x$');\n" +
      "CREATE TABLE tail (i int);";
    expect(tablesDeclaredByInitSql(sql)).toEqual(["swallowed", "tail"]);
  });

  test("a dollar-quoted body containing an apostrophe still strips whole", () => {
    // Which is why literals cannot simply be stripped first.
    const sql = "CREATE FUNCTION f() AS $$ it's a body; CREATE TABLE ghost (i int); $$ LANGUAGE plpgsql;\nCREATE TABLE real_one (i int);";
    expect(tablesDeclaredByInitSql(sql)).toEqual(["real_one"]);
  });

  test("an UNTERMINATED dollar quote does not swallow the file silently", () => {
    // If it did, `declared` would come back short or empty — and empty is the
    // vacuous-complete hole `classifySchemaState` throws on.
    const sql = "CREATE TABLE before_it (i int);\nCREATE FUNCTION f() AS $$ unterminated";
    expect(tablesDeclaredByInitSql(sql)).toContain("before_it");
  });

  test("positional parameters ($1, $2) are not dollar quotes", () => {
    const sql = "CREATE TABLE t (i int);\n-- a prepared statement shape: $1, $2\nCREATE TABLE u (i int);";
    expect(tablesDeclaredByInitSql(sql)).toEqual(["t", "u"]);
  });
});

describe("one case per lexer state", () => {
  // The states are enumerated in the function's header, and each one is pinned
  // here. Two earlier versions each added the state whose absence had just been
  // measured; the list is the design, so the list is the test.

  test("a dollar-quoted body swallows quotes and comment markers whole", () => {
    expect(
      tablesDeclaredByInitSql(
        "$$ it's a body with -- and /* CREATE TABLE ghost (i int); inside $$ CREATE TABLE t (x int);",
      ),
    ).toEqual(["t"]);
  });

  test("a QUOTED IDENTIFIER containing an apostrophe does not open a literal", () => {
    // Without this state, `"it's"` opened a literal that ran to the next
    // apostrophe ANYWHERE in the file — an unbounded UNDER-match, which is the
    // direction that boots a pod onto a half-schema.
    expect(tablesDeclaredByInitSql(`CREATE TABLE "it's" (i int); CREATE TABLE after (i int);`))
      .toEqual(["it's", "after"]);
  });

  test("a quoted identifier containing -- or a dollar quote is still just a name", () => {
    expect(tablesDeclaredByInitSql(`CREATE TABLE "a--b" (i int); CREATE TABLE after (i int);`))
      .toEqual(["a--b", "after"]);
    expect(tablesDeclaredByInitSql(`CREATE TABLE t ("user's id" int); CREATE TABLE after (i int);`))
      .toEqual(["t", "after"]);
  });

  test("an E-string escapes with a backslash — both directions of getting it wrong", () => {
    // UNDER-match if `\'` is read as the end of the literal:
    expect(tablesDeclaredByInitSql(`SELECT E'don\\'t'; CREATE TABLE t (i int);`)).toEqual(["t"]);
    // OVER-match if the run between two escaped quotes is read as code:
    expect(
      tablesDeclaredByInitSql(
        `SELECT E'a\\' CREATE TABLE ghost (i int); \\'b'; CREATE TABLE ok (i int);`,
      ),
    ).toEqual(["ok"]);
  });

  test("a PLAIN literal does NOT escape with a backslash", () => {
    // standard_conforming_strings has defaulted on since 9.1, so a backslash in
    // a plain literal is an ordinary character and the quote after it CLOSES.
    // Treating it as an escape would run the literal on and swallow code.
    expect(tablesDeclaredByInitSql(`SELECT 'a\\'; CREATE TABLE t (i int);`)).toEqual(["t"]);
  });

  test("`E` must be its own token, not the tail of an identifier", () => {
    // `value'` would otherwise read as an escape-string opener.
    expect(tablesDeclaredByInitSql(`SELECT value'x'; CREATE TABLE t (i int);`)).toEqual(["t"]);
  });

  test("BLOCK COMMENTS NEST, as they do in Postgres", () => {
    // Un-nested, the first closing marker ends the comment and the tail is read
    // as code — an OVER-match, inventing `ghost`.
    expect(tablesDeclaredByInitSql("/* a /* b */ CREATE TABLE ghost (i int); */ CREATE TABLE t (i int);"))
      .toEqual(["t"]);
  });

  test("a skipped region leaves a SPACE, so tokens cannot fuse", () => {
    // `CREATE/*x*/TABLE t` is `CREATE TABLE t` to Postgres. Blanked to nothing
    // it becomes `CREATETABLE t` and the table is silently dropped.
    expect(tablesDeclaredByInitSql("CREATE/**/TABLE t (i int);")).toEqual(["t"]);
  });

  test("an UNTERMINATED dollar body consumes to the end rather than emitting half of one", () => {
    // Emitting the tail would read the body's contents as declarations.
    expect(
      tablesDeclaredByInitSql(
        "CREATE TABLE before_it (i int);\nCREATE FUNCTION f() AS $$ CREATE TABLE inside_body (i int);",
      ),
    ).toEqual(["before_it"]);
  });

  test("an unterminated literal and an unterminated block comment also consume to the end", () => {
    expect(tablesDeclaredByInitSql("CREATE TABLE t (i int); SELECT 'oops CREATE TABLE ghost (i int);"))
      .toEqual(["t"]);
    expect(tablesDeclaredByInitSql("CREATE TABLE t (i int); /* oops CREATE TABLE ghost (i int);"))
      .toEqual(["t"]);
  });

  test("`E` at the tail of an identifier does not turn a plain literal into an escape one", () => {
    // `value'a\\'` is `value` followed by the plain literal `a\\`, which CLOSES at
    // that quote. Read as an E-string, the backslash escapes it and the literal
    // runs to the next apostrophe — swallowing every declaration after it.
    expect(tablesDeclaredByInitSql(String.raw`SELECT value'a\'; CREATE TABLE t (i int);`))
      .toEqual(["t"]);
  });

  test('`""` inside a quoted identifier is ONE quote, as Postgres names it', () => {
    // Measured against the real lexer: `CREATE TABLE "a""b"` creates a table
    // named `a"b`. Capturing `a` instead reports the real one as missing, which
    // refuses a healthy database — an under-match by way of the NAME rather
    // than the count, and the only thing that makes the doubled-quote escape
    // observable at all (inside a plain literal it is not: `''` is simply two
    // adjacent literals covering the same span).
    expect(tablesDeclaredByInitSql(`CREATE TABLE "a""b" (i int); CREATE TABLE after (i int);`))
      .toEqual([`a"b`, "after"]);
  });

  test("a doubled quote inside an E-string keeps the run going — the branch is NOT a no-op", () => {
    // Claimed an equivalent mutant in an earlier round; it is not, and these are
    // the counterexamples. `E'a''b\'c'` is ONE string to Postgres (measured: it
    // selects `a'b'c`). Handing control back at the first quote of the `''`
    // re-enters as a PLAIN literal, which does not honour `\'` — so the two
    // scanners disagree about every escape after it, in BOTH directions.
    expect(tablesDeclaredByInitSql(String.raw`SELECT E'a''b\'c'; CREATE TABLE t (i int);`))
      .toEqual(["t"]);
    expect(tablesDeclaredByInitSql(String.raw`SELECT E'''\'q'; CREATE TABLE t (i int);`))
      .toEqual(["t"]);
    // And the other direction: unterminated, so nothing after it counts.
    expect(tablesDeclaredByInitSql(String.raw`SELECT E'a''\'; CREATE TABLE t (i int);`))
      .toEqual([]);
  });

  test("an UNTERMINATED quoted identifier stops the scan instead of emitting the file", () => {
    // The regression this rewrite removes at the root. The previous scanner
    // EMITTED an identifier's span so a regex could read the name, so one
    // unpaired `"` handed the whole rest of the file to that regex as code —
    // every comment, literal and function body in it. Over-match: phantom names
    // enter `declared`, are never in `present`, and a complete healthy database
    // is refused on every restart with a schema drop printed beside it.
    // No `--` in the tail: resuming inside the identifier must not find this
    // `CREATE TABLE`. (With a comment in the way the two behaviours agree by
    // accident, which is how the first version of this case passed against the
    // bug it was written for.)
    expect(
      tablesDeclaredByInitSql(
        `CREATE TABLE t_ok (i int); SELECT 1 AS "oops CREATE TABLE ghost (i int);`,
      ),
    ).toEqual(["t_ok"]);
  });

  test("a quoted identifier's CONTENT is never read as a declaration", () => {
    // Same root cause, reachable without a stray quote: the regex read inside
    // the identifier text the scanner emitted.
    expect(tablesDeclaredByInitSql(`CREATE TABLE t ("CREATE TABLE ghost" int);`)).toEqual(["t"]);
    expect(tablesDeclaredByInitSql(`COMMENT ON COLUMN t."create table ghost" IS 'x';`)).toEqual([]);
  });

  test("a quoted identifier is never a keyword, even when it spells one", () => {
    // A table may legally be named `"CREATE"`, and the scan must not re-enter
    // the state machine on it. The distinguishing input is deliberately not
    // valid SQL — `"create" TABLE ghost` cannot appear in a working file — and
    // that is the point: this scanner runs over a file that may be TRUNCATED or
    // half-merged, which is exactly when invalid token sequences show up, and an
    // over-match there refuses a healthy database on every restart.
    expect(tablesDeclaredByInitSql(`CREATE TABLE "CREATE" (i int);`)).toEqual(["CREATE"]);
    expect(tablesDeclaredByInitSql(`SELECT "create" TABLE ghost;`)).toEqual([]);
  });

  test("a schema qualifier with trivia around the dot still names the TABLE", () => {
    // Measured: `CREATE TABLE public . a6 (i int)` creates `a6`. Taking
    // `public` for the name declares a SCHEMA as a table — one that can never
    // appear in `information_schema.tables`, so a healthy database is refused
    // on every restart with the schema-drop remedy printed beside it.
    expect(tablesDeclaredByInitSql("CREATE TABLE public . a6 (i int);")).toEqual(["a6"]);
    expect(tablesDeclaredByInitSql("CREATE TABLE public.\n  a7 (i int);")).toEqual(["a7"]);
    expect(tablesDeclaredByInitSql("CREATE TABLE public/*x*/.a8 (i int);")).toEqual(["a8"]);
    expect(tablesDeclaredByInitSql("CREATE TABLE public.--c\n a9 (i int);")).toEqual(["a9"]);
    // And a qualifier chain takes the LAST part, not the second.
    expect(tablesDeclaredByInitSql("CREATE TABLE db.public.t3 (i int);")).toEqual(["t3"]);
  });

  test("`IF` is a legal table name, and a failed IF-NOT-EXISTS peek must not end the scan", () => {
    // Measured: `CREATE TABLE if (i int)` creates a table called `if`.
    // Consuming the lookahead and giving up abandoned the REST OF THE FILE —
    // the under-match direction, where a stump classifies COMPLETE and the pod
    // migrates onto a half-schema.
    expect(tablesDeclaredByInitSql("CREATE TABLE if (i int); CREATE TABLE a49 (i int);"))
      .toEqual(["if", "a49"]);
    // A typo'd modifier is the half-merged shape this scanner exists to survive.
    expect(tablesDeclaredByInitSql("CREATE TABLE IF NOT EXIST t (i int); CREATE TABLE a50 (i int);"))
      .toContain("a50");
    // The real form still works.
    expect(tablesDeclaredByInitSql("CREATE TABLE IF NOT EXISTS t (i int); CREATE TABLE a51 (i int);"))
      .toEqual(["t", "a51"]);
  });

  test("a quoted `IF` is a name, not the start of IF NOT EXISTS", () => {
    expect(tablesDeclaredByInitSql(`CREATE TABLE "IF" (i int); CREATE TABLE later (i int);`))
      .toEqual(["IF", "later"]);
    // The input that actually distinguishes the guard is not valid SQL — with
    // the lookahead now non-destructive, a quoted `"IF"` followed by anything
    // OTHER than `NOT EXISTS` already falls back to being the name. Only the
    // `NOT EXISTS` sequence tells the two apart, and `CREATE TABLE "IF" NOT
    // EXISTS t` is a syntax error. It is pinned anyway, for the same reason the
    // quoted-`CREATE` case is: this scanner runs over files that may be
    // truncated or half-merged, which is when invalid sequences appear.
    expect(tablesDeclaredByInitSql(`CREATE TABLE "IF" NOT EXISTS t (i int);`)).toEqual(["IF"]);
  });

  test("a quoted `TABLE` after CREATE does not declare anything", () => {
    // `CREATE "TABLE" ghost` is not a table declaration — the quoted word is an
    // identifier, and a quoted identifier is never a keyword.
    expect(tablesDeclaredByInitSql(`CREATE "TABLE" ghost (i int);`)).toEqual([]);
  });

  test("a quoted `E` before a literal is an identifier, not an escape-string", () => {
    expect(tablesDeclaredByInitSql(String.raw`SELECT "E"'a\'b'; CREATE TABLE later (i int);`))
      .toEqual([]);
  });

  test("a zero-length quoted identifier is not a name", () => {
    // Postgres refuses `""` outright; pushing the empty string would put a name
    // in `declared` that nothing can ever satisfy.
    expect(tablesDeclaredByInitSql(`CREATE TABLE "" (i int); CREATE TABLE t (i int);`))
      .toEqual(["t"]);
  });

  test("a failed IF-peek RESTORES the cursor — the next declaration must survive it", () => {
    // The mechanism of the fix, and nothing pinned it: deleting the restore left
    // the whole suite green, because in every other `IF` case the swallowed
    // lookahead words are ones the outer loop skips anyway. Here they are a
    // `CREATE TABLE`, so a consuming lookahead drops the NEXT table — under-match,
    // which is round 6's defect in a slightly different shape.
    expect(tablesDeclaredByInitSql("CREATE TABLE if CREATE TABLE t2 (i int);"))
      .toEqual(["if", "t2"]);
    expect(tablesDeclaredByInitSql("CREATE TABLE if NOT CREATE TABLE t3 (i int);"))
      .toEqual(["if", "t3"]);
  });

  test("the IF-peek's own quoted guard: a quoted NOT is not the keyword", () => {
    expect(tablesDeclaredByInitSql(`CREATE TABLE IF "NOT" EXISTS t (i int);`)).toEqual(["if"]);
  });

  test("a LOWERCASE e'…' is an escape string too — and this one is valid SQL", () => {
    // The only unpinned branch here that a working file could reach.
    expect(
      tablesDeclaredByInitSql(String.raw`SELECT e'a\'CREATE TABLE ghost (i int)'; CREATE TABLE t (i int);`),
    ).toEqual(["t"]);
  });

  test("after a dot, trivia is skipped but a quoted run is NOT scanned past", () => {
    // `skipBlanks`, not `skipTrivia`: the latter steps over literals and dollar
    // bodies to reach the next word, which after a qualifier dot would take a
    // token out of a literal for the table name. Invalid SQL either way — the
    // point is which way it fails on a half-merged file.
    expect(tablesDeclaredByInitSql("CREATE TABLE public . 'x' (i int);")).toEqual(["public"]);
  });

  test("a quoted or dollar-quoted token before the dot is not trivia", () => {
    // `skipBlanks` stops AT a quote rather than skipping it, so these do not
    // reach the dot and the qualifier is not taken. Postgres rejects all three;
    // what matters is that the scan does not wander.
    for (const sql of [
      `CREATE TABLE public "x" . t (i int);`,
      `CREATE TABLE public $$q$$ . t (i int);`,
      `CREATE TABLE public 'q' . t (i int);`,
    ]) {
      expect(tablesDeclaredByInitSql(sql)).toEqual(["public"]);
    }
  });

  test("U&, B and X prefixes need no state of their own", () => {
    expect(tablesDeclaredByInitSql(`SELECT U&'d\\0061t'; CREATE TABLE t (i int);`)).toEqual(["t"]);
    expect(tablesDeclaredByInitSql(`SELECT B'1011'; CREATE TABLE t (i int);`)).toEqual(["t"]);
    expect(tablesDeclaredByInitSql(`SELECT X'1FF'; CREATE TABLE t (i int);`)).toEqual(["t"]);
  });
});

describe("classifySchemaState", () => {
  const declared = ["users", "messages", LEDGER_TABLE];

  test("empty", () => {
    expect(classifySchemaState(declared, new Set())).toEqual({ kind: "empty" });
  });

  test("complete — and extra tables alongside do not spoil it", () => {
    expect(classifySchemaState(declared, new Set(declared)).kind).toBe("complete");
    expect(classifySchemaState(declared, new Set([...declared, "someone_elses"])).kind).toBe(
      "complete",
    );
  });

  test("incomplete — the unrepairable-pod state, named", () => {
    const state = classifySchemaState(declared, new Set(["users"]));
    expect(state.kind).toBe("incomplete");
    if (state.kind !== "incomplete") throw new Error("unreachable");
    expect(state.present).toEqual(["users"]);
    expect(state.missing).toEqual(["messages", LEDGER_TABLE]);
  });

  test("lone ledger — WITH or WITHOUT rows, because rows are not the question", () => {
    // `bun db/migrate.ts` against an empty database leaves the ledger empty;
    // `--baseline` against one leaves it full. Both are the same mistake and
    // both take the same one-line remedy. An earlier version required it to be
    // empty, so the likelier of the two got a `DROP SCHEMA public CASCADE`.
    expect(classifySchemaState(declared, new Set([LEDGER_TABLE])).kind).toBe("lone-ledger");
  });

  test("foreign — tables, none of them ours", () => {
    const state = classifySchemaState(declared, new Set(["customers", "orders"]));
    expect(state.kind).toBe("foreign");
  });

  test("REFUSES an empty declared set instead of calling every database complete", () => {
    // Left unchecked, `missing.length === 0` is vacuously true, so every
    // non-empty database classifies as `complete` and the caller then queries a
    // ledger that may not be there — a raw driver stack from the code whose
    // entire job is to not produce one. Schema-qualifying init.sql's CREATE
    // TABLEs would have been enough to cause it.
    expect(() => classifySchemaState([], new Set(["anything"]))).toThrow(/init\.sql/);
  });
});

describe("plural", () => {
  test("says '1 table', not '1 tables'", () => {
    expect(plural(1, "table")).toBe("1 table");
    expect(plural(2, "table")).toBe("2 tables");
    expect(plural(0, "table")).toBe("0 tables");
  });
});
