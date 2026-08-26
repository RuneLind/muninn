import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { authedFetchScript, EXPIRED_BANNER_ID, RELOAD_STAMP_KEY, RELOAD_WINDOW_MS } from "./authed-fetch.ts";
import { LOGIN_URL_HINT } from "../../../auth/zones.ts";
import { renderChatPage } from "../page.ts";

/**
 * Two kinds of assertion, and both are needed.
 *
 * 1. **The INVENTORY** — no bare `fetch(` survives under `src/chat/views/`.
 *    That is the only thing standing between "every call site was converted"
 *    and "every call site I remembered was converted": one missed site is a
 *    silent retry loop against a 401 with nothing on screen, which is precisely
 *    the state this feature exists to end. It reads the SOURCE (a call site can
 *    be inside a template string that no type checker looks at) and the
 *    COMPOSED page (which is what actually runs).
 *
 * 2. **The BEHAVIOUR** — the emitted script, evaluated against a stubbed
 *    browser. The three channels' predicates and the shared breaker have no
 *    other test: they are a template string, invisible to `tsc`, and their
 *    failure mode is "the page silently does the wrong thing at expiry". Same
 *    idiom as `connector-selector.test.ts` and `jira-entry.test.ts`, which
 *    drive their real injected scripts the same way.
 */

const VIEWS_DIR = path.resolve(new URL(".", import.meta.url).pathname, "..");
/** The one legal bare `fetch(`: `authedFetch`'s own definition wraps it. */
const DEFINITION_FILE = "authed-fetch.ts";
/**
 * Matches a bare call, not `res.fetch(` (a method) and not `authedFetch(` —
 * but INCLUDING the three GLOBAL spellings of the same call. `window.fetch(`,
 * `globalThis.fetch(` and `self.fetch(` issue the identical unwrapped request
 * and produce the identical silent 401, and the first cut of this pin
 * (`(?<![\w.])fetch\(`) let all three through.
 */
