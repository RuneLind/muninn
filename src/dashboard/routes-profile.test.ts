import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { createDashboardRoutes } from "./routes.ts";
import { NAIS_DROPPED_ROUTE_GROUPS, servesWikiReadSliceOnly, wikiToolsRegistered } from "./route-groups.ts";
import { routeRows, wikiRouteTable } from "../test/wiki-route-table.ts";
import { answerBodyLimit } from "./routes/wiki-answers.ts";
import { HEADER_HIDDEN_CLASS, HEADER_HIDDEN_KEY, HEADER_HINT_TEXT, renderNav } from "./views/shared-styles.ts";

/**
 * The `nais` serving profile's surface — the routes it drops, and the nav that
 * must stop linking to them.
 *
 * The distinction under test on the DROPPED half is ABSENT versus DENIED, so
 * those cases issue a real request through a real `createDashboardRoutes`: a
 * dropped group has no handler at all, so the answer is Hono's own 404 — not a
 * 403 from the zone middleware, which is a policy someone can later relax, and
 * not a 500 from a route reaching for a working tree a pod does not have.
 *
 * The PRESENT half reads `app.routes` instead of issuing the same request
 * against a live registration. That is not squeamishness: `/api/events` is an
 * SSE stream that never closes, `/api/claude-usage/overview` fetches an
 * external service, and `/api/wiki/pages` reads whatever `WIKI_EXTRA` this
 * machine carries — a presence check that runs handlers is a presence check
 * that depends on the machine.
 *
 * The profile is passed on the `Config`, never through `MUNINN_PROFILE`: the
 * variable is in `AMBIENT_INSTANCE_ENV` (the preload deletes it), and an
 * env-driven test here would be the one thing that flips behaviour for every
 * OTHER file in the same `bun test` process.
 */
const CONFIG = { dashboardPort: 3010, profile: "default" } as Config;

/** One representative path per dropped group — the address a client would use. */
const DROPPED_PATHS: Record<string, string> = {
  "wiki": "/api/wiki/similar",
  "wiki-gardener": "/api/wiki/proposals",
  "plans": "/api/plans/board",
  "sync": "/api/sync/status",
  "claude-usage": "/api/claude-usage/overview",
  "benchmark": "/api/benchmark/runs",
  "logs": "/api/logs",
  "summaries": "/api/summaries/documents",
  "anthropic": "/api/anthropic/candidates",
  "article": "/api/articles/summarize",
  "youtube": "/api/youtube/summarize",
  "x-article": "/api/x-articles/summarize",
  "tiktok": "/api/tiktok/summarize",
  "vimeo": "/api/vimeo/summarize",
};

/** The page routes that go with them — a dropped group must take its HTML
 *  surface with it, or a `/plans` bookmark renders a shell whose every fetch
 *  404s and reads as a broken page rather than as an absent feature. */
const DROPPED_PAGES = ["/wiki/issues", "/wiki/gardener", "/plans", "/logs", "/benchmark", "/summaries"];

function build(profile: "default" | "nais"): Hono {
  const app = new Hono();
  app.route("/", createDashboardRoutes({ ...CONFIG, profile } as Config));
  return app;
}

/** A HEAD-free status probe: GET for reads, POST for the capture verticals
 *  (which register no GET). A 404 means "no handler"; anything else — 400 on a
 *  missing body, 500 from an unreachable huginn — means the route EXISTS. */
async function status(app: Hono, path: string): Promise<number> {
  const method = path.endsWith("/summarize") ? "POST" : "GET";
  const res = await app.request(path, {
    method,
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
  });
  return res.status;
}

/** Registered path patterns — presence without running a handler. */
function registeredPaths(app: Hono): ReadonlySet<string> {
  return new Set(app.routes.map((r) => r.path));
}

