import { ConfigError, VERTEX_GLOBAL_HOST, VERTEX_GLOBAL_REGION } from "../config.ts";
import { getLog } from "../logging.ts";

const log = getLog("ai", "vertex-access");

/**
 * Reaching Vertex AI over plain HTTP: which URLs are Vertex, which of those are
 * refused, and where the bearer token comes from.
 *
 * The Agent SDK (`claude-sdk`) reads its own Vertex env names and needs none of
 * this — see `resolveVertexConfig` in `config.ts`. This module is for the
 * connectors that speak HTTP themselves, where the OpenAI-compatible endpoint
 *
 *     https://<region>-aiplatform.googleapis.com/v1/projects/<p>/locations/<region>/endpoints/openapi
 *
 * is a drop-in for any other OpenAI-compatible `baseUrl` EXCEPT in one respect:
 * the credential is a Google OAuth access token that expires in about an hour,
 * not a static API key.
 */

/** `<region>-aiplatform.googleapis.com`, and the bare region-less host. */
const REGIONAL_HOST = /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/;
/** `aiplatform.<multi-region>.rep.googleapis.com` — the `eu` endpoint and siblings. */
const MULTI_REGION_HOST = /^aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com$/;
/** The region a Vertex resource path names, e.g. `/v1/projects/p/locations/eu/…`. */
const PATH_REGION = /\/locations\/([^/]+)(?:\/|$)/;

function hostOf(baseUrl: string): string | null {
  try {
    // The trailing dot is the load-bearing half, and it is not cosmetic:
    // `aiplatform.googleapis.com.` is the same name in DNS and a LIVE route —
    // measured, it answers 301 to the region-less host, which IS the global
    // endpoint. Without the strip, `isVertexEndpoint` answers false for it, and
    // a request to the global endpoint is then handed to the static-key path
    // with no guard applied at all.
    //
    // `.toLowerCase()` is redundant belt-and-braces: `URL.hostname` already
    // lowercases (measured — no test can tell it from its absence). Kept so the
    // three normalizations read together here and in `pathRegion`, where none of
    // them is redundant.
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
}

/**
 * Does this `baseUrl` address Vertex AI?
 *
 * Host-based and implicit, deliberately, rather than a new per-bot "auth mode"
 * field. There is no second credential that could be meant: a static
 * `OPENAI_API_KEY` against a Vertex host is a guaranteed 401 (measured), so an
 * operator who sets a Vertex `baseUrl` can only have meant Google credentials.
 * The first token fetch logs which source supplied it, so the inference is
 * never silent.
 */
export function isVertexEndpoint(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return host !== null && (REGIONAL_HOST.test(host) || MULTI_REGION_HOST.test(host));
}

/**
 * Refuse a Vertex `baseUrl` that names the `global` region.
 *
 * The same rule `resolveVertexConfig` enforces for the Agent SDK's env names,
 * through the door a connector `baseUrl` opens past every one of those
 * variables. `global` routes to whichever region has capacity and does not
 * report which, so it cannot satisfy a deployment that must keep inference
 * inside a named jurisdiction.
 *
 * **The HOST is the control point, and that part is measured.** Google's refusal
 * for a blocked region names the endpoint — `Access to projects/… through
 * endpoint us-central1-aiplatform.googleapis.com was denied` — so the two host
 * checks are the ones that bind. The resource path is checked as well, and
 * deliberately NOT because it routes: against `endpoints/openapi`,
 * `locations/global`, `locations/%67lobal` and `locations/nosuchregion` ALL
 * answer 200 from the same regional host, which shows the segment is not
 * validated there rather than that it is authoritative. (An earlier version of
 * this comment cited the first two of those as proof that it routes — a
 * conclusion drawn without the third, which is the control that refutes it.) It
 * is refused anyway, on two grounds that do not need it to route: a URL naming
 * `global` is at best confused about what it is asking for, and other Vertex
 * path shapes — `:rawPredict` and friends — do resolve the location from the
 * path. Conservative in the safe direction, and honest about which half binds.
 */
export function assertVertexEndpointAllowed(baseUrl: string, botName: string): void {
  const host = hostOf(baseUrl);
  if (host === null || !isVertexEndpoint(baseUrl)) return;

  const refuse = (what: string): never => {
    throw new ConfigError(
      `Bot "${botName}" has baseUrl="${baseUrl}", which names the \`global\` Vertex ` +
      `region (${what}). \`global\` routes to whichever region has capacity and does not ` +
      `report which, so it cannot satisfy a deployment that must keep inference inside a ` +
      `named jurisdiction. Name an explicit region — the regional host is ` +
      `<region>-${VERTEX_GLOBAL_HOST} with a matching /locations/<region>/ in the path.`,
    );
  };

  if (host === VERTEX_GLOBAL_HOST) refuse("the region-less host IS the global endpoint");
  if (host === `${VERTEX_GLOBAL_REGION}-${VERTEX_GLOBAL_HOST}`) refuse("host prefix");

  let path: string;
  try {
    path = new URL(baseUrl).pathname;
  } catch {
    return;
  }
  if (pathRegion(path) === VERTEX_GLOBAL_REGION) refuse("/locations/global/ in the path");
}

/**
 * The region a Vertex resource path names, NORMALIZED.
 *
 * Three normalizations, because the check above must give one answer for one
 * URL. `URL.pathname` preserves percent-escapes, keeps case, and keeps a
 * trailing dot — so `%67lobal`, `GLOBAL` and `global.` all compared unequal to
 * `global` while being the same request to write down. A door that refuses one
 * spelling and admits another is not a door.
 *
 * (The host is normalized the same three ways already: `URL.hostname` decodes
 * and lowercases, and `hostOf` strips the trailing dot.)
 */
function pathRegion(pathname: string): string | null {
  const raw = PATH_REGION.exec(pathname)?.[1];
  if (raw === undefined) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A lone `%` throws. Such a segment is rejected by Google rather than
    // resolved, so the raw form is the honest comparison, not a reason to refuse.
  }
  return decoded.toLowerCase().replace(/\.+$/, "");
}

