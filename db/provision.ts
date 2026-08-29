/**
 * "Provision this database" — apply `db/init.sql` and record the shipped
 * migrations, as the APP user, from the image the pod already runs.
 *
 * This is the step that had no runnable form. `db/require-provisioned.ts`
 * refuses an empty database and names `psql "<url>" -f db/init.sql`, then says
 * psql is not in the image — "run it from a machine that has it and can reach
 * this database". On a nais deployment there is no such machine: a post-
 * 2024-04-18 Cloud SQL instance is private-IP, and the app user's credentials
 * exist only inside the pod. So the one command our own refusal prints was
 * unrunnable exactly where it is printed, and the schema step stalled there.
 *
 * The image ships bun, `db/` and `postgres` — everything except psql. So the
 * applier is the missing piece, not the tooling:
 *
 *   kubectl debug deploy/<app> --copy-to=<app>-provision --container=<app> \
 *     --profile=general -- bun db/provision.ts
 *
 * The copy inherits the Deployment's env, its secret mounts (the Cloud SQL
 * client certificate `openPostgres` translates for postgres.js) and its
 * sidecars, and this script reads nais's `DB_URL` itself — which matters
 * because `--copy-to … -- <command>` REPLACES the entrypoint that would
 * otherwise export `DATABASE_URL` from it (see ./database-url.ts).
 *
 * **What it deliberately does not do.** It never touches a database that is
 * already provisioned: `users` present is a refusal, not a no-op with a
 * rewrite, because `db/init.sql` is bare `CREATE TABLE` throughout and the
 * honest answer to "this already has a schema" is an operator decision. And it
 * does not run pending migrations — `--baseline` records the shipped ones as
 * applied, which is the whole contract of a database built from the
 * consolidated schema; the container entrypoint runs anything newer on the
 * next start.
 *
 * **Why the whole file lands or none of it does.** `sql.unsafe(text)` with no
 * parameters selects postgres.js's SIMPLE protocol (`src/index.js`: `simple:
 * args.length === 0`), and Postgres wraps a multi-statement simple query in one
 * implicit transaction. `db/init.sql` contains no transaction control of its
 * own — its `BEGIN`s are plpgsql function bodies — so a failure anywhere rolls
 * the whole schema back rather than leaving a half-built one for the next
 * reader to diagnose. `provision.test.ts` asserts that against a real database
 * rather than trusting the paragraph.
 *
 * Exit codes, matching ./require-provisioned.ts: 0 done, 1 refused (a state an
 * operator must resolve), 2 could not use or reach the database.
 *
 * Usage:
 *   bun db/provision.ts             # apply init.sql, then baseline
 *   bun db/provision.ts --dry-run   # report the state, change nothing
 *   bun run db:provision
 */
import { join } from "node:path";
import { resolveCliDatabaseUrl, DATABASE_URL_ENV_NAMES } from "./database-url.ts";
import { openPostgres, parsePostgresUrl } from "./postgres-connection.ts";
import { DatabaseUrlError, runMigrations } from "./migrate.ts";

/** Same budget and reason as ./require-provisioned.ts: under `kubectl debug
 *  --copy-to` the Cloud SQL proxy sidecar starts alongside this process, so a
 *  refused CONNECTION for the first seconds is normal. An ANSWER is never
 *  retried — it will not change.
 *
 *  One difference from that mirror, stated because the reader would otherwise
 *  assume equivalence: it rebuilds the client on every attempt, this retries
 *  `SELECT 1` on ONE client. postgres.js reconnects underneath, so the
 *  ECONNREFUSED case behaves identically (measured) — but a client wedged in an
 *  unrecoverable internal state is retried here rather than replaced. Accepted:
 *  the alternative moves `openPostgres`, whose throw is a DIFFERENT exit code,
 *  inside the retry loop. */
const CONNECT_BUDGET_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

/** Postgres codes that will not resolve by waiting — the same set
 *  ./require-provisioned.ts refuses fast on, for the same reason: retrying a
 *  config mistake for the full budget buys 30 seconds of silence in front of
 *  the message that names it. */
const FATAL_PG_CODES = new Set([
  "3D000", // invalid_catalog_name — no such database
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
]);

/**
 * The role running this may not do something `db/init.sql` asks for. Its own
 * class because the CLI answers it with exit 1 (an operator resolves it) rather
 * than exit 2 (this URL is unusable), and because the remedy differs by
 * statement — which is why the underlying Postgres message is carried verbatim
 * instead of being replaced by a guess about which grant is missing.
 */
export class ProvisionPrivilegeError extends Error {
  constructor(readonly pgMessage: string) {
    super(pgMessage);
    this.name = "ProvisionPrivilegeError";
  }
}

