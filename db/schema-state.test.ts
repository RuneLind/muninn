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
  stripNonCode,
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

describe("stripNonCode — the two inputs that broke the first version", () => {
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

describe("stripNonCode", () => {
  test("takes the dollar-quoted body first, so its quotes cannot tear the rest", () => {
    // Order matters: a body can contain an apostrophe, and stripping string
    // literals first would consume from inside it to somewhere else entirely.
    const out = stripNonCode("$$ it's a body with -- and /* inside $$ CREATE TABLE t (x int);");
    expect(out).toContain("CREATE TABLE t");
    expect(out).not.toContain("body");
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
