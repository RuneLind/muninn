import { describe, test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { authedFetchScript, EXPIRED_BANNER_ID, RELOAD_STAMP_KEY, RELOAD_WINDOW_MS } from "./authed-fetch.ts";
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
/** Matches a bare call, not `.fetch(` (a method) and not `authedFetch(`. */
const BARE_FETCH = /(?<![\w.])fetch\(/;

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

  test("new WebSocket is covered by the 4401 predicate, and EventSource by its own", async () => {
    const html = await renderChatPage();
    expect(html).toContain("e.code === 4401");
    expect(html).toContain("__muninnAuthRefusal('ws')");
    expect(html).toContain("__muninnAuthRefusal('sse')");
  });
});

// ── The behaviour half ────────────────────────────────────────────────────

interface Stub {
  reloads: number;
  store: Record<string, string>;
  now: number;
  banner: () => boolean;
  refusal: (channel: string, hint?: string) => string;
  authedFetch: (url: string) => Promise<{ status: number }>;
  setProvider: (p: string | null) => void;
  clearStamp: () => void;
  fetches: number;
}

/** Evaluate the real emitted script against a stubbed browser. */
function evalScript(opts: { status?: number; body?: unknown; raw?: string } = {}): Stub {
  const state = { reloads: 0, now: 1_700_000_000_000, fetches: 0 };
  const store: Record<string, string> = {};
  const children: { id?: string }[] = [];

  const win: Record<string, unknown> = {
    location: { reload: () => { state.reloads++; } },
  };
  const sandbox = {
    window: win,
    Date: { now: () => state.now },
    sessionStorage: {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    document: {
      getElementById: (id: string) =>
        id === "chatMessages"
          ? { appendChild: (el: { id?: string }) => children.push(el) }
          : children.find((c) => c.id === id) ?? null,
      createElement: () => ({ id: "", className: "", textContent: "" }),
    },
    fetch: async () => {
      state.fetches++;
      if (opts.raw !== undefined) return new Response(opts.raw, { status: opts.status ?? 401 });
      const body = opts.body ?? { error: "unauthenticated", mode: "entra", loginUrl: "/oauth2/login" };
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
    banner: () => children.some((c) => c.id === EXPIRED_BANNER_ID),
    refusal: (channel, hint) => (win.__muninnAuthRefusal as (c: string, h?: string) => string)(channel, hint),
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

  test("…and shows the banner otherwise", () => {
    for (const provider of ["local", null]) {
      const s = evalScript();
      s.setProvider(provider);
      expect(s.refusal("ws")).toBe("banner");
      expect(s.reloads).toBe(0);
      expect(s.banner()).toBe(true);
    }
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

describe("the stamp and its window-guarded clear", () => {
  test("a reload stamps the window", () => {
    const s = evalScript();
    s.setProvider("entra");
    s.refusal("ws");
    expect(Number(s.store[RELOAD_STAMP_KEY])).toBe(s.now);
  });

  test("a successful /chat/me does NOT clear a stamp inside the window", () => {
    // The loop this closes: reload → /chat/me succeeds against a half-recovered
    // sidecar → stamp cleared → next call 401s → reload again, forever.
    const s = evalScript();
    s.setProvider("entra");
    s.refusal("ws");
    s.clearStamp();
    expect(s.store[RELOAD_STAMP_KEY]).toBeDefined();
    expect(s.refusal("ws")).toBe("banner");
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