const BARE_FETCH = /(?<![\w.])(?:(?:window|globalThis|self)\.)?fetch\(/;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("acceptance 20 — no bare fetch survives under src/chat/views/", () => {
  test("every source file routes through authedFetch", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(VIEWS_DIR)) {
      if (path.basename(file) === DEFINITION_FILE) continue;
      const text = await readFile(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        // Prose in a doc comment is not a call site.
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
        if (BARE_FETCH.test(line)) offenders.push(`${path.relative(VIEWS_DIR, file)}:${i + 1}`);
      }
    }
    expect(offenders, "these call sites bypass authedFetch and will retry a 401 in silence").toEqual([]);
  });

  /**
   * The composed page's bare-`fetch` inventory, with a DISPOSITION per row —
   * the `claimed-id-inventory.txt` idiom, because a bare count would either be
   * a lie or a permanently-failing test.
   *
   * The source scan above cannot see a bundled browser module (`Bun.build`
   * output interpolated into the page) or a script constant assembled at render
   * time. The rendered page can — and it shows that three call sites reach this
   * page from SHARED `src/dashboard/views/` modules, i.e. outside the directory
   * acceptance 20 scopes. They are listed rather than converted: each is used by
   * five other pages that have no `window.authedFetch`, so routing them belongs
   * to a change that can review those pages too. A NEW row here — which is what
   * a missed `src/chat/views/` call site would be — fails this test.
   */
  const SHARED_DASHBOARD_FETCHES = [
    // client-runtime.ts `getJson` — the shared fetch+JSON helper.
    "const res = await fetch(url, opts);",
    // The reload-on-new-build poller. A 401 there is harmless: it polls again.
    'const r = await fetch("/api/dashboard-build-hash", { cache: "no-store" });',
    // doc-panel.ts — opens a knowledge document in the slide-over panel.
    "fetch('/api/search/document/'",
  ];

  test("the COMPOSED page carries the definition plus a KNOWN shared-module set", async () => {
    const html = await renderChatPage();
    const bare = html
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => BARE_FETCH.test(l) && !l.startsWith("*") && !l.startsWith("//"));

    const unaccounted = bare.filter(
      (l) => !l.startsWith("var p = fetch(input, init)") && !SHARED_DASHBOARD_FETCHES.some((k) => l.includes(k)),
    );
    expect(unaccounted, "a bare fetch reached the chat page with no disposition").toEqual([]);
    // And every dispositioned row still exists — a stale inventory is the other
    // way this assertion rots into a tautology.
    for (const known of SHARED_DASHBOARD_FETCHES) {
      expect(bare.some((l) => l.includes(known)), `no longer present: ${known}`).toBe(true);
    }
    expect(bare.some((l) => l.startsWith("var p = fetch(input, init)"))).toBe(true);
  });

  test("the definition is interpolated ahead of every other script", async () => {
    // A call site evaluated before window.authedFetch exists is a
    // ReferenceError on the path whose job is to degrade gracefully.
    const html = await renderChatPage();
    expect(html.indexOf("window.authedFetch = function")).toBeGreaterThan(-1);
    expect(html.indexOf("window.authedFetch = function")).toBeLessThan(html.indexOf("authedFetch("));
  });

  test("the pin catches the GLOBAL spellings of the same bare call", () => {
    // `window.fetch(` is the identical unwrapped request and the identical
    // silent 401 — and the first cut of this regex (`(?<![\w.])fetch\(`) let it
    // through, so a call site written that way would have passed acceptance 20
    // with nothing on screen at expiry. `.fetch(` on a real object still must
    // NOT match, or the pin fires on every `res.fetch`-shaped method call.
    for (const spelling of ["fetch(", "window.fetch(", "globalThis.fetch(", "self.fetch("]) {
      expect(BARE_FETCH.test(`await ${spelling}'/x')`), spelling).toBe(true);
    }
    expect(BARE_FETCH.test("authedFetch('/x')")).toBe(false);
    expect(BARE_FETCH.test("client.fetch('/x')")).toBe(false);
  });

  test("the sidecar login url is the ONE exported constant, not a hand-copied literal", () => {
    // Producer: `unauthenticatedBody` (src/auth/middleware.ts). Consumer: the
    // HTTP predicate below. Four copies of one string is four places a sidecar
    // upgrade can silently stop the page reloading.
    expect(authedFetchScript()).toContain(JSON.stringify(LOGIN_URL_HINT));
  });

  test("new WebSocket is covered by the 4401 predicate, and EventSource by its own", async () => {
    const html = await renderChatPage();
    expect(html).toContain("e.code === 4401");
    expect(html).toContain("__muninnAuthRefusal('ws')");
    expect(html).toContain("__muninnAuthRefusal('sse')");
  });

  test("both latch RELEASES are wired — the page has an onopen and a reconnect clear", async () => {
    // A latch with no release is a permanent outage. These two call sites are
    // the whole recovery path and both are template-string code no type checker
    // looks at: deleting either restores the "one transient failure kills the
    // stream for the life of the tab" regression, silently.
    const html = await renderChatPage();
    expect(html).toContain("__muninnAuthChannelRecovered('sse')");
    expect(html).toContain("__muninnAuthReleaseLatch('sse')");
    // And the socket's open is the ws-side half of the same rule.
    expect(html).toContain("__muninnAuthChannelRecovered('ws')");
  });
});

// ── The behaviour half ────────────────────────────────────────────────────

interface Stub {
  reloads: number;
  store: Record<string, string>;
  now: number;
  banner: () => boolean;
  /** How many nodes the banner ever appended — the idempotency assertion. */
  banners: () => number;
  /** True when the banner was appended OUTSIDE `#chatMessages` (acceptance F5:
   *  `clearChat()` wipes that container's innerHTML on every thread switch). */
  bannerIsPageLevel: () => boolean;
  refusal: (channel: string, hint?: string) => string;
  latched: (channel: string) => boolean;
  authedFetch: (url: string) => Promise<{ status: number }>;
  setProvider: (p: string | null) => void;
  clearStamp: () => void;
  /** The channel OPENED — releases its latch and, when nothing is left latched,
   *  takes the banner down. */
  recovered: (channel: string) => void;
  /** An explicit reconnect — releases the latch and leaves the banner alone. */
  releaseLatch: (channel: string) => void;
  /** How many banner nodes were ever APPENDED, which a removal does not reduce.
   *  The idempotency assertion needs this and the presence one needs `banner()`. */
  bannerAppends: () => number;
  fetches: number;
}

