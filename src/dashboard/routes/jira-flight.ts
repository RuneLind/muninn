/**
 * The Jira composer's single-flight registry.
 *
 * One holder today — `POST /api/jira/draft/from-thread`, whose slot is keyed on
 * the THREAD and nothing else. It lives in its own module because the routes
 * file is a registrar and this is a process-wide piece of state with expiry
 * arithmetic worth reading on its own; it was extracted verbatim out of the
 * deleted `jira-sse.ts`, where the notes path used to share it.
 */

import type { JiraDepth } from "../../jira/wire.ts";

/**
 * How long a slot may be HELD, per depth — the budget half of its EXPIRY.
 *
 * **These bound nothing but the slot.** Nothing here cancels a run, and nothing
 * downstream reads them as a timeout: the work is one turn in a chat thread, and
 * the connector owns its own budget — melosys sets `timeoutMs` to 10 000 000, so
 * on the surviving path a turn is effectively unbounded. What this decides is
 * how long a crashed or wedged run may keep a thread's slot before the next 🧾
 * click is allowed through.
 *
 * The numbers are a HEURISTIC, and their provenance says why they are only that.
 * They were measured 2026-08-22 on melosys (copilot-sdk) curl to curl — two cold
 * `Ingen` runs at 21.5 s and 18.2 s, a `Skisse` run at 55.3 s, a `Full` run at
 * 118.4 s — but through the notes POST, which really did pass
 * `JIRA_TIMEOUT_MS_BY_DEPTH[depth]` down as the one-shot's `timeoutMs`. That
 * route is deleted; the figures now describe work that no longer runs, and the
 * feature's own docs put a thread turn at 60–600 s.
 *
 * **The consequence, stated plainly:** a legitimate turn that outruns its expiry
 * FREES ITS OWN SLOT, and a second 🧾 click on that thread then starts a turn
 * that interleaves with the first — the exact failure the slot exists to
 * prevent, arrived at by waiting instead of by clicking twice. Accepted for now;
 * retuning these against measured thread-turn durations is filed as a plan
 * follow-up. The ordering is deliberate in the meantime: `full` gets 5× its old
 * figure because it is a tool loop rather than a bounded completion, and `ingen`
 * and `skisse` share a budget because they differ only by a rider.
 */
export const JIRA_TIMEOUT_MS_BY_DEPTH: Record<JiraDepth, number> = {
  ingen: 120_000,
  skisse: 120_000,
  full: 600_000,
};

/**
 * Slack added to the slot's expiry on top of the budget above.
 *
 * The budget is meant to cover the TURN; this covers everything the run does
 * around it, which is real work: the thread history + `research_citations` read,
 * the citation seeding, and — the only externally bounded item left — the
 * `jira-issues` key-index listing key verification fetches (≤ **15 s**,
 * `verify-keys.ts`). The notes path's own two items are gone with it: the 60 s
 * Haiku question condense and the 8 s per-document pull no longer happen on any
 * path, so 15 s is what the arithmetic actually rests on and
 * `JIRA_SLOT_SLACK_MS >= 15_000` is pinned as a floor in
 * `jira-routes.test.ts`.
 *
 * It is a ceiling on a WEDGE, so over-sizing costs only a later retry after a
 * crash while under-sizing costs two interleaved turns in one conversation —
 * which is why the value sits far above that floor rather than at it.
 */
export const JIRA_SLOT_SLACK_MS = 180_000;

interface JiraFlight {
  startedAt: number;
  expiresAt: number;
}

/**
 * The registry.
 *
 * `expiresAt` on the value is what stops a process killed mid-run from wedging
 * a thread forever; it is evaluated lazily on the next hit — no sweeper, no
 * timer.
 */
const jiraFlights = new Map<string, JiraFlight>();

/**
 * The 409 sentence for the thread slot — ONE spelling.
 *
 * There is exactly ONE holder of a {@link threadFlightKey} slot, `POST
 * …/from-thread` — a re-run is another click on that same route.
 */
export const JIRA_THREAD_FLIGHT_MESSAGE =
  "Det skrives allerede en sak fra denne samtalen — vent til den er ferdig.";

/**
 * The single-flight key: the thread, and nothing else.
 *
 * A thread draft is a message in a conversation, and two of them in one thread
 * interleave (measured: two `Lag Jira-sak` user lines 17 ms apart, then two
 * replies) whatever template or depth each asked for. Keying on the thread makes
 * the second caller wait, which is what the 409 already tells them.
 *
 * Domain-separated by its `jira-thread` prefix, so a thread id can never collide
 * with anything else hashed into this registry.
 */
export function threadFlightKey(threadId: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(["jira-thread", threadId].join("\0"));
  return h.digest("hex");
}

export type JiraAcquisition =
  | { ok: true; release: () => void }
  | { ok: false; expiresAtMs: number };

/** Claim the slot for `key`, treating an EXPIRED holder as free. `release` is
 *  identity-checked, so a late release from a run whose entry already expired and
 *  was re-taken cannot free the newer holder's slot. */
export function acquireJiraFlight(
  key: string,
  depth: JiraDepth,
  now: number = Date.now(),
): JiraAcquisition {
  const held = jiraFlights.get(key);
  if (held && held.expiresAt > now) return { ok: false, expiresAtMs: held.expiresAt };
  const entry: JiraFlight = {
    startedAt: now,
    expiresAt: now + JIRA_TIMEOUT_MS_BY_DEPTH[depth] + JIRA_SLOT_SLACK_MS,
  };
  jiraFlights.set(key, entry);
  return {
    ok: true,
    release: () => {
      if (jiraFlights.get(key) === entry) jiraFlights.delete(key);
    },
  };
}

/** Test-only: drop every in-flight entry. */
export function __resetJiraFlightsForTest(): void {
  jiraFlights.clear();
}