describe("MUNINN_PROFILE=nais route surface", () => {
  test("every dropped group has a representative path pinned here", () => {
    // Guards the shape of this file rather than the code: a group added to the
    // drop list with no path below would be "asserted" by nothing at all.
    expect(Object.keys(DROPPED_PATHS).sort()).toEqual([...NAIS_DROPPED_ROUTE_GROUPS].sort());
  });

  test("the dropped groups answer 404 — no handler, not a denial", async () => {
    const app = build("nais");
    const answers: Record<string, number> = {};
    for (const [group, path] of Object.entries(DROPPED_PATHS)) {
      answers[group] = await status(app, path);
    }
    expect(answers).toEqual(Object.fromEntries(Object.keys(DROPPED_PATHS).map((g) => [g, 404])));
  });

  test("their page routes are gone too", async () => {
    const app = build("nais");
    for (const path of DROPPED_PAGES) {
      expect(`${path} → ${(await app.request(path)).status}`).toBe(`${path} → 404`);
    }
  });

  test("the same paths are REGISTERED on the default profile", () => {
    // The other half of the pin: a 404 above has to mean "dropped", not "that
    // path never existed" — a typo'd path would make the whole suite vacuous.
    const paths = registeredPaths(build("default"));
    for (const [group, path] of Object.entries({ ...DROPPED_PATHS, ...Object.fromEntries(DROPPED_PAGES.map((p) => [p, p])) })) {
      expect(`${group} ${path} → ${paths.has(path)}`).toBe(`${group} ${path} → true`);
    }
  });

  test("the inline instance routes and both health paths survive on nais", async () => {
    const app = build("nais");
    // ANSWERED, not merely registered: a registration check cannot tell
    // "renders" from "throws inside the handler", which is exactly the failure
    // a profile branch introduces. `/` renders the whole dashboard page, so
    // this asserts that render path executes — NOT the nais nav: this app IS
    // built with a `Config` carrying `profile: "nais"`, but `routes.ts` calls
    // `renderDashboardPage()` with no arguments, so the profile never reaches
    // `renderNav`, which falls back to the (blanked) env and runs its DEFAULT
    // branch here. The nais nav
    // (`droppedRouteGroups` omitting links) is covered by the explicit
    // "renderNav under the nais profile" describe below. These are the cheap,
    // hermetic paths: no DB, no network, no filesystem beyond the inlined
    // bundles.
    const answers: Record<string, number> = {};
    for (const path of ["/api/live", "/", "/favicon.svg", "/favicon.ico", "/api/dashboard-build-hash"]) {
      answers[path] = (await app.request(path)).status;
    }
    expect(answers).toEqual({
      "/api/live": 200, "/": 200, "/favicon.svg": 200, "/favicon.ico": 200, "/api/dashboard-build-hash": 200,
    });

    // The remaining two are asserted by registration only: `/api/ready` and
    // `/api/attention` touch the database, so their STATUS depends on the
    // environment; that they are ROUTED does not.
    const paths = registeredPaths(app);
    for (const path of ["/api/ready", "/api/attention"]) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });

  test("the surfaces the profile KEEPS are still registered", () => {
    const paths = registeredPaths(build("nais"));
    for (const path of ["/api/stats", "/traces", "/api/events", "/models", "/agents", "/jira", "/graph", "/research"]) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });

  test("a Config with no profile falls through to the env, i.e. today's full surface", () => {
    // The compatibility pin. The unit tests that hand-build a `{} as Config`
    // (health, owner-guard) go down this path, and on a machine with no
    // MUNINN_PROFILE it must be the surface it was before this PR.
    const app = new Hono();
    app.route("/", createDashboardRoutes({ dashboardPort: 3010 } as Config));
    const paths = registeredPaths(app);
    for (const path of [...Object.values(DROPPED_PATHS), ...DROPPED_PAGES]) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });
});

/**
 * The nav that goes with it.
 *
 * `renderNav` is on EVERY page, `/chat` and `/wiki` included — the two pages a
 * nais pod serves its users — so a link to a dropped group there is a dead link
 * on the pod. The nav is not part of `createDashboardRoutes`, so nothing above would
 * have caught it.
 */
describe("renderNav under the nais profile", () => {
  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

  test("links to dropped groups are absent — on the chat page too", () => {
    for (const page of ["chat", "dashboard"] as const) {
      const linked = hrefs(renderNav(page, { profile: "nais" }));
      for (const dead of ["/plans", "/logs", "/benchmark", "/summaries"]) {
        expect(`${page} links ${dead}: ${linked.includes(dead)}`).toBe(`${page} links ${dead}: false`);
      }
    }
  });

  test("the kept links — including the Tools ▾ entries — are still there", () => {
    const linked = hrefs(renderNav("chat", { profile: "nais" }));
    for (const kept of ["/", "/chat", "/agents", "/traces", "/research", "/search", "/wiki", "/graph", "/jira", "/models", "/indexing"]) {
      expect(`nais links ${kept}: ${linked.includes(kept)}`).toBe(`nais links ${kept}: true`);
    }
  });

  test("the default profile links everything, dropdown included", () => {
    const linked = hrefs(renderNav("dashboard", { profile: "default" }));
    for (const kept of ["/wiki", "/plans", "/logs", "/benchmark", "/summaries", "/mcp-debug", "/serena"]) {
      expect(`default links ${kept}: ${linked.includes(kept)}`).toBe(`default links ${kept}: true`);
    }
  });

  test("no options at all is the default profile, byte for byte", () => {
    expect(renderNav("dashboard")).toBe(renderNav("dashboard", { profile: "default" }));
  });
});

