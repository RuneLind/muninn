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
 * The port matches `docker-compose.yml` and CI's `pgvector/pgvector:pg17`
 * service.
 */
export const TEST_DATABASE_URL = "postgresql://muninn:muninn@127.0.0.1:5435/muninn_test";
