/// <reference lib="dom" />
/** Shared browser-runtime helpers for the dashboard/chat inline scripts.
 *
 *  These are bundled onto `globalThis` via `helpers-browser.ts`, so any page
 *  that injects `helpersClientScript()` can call `sseClient()` / `getJson()`
 *  by bare name from its inline `<script>` IIFE.
 *
 *  - `sseClient` collapses the hand-rolled `new EventSource(...) + N ×
 *    addEventListener + onerror` boilerplate duplicated across the summaries,
 *    research, and chat pages into one call that returns a close handle.
 *  - `getJson` is `fetch` + ok-check + JSON parse with a typed error path
 *    (`HttpError` carries the status and any parsed error body).
 */

/** Handler map for {@link sseClient}. Keys are SSE event names wired via
 *  `addEventListener`, except the reserved `onopen`/`onerror` which map to the
 *  EventSource's native `onopen`/`onerror` (connection lifecycle, no `data`).
 *  Note a server may also emit a *named* `error` event (with a `data` payload) —
 *  pass it as `error` to get it via `addEventListener`; use `onerror` for the
 *  native connection-drop callback. */
export interface SseHandlers {
  onopen?: (ev: Event) => void;
  onerror?: (ev: Event) => void;
  [event: string]: ((ev: MessageEvent) => void) | ((ev: Event) => void) | undefined;
}

/** Close handle returned by {@link sseClient}. */
export interface SseHandle {
  /** The underlying EventSource — for readyState checks / identity guards. */
  source: EventSource;
  /** Closes the stream. Idempotent (EventSource.close is a no-op when closed). */
  close: () => void;
}

/** Open an EventSource and wire named-event + onopen/onerror handlers. */
export function sseClient(url: string, handlers: SseHandlers = {}): SseHandle {
  const es = new EventSource(url);
  for (const name of Object.keys(handlers)) {
    const fn = handlers[name];
    if (typeof fn !== "function") continue;
    if (name === "onopen") es.onopen = fn as (ev: Event) => void;
    else if (name === "onerror") es.onerror = fn as (ev: Event) => void;
    else es.addEventListener(name, fn as EventListener);
  }
  return { source: es, close: () => es.close() };
}

/** Thrown by {@link getJson} on a non-2xx response. Carries the HTTP status and
 *  the parsed JSON error body when the server sent one (else `undefined`). */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** `fetch` + ok-check + JSON parse. Throws {@link HttpError} on a non-2xx
 *  response (with the parsed error body when present). */
export async function getJson<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Non-JSON error body — leave `body` undefined.
    }
    throw new HttpError(res.status, body);
  }
  return (await res.json()) as T;
}