/** Evaluate the real emitted script against a stubbed browser. */
function evalScript(
  opts: { status?: number; body?: unknown; raw?: string; storageThrows?: boolean } = {},
): Stub {
  const state = { reloads: 0, now: 1_700_000_000_000, fetches: 0, bannerAppends: 0 };
  const store: Record<string, string> = {};
  /** Everything appended to <body>, in order. */
  const bodyChildren: Node[] = [];
  /** Everything appended to #chatMessages — must stay EMPTY for the banner. */
  const chatChildren: Node[] = [];
  const all = () => [...bodyChildren, ...chatChildren];

  /** Enough of a Node for `appendChild` + `parentNode.removeChild`, which is
   *  what the recovery path uses to take the banner back down. */
  interface Node { id?: string; parentNode?: { removeChild: (child: Node) => void } }
  const appender = (into: Node[]) => (el: Node) => {
    into.push(el);
    if (el.id === EXPIRED_BANNER_ID) state.bannerAppends++;
    el.parentNode = {
      removeChild: (child: Node) => {
        const i = into.indexOf(child);
        if (i >= 0) into.splice(i, 1);
      },
    };
  };

  const win: Record<string, unknown> = {
    location: { reload: () => { state.reloads++; } },
  };
  /** A storage that throws on EVERY operation — a browser configured to block
   *  site data, or a sandboxed frame. Measured: the breaker was inert there. */
  const throwing = () => { throw new Error("storage blocked"); };
  const sandbox = {
    window: win,
    Date: { now: () => state.now },
    sessionStorage: opts.storageThrows
      ? { getItem: throwing, setItem: throwing, removeItem: throwing }
      : {
        getItem: (k: string) => (k in store ? store[k]! : null),
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
      },
    document: {
      body: { appendChild: appender(bodyChildren) },
      getElementById: (id: string) =>
        id === "chatMessages"
          ? { appendChild: appender(chatChildren) }
          : all().find((c) => c.id === id) ?? null,
      createElement: () => ({ id: "", className: "", textContent: "", style: { cssText: "" }, setAttribute: () => {} }),
    },
    fetch: async () => {
      state.fetches++;
      if (opts.raw !== undefined) return new Response(opts.raw, { status: opts.status ?? 401 });
      const body = opts.body ?? { error: "unauthenticated", mode: "entra", loginUrl: LOGIN_URL_HINT };
      return new Response(JSON.stringify(body), { status: opts.status ?? 401 });
    },
  };

  const fn = new Function(
    "ctx",
    "var window = ctx.window; var document = ctx.document; var sessionStorage = ctx.sessionStorage;" +
    "var fetch = ctx.fetch; var Date = ctx.Date;" +
    authedFetchScript(),
  );
  fn(sandbox);

  return {
    get reloads() { return state.reloads; },
    get fetches() { return state.fetches; },
    store,
    get now() { return state.now; },
    set now(v: number) { state.now = v; },
    banner: () => all().some((c) => c.id === EXPIRED_BANNER_ID),
    banners: () => all().filter((c) => c.id === EXPIRED_BANNER_ID).length,
    bannerAppends: () => state.bannerAppends,
    recovered: (channel) => (win.__muninnAuthChannelRecovered as (c: string) => void)(channel),
    releaseLatch: (channel) => (win.__muninnAuthReleaseLatch as (c: string) => void)(channel),
    bannerIsPageLevel: () =>
      bodyChildren.some((c) => c.id === EXPIRED_BANNER_ID) &&
      !chatChildren.some((c) => c.id === EXPIRED_BANNER_ID),
    refusal: (channel, hint) => (win.__muninnAuthRefusal as (c: string, h?: string) => string)(channel, hint),
    latched: (channel) => (win.__muninnAuthLatched as (c: string) => boolean)(channel),
    authedFetch: (url) => (win.authedFetch as (u: string) => Promise<{ status: number }>)(url),
    setProvider: (p) => (win.__muninnSetAuthProvider as (p: string | null) => void)(p),
    clearStamp: () => (win.__muninnClearAuthReloadStamp as () => void)(),
  };
}

