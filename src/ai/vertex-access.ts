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
    // Trailing dots stripped for the same reason `resolveVertexConfig` strips
    // them: `aiplatform.googleapis.com.` is the same name in DNS.
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
 * Refuse a Vertex `baseUrl` that resolves to the `global` region.
 *
 * The same rule `resolveVertexConfig` enforces for the Agent SDK's env names,
 * through the third door: a connector `baseUrl` steers past every one of those
 * variables. `global` routes to whichever region has capacity and does not
 * report which, so it cannot satisfy a deployment that must keep inference
 * inside a named jurisdiction.
 *
 * Two spellings reach it and both are checked, because the OpenAI-compatible
 * URL carries the region TWICE — once in the host, once in the resource path —
 * and Vertex accepts the path as authoritative for the resource.
 */
export function assertVertexEndpointAllowed(baseUrl: string, botName: string): void {
  const host = hostOf(baseUrl);
  if (host === null || !isVertexEndpoint(baseUrl)) return;

  const refuse = (what: string): never => {
    throw new ConfigError(
      `Bot "${botName}" has baseUrl="${baseUrl}", which addresses the \`global\` Vertex ` +
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
    path = new URL(baseUrl).pathname.toLowerCase();
  } catch {
    return;
  }
  if (PATH_REGION.exec(path)?.[1] === VERTEX_GLOBAL_REGION) refuse("/locations/global/ in the path");
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
    // (a stale token).
    const ttlMs = typeof body.expires_in === "number" && body.expires_in > 0
      ? body.expires_in * 1000
      : GCLOUD_ASSUMED_TTL_MS;
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
  #inFlight: Promise<VertexAccessToken> | null = null;
  #loggedSource: string | null = null;

  constructor(private readonly fetcher: VertexTokenFetcher = defaultVertexTokenFetcher) {}

  async get(now: number = Date.now()): Promise<string> {
    const cached = this.#cached;
    if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now) return cached.token;

    // Await an in-flight fetch rather than starting a second one. Note this is
    // read AFTER the cache check, so a caller that arrives during a refresh gets
    // the new token rather than the expiring one it would otherwise reuse.
    if (this.#inFlight) return (await this.#inFlight).token;

    const flight = this.fetcher().finally(() => {
      if (this.#inFlight === flight) this.#inFlight = null;
    });
    this.#inFlight = flight;
    const fresh = await flight;
    this.#cached = fresh;
    if (this.#loggedSource !== fresh.source) {
      this.#loggedSource = fresh.source;
      log.info("Vertex access token from {source}", { source: fresh.source });
    }
    return fresh.token;
  }

  /** Drop the cached token — after a 401, where the estimate above was wrong. */
  invalidate(): void {
    this.#cached = null;
  }
}

/** Process-wide, because the credential is the process's, not a bot's: two bots
 *  on Vertex share one ADC identity and must not each hold their own cache. */
export const vertexTokens = new VertexTokenProvider();