/**
 * Role `user` gets no nav: on the pod that is every colleague, who reaches the
 * wiki from `/` and has no use for the operator's links (and a 403 behind most
 * of them). Admin and auth off keep the profile's nav unchanged.
 */
describe("renderNav for role `user`", () => {
  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

  test("renders no nav element and no link, on either profile and either page", () => {
    for (const profile of ["nais", "default"] as const) {
      for (const page of ["wiki", "chat"] as const) {
        const html = renderNav(page, { profile, role: "user" });
        expect(`${profile}/${page} <nav>: ${html.includes("<nav")}`).toBe(`${profile}/${page} <nav>: false`);
        expect(`${profile}/${page} hrefs: ${hrefs(html).join(",")}`).toBe(`${profile}/${page} hrefs: `);
        expect(html).not.toContain("nav-sep");
        expect(html).toContain("uninn</h1>");
      }
    }
  });

  test("the `m` hint sits on the wordmark for every role, never on the nav", () => {
    const h1 = (html: string): string => html.match(/<h1[^>]*>/)![0];
    for (const role of ["admin", null, "user"] as const) {
      const html = renderNav("wiki", { profile: "nais", role });
      expect(`${role}: ${h1(html)}`).toBe(`${role}: <h1 title="Press m to hide or show the header">`);
      if (role !== "user") expect(html.match(/<nav[^>]*>/)![0]).toBe("<nav>");
    }
  });

  /**
   * The header's starting state, run from the emitted early-apply script. On
   * the pod (`nais`, where the wiki read slice is role `user`'s surface) that
   * role starts hidden, and the first such load says how to bring the header
   * back once, then stores the hidden state so the notice does not repeat.
   * Everyone else starts shown. A stored choice beats the default either way;
   * storage that throws falls back to the default.
   */
  test("role `user` on the pod starts hidden with a one-time notice; a stored choice wins", () => {
    type Stored = string | null | "throws";
    const run = (role: "user" | "admin" | null, profile: "nais" | "default", stored: Stored) => {
      const html = renderNav("wiki", { profile, role });
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((s) => s.includes("__navToggle"))!;
      const classes = new Set<string>();
      const hints: string[] = [];
      let value: Stored = stored;
      const document = {
        documentElement: { classList: { add: (c: string) => classes.add(c), toggle: () => false } },
        addEventListener: () => {},
        querySelector: () => null,
        createElement: () => ({ className: "", textContent: "", setAttribute() {}, remove() {} }),
        body: { appendChild: (el: { textContent: string }) => hints.push(el.textContent) },
      };
      const localStorage = {
        getItem: () => { if (value === "throws") throw new Error("blocked"); return value; },
        setItem: (_k: string, v: string) => { if (value === "throws") throw new Error("blocked"); value = v; },
      };
      new Function("window", "document", "localStorage", "setTimeout", script)({}, document, localStorage, () => {});
      const hint = hints.length === 0 ? "" : hints.every((h) => h === HEADER_HINT_TEXT) ? ` +notice×${hints.length}` : " +WRONG notice";
      return `${classes.has(HEADER_HIDDEN_CLASS) ? "hidden" : "shown"}${hint} stored=${value}`;
    };
    const rows: string[] = [];
    for (const role of ["user", "admin", null] as const) {
      for (const stored of [null, "1", "0", "", "garbage", "throws"] as const) {
        rows.push(`nais ${role}/${stored} → ${run(role, "nais", stored)}`);
      }
    }
    expect(rows).toEqual([
      "nais user/null → hidden +notice×1 stored=1",
      "nais user/1 → hidden stored=1",
      "nais user/0 → shown stored=0",
      "nais user/ → shown stored=",
      "nais user/garbage → shown stored=garbage",
      "nais user/throws → hidden +notice×1 stored=throws",
      "nais admin/null → shown stored=null",
      "nais admin/1 → hidden stored=1",
      "nais admin/0 → shown stored=0",
      "nais admin/ → shown stored=",
      "nais admin/garbage → shown stored=garbage",
      "nais admin/throws → shown stored=throws",
      "nais null/null → shown stored=null",
      "nais null/1 → hidden stored=1",
      "nais null/0 → shown stored=0",
      "nais null/ → shown stored=",
      "nais null/garbage → shown stored=garbage",
      "nais null/throws → shown stored=throws",
    ]);
    // Off the pod role `user` reaches only /chat, whose bot selector is in the
    // header: it starts shown there.
    expect(run("user", "default", null)).toBe("shown stored=null");
    expect(run("user", "default", "1")).toBe("hidden stored=1");
  });

  /**
   * The toggle's script injects wiki-panes.ts's guards by SOURCE
   * (`.toString()`), so a renamed identifier or a new helper call passes tsc
   * and throws in the browser. Run the emitted script against a stub DOM.
   */
  test("the emitted `m` script runs: toggles, remembers, hints, and refuses under a menu or dialog", () => {
    const html = renderNav("wiki", { profile: "default", role: "admin" });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((s) => s.includes("__navToggle"))!;
    let listener: ((e: object) => void) | undefined;
    const classes = new Set<string>();
    const stored: Record<string, string> = {};
    const added: { textContent: string }[] = [];
    let menuOpen = false;
    let dialogs: { getClientRects(): unknown[] }[] = [];
    const document = {
      documentElement: { classList: {
        add: (c: string) => classes.add(c),
        toggle: (c: string) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
      } },
      addEventListener: (type: string, fn: (e: object) => void) => { if (type === "keydown") listener = fn; },
      querySelector: (sel: string) => (sel === "details.nav-dropdown[open]" && menuOpen ? {} : null),
      querySelectorAll: () => dialogs,
      createElement: () => ({ className: "", textContent: "", setAttribute() {}, remove() {} }),
      body: { appendChild: (el: { textContent: string }) => added.push(el) },
    };
    const localStorage = { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; } };
    new Function("window", "document", "localStorage", "setTimeout", script)({}, document, localStorage, () => {});
    const m = { key: "m", ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: { tagName: "BODY" } };

    listener!(m);
    expect(classes.has(HEADER_HIDDEN_CLASS)).toBe(true);
    expect(stored[HEADER_HIDDEN_KEY]).toBe("1");
    expect(added.map((el) => el.textContent)).toEqual([HEADER_HINT_TEXT]);

    menuOpen = true;
    listener!(m);
    expect(classes.has(HEADER_HIDDEN_CLASS)).toBe(true);
    menuOpen = false;
    dialogs = [{ getClientRects: () => [{}] }];
    listener!(m);
    expect(classes.has(HEADER_HIDDEN_CLASS)).toBe(true);

    dialogs = [{ getClientRects: () => [] }];
    listener!(m);
    expect(classes.has(HEADER_HIDDEN_CLASS)).toBe(false);
    expect(stored[HEADER_HIDDEN_KEY]).toBe("0");
    expect(added).toHaveLength(1);
  });

  test("role `admin` and auth off render the profile's nav byte for byte", () => {
    for (const profile of ["nais", "default"] as const) {
      const plain = renderNav("wiki", { profile });
      expect(renderNav("wiki", { profile, role: "admin" })).toBe(plain);
      expect(renderNav("wiki", { profile, role: null })).toBe(plain);
      expect(hrefs(plain)).toContain("/wiki");
    }
  });
});

