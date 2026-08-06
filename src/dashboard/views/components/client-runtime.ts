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

// ── Raw `text/event-stream` framing ───────────────────────────────────
// `sseClient` above covers the ordinary case. Some streams cannot use
// `EventSource` at all — it exposes neither status nor body on a non-200 (so a
// 409's JSON payload is unreadable) and it auto-reconnects on a drop, straight
// back into whatever single-flight slot the first connection was holding. Those
// consume `fetch` + a ReadableStream and need their OWN framing, which is what
// these two are. They live here — beside `sseClient` — rather than in a DOM
// module, so they can be unit-tested without a browser.

/** One decoded SSE frame: the event name (`message` when the frame named none)
 *  and its `data:` lines joined with newlines. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Decode ONE raw frame (the text between two blank lines).
 *
 * Per the spec: `:` lines are comments, `field: value` drops ONE leading space
 * after the colon, and multiple `data:` lines join with `\n`. Returns null for a
 * frame carrying neither an `event:` nor a `data:` line (a comment-only keepalive
 * dispatches nothing).
 */
export function parseSseFrame(raw: string): SseFrame | null {
  let event = "";
  const dataLines: string[] = [];
  let sawData = false;
  for (const line of raw.split("\n")) {
    const l = line.replace(/\r$/, "");
    if (!l || l.charAt(0) === ":") continue;
    if (l.indexOf("event:") === 0) event = l.slice(6).replace(/^ /, "").trim();
    else if (l.indexOf("data:") === 0) {
      sawData = true;
      dataLines.push(l.slice(5).replace(/^ /, ""));
    }
  }
  if (!sawData && !event) return null;
  return { event: event || "message", data: dataLines.join("\n") };
}

/** Incremental frame splitter returned by {@link makeSseFrameParser}. */
export interface SseFrameParser {
  /** Feed a decoded chunk; emits every COMPLETE frame it now holds. */
  push: (text: string) => void;
  /** End of stream: emit a final frame the server never terminated with a blank
   *  line. Idempotent. */
  end: () => void;
}

/**
 * Split a byte stream into SSE frames, tolerating chunk boundaries anywhere.
 *
 * Two details are load-bearing and were both wrong in the hand-rolled version
 * this replaces: the delimiter is `\r?\n\r?\n`, because a proxy (or any server
 * writing CRLF) produces frames a bare `\n\n` scan never finds at all; and
 * {@link end} flushes the buffered tail, because a server that closes right after
 * its last frame without a trailing blank line otherwise LOSES that frame — for
 * the claim-retry stream that is the verdict itself, dropped silently.
 */
export function makeSseFrameParser(onFrame: (frame: SseFrame) => void): SseFrameParser {
  let buf = "";
  const emit = (raw: string): void => {
    const frame = parseSseFrame(raw);
    if (frame) onFrame(frame);
  };
  return {
    push(text: string): void {
      if (!text) return;
      buf += text;
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        emit(raw);
      }
    },
    end(): void {
      const tail = buf;
      buf = "";
      if (tail.trim()) emit(tail);
    },
  };
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