/**
 * The database is neither empty nor provisioned — tables present, no `users`.
 * Its own class because it is a STATE an operator resolves, not a driver fault,
 * and because it has a likely cause worth naming: a `psql -f db/init.sql` that
 * died mid-file. psql without `-1` is not atomic, so the remedy this applier
 * replaces is itself the most common way to reach this state.
 */
export class ProvisionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionStateError";
  }
}

/**
 * `db/init.sql` applied and the baseline did not. Separated from every other
 * failure because the operator-facing fact is the opposite of what a bare stack
 * trace implies: the schema IS there, and one command finishes the job. Without
 * this, `console.error("Provisioning failed:", err)` prints a bun source
 * snippet for a database that is most of the way provisioned.
 */
export class ProvisionBaselineError extends Error {
  constructor(readonly cause2: unknown) {
    super(
      "db/init.sql applied, but recording the shipped migrations did not. " +
        "The schema IS present. Finish with `bun db/migrate.ts --baseline`.",
    );
    this.name = "ProvisionBaselineError";
  }
}

export type ProvisionStatus =
  /** init.sql applied and the shipped migrations recorded. */
  | "provisioned"
  /** `users` was already there. Nothing was written. */
  | "already-provisioned"
  /** --dry-run against a database that would be provisioned. */
  | "would-provision"
  /** --dry-run against a database that is neither empty nor provisioned. A dry
   *  run REPORTS this rather than throwing, because its whole contract is to
   *  say what would happen without failing; the real run throws
   *  `ProvisionStateError` for the same state. */
  | "not-empty";

export interface ProvisionResult {
  status: ProvisionStatus;
  /** Operator-facing lines the CLI prints. Returned rather than logged so a
   *  test can assert on the decision instead of on stdout. */
  notes: string[];
}

/** Wait for the database to ANSWER, distinguishing "not up yet" from "will
 *  never work". Returns nothing; throws on a fatal code or a spent budget. */
