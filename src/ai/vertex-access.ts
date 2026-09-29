import { ConfigError, VERTEX_GLOBAL_HOST, VERTEX_GLOBAL_REGION } from "../config.ts";
import {
  createAdcTokenFetcher,
  GcpTokenProvider,
  type GcpAccessToken,
  type GcpTokenFetcher,
} from "../gcp/access-token.ts";

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
    // `.toLowerCase()` looks redundant and is not quite. `URL.hostname`
    // lowercases a SPECIAL scheme's host (`https:`) but leaves a non-special
    // scheme's host opaque and verbatim — measured:
    // `new URL("foo://AIPLATFORM.GOOGLEAPIS.COM/x").hostname` is unchanged. That
    // is the only input that can tell this call from its absence, and it is not
    // a live exploit: the connector could not fetch such a URL anyway. Kept and
    // pinned by a test, because an expression no test can distinguish is one
    // someone deletes later. (Two earlier versions of this comment got the
    // reason wrong in both directions — "redundant", then "load-bearing".)
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
//
// The generic half — ADC fetch, single-flight cache, refresh margin, TTL
// ceiling — lives in `src/gcp/access-token.ts`, shared with the wiki bucket
// mirror. These names are kept so every Vertex caller is unchanged.

export type VertexAccessToken = GcpAccessToken;
export type VertexTokenFetcher = GcpTokenFetcher;

export const defaultVertexTokenFetcher: VertexTokenFetcher = createAdcTokenFetcher("Vertex");

/** A {@link GcpTokenProvider} labelled for Vertex, defaulting to ADC. */
export class VertexTokenProvider extends GcpTokenProvider {
  constructor(fetcher: VertexTokenFetcher = defaultVertexTokenFetcher) {
    super(fetcher, "Vertex");
  }
}

/** Process-wide, because the credential is the process's, not a bot's: two bots
 *  on Vertex share one ADC identity and must not each hold their own cache. */
export const vertexTokens = new VertexTokenProvider();