// ── The access token ─────────────────────────────────────────────

export interface VertexAccessToken {
  token: string;
  /** Epoch ms after which this token must not be used again. */
  expiresAtMs: number;
  /** Which credential source answered — logged once, so the inference above is visible. */
  source: "metadata-server" | "gcloud-adc";
}

export type VertexTokenFetcher = () => Promise<VertexAccessToken>;

/**
 * Stop using a token this long before it expires, so a request that STARTS just
 * inside the window still authenticates. Generous rather than tight: the cost of
 * refreshing early is one cheap call, and the cost of refreshing late is a
 * failed chat turn.
 */
const REFRESH_MARGIN_MS = 120_000;

/**
 * How long a `gcloud`-sourced token is trusted for.
 *
 * gcloud DOES report an expiry, and it is a naive UTC datetime (measured
 * 2026-08-28: it read 59.5 minutes ahead of `date -u`). It is not parsed here
 * anyway. Reading it costs an output-format flag whose field names are gcloud's
 * to change, and `--format=json` — the obvious way to ask — prints the OAuth
 * client secret and the refresh token alongside it, which this process has no
 * business reading. A conservative window plus the 401 retry below is strictly
 * safer: the ONLY consequence of guessing this too long is one extra round trip
 * on the first request after the real expiry, and then a fresh token.
 *
 * The metadata server needs none of this — it reports `expires_in` as a number.
 */
const GCLOUD_ASSUMED_TTL_MS = 30 * 60_000;

/** Google's own ceiling for an OAuth access token. Nothing may be cached longer,
 *  whatever a credential source claims. */
const MAX_TOKEN_TTL_MS = 60 * 60_000;

/** The metadata server answers in single-digit ms in a pod; off one it is an
 *  unroutable address that must not delay `gcloud` getting its turn. */
const METADATA_TIMEOUT_MS = 700;

async function fetchFromMetadataServer(): Promise<VertexAccessToken | null> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) return null;
    // A missing or nonsensical `expires_in` falls back to the same conservative
    // window gcloud gets, rather than to `now` (a refresh storm) or to an hour
    // (a stale token). CLAMPED at the top, because the number is trusted
    // verbatim otherwise: one absurd-but-numeric value (`1e15`) would pin a
    // single token for the life of the process. An hour is Google's own maximum
    // for these tokens, so the clamp can only ever shorten a real answer.
    const reportedMs = typeof body.expires_in === "number" && body.expires_in > 0
      ? body.expires_in * 1000
      : GCLOUD_ASSUMED_TTL_MS;
    const ttlMs = Math.min(reportedMs, MAX_TOKEN_TTL_MS);
    return { token: body.access_token, expiresAtMs: Date.now() + ttlMs, source: "metadata-server" };
  } catch {
    return null; // Not on GCE — `gcloud` is the other shape this runs in.
  }
}

async function fetchFromGcloud(): Promise<VertexAccessToken> {
  let proc;
  try {
    proc = Bun.spawn(["gcloud", "auth", "application-default", "print-access-token"], {
      stdout: "pipe", stderr: "pipe",
    });
  } catch {
    // `Bun.spawn` THROWS for a binary that is not on PATH, so without this catch
    // the useful message below is unreachable in the commonest case of all.
    throw new Error(
      "No Vertex credential: the GCE metadata server is unreachable and `gcloud` is not on " +
      "PATH. Install the Google Cloud SDK and run `gcloud auth application-default login`.",
    );
  }
  const token = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !token) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(
      "No Vertex credential: the GCE metadata server is unreachable and `gcloud auth " +
      `application-default print-access-token\` failed — ${err.slice(0, 300)}`,
    );
  }
  return { token, expiresAtMs: Date.now() + GCLOUD_ASSUMED_TTL_MS, source: "gcloud-adc" };
}