/** The 401 body is read off a clone in a detached promise chain. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("acceptance 19 — expiry, per channel", () => {
  test("a 4401 close reloads when the cached provider is entra", async () => {
    const s = evalScript();
    s.setProvider("entra");
    expect(s.refusal("ws")).toBe("reload");
    expect(s.reloads).toBe(1);
    expect(s.banner()).toBe(false);
  });

  test("…and shows the banner in an authenticating mode that has no login page", () => {
    const s = evalScript();
    s.setProvider("local");
    expect(s.refusal("ws")).toBe("banner");
    expect(s.reloads).toBe(0);
    expect(s.banner()).toBe(true);
  });

  test("with auth OFF a ws/sse failure is IGNORED — there is no session to expire", () => {
    // The regression this closes: `authProvider === null` is BOTH "auth is off"
    // and "before /chat/me answered", and the first cut banner'd for both. On
    // an auth-off instance — today's default — any permanent SSE failure (a
    // 500, a 403, a dev-server restart) then reads "Your session expired" to a
    // reader who has no session at all. Silent reconnect is what those
    // instances did before this module existed, and it stays their behaviour.
    for (const provider of [null, undefined]) {
      const s = evalScript();
      s.setProvider(provider as string | null);
      expect(s.refusal("sse")).toBe("ignore");
      expect(s.refusal("ws")).toBe("ignore");
      expect(s.banner()).toBe(false);
      expect(s.reloads).toBe(0);
    }
  });

  test("an entra 401 whose body is UNREADABLE banners rather than saying nothing", () => {
    // A proxy's own HTML 401, or a body whose loginUrl is something else: the
    // reload predicate cannot fire (no evidence a reload lands on a login page)
    // but the request WAS refused, and silence there is exactly the state this
    // module exists to end. Provider `entra` is what makes it a session
    // expiry rather than an ordinary 401 a call site owns.
    const s = evalScript({ status: 401, raw: "<html>401</html>" });
    s.setProvider("entra");
    expect(s.refusal("http", undefined)).toBe("banner");
    expect(s.reloads).toBe(0);
    expect(s.banner()).toBe(true);
  });

  test("…and the same body on a non-entra instance is still IGNORED", () => {
    const s = evalScript();
    s.setProvider("local");
    expect(s.refusal("http", undefined)).toBe("ignore");
    expect(s.banner()).toBe(false);
  });

  test("an HTTP 401 reloads when the body's loginUrl is the sidecar's", async () => {
    const s = evalScript();
    // Deliberately NOT the provider: an HTTP refusal HAS a body, and the body
    // is the more direct evidence that a login page exists.
    await s.authedFetch("/chat/threads");
    await settle();
    expect(s.reloads).toBe(1);
  });

  test("an HTTP 401 carrying the local loginUrl does NOT reload, and adds no banner", async () => {
    // In local mode there is no login page; a reload replaces the chat with raw
    // 401 JSON. The call site's own handling is unchanged.
    const s = evalScript({ body: { error: "unauthenticated", mode: "local", loginUrl: "/?muninn_token=X" } });
    expect(s.refusal("http", "/?muninn_token=X")).toBe("ignore");
    await s.authedFetch("/chat/threads");
    await settle();
    expect(s.reloads).toBe(0);
    expect(s.banner()).toBe(false);
  });

  test("a second refusal inside the window shows the banner instead of reloading", async () => {
    // The row that proves the breaker: without it a persistent 401 is
    // reload → init → 401 → reload from every open tab.
    const s = evalScript();
    s.setProvider("entra");
    expect(s.refusal("ws")).toBe("reload");
    expect(s.refusal("ws")).toBe("banner");
    expect(s.refusal("sse")).toBe("banner");
    await s.authedFetch("/chat/threads");
    await settle();
    expect(s.reloads).toBe(1);
    expect(s.banner()).toBe(true);
  });

  test("the breaker is SHARED across the three channels, not one budget each", async () => {
    const s = evalScript();
    s.setProvider("entra");
    await s.authedFetch("/chat/threads");
    await settle();
    expect(s.reloads).toBe(1);
    expect(s.refusal("ws")).toBe("banner");
    expect(s.refusal("sse")).toBe("banner");
    expect(s.reloads).toBe(1);
  });

  test("past the window, a later expiry reloads again — the hourly case", () => {
    // A boolean breaker would give one transparent re-login and a static banner
    // for every hour after, which is the opposite of the intent.
    const s = evalScript();
    s.setProvider("entra");
    expect(s.refusal("ws")).toBe("reload");
    s.now += RELOAD_WINDOW_MS + 1;
    expect(s.refusal("ws")).toBe("reload");
    expect(s.reloads).toBe(2);
  });
});

describe("the breaker survives a storage that throws", () => {
  test("a blocked sessionStorage still bounds the page to one reload per window", async () => {
    // Measured before the fix: `armReload()` returned true on a `setItem`
    // throw, so the breaker was INERT and a permanent refusal reloaded as fast
    // as the page could load — 11.5 reloads per second. A context that blocks
    // site data cannot carry the bound ACROSS reloads (nothing there can), but
    // within one page it must still be one.
    const s = evalScript({ storageThrows: true });
    s.setProvider("entra");
    expect(s.refusal("ws")).toBe("reload");
    expect(s.refusal("ws")).toBe("banner");
    expect(s.refusal("sse")).toBe("banner");
    await s.authedFetch("/chat/threads");
    await settle();
    expect(s.reloads).toBe(1);
  });

  test("…and the window still expires there — the hourly case is not lost", () => {
    const s = evalScript({ storageThrows: true });
    s.setProvider("entra");
    expect(s.refusal("ws")).toBe("reload");
    s.now += RELOAD_WINDOW_MS + 1;
    expect(s.refusal("ws")).toBe("reload");
    expect(s.reloads).toBe(2);
  });
});

describe("the SSE/WS channel latch — a terminal refusal is TERMINAL", () => {
  test("a channel that has spent a verdict is latched, and stays latched", () => {
    // Without this the SSE loop re-enters the rule every 3 s and re-arms the
    // breaker every 60 s: measured, a permanent 403 on /chat/events reloaded
    // the page once a minute forever and banner'd in between. The page reads
    // this flag to stop reconnecting that stream.
    const s = evalScript();
    s.setProvider("entra");
    expect(s.latched("sse")).toBe(false);
    expect(s.refusal("sse")).toBe("reload");
    expect(s.latched("sse")).toBe(true);
    expect(s.refusal("sse")).toBe("banner");
    expect(s.latched("sse")).toBe(true);
    // Per channel, not global: the socket's own retry is a separate decision.
    expect(s.latched("ws")).toBe(false);
  });

  test("a banner verdict latches too — including the auth-off IGNORE case, which does NOT", () => {
    const s = evalScript();
    s.setProvider("local");
    expect(s.refusal("sse")).toBe("banner");
    expect(s.latched("sse")).toBe(true);

    const off = evalScript();
    off.setProvider(null);
    expect(off.refusal("sse")).toBe("ignore");
    expect(off.latched("sse")).toBe(false);
  });

  test("a channel that OPENS releases its own latch and takes the banner down", () => {
    // ⚠️ The regression this closes. The latch's ONLY release was
    // `__muninnClearAuthReloadStamp`, whose only caller is init — so a latch set
    // after init lived for the whole tab. On a `local` instance one transient
    // /chat/events failure therefore banner'd the channel and killed the stream
    // PERMANENTLY, where the pre-latch page recovered in 3 s. An open stream is
    // the evidence the refusal is over.
    const s = evalScript();
    s.setProvider("local");
    expect(s.refusal("sse")).toBe("banner");
    expect(s.latched("sse")).toBe(true);
    expect(s.banner()).toBe(true);

    s.recovered("sse");
    expect(s.latched("sse")).toBe(false);
    expect(s.banner()).toBe(false);
  });

  test("…but NOT while another channel is still latched", () => {
    // The banner is one page-level bar shared by three channels. An SSE recovery
    // clearing it while a 4401'd socket is still refused would hide a live
    // expiry behind a stream that happens to work.
    const s = evalScript();
    s.setProvider("local");
    s.refusal("ws");
    s.refusal("sse");
    s.recovered("sse");
    expect(s.latched("sse")).toBe(false);
    expect(s.latched("ws")).toBe(true);
    expect(s.banner()).toBe(true);

    // Once the socket comes back too, it goes.
    s.recovered("ws");
    expect(s.banner()).toBe(false);
  });

  test("a recovery on an UNLATCHED channel is a no-op, not a banner eraser", () => {
    // The ordinary case: every successful stream open calls this, on a page
    // where nothing has been refused. It must not become a second, decision-free
    // door onto removing a banner some other channel put up.
    const s = evalScript();
    s.setProvider("local");
    s.refusal("ws");
    expect(s.banner()).toBe(true);
    s.recovered("sse");        // sse was never latched
    expect(s.banner()).toBe(true);
  });

  test("an explicit reconnect releases the latch and LEAVES the banner", () => {
    // `reconnectChatSse()` is a request, not an outcome. Releasing the latch is
    // what makes the new stream's first transient error take the 3 s retry
    // instead of the terminal branch; removing the banner would claim a recovery
    // nothing has demonstrated yet. `onopen` is what removes it.
    const s = evalScript();
    s.setProvider("local");
    s.refusal("sse");
    s.releaseLatch("sse");
    expect(s.latched("sse")).toBe(false);
    expect(s.banner()).toBe(true);
  });

  test("after a recovery the channel can banner AGAIN — the release is not a mute", () => {
    const s = evalScript();
    s.setProvider("local");
    s.refusal("sse");
    s.recovered("sse");
    expect(s.banner()).toBe(false);
    expect(s.refusal("sse")).toBe("banner");
    expect(s.banner()).toBe(true);
    // Two separate appends, because the first node really was removed.
    expect(s.bannerAppends()).toBe(2);
  });

  test("a successful /chat/me RELEASES the latches", () => {
    // The release condition: a working identity answer is the evidence the
    // stream is worth re-opening. The reload STAMP is deliberately not dropped
    // with it — see the window-guard case below.
    const s = evalScript();
    s.setProvider("entra");
    s.refusal("sse");
    expect(s.latched("sse")).toBe(true);
    s.clearStamp();
    expect(s.latched("sse")).toBe(false);
  });
});

describe("the banner is page-level and idempotent", () => {
  test("it is appended OUTSIDE #chatMessages", () => {
    // `clearChat()` and `loadThreadMessages()` both assign `innerHTML` on
    // #chatMessages, so a banner rendered inside it disappears on the next
    // thread or bot switch — while the session it is reporting on is still
    // expired.
    const s = evalScript();
    s.setProvider("local");
    s.refusal("ws");
    expect(s.bannerIsPageLevel()).toBe(true);
  });

  test("three refusals render ONE banner", () => {
    const s = evalScript();
    s.setProvider("local");
    s.refusal("ws");
    s.refusal("sse");
    s.refusal("ws");
    expect(s.banners()).toBe(1);
  });
});

describe("the stamp and its window-guarded clear", () => {
  test("a reload stamps the window", () => {
    const s = evalScript();
    s.setProvider("entra");
    s.refusal("ws");
    expect(Number(s.store[RELOAD_STAMP_KEY])).toBe(s.now);
  });

  test("a successful /chat/me does NOT clear a stamp inside the window", () => {
    // ⚠️ This is the ONE property that keeps a permanent partial refusal from
    // being an unbounded reload loop, and it is not a no-op dressed up as a
    // rule. The concrete case is the measured one: /chat/events answers a
    // permanent 403 while /chat/me answers 200. Every reload then re-runs
    // init → /chat/me succeeds → and if the clear were unconditional the
    // breaker would be re-armed BEFORE the SSE failed again, i.e. one reload
    // per page load, forever, against a service that is already refusing.
    // The clear releases the channel LATCHES (tested above) and leaves the
    // reload budget alone.
    const s = evalScript();
    s.setProvider("entra");
    s.refusal("ws");
    s.clearStamp();
    expect(s.store[RELOAD_STAMP_KEY]).toBeDefined();
    expect(s.refusal("ws")).toBe("banner");
  });

  test("the dead banner global is gone", () => {
    // `window.__muninnShowExpiredBanner` had zero callers: every path goes
    // through `__muninnAuthRefusal`, which is where the mode decision lives. A
    // second, decision-free door onto the banner is how one gets shown in a
    // mode that has no session to expire.
    expect(authedFetchScript()).not.toContain("__muninnShowExpiredBanner");
  });

  test("…and does clear one that is already outside it", () => {
    const s = evalScript();
    s.setProvider("entra");
    s.refusal("ws");
    s.now += RELOAD_WINDOW_MS + 1;
    s.clearStamp();
    expect(s.store[RELOAD_STAMP_KEY]).toBeUndefined();
  });
});

describe("authedFetch is transparent", () => {
  test("it passes the response through untouched and reads the body off a CLONE", async () => {
    const s = evalScript({ status: 200, body: { ok: true } });
    const res = await s.authedFetch("/chat/bots");
    expect(res.status).toBe(200);
    // The caller's own body is still readable — the probe used a clone.
    expect(await (res as unknown as Response).json()).toEqual({ ok: true });
    expect(s.fetches).toBe(1);
  });

  test("a non-401 is not inspected at all", async () => {
    const s = evalScript({ status: 403 });
    await s.authedFetch("/api/traces");
    await settle();
    expect(s.reloads).toBe(0);
    expect(s.banner()).toBe(false);
  });

  test("a 401 with no JSON body is not evidence of a login page", async () => {
    // A proxy's own HTML 401 carries no `loginUrl`, so it must not reload —
    // even on an entra instance, where the provider says a login page exists.
    const s = evalScript({ status: 401, raw: "<html>401</html>" });
    s.setProvider("entra");
    await s.authedFetch("/chat/threads");
    await settle();
    expect(s.reloads).toBe(0);
  });
});
