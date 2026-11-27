/// <reference lib="dom" />
/**
 * One EventSource per URL across all of this origin's tabs.
 *
 * Chrome allows 6 HTTP/1.1 connections per host, and every dashboard home,
 * /agents and /chat tab held one permanent stream: with enough tabs open a
 * POST (a Discuss send) sat in the browser's queue and never reached the
 * server (measured 2026-11-27, 16 connections open to :3010).
 *
 * The tab holding the Web Lock `muninn-sse:<url>` opens the real stream and
 * re-posts every frame on the BroadcastChannel of the same name; the others
 * queue on the lock and dispatch what the channel brings. A joiner says
 * `hello` and the leader answers it alone with its lifecycle state and a
 * replay buffer (the latest frame of each name, `history[name]` frames of a
 * name that accumulates), so it starts where a fresh connection would.
 * When the leader closes (or its tab goes), the lock passes to the next tab,
 * which opens its own stream. A leader whose stream dies for good
 * (readyState 2, a non-200) steps down and stays dead, as its own tab would.
 *
 * Without `navigator.locks` or `BroadcastChannel` (Web Locks need a secure
 * context: http://localhost is one, http://<tailnet-host> is not) this is
 * plain {@link sseClient}.
 */
import { sseClient, type SseHandlers } from "./client-runtime.ts";

export interface SharedSseLocks {
  request(name: string, opts: { signal?: AbortSignal }, cb: () => Promise<void>): Promise<unknown>;
}

