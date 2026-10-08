/**
 * The test database, as ONE constant.
 *
 * Split out of `setup-db.ts` because that module imports `bun:test` at the top
 * level — fine for a `bun test` file, fatal in a Playwright process. An e2e spec
 * that needs to read rows back out of the database (`entra-identity.spec.ts`)
 * therefore imports the URL from here.
 *
 * It must stay a shared constant rather than a literal per caller. A spec that
 * spells its own would be one typo away from pointing a spawned muninn — which
 * PROVISIONS USERS — at the developer's real `muninn` database, and
 * `e2e/ports.test.ts` refuses a bare `host:port` literal under `e2e/` for
 * exactly that class of reason.
 *
 * The default's port matches `docker-compose.yml` and CI's
 * `pgvector/pgvector:pg17` service.
 */
const DEFAULT_TEST_DATABASE_URL = "postgresql://muninn:muninn@127.0.0.1:5435/muninn_test";

/**
 * `MUNINN_TEST_DATABASE_URL`, when set, points the suites at another database —
 * a second one on the same server, so two runs (two worktrees, two agents) do
 * not truncate each other's rows. Refused unless its database name ends in
 * `_test`: `db/setup-test-db.ts` drops the public schema of whatever this
 * names, and a typo must never reach a real database.
 */
export function resolveTestDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.MUNINN_TEST_DATABASE_URL ?? "").trim();
  if (!raw) return DEFAULT_TEST_DATABASE_URL;
  let name: string;
  try {
    name = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("MUNINN_TEST_DATABASE_URL is not a URL");
  }
  if (!/^[A-Za-z0-9_]+_test$/.test(name)) {
    throw new Error(`MUNINN_TEST_DATABASE_URL must name a database ending in "_test" (got "${name.slice(0, 64)}")`);
  }
  return raw;
}

export const TEST_DATABASE_URL = resolveTestDatabaseUrl();
