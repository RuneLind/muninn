import { getLog } from "../logging.ts";

const log = getLog("gcp", "access-token");

/**
 * A Google OAuth access token from Application Default Credentials, for any
 * caller that speaks a Google API over plain HTTP: the Vertex connectors
 * (`src/ai/vertex-access.ts`) and the wiki bucket mirror
 * (`src/wiki/bucket-mirror.ts`). Moved here from `vertex-access.ts` unchanged
 * apart from the `label` that names the caller in logs and errors.
 */

export interface GcpAccessToken {
  token: string;
  /** Epoch ms after which this token must not be used again. */
  expiresAtMs: number;
  /** Which credential source answered — logged once, so the inference is visible. */
  source: "metadata-server" | "gcloud-adc";
}

export type GcpTokenFetcher = () => Promise<GcpAccessToken>;

/**
 * Stop using a token this long before it expires, so a request that STARTS just
 * inside the window still authenticates. Generous rather than tight: the cost of
 * refreshing early is one cheap call, and the cost of refreshing late is a
 * failed request.
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
 * business reading. A conservative window plus the caller's 401 retry is
 * strictly safer: the ONLY consequence of guessing this too long is one extra
 * round trip on the first request after the real expiry, and then a fresh token.
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

async function fetchFromMetadataServer(): Promise<GcpAccessToken | null> {
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

async function fetchFromGcloud(label: string): Promise<GcpAccessToken> {
  let proc;
  try {
    proc = Bun.spawn(["gcloud", "auth", "application-default", "print-access-token"], {
      stdout: "pipe", stderr: "pipe",
    });
  } catch {
    // `Bun.spawn` THROWS for a binary that is not on PATH, so without this catch
    // the useful message below is unreachable in the commonest case of all.
    throw new Error(
      `No ${label} credential: the GCE metadata server is unreachable and \`gcloud\` is not on ` +
      "PATH. Install the Google Cloud SDK and run `gcloud auth application-default login`.",
    );
  }
  const token = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !token) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(
      `No ${label} credential: the GCE metadata server is unreachable and \`gcloud auth ` +
      `application-default print-access-token\` failed — ${err.slice(0, 300)}`,
    );
  }
  return { token, expiresAtMs: Date.now() + GCLOUD_ASSUMED_TTL_MS, source: "gcloud-adc" };
}

/** Application Default Credentials, in the two shapes muninn runs under: the
 *  workload-identity metadata server in a pod, `gcloud` on a developer machine.
 *  No key material is read, printed or stored — only the access token itself.
 *  `label` names the caller in the no-credential error. */
export function createAdcTokenFetcher(label: string): GcpTokenFetcher {
  return async () => (await fetchFromMetadataServer()) ?? (await fetchFromGcloud(label));
}

/**
 * A cached, single-flighted access token.
 *
 * Single-flight because the alternative is one credential fetch per concurrent
 * request: on the `gcloud` path each is a ~700 ms subprocess (measured), and five
 * bots answering at once would spawn five.
 */
export class GcpTokenProvider {
  #cached: GcpAccessToken | null = null;
  /** The outstanding fetch AND the generation it was started at, together —
   *  a caller that joins it must report that flight's generation, not whatever
   *  the counter has reached since. */
  #inFlight: { generation: number; promise: Promise<GcpAccessToken> } | null = null;
  #loggedSource: string | null = null;
  /** Bumped by `invalidate()`. A fetch that started before the bump must not
   *  install its result — see there. */
  #generation = 0;

  constructor(
    private readonly fetcher: GcpTokenFetcher,
    /** Names the caller in the one-time "token from <source>" log line. */
    private readonly label: string,
  ) {}

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
    // call fixes — the caller's 401 retry is that backstop.
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

  #usable(token: GcpAccessToken, now: number): boolean {
    return token.expiresAtMs - REFRESH_MARGIN_MS > now;
  }

  async #fetchShared(): Promise<{ token: GcpAccessToken; generation: number }> {
    // Join an in-flight fetch rather than starting a second one. No expiry test
    // here, and none is owed: a flight in progress is at most one fetch old
    // (sub-second on both sources), so its token cannot be staler than one this
    // caller would have fetched itself.
    const existing = this.#inFlight;
    if (existing) return { token: await existing.promise, generation: existing.generation };

    const generation = this.#generation;
    const entry: { generation: number; promise: Promise<GcpAccessToken> } = {
      generation,
      promise: undefined as unknown as Promise<GcpAccessToken>,
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
        log.info("{label} access token from {source}", { label: this.label, source: fresh.source });
      }
    }
    return { token: fresh, generation };
  }
}
