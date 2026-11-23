/**
 * The peer client (mimir plan muninn-wiki-owner-step-checks, PR 4): asks the
 * other machine's muninn (`MUNINN_PEERS`) to answer probes for itself through
 * `GET /api/checks/answer`, and trusts the reply only through a closed grammar.
 *
 * - Calls a page makes in one pass are batched per machine: every
 *   `viaPeer` of one `answerStepChecks` runs in the same synchronous pass, so
 *   one microtask later the distinct probes go out in one request (chunks of
 *   {@link MAX_PROBES_PER_PAGE}). A probe already in flight joins that request.
 * - The reply is checked whole: status 200, a JSON content type, at most
 *   {@link PEER_MAX_BYTES}, `v === 1`, `machine` equal to the name asked,
 *   `results` as long as the asked list, each result echoing the asked probe's
 *   kind and value at its index, each `state` one of the three. Anything off
 *   makes every probe of that request `unknown` (a 429: «is busy»). A why
 *   comes back as one line, prefixed `<machine>: ` (`oneLineWhy`).
 * - Its own cache, keyed by (machine, kind, value): `ok`/`not-yet` for
 *   {@link PROBE_TTL_MS}; an `unknown` (transport failure, timeout, a rejected
 *   reply, or the peer's own unknown) is not kept, so a slow first answer never
 *   sticks.
 * - A down window per machine: a request that fails as a whole (fetch threw or
 *   timed out, or the reply was refused) makes that machine's uncached probes
 *   answer `unknown` at once for {@link PEER_DOWN_WINDOW_MS}, so a peer that is
 *   off costs one timeout, not one per page open. A cached `ok`/`not-yet` is
 *   still served inside its TTL; the window never yields one. The opening
 *   failure logs one warn (machine name, error name and code, never the url).
 */

import type { CheckProbe } from "../../format/check-tag.ts";
import { getLog } from "../../logging.ts";
import { MAX_PROBES_PER_PAGE, noPeer, PROBE_TTL_MS, type PeerAnswerer } from "./answer.ts";
import { boundedPeerGet, createDownWindow, failureLogFields, type FetchLike, type PeerFailure } from "./peer-request.ts";
import type { ProbeResult, ProbeState } from "./probes.ts";
import { stampSource, within, type Stamp } from "./two-clock.ts";

export { fetchFailureWhy } from "./peer-request.ts";