async function awaitAnswer(sql: ReturnType<typeof openPostgres>["sql"]): Promise<void> {
  const start = Date.now();
  const deadline = start + CONNECT_BUDGET_MS;
  for (;;) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | null)?.code;
      if (code && FATAL_PG_CODES.has(code)) {
        throw new DatabaseUrlError(`Cannot use this database (${code}): ${message}`);
      }
      if (Date.now() >= deadline) {
        // Elapsed, not the budget. The deadline is only checked AFTER an
        // attempt returns and postgres.js adds its own connect handling on top,
        // so a 30s budget was measured taking 41s — a message naming "30s" for
        // a 41s wait sends an operator looking for a second timeout that does
        // not exist. (./require-provisioned.ts still names the budget; that is
        // the same overstatement, not a difference in behaviour.)
        const waited = Math.round((Date.now() - start) / 1000);
        throw new DatabaseUrlError(`Could not reach the database after ${waited}s: ${message}`);
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

export async function provisionDatabase(
  databaseUrl: string,
  opts?: { dryRun?: boolean },
): Promise<ProvisionResult> {
  const notes: string[] = [];

  let sql: ReturnType<typeof openPostgres>["sql"];
  let tlsNotes: string[];
  try {
    ({ sql, notes: tlsNotes } = openPostgres(databaseUrl, { max: 1, onnotice: () => {} }));
  } catch (err) {
    throw new DatabaseUrlError(
      `Cannot use this database URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const note of tlsNotes) notes.push(`TLS: ${note}`);

  try {
    await awaitAnswer(sql);

    // `to_regclass` answers NULL for an absent relation instead of throwing, so
    // "no such table" is a VALUE here rather than an error indistinguishable
    // from a connection fault — the same reason ./require-provisioned.ts uses
    // it, and `users` is the same canonical predicate: init.sql owns it, no
    // migration creates it, and unlike `schema_migrations` nothing else creates
    // it as a side effect.
    const [state] = await sql`
      SELECT to_regclass('public.users') IS NOT NULL AS provisioned,
             to_regclass('public.schema_migrations') IS NOT NULL AS tracked,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
             (SELECT count(*)::int FROM information_schema.tables
               WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables
    `;
    if (state?.provisioned) {
      notes.push("This database already has a `users` table — it is provisioned. Nothing was written.");
      // Only when it is actually true. Printed unconditionally this is the
      // wrong instruction presented as a diagnosis, and it collapses the two
      // states ./require-provisioned.ts goes to some length to tell apart.
      // A second statement, not a CASE: Postgres parses a whole statement
      // before running it, so a subselect over `schema_migrations` would fail
      // to parse on a database where that table is missing.
      const recorded = state.tracked
        ? Number((await sql`SELECT count(*)::int AS n FROM schema_migrations`)[0]?.n ?? 0)
        : 0;
      if (recorded === 0) {
        notes.push(
          "The schema is there but `schema_migrations` records nothing. The missing step is",
          "  bun db/migrate.ts --baseline",
        );
      }
      return { status: "already-provisioned", notes };
    }

    // Neither empty nor provisioned. `db/init.sql` is bare `CREATE TABLE`
    // throughout, so applying it here fails on the first collision — and
    // without this branch it fails as a raw `PostgresError: relation "…"
    // already exists` with a node_modules stack, in a container log whose whole
    // point is a one-line answer.
    if ((state?.tables ?? 0) > 0) {
      const present = await sql`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name LIMIT 5
      `;
      const names = present.map((r) => r.table_name).join(", ");
      const summary =
        `This database is not empty and not provisioned: ${state?.tables} table(s) in ` +
        `\`public\` (${names}${(state?.tables ?? 0) > 5 ? ", …" : ""}) and no \`users\`.`;
      if (opts?.dryRun) {
        notes.push(summary, "Dry run: would refuse. Nothing here can be provisioned as-is.");
        return { status: "not-empty", notes };
      }
      throw new ProvisionStateError(
        `${summary}\n` +
          "  Most likely a `psql -f db/init.sql` that died mid-file — psql without `-1`\n" +
          "  is not atomic. Decide what those tables are, then either drop them (a\n" +
          "  throwaway database: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) or\n" +
          "  provision a fresh database. This script will not write over them.",
      );
    }

    // Probed rather than required. `db/init.sql` opens with `CREATE EXTENSION
    // IF NOT EXISTS vector`, which the app user on a managed instance may not
    // run — but `IF NOT EXISTS` short-circuits BEFORE the privilege check, so
    // once an elevated role has created it the app user applies the whole file.
    // Refusing here would break the case where the role CAN create it (a local
    // superuser, docker-compose), so this is a note, and the 42501 handler
    // below is what actually diagnoses the failure if it comes.
    if (!state?.has_vector) {
      notes.push(
        "Note: the `vector` extension does not exist yet. init.sql will try to create it,",
        "which needs an elevated role on a managed instance (`CREATE EXTENSION vector`).",
      );
    }

    if (opts?.dryRun) {
      notes.push("Dry run: would apply db/init.sql, then record the shipped migrations.");
      return { status: "would-provision", notes };
    }

    const initSql = await Bun.file(join(import.meta.dir, "init.sql")).text();
    try {
      await sql.unsafe(initSql);
    } catch (err) {
      // 42501 is insufficient_privilege, and it has more than one cause here:
      // `CREATE EXTENSION vector` for a role that may not, and — on Postgres 15
      // and later, where CREATE on schema `public` is no longer granted to
      // PUBLIC — `CREATE TABLE` for a role that does not own the database. The
      // remedies differ, so the underlying message is carried through rather
      // than replaced by whichever guess is written here.
      const code = (err as { code?: string } | null)?.code;
      if (code === "42501") {
        throw new ProvisionPrivilegeError(err instanceof Error ? err.message : String(err));
      }
      // 42P07 is duplicate_table. The pre-flight above catches the ordinary
      // partial-schema case; this catches the race — something created a table
      // between the probe and the apply — and gives it the same named answer
      // rather than a driver stack.
      if (code === "42P07") {
        throw new ProvisionStateError(
          `${err instanceof Error ? err.message : String(err)}\n` +
            "  This database gained a table between the emptiness check and the apply.\n" +
            "  Nothing was written — the whole file is one implicit transaction.",
        );
      }
      throw err;
    }
    notes.push("Applied db/init.sql.");
  } finally {
    await sql.end().catch(() => {});
  }

  // Its own connection, deliberately: `runMigrations` opens, uses and ends one
  // of its own, and it takes the session-level advisory lock that serialises
  // two rollouts. Handing it a connection this function still owned would give
  // it a lock lifetime it does not control.
  try {
    await runMigrations(databaseUrl, { baseline: true, quiet: true });
  } catch (err) {
    // The schema landed. Saying so is the whole point: the naked rethrow
    // printed a bun source snippet under "Provisioning failed:", which reads as
    // "nothing happened" for a database that is most of the way there.
    throw new ProvisionBaselineError(err);
  }
  notes.push("Recorded the shipped migrations as applied (baseline).");

  return { status: "provisioned", notes };
}

const PRIVILEGE_INSTRUCTION = [
  "",
  "  The role this connected as may not run something db/init.sql asks for.",
  "  Nothing was written — the whole file is one implicit transaction, so it",
  "  rolled back.",
  "",
  "  Postgres said:",
  "",
];

const PRIVILEGE_REMEDIES = [
  "",
  "  Two causes, and the message above says which:",
  "",
  "  · `extension \"vector\"` / `CREATE EXTENSION` — the app user may not create",
  "    an extension on a managed instance. Have a role that can run it once:",
  "",
  "      CREATE EXTENSION IF NOT EXISTS vector;",
  "",
  "    then re-run this script as the app user. init.sql's own `IF NOT EXISTS`",
  "    short-circuits before the privilege check, so the rest of the file applies.",
  "",
  "  · `permission denied for schema public` — the role does not own this",
  "    database. On Postgres 15 and later CREATE on `public` is not granted to",
  "    PUBLIC. Grant it, or connect as the owner nais provisioned.",
  "",
];

// --- CLI entrypoint ---

/** Every flag this script accepts. Anything else is refused rather than
 *  ignored: `--dryrun`, `--dry_run` and `-n` all used to fall through to a REAL
 *  provisioning run, because the flag was read with `argv.includes` and an
 *  unmatched argument meant nothing. For the one command in this repo whose
 *  purpose is applying a schema, a typo in the safety valve must not BE the
 *  unsafe path. */
const KNOWN_FLAGS = new Set(["--dry-run", "--yes"]);

const CONFIRM_INSTRUCTION = [
  "",
  "  Re-run with --yes to provision THAT database:",
  "",
  "    bun db/provision.ts --yes",
  "",
  "  Why the confirmation. Bun auto-loads `.env`, so a bare invocation in a",
  "  checkout resolves whatever DATABASE_URL that file names — with nothing",
  "  typed and nothing exported. This script applies 881 lines of DDL, so the",
  "  target is confirmed rather than inferred. (`.env` is in .dockerignore, so",
  "  in a pod the URL can only have come from the platform.)",
  "",
  "  --dry-run needs no --yes: it is the form that cannot write.",
  "",
].join("\n");

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
  const DRY_RUN = args.includes("--dry-run");
  const CONFIRMED = args.includes("--yes");

  const databaseUrl = resolveCliDatabaseUrl();

  if (unknown.length > 0) {
    console.error(
      `Unrecognised argument(s): ${unknown.join(" ")}. ` +
        `Known flags: ${[...KNOWN_FLAGS].join(", ")}. Nothing was written.`,
    );
    process.exitCode = 2;
  } else if (!databaseUrl) {
    // `DATABASE_URL` → `DB_URL`, and NO dev default. db/migrate.ts falls back to
    // a laptop URL because `bun run db:migrate` relies on it; this script
    // APPLIES A SCHEMA, so guessing is the one outcome worth refusing outright.
    // ./require-provisioned.ts refuses for the same reason.
    console.error(
      `${DATABASE_URL_ENV_NAMES} is not set — refusing to guess which database to provision.`,
    );
    process.exitCode = 2;
  } else {
    // Host and database only, never credentials. This is the only line naming
    // what is about to be written, on a path that bypasses the entrypoint's own
    // echo — and it prints BEFORE the confirmation gate, so the operator being
    // asked to type --yes can see what they would be agreeing to.
    let target = databaseUrl;
    try {
      const parsed = new URL(parsePostgresUrl(databaseUrl).url);
      target = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
      console.log(`Database: ${target}`);
    } catch {
      // an unparseable URL fails loudly one statement later; don't pre-empt it
    }

    if (!DRY_RUN && !CONFIRMED) {
      console.error(`Refusing to provision ${target} without confirmation.`);
      console.error(CONFIRM_INSTRUCTION);
      process.exitCode = 2;
    } else {
      try {
        const result = await provisionDatabase(databaseUrl, { dryRun: DRY_RUN });
        for (const note of result.notes) console.log(`  ${note}`);
        // "already provisioned" and "not empty" are not success: someone ran
        // this expecting a schema to be laid down, and none was. Exit 1 so a
        // script chaining on it stops rather than reporting a database it did
        // not build.
        process.exitCode =
          result.status === "already-provisioned" || result.status === "not-empty" ? 1 : 0;
      } catch (err) {
        if (err instanceof ProvisionPrivilegeError) {
          console.error(PRIVILEGE_INSTRUCTION.join("\n"));
          console.error(`    ${err.pgMessage}`);
          console.error(PRIVILEGE_REMEDIES.join("\n"));
          process.exitCode = 1;
        } else if (err instanceof ProvisionStateError) {
          console.error(`\n  ${err.message}\n`);
          process.exitCode = 1;
        } else if (err instanceof ProvisionBaselineError) {
          console.error(`\n  ${err.message}\n`);
          console.error(`  Underlying failure: ${String(err.cause2)}\n`);
          process.exitCode = 1;
        } else if (err instanceof DatabaseUrlError) {
          console.error(err.message);
          process.exitCode = 2;
        } else {
          console.error("Provisioning failed:", err);
          process.exitCode = 1;
        }
      }
    }
  }
}