/** Application Default Credentials, in the two shapes muninn runs under: the
 *  workload-identity metadata server in a pod, `gcloud` on a developer machine.
 *  No key material is read, printed or stored — only the access token itself. */
export const defaultVertexTokenFetcher: VertexTokenFetcher = async () =>
  (await fetchFromMetadataServer()) ?? (await fetchFromGcloud());

/**
 * A cached, single-flighted Vertex access token.
 *
 * Single-flight because the alternative is one credential fetch per concurrent
 * turn: on the `gcloud` path each is a ~700 ms subprocess (measured), and five
 * bots answering at once would spawn five.
 */
export class VertexTokenProvider {
  #cached: VertexAccessToken | null = null;
  /** The outstanding fetch AND the generation it was started at, together —
   *  a caller that joins it must report that flight's generation, not whatever
   *  the counter has reached since. */
  #inFlight: { generation: number; promise: Promise<VertexAccessToken> } | null = null;
  #loggedSource: string | null = null;
  /** Bumped by `invalidate()`. A fetch that started before the bump must not
   *  install its result — see there. */
  #generation = 0;

  constructor(private readonly fetcher: VertexTokenFetcher = defaultVertexTokenFetcher) {}

  /**
   * A token, plus the GENERATION it came from — the value to hand back to
   * {@link invalidate} if it turns out to be refused. Without it, a burst of
   * concurrent 401s each invalidates the refresh the previous one started (see
   * there).
   */
  async acquire(now: number = Date.now()): Promise<{ token: string; generation: number }> {
    const cached = this.#cached;
    if (cached && this.#usable(cached, now)) {
      return { token: cached.token, generation: this.#generation };
    }

    // Whatever comes back is returned, even if it is already inside the margin.
    // Refetching on that condition was tried and reverted: a token legitimately
    // near its end is exactly what a source hands over just before it rolls, so
    // the branch fired on the ordinary refresh and fetched twice for nothing. A
    // source that keeps returning near-dead tokens is not something a second
    // call fixes — the 401 retry in `openai-compat-auth.ts` is that backstop.
    const fetched = await this.#fetchShared();
    return { token: fetched.token.token, generation: fetched.generation };
  }

  /**
   * Report the token from `generation` as refused, and make the next `acquire()`
   * fetch a new one.
   *
   * Detaching `#inFlight` is the load-bearing half. Clearing only `#cached` made
   * this a NO-OP whenever a fetch happened to be in flight: the next acquire
   * joined that flight, and the flight then re-installed the very token that had
   * just been refused. The generation bump is the other half — the detached
   * flight must not write `#cached` when it lands either.
   *
   * And the generation ARGUMENT is the third. Detaching unconditionally made
   * every caller in a 401 burst throw away the refresh the previous caller had
   * already started: five simultaneous turns produced five credential fetches
   * (five ~700 ms subprocesses on the `gcloud` path) and five tokens, four of
   * them discarded unwritten — defeating the single flight on the one path it
   * exists for. A caller reporting a generation that has already been superseded
   * is reporting a token someone else has replaced, so there is nothing to do.
   */
  invalidate(generation: number): void {
    if (generation < this.#generation) return;
    this.#cached = null;
    this.#inFlight = null;
    this.#generation++;
  }

  #usable(token: VertexAccessToken, now: number): boolean {
    return token.expiresAtMs - REFRESH_MARGIN_MS > now;
  }

  async #fetchShared(): Promise<{ token: VertexAccessToken; generation: number }> {
    // Join an in-flight fetch rather than starting a second one. No expiry test
    // here, and none is owed: a flight in progress is at most one fetch old
    // (sub-second on both sources), so its token cannot be staler than one this
    // caller would have fetched itself.
    const existing = this.#inFlight;
    if (existing) return { token: await existing.promise, generation: existing.generation };

    const generation = this.#generation;
    const entry: { generation: number; promise: Promise<VertexAccessToken> } = {
      generation,
      promise: undefined as unknown as Promise<VertexAccessToken>,
    };
    entry.promise = this.fetcher().finally(() => {
      if (this.#inFlight === entry) this.#inFlight = null;
    });
    this.#inFlight = entry;
    const fresh = await entry.promise;
    if (this.#generation === generation) {
      this.#cached = fresh;
      if (this.#loggedSource !== fresh.source) {
        this.#loggedSource = fresh.source;
        log.info("Vertex access token from {source}", { source: fresh.source });
      }
    }
    return { token: fresh, generation };
  }
}

/** Process-wide, because the credential is the process's, not a bot's: two bots
 *  on Vertex share one ADC identity and must not each hold their own cache. */
export const vertexTokens = new VertexTokenProvider();