export const CHECKS_ANSWER_PATH = "/api/checks/answer";
/** The wire version both sides speak. */
export const CHECKS_ANSWER_VERSION = 1;
/** The whole request, body included: under the asking page's 8 s bound, above the answering side's {@link PEER_ROUTE_BOUND_MS}. */
export const PEER_FETCH_TIMEOUT_MS = 7_000;
/** The answering route's own bound: it must answer before the asker's {@link PEER_FETCH_TIMEOUT_MS} gives up. */
export const PEER_ROUTE_BOUND_MS = 6_000;
/** After a request fails as a whole (fetch threw or timed out, or the reply was refused), a machine's probes answer `unknown` at once for this long instead of each page open waiting out {@link PEER_FETCH_TIMEOUT_MS} again. */
export const PEER_DOWN_WINDOW_MS = 15_000;
/** A reply for 60 probes is a few KiB. */
export const PEER_MAX_BYTES = 64 * 1024;
/** A peer's why is shown as one line; longer is cut. */
const WHY_MAX = 300;
/** C0/C1 controls, U+2028/2029 and the bidi controls: a newline in a why would forge a line of the chip title, which joins lines with \n. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Peer text as one line of plain text, cut at `max`: the unsafe characters become spaces, runs of space one. */
export function oneLine(text: string, max: number): string {
  return text.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A peer's why as one line of plain text, cut at {@link WHY_MAX}. */
export function oneLineWhy(why: string): string {
  return oneLine(why, WHY_MAX);
}

const log = getLog("wiki", "step-checks-peer");

/** A request's results, and the reason when it failed as a whole. */
interface Outcome {
  results: ProbeResult[];
  failure?: PeerFailure;
}

const STATES: ReadonlySet<string> = new Set<ProbeState>(["ok", "not-yet", "unknown"]);

export interface PeerClientDeps {
  peers: ReadonlyMap<string, string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  ttlMs?: number;
  /** {@link PEER_DOWN_WINDOW_MS} unless set. */
  downMs?: number;
  /** One clock driving both halves of every stamp; `wall`/`mono` override a half each (`two-clock.ts`). */
  now?: () => number;
  wall?: () => number;
  mono?: () => number;
}

interface Entry {
  promise: Promise<ProbeResult>;
  settledAt: Stamp | null;
}

interface Pending {
  probe: CheckProbe;
  resolve: (r: ProbeResult) => void;
}

const keyOf = (machine: string, p: CheckProbe) => `${machine}\u0000${p.kind}\u0000${p.value}`;

/** The reply for `asked`, or a reason it is refused. Pure. */
export function readPeerReply(body: unknown, machine: string, asked: readonly CheckProbe[]): ProbeResult[] | { refused: string } {
  if (!body || typeof body !== "object") return { refused: "not a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.v !== CHECKS_ANSWER_VERSION) return { refused: "speaks another version" };
  if (b.machine !== machine) return { refused: "answered as another machine" };
  if (!Array.isArray(b.results) || b.results.length !== asked.length) return { refused: "answered a different number of probes" };
  const out: ProbeResult[] = [];
  for (let i = 0; i < asked.length; i++) {
    const r = b.results[i] as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || r.kind !== asked[i]!.kind || r.value !== asked[i]!.value) return { refused: "answered probes out of order" };
    if (typeof r.state !== "string" || !STATES.has(r.state)) return { refused: "answered a state muninn does not know" };
    if (r.why !== undefined && typeof r.why !== "string") return { refused: "answered a why that is not text" };
    const said = typeof r.why === "string" ? oneLineWhy(r.why) : "";
    const why = said || (r.state === "ok" ? "holds" : "no reason given");
    out.push({ state: r.state as ProbeState, why: `${machine}: ${why}` });
  }
  return out;
}

/**
 * A {@link PeerAnswerer} over `deps.peers`. One instance per process: its
 * cache and in-flight batches are what keep a page from fanning out.
 */
export function createPeerAnswerer(deps: PeerClientDeps): PeerAnswerer {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? PEER_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? PEER_MAX_BYTES;
  const ttlMs = deps.ttlMs ?? PROBE_TTL_MS;
  const now = stampSource({ wall: deps.wall ?? deps.now, mono: deps.mono ?? deps.now });
  const downMs = deps.downMs ?? PEER_DOWN_WINDOW_MS;
  const cache = new Map<string, Entry>();
  const batches = new Map<string, Pending[]>();
  // Both timers are live only while their age is in [0, limit) on the wall AND the monotonic clock (`within`): a wall step
  // forward and a sleep expire them early, a wall step back expires them no later than the monotonic limit (two-clock.ts names the one residual).
  const down = createDownWindow({
    downMs,
    now,
    onOpen: (machine, { reason, err }) =>
      log.warn("Step-check peer {machine} failed ({reason}); its probes answer unknown for {seconds} s", {
        machine,
        reason,
        seconds: Math.round(downMs / 1000),
        ...failureLogFields(err),
      }),
  });
  const isDown = down.isDown;
  const fresh = (e: Entry, t: Stamp) => e.settledAt === null || within(e.settledAt, ttlMs, t);

  // A request that was in flight when the window opened finds it open: no second log line.
  const settle = (machine: string, outcome: Outcome) => down.settle(machine, outcome.failure);

  const request = async (machine: string, base: string, asked: readonly CheckProbe[]): Promise<Outcome> => {
    const qs = new URLSearchParams({ v: String(CHECKS_ANSWER_VERSION), machine });
    for (const p of asked) qs.append("p", `${p.kind}:${p.value}`);
    const got = await boundedPeerGet(`${base}${CHECKS_ANSWER_PATH}?${qs}`, { fetch: doFetch, timeoutMs, maxBytes }, (body) => {
      const read = readPeerReply(body, machine, asked);
      return "refused" in read ? read : { value: read };
    });
    if ("value" in got) return { results: got.value };
    const { reason } = got.failure;
    return { results: asked.map((): ProbeResult => ({ state: "unknown", why: `the peer for ${machine} ${reason}` })), failure: got.failure };
  };

  const flush = (machine: string, base: string) => {
    const batch = batches.get(machine) ?? [];
    batches.delete(machine);
    for (let i = 0; i < batch.length; i += MAX_PROBES_PER_PAGE) {
      const chunk = batch.slice(i, i + MAX_PROBES_PER_PAGE);
      void request(machine, base, chunk.map((c) => c.probe)).then(
        (outcome) => {
          chunk.forEach((c, k) => c.resolve(outcome.results[k] ?? { state: "unknown", why: `the peer for ${machine} sent no answer` }));
          // After the resolves: a throw here must not strand the chunk's in-flight cache entries.
          try {
            settle(machine, outcome);
          } catch {
            /* the window and its log line are best-effort */
          }
        },
        () => chunk.forEach((c) => c.resolve({ state: "unknown", why: `the peer for ${machine} failed` })),
      );
    }
  };

  const one = (machine: string, base: string, probe: CheckProbe): Promise<ProbeResult> => {
    const key = keyOf(machine, probe);
    const t = now();
    const hit = cache.get(key);
    if (hit) {
      if (fresh(hit, t)) return hit.promise;
      cache.delete(key);
    }
    const d = isDown(machine, t);
    if (d) return Promise.resolve({ state: "unknown", why: `the peer for ${machine} was unreachable a moment ago (${d.reason})` });
    let resolve!: (r: ProbeResult) => void;
    const entry: Entry = { promise: new Promise<ProbeResult>((r) => (resolve = r)), settledAt: null };
    cache.set(key, entry);
    void entry.promise.then((r) => {
      if (r.state === "unknown") {
        if (cache.get(key) === entry) cache.delete(key);
      } else entry.settledAt = now();
    });
    for (const [k, e] of cache) if (!fresh(e, t)) cache.delete(k);
    let batch = batches.get(machine);
    if (!batch) {
      batch = [];
      batches.set(machine, batch);
      queueMicrotask(() => flush(machine, base));
    }
    batch.push({ probe, resolve });
    return entry.promise;
  };

  return async (machine, probes) => {
    const base = deps.peers.get(machine);
    if (!base) return noPeer(machine, probes);
    return Promise.all(probes.map((p) => one(machine, base, p)));
  };
}

/** The process's one client, rebuilt only when the configured peers change. */
let shared: { sig: string; answer: PeerAnswerer } | null = null;
export function sharedPeerAnswerer(peers: ReadonlyMap<string, string>): PeerAnswerer | undefined {
  if (peers.size === 0) return undefined;
  const sig = JSON.stringify([...peers]);
  if (shared?.sig !== sig) shared = { sig, answer: createPeerAnswerer({ peers }) };
  return shared.answer;
}
