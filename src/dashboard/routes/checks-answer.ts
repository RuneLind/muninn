/**
 * `GET /api/checks/answer?v=1&machine=<name>&p=<kind>:<value>…` (mimir plan
 * muninn-wiki-owner-step-checks, PR 4): this machine answers owner-step probes
 * for ITSELF, for the other machine's step-checks route (`peer.ts`). It takes
 * probes only, never a step key, wiki or relPath: pages differ between machines.
 *
 * - `machine` must equal this process's `MUNINN_MACHINE`; otherwise (or with
 *   none set) every probe answers `unknown` with a why naming both, so a
 *   mis-pointed url never reads as checked.
 * - Probes run exactly as the local path runs them (`answerProbesHere`: the
 *   shared cache, git slots and per-probe bounds), within
 *   {@link PEER_ROUTE_BOUND_MS}. It has no peer, so it never forwards.
 * - At most {@link PEER_ROUTE_MAX_IN_FLIGHT} requests run at once; another is
 *   answered 429 at once. A probe value or machine name over
 *   {@link PEER_PROBE_VALUE_MAX} chars is a 400.
 * - It writes nothing, so a `MUNINN_WIKI_READONLY` instance answers too. It
 *   spawns git, so it is on `SIDE_EFFECTING_GETS`; under an authenticating mode
 *   it has no zone entry and falls to the admin default.
 * - Registered in the `wiki` group beside step-checks: a pod has no such route.
 */

import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import { parseCheckAttrs, CHECK_PROBES, type CheckProbe, type CheckProbeKind } from "../../format/check-tag.ts";
import { getLog } from "../../logging.ts";
import { answerProbesHere, MAX_PROBES_PER_PAGE, type LocalAnswerDeps } from "../../wiki/step-checks/answer.ts";
import { CHECKS_ANSWER_PATH, CHECKS_ANSWER_VERSION, PEER_ROUTE_BOUND_MS } from "../../wiki/step-checks/peer.ts";
import { realProbeDeps, stepCheckCache } from "../../wiki/step-checks/real-deps.ts";
import { resolveMachineName } from "../../config.ts";

const log = getLog("dashboard", "checks-answer");

/** Requests to this route running at once; one more is answered 429 and runs nothing. */
export const PEER_ROUTE_MAX_IN_FLIGHT = 2;
/** The longest probe value or machine name taken: env keys, migration versions and repo folder names are far shorter. */
export const PEER_PROBE_VALUE_MAX = 100;
let inFlight = 0;

export interface ChecksAnswerDeps extends LocalAnswerDeps {
  /** `MUNINN_MACHINE`, or null. */
  machine: string | null;
}

export function realChecksAnswerDeps(config: Config): ChecksAnswerDeps {
  return { probes: realProbeDeps(config), cache: stepCheckCache, machine: config.machine, boundMs: PEER_ROUTE_BOUND_MS };
}

/** One `p=<kind>:<value>` through the page parser's own grammar, or null. */
export function parseProbeParam(raw: string): CheckProbe | null {
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const kind = raw.slice(0, at);
  if (!(CHECK_PROBES as readonly string[]).includes(kind)) return null;
  const parsed = parseCheckAttrs({ [kind as CheckProbeKind]: raw.slice(at + 1) });
  return parsed.probes.length === 1 && parsed.problems.length === 0 ? parsed.probes[0]! : null;
}

export function registerChecksAnswerRoute(app: Hono, config: Config, depsFor: () => ChecksAnswerDeps = () => realChecksAnswerDeps(config)): void {
  app.get(CHECKS_ANSWER_PATH, async (c) => {
    // Bounds the requests in flight, not the git-slot queue: jobs a request queued keep
    // waiting there after its 6 s bound, so a caller repeating requests can still grow
    // that queue, which is unbounded (a follow-up).
    if (inFlight >= PEER_ROUTE_MAX_IN_FLIGHT) return c.json({ error: "busy: too many check requests at once" }, 429);
    inFlight++;
    try {
      return await answer(c);
    } finally {
      inFlight--;
    }
  });

  const answer = async (c: Context) => {
    if (c.req.query("v") !== String(CHECKS_ANSWER_VERSION)) return c.json({ error: `v must be ${CHECKS_ANSWER_VERSION}` }, 400);
    const machineRaw = c.req.query("machine") ?? "";
    const asked = resolveMachineName(machineRaw);
    if (!asked || asked !== machineRaw || machineRaw.length > PEER_PROBE_VALUE_MAX) return c.json({ error: "machine must be a machine name" }, 400);
    const raws = c.req.queries("p") ?? [];
    if (raws.length === 0) return c.json({ error: "no probes" }, 400);
    if (raws.length > MAX_PROBES_PER_PAGE) return c.json({ error: `at most ${MAX_PROBES_PER_PAGE} probes` }, 400);
    const probes: CheckProbe[] = [];
    for (const raw of raws) {
      if (raw.length - raw.indexOf(":") - 1 > PEER_PROBE_VALUE_MAX) return c.json({ error: `a probe value is longer than ${PEER_PROBE_VALUE_MAX}` }, 400);
      const p = parseProbeParam(raw);
      if (!p) return c.json({ error: "a probe is not <kind>:<value> of a known kind and shape" }, 400);
      probes.push(p);
    }
    try {
      const deps = depsFor();
      const own = deps.machine;
      if (own !== asked) {
        const why = own ? `asked as ${asked}, but this muninn is ${own}` : `asked as ${asked}, but this muninn has no MUNINN_MACHINE`;
        return c.json({ v: CHECKS_ANSWER_VERSION, machine: own, results: probes.map((p) => ({ kind: p.kind, value: p.value, state: "unknown", why })) });
      }
      const results = await answerProbesHere(probes, deps);
      return c.json({
        v: CHECKS_ANSWER_VERSION,
        machine: own,
        results: probes.map((p, i) => ({ kind: p.kind, value: p.value, ...(results[i] ?? { state: "unknown", why: "no answer" }) })),
      });
    } catch (err) {
      log.error("Checks answer failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the checks could not be answered" }, 500);
    }
  };
}