export interface SharedSseChannel {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface SharedSseDeps {
  locks: SharedSseLocks | null;
  channel: ((name: string) => SharedSseChannel) | null;
  eventSource: (url: string) => EventSource;
  id: () => string;
}

export interface SharedSseOptions {
  /** Event names the stream carries beyond this handler map's own: a leading
   *  tab relays (and buffers) them for tabs that read them. */
  events?: readonly string[];
  /** Names whose frames accumulate, and how many of each a joiner is replayed.
   *  Any other name replays its latest frame only. */
  history?: Readonly<Record<string, number>>;
  deps?: SharedSseDeps;
}

export interface SharedSseHandle {
  /** This tab's own EventSource: the leader's or the fallback's, else null. */
  readonly source: EventSource | null;
  /** The leader's own EventSource state, or (a follower) the last state the
   *  leader broadcast; 2 once closed. */
  readonly readyState: number;
  readonly role: "leader" | "follower" | "solo" | "done";
  close(): void;
}

/** The operator stream's channels (`sse-routes.ts`): home and /agents pass
 *  the same set, so whichever tab leads relays what the other reads. */
export const API_EVENTS_SHARED: SharedSseOptions = {
  events: ["activity", "stats", "agent_status", "request_progress", "agent_runs"],
  history: { activity: 50 },
};

interface Frame {
  event: string;
  data: string;
  lastEventId: string;
}

type Msg =
  | { t: "hello"; from: string; events: string[] }
  | { t: "welcome"; to: string; rs: number; frames: Frame[] }
  | ({ t: "frame" } & Frame)
  | { t: "open" }
  | { t: "error"; rs: number };

function defaultDeps(): SharedSseDeps {
  const g = globalThis as { navigator?: { locks?: SharedSseLocks }; BroadcastChannel?: new (name: string) => SharedSseChannel };
  const locks = g.navigator?.locks;
  const BC = g.BroadcastChannel;
  return {
    locks: locks && typeof locks.request === "function" ? locks : null,
    channel: typeof BC === "function" ? (n) => new BC(n) : null,
    eventSource: (u) => new EventSource(u),
    id: () => Math.random().toString(36).slice(2) + Date.now().toString(36),
  };
}

function lifecycleEvent(type: string): Event {
  return typeof Event === "function" ? new Event(type) : ({ type } as Event);
}

function frameEvent(f: Frame): MessageEvent {
  return typeof MessageEvent === "function"
    ? new MessageEvent(f.event, { data: f.data, lastEventId: f.lastEventId })
    : ({ type: f.event, data: f.data, lastEventId: f.lastEventId } as MessageEvent);
}

export function sharedSseClient(url: string, handlers: SseHandlers = {}, opts: SharedSseOptions = {}): SharedSseHandle {
  const deps = opts.deps ?? defaultDeps();
  if (!deps.locks || !deps.channel) {
    const h = sseClient(url, handlers, deps.eventSource);
    return {
      source: h.source,
      get readyState() {
        return h.source.readyState;
      },
      role: "solo",
      close: h.close,
    };
  }
  const name = "muninn-sse:" + url;
  const me = deps.id();
  const names = new Set<string>(opts.events ?? []);
  for (const k of Object.keys(handlers)) if (k !== "onopen" && k !== "onerror") names.add(k);
  const history = opts.history ?? {};
  const ch = deps.channel(name);
  const abort = new AbortController();
  let role: SharedSseHandle["role"] = "follower";
  let rs = 0;
  let closed = false;
  let synced = false;
  let es: EventSource | null = null;
  let release: (() => void) | null = null;
  let buffer: Frame[] = [];
  const listening = new Set<string>();

  const fire = (key: string, ev: Event): void => {
    const fn = handlers[key];
    if (typeof fn === "function") (fn as (e: Event) => void)(ev);
  };
  const post = (m: Msg): void => {
    if (closed || role === "done") return;
    try {
      ch.postMessage(m);
    } catch {
      /* a closed channel: nobody to tell */
    }
  };
  const remember = (f: Frame): void => {
    const cap = history[f.event] ?? 0;
    if (cap > 0) {
      buffer.push(f);
      let n = buffer.filter((x) => x.event === f.event).length;
      while (n-- > cap) buffer.splice(buffer.findIndex((x) => x.event === f.event), 1);
    } else {
      buffer = buffer.filter((x) => x.event !== f.event);
      buffer.push(f);
    }
  };
  const listen = (n: string): void => {
    if (!es || listening.has(n)) return;
    listening.add(n);
    es.addEventListener(n, (ev) => {
      const msg = ev as MessageEvent;
      const f: Frame = { event: n, data: String(msg.data ?? ""), lastEventId: msg.lastEventId ?? "" };
      remember(f);
      post({ t: "frame", ...f });
      fire(n, ev);
    });
  };
  const stepDown = (): void => {
    role = "done";
    release?.();
    release = null;
    try {
      ch.close();
    } catch {
      /* already closed */
    }
  };

  const lead = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      role = "leader";
      release = resolve;
      buffer = [];
      const src = deps.eventSource(url);
      es = src;
      for (const n of names) listen(n);
      src.onopen = (ev) => {
        buffer = []; // a (re)connect's opening burst is what a joiner should get
        post({ t: "open" });
        fire("onopen", ev);
      };
      src.onerror = (ev) => {
        // Read before the handlers run: a consumer that closes would read 2.
        const state = src.readyState;
        rs = state;
        // An error leaves an EventSource at 0 (retrying) or 2 (dead). A dead
        // leader steps down below and the next tab opens its own stream, so for
        // the others it is reconnecting (0) either way: each gets its own
        // verdict, as it would without sharing.
        post({ t: "error", rs: 0 });
        fire("onerror", ev);
        if (state === 2 && !closed) stepDown();
      };
    });

  ch.onmessage = (ev) => {
    const m = ev.data as Msg | null;
    if (closed || !m || typeof m !== "object") return;
    if (role === "leader") {
      if (m.t !== "hello") return;
      for (const n of m.events ?? []) {
        names.add(n);
        listen(n);
      }
      post({ t: "welcome", to: m.from, rs: es ? es.readyState : 0, frames: buffer.slice() });
      return;
    }
    if (role !== "follower") return;
    if (m.t === "welcome") {
      if (m.to !== me || synced) return;
      synced = true;
      rs = m.rs;
      if (m.rs === 1) fire("onopen", lifecycleEvent("open"));
      for (const f of m.frames) fire(f.event, frameEvent(f));
    } else if (m.t === "open") {
      // A new leader's stream: its opening burst follows on the channel.
      synced = true;
      rs = 1;
      fire("onopen", lifecycleEvent("open"));
    } else if (!synced) {
      // Frames before our welcome are in its replay already.
    } else if (m.t === "error") {
      rs = m.rs;
      fire("onerror", lifecycleEvent("error"));
    } else if (m.t === "frame") fire(m.event, frameEvent(m));
  };

  post({ t: "hello", from: me, events: [...names] });
  deps.locks.request(name, { signal: abort.signal }, lead).catch(() => {
    /* withdrawn by close() */
  });

  return {
    get source() {
      return role === "leader" || role === "done" ? es : null;
    },
    get readyState() {
      if (closed) return 2;
      return es && (role === "leader" || role === "done") ? es.readyState : rs;
    },
    get role() {
      return role;
    },
    close() {
      if (closed) return;
      closed = true;
      abort.abort();
      es?.close();
      rs = 2;
      try {
        ch.close();
      } catch {
        /* already closed */
      }
      release?.();
      release = null;
    },
  };
}