/**
 * The wiki READ slice: the one wiki group `nais` keeps. Its routes answer and
 * every other wiki route is absent — the split the user zone's wiki entries
 * rest on (`src/auth/zones.ts`).
 */
describe("the wiki read slice under nais", () => {
  test("the read routes are registered", () => {
    const read = wikiRouteTable("read", "nais");
    expect(read.length).toBeGreaterThanOrEqual(7);
    expect(read.some((r) => r.path === "/api/wiki/related")).toBe(true);
    expect(read.some((r) => r.path === "/api/wiki/decision-chain")).toBe(true);
    const paths = registeredPaths(build("nais"));
    for (const { path } of read) {
      expect(`${path} → ${paths.has(path)}`).toBe(`${path} → true`);
    }
  });

  test("…and ANSWER — a handler runs, not Hono's 404", async () => {
    // Parameters that each handler refuses before any filesystem read, so the
    // answer is the route's own and does not depend on this machine's wikis.
    const app = build("nais");
    const answers: Record<string, number> = {};
    for (const path of ["/api/wiki/page", "/api/wiki/page/provenance", "/api/wiki/related", "/api/wiki/decision-chain", "/api/wiki/html", "/api/wiki/pages?wiki=__no_such_wiki__"]) {
      answers[path] = (await app.request(path)).status;
    }
    expect(answers).toEqual({
      "/api/wiki/page": 400, "/api/wiki/page/provenance": 400, "/api/wiki/related": 400, "/api/wiki/decision-chain": 400, "/api/wiki/html": 400,
      "/api/wiki/pages?wiki=__no_such_wiki__": 200,
    });
  });

  test("every other wiki route is 404 — Explain, Ask, Stamp and every write", async () => {
    const routes = wikiRouteTable("tools");
    for (const must of ["/api/wiki/explain", "/api/wiki/ask", "/api/wiki/provenance/stamp", "/api/wiki/series", "/api/wiki/similar"]) {
      expect(routes.some((r) => r.path === must), must).toBe(true);
    }
    const app = build("nais");
    for (const r of routes) {
      const res = await app.request(r.path, {
        method: r.method,
        ...(r.method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      });
      expect(`${r.method} ${r.path} → ${res.status}`).toBe(`${r.method} ${r.path} → 404`);
    }
  });

  test("the default profile registers both halves", async () => {
    const paths = registeredPaths(build("default"));
    for (const r of wikiRouteTable("tools")) {
      expect(`${r.path} → ${paths.has(r.path)}`).toBe(`${r.path} → true`);
    }
    expect(paths.has("/api/wiki/page")).toBe(true);
  });

  test("the answer routes (`wiki-answers`) are KEPT by nais and registered on default (D14)", () => {
    const answers = wikiRouteTable("answers");
    expect(answers.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /api/wiki/answers",
      "GET /api/wiki/answers/export",
      "POST /api/wiki/answers",
      "POST /api/wiki/answers/export/confirm",
      "POST /api/wiki/answers/redact",
    ]);
    for (const profile of ["nais", "default"] as const) {
      const app = build(profile);
      for (const r of answers) {
        expect(`${profile} ${r.method} ${r.path} → ${app.routes.some((x) => x.method === r.method && x.path === r.path)}`)
          .toBe(`${profile} ${r.method} ${r.path} → true`);
      }
    }
  });

  test("…and ANSWER on nais — a handler runs, not Hono's 404", async () => {
    const app = build("nais");
    expect((await app.request("/api/wiki/answers")).status).toBe(400);
    const res = await app.request("/api/wiki/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  test("wikiToolsRegistered and servesWikiReadSliceOnly are complements on both profiles", () => {
    expect(wikiToolsRegistered("nais")).toBe(false);
    expect(wikiToolsRegistered("default")).toBe(true);
    expect(servesWikiReadSliceOnly("nais")).toBe(true);
    expect(servesWikiReadSliceOnly("default")).toBe(false);
  });
});

describe("the worked-on ledger's boot kick (fix round 2)", () => {
  /**
   * The gate `src/index.ts` warms the memo behind. A predicate rather than an
   * inline test at the boot site, so both profiles are drivable: under `nais`
   * there is no `/wiki` reader to warm the axis for, the wiki roots are working
   * trees that do not exist in a pod, and the claude-usage it would dial is a
   * launchd service on another machine's loopback.
   */
  test("the default profile kicks it and `nais` does not", () => {
    expect(wikiToolsRegistered("default")).toBe(true);
    expect(wikiToolsRegistered("nais")).toBe(false);
  });

  test("…and it is DERIVED from the drop set, not from the profile name", () => {
    // So a later profile that drops `wiki` skips the kick with no second edit.
    expect(NAIS_DROPPED_ROUTE_GROUPS.includes("wiki")).toBe(true);
  });
});

describe("routeRows (src/test/wiki-route-table.ts)", () => {
  const ok = () => new Response("ok");
  test("the answer POSTs' body-limit middleware is not a row of its own", () => {
    const app = new Hono();
    app.post("/p", answerBodyLimit, ok);
    expect(routeRows(app)).toEqual([{ method: "POST", path: "/p" }]);
  });

  test("a second registration of the same route is a second row, so a shadowing duplicate fails the route tables", () => {
    const app = new Hono();
    app.post("/p", answerBodyLimit, ok);
    app.post("/p", ok);
    expect(routeRows(app)).toEqual([
      { method: "POST", path: "/p" },
      { method: "POST", path: "/p" },
    ]);
  });
});
