import type { Context } from "hono";
import { getLog } from "../logging.ts";

const log = getLog("ai", "knowledge-api");

const DEFAULT_TIMEOUT_MS = 5000;

export class KnowledgeApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    /** The upstream HTTP status when the failure was an API response (not a
     *  transport error) — lets callers distinguish e.g. a 409 CAS conflict from a
     *  generic 502. Undefined when the API was unreachable. */
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "KnowledgeApiError";
  }
}

interface KnowledgeApiOptions {
  timeoutMs?: number;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * The request half both public fetchers share: AbortController timeout, the
 * optional method/body/headers, and the 502/503 mapping.
 *
 * PRIVATE, and it hands back the `Response` rather than a body — the two
 * exported wrappers below differ in exactly one line (`.json()` vs `.text()`)
 * and everything before that line is the contract. It used to be two
 * byte-identical copies, which is two places for a timeout or a status mapping
 * to change on its own.
 *
 * The body read stays INSIDE each wrapper's own try, because a `.json()` on a
 * malformed body must map to the same 503 the transport failure does; that is
 * the behaviour both copies had.
 */
async function fetchKnowledgeApiRes(
  baseUrl: string,
  path: string,
  options: KnowledgeApiOptions | undefined,
  readBody: (res: Response) => Promise<unknown>,
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOptions: RequestInit = { signal: controller.signal };
    if (options?.method) fetchOptions.method = options.method;
    if (options?.body) fetchOptions.body = options.body;
    if (options?.headers) fetchOptions.headers = options.headers;

    const res = await fetch(`${baseUrl}${path}`, fetchOptions);
    clearTimeout(timeout);
    if (!res.ok) {
      throw new KnowledgeApiError("API returned " + res.status, 502, res.status);
    }
    return await readBody(res);
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof KnowledgeApiError) throw err;
    throw new KnowledgeApiError("Knowledge API unreachable", 503);
  }
}

/**
 * Fetch from the Knowledge API with AbortController timeout and error handling.
 *
 * @param baseUrl  The Knowledge API base URL (e.g. "http://localhost:8321")
 * @param path     The API path (e.g. "/api/tags?collection=foo")
 * @param options  Optional: timeoutMs (default 5000), method, body, headers
 * @returns        Parsed JSON response
 * @throws         KnowledgeApiError with statusCode 502 (upstream error) or 503 (unreachable)
 */
export async function fetchKnowledgeApi(
  baseUrl: string,
  path: string,
  options?: KnowledgeApiOptions,
): Promise<any> {
  return await fetchKnowledgeApiRes(baseUrl, path, options, (res) => res.json());
}

/**
 * The same fetch as {@link fetchKnowledgeApi} — same timeout, same 502/503
 * mapping — for an endpoint that answers with TEXT rather than JSON.
 *
 * It exists for huginn's `GET /api/document/<c>/<id>?raw=1` (huginn #131),
 * which serves a capture's source file as `text/markdown`. That body is what
 * the capture re-run splits at `## Transcript`, and it MUST NOT be parsed: the
 * JSON form is a cleaned copy (fences removed, images rewritten, a breadcrumb
 * prepended), so a re-run built from it shrinks the document a little on every
 * pass.
 *
 * Deliberately a sibling rather than an option on `fetchKnowledgeApi`: that
 * function's contract is "parsed JSON", and a caller that got a string back
 * from it because of a flag is one refactor away from a `.documents` read on a
 * string. The two share their whole request half through
 * `fetchKnowledgeApiRes`, so being siblings costs no duplication.
 */
export async function fetchKnowledgeApiText(
  baseUrl: string,
  path: string,
  options?: KnowledgeApiOptions,
): Promise<string> {
  return (await fetchKnowledgeApiRes(baseUrl, path, options, (res) => res.text())) as string;
}

/**
 * Hono handler helper: fetches from the Knowledge API and returns a JSON response.
 * On success returns the API's JSON with status 200.
 * On upstream error returns `{ error: "API returned <status>" }` with status 502.
 * On unreachable returns `{ error: "Knowledge API unreachable" }` with status 503.
 */
export async function knowledgeApiHandler(
  c: Context,
  baseUrl: string,
  path: string,
  timeoutMs?: number,
): Promise<Response> {
  try {
    const data = await fetchKnowledgeApi(baseUrl, path, { timeoutMs });
    return c.json(data);
  } catch (err) {
    if (err instanceof KnowledgeApiError) {
      log.warn("Knowledge API error on {path}: {error}", { path, error: err.message });
      return c.json({ error: err.message }, err.statusCode as 502 | 503);
    }
    log.warn("Knowledge API unexpected error on {path}: {error}", { path, error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: "Knowledge API unreachable" }, 503);
  }
}
