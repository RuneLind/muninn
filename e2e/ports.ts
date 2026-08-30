/**
 * Every TCP port the e2e suite binds, in one place.
 *
 * Playwright runs SPEC FILES in parallel across workers, and most specs in this
 * directory boot their own muninn on a hardcoded port. Two files picked 3042 —
 * `plans-write` for its read-only instance and `wiki-start-cards` for its only
 * one — so under parallelism whichever bound first won and the loser's server
 * died on `EADDRINUSE`. The symptom was NOT a bind error: the surviving server
 * answers on that port with a DIFFERENT wiki registered, so the loser's specs
 * either read an empty page list (`.wiki-list-item` count 0, expected 2) or hit
 * `ERR_CONNECTION_REFUSED` once the winner's `afterAll` killed it. Which spec
 * lost depended on worker scheduling, so it read as a flake and passed in
 * isolation both ways.
 *
 * A spec must import its port from here rather than writing a literal —
 * `ports.test.ts` fails on a duplicate value AND on a bare port literal left in
 * a spec, which is what makes the collision impossible to reintroduce silently.
 */

/** Not ours to bind, and not available to a spec:
 *  - 3010 is `bun run dev`, the developer's real instance;
 *  - 3011 is the shared server in `playwright.config.ts` (`reuseExistingServer`);
 *  - 9180/9190 are the hivemind + research MCP servers a spawned muninn tries to
 *    open and warns about when they are taken. */
export const RESERVED_PORTS = [3010, 3011, 9180, 9190] as const;

/**
 * One entry per port a spec binds. Names are `<spec-file>`, plus a suffix when a
 * spec boots more than one process.
 */
export const E2E_PORTS = {
  "wiki-integrate": 3021,
  "wiki-factcheck-reader": 3022,
  "wiki-status-facet": 3023,
  "wiki-refresh": 3024,
  "wiki-chat-dialog": 3025,
  "wiki-claim-retry": 3026,
  "wiki-share": 3027,
  "summaries-share": 3028,
  "summaries-share/huginn": 3029,
  "wiki-start-cards": 3030,
  "ws-scope": 3031,
  // Two instances, one spec: MUNINN_LOCAL_ROLE is a per-PROCESS setting, so the
  // admin and `user` halves of the zone acceptance cannot share a server.
  "auth-zones/admin": 3032,
  "auth-zones/user": 3033,
  // MUNINN_AUTH=entra, plus the stub Texas introspection endpoint it points at
  // (an in-process Bun.serve in the spec, not a muninn).
  "entra-identity": 3034,
  "entra-identity/texas": 3035,
  "wiki-code-highlight": 3036,
  "plans-write": 3041,
  "plans-write/readonly": 3042,
  "plans-write/no-queue": 3043,
  // Not bound by anything — the opposite. `plans-write` points `CLAUDE_USAGE_URL`
  // here BECAUSE nothing answers: a dead ledger is the state its assertions are
  // written against. It is registered so the number is reserved against a future
  // spec binding it, which would quietly turn those assertions into a live-ledger
  // run.
  "plans-write/dead-ledger": 8799,
} as const;

export type E2ePortName = keyof typeof E2E_PORTS;

/** The port for one spec process. A typo'd name is a compile error, not a
 *  silently-shared default. */
export function e2ePort(name: E2ePortName): number {
  return E2E_PORTS[name];
}
