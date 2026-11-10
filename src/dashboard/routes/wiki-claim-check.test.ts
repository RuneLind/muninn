/**
 * `GET /api/wiki/claim-check` against real temp wikis read through the real
 * index and the real `gh` gate, with a stubbed `gh`. Repos, numbers and dates
 * are made up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { getWikiIndex, readWikiPage } from "../../wiki/store.ts";
import { __resetGhCheckForTest, GH_FAILED_REPO_HOLD_MS, GH_PRS_PER_HOUR, type GhCheckDeps, type GhResult, type GhRunner } from "../../wiki/work-map/gh-check.ts";
import type { WorkMapRunDeps } from "../../wiki/work-map/run.ts";
import { registerWikiClaimCheckRoute } from "./wiki-claim-check.ts";
import { registerWikiWorkMapRoutes } from "./wiki-work-map.ts";

const NOW = Date.parse("2026-06-01T12:00:00Z");

afterEach(() => __resetGhCheckForTest());

const WORK_MAP = JSON.stringify({
  version: 1,
  wiki: "w",
  runAtMs: NOW,
  model: "m",
  coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
  summary: "",
  needsYou: [],
  themes: [],
  efforts: [],
  loose: [],
});

const THEME_MAP = JSON.stringify({
  version: 1,
  kind: "themes",
  wiki: "w",
  runAtMs: NOW,
  model: "m",
  coverage: { activeSources: 1, hubs: 0, driftHubs: 0, placed: 1, digestChars: 1, windowDays: 28, warnings: [] },
  summary: "",
  needsYou: [],
  themes: [],
  efforts: [],
  retired: [],
  loose: [],
});

const page = (fm: string) => `---\ntitle: A plan\nplan_status: in-flight\n${fm}---\n\n# A plan\n`;

type Pr = { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt?: string };

/** A `gh` that answers from a table keyed `owner/repo#n`; a miss is NOT_FOUND with exit 1, as the real one. */
function stubGh(table: Record<string, Pr>): GhRunner {
  return async (args) => {
    const owner = args.find((a) => a.startsWith("owner="))!.slice(6);
    const repo = args.find((a) => a.startsWith("repo="))!.slice(5);
    const q = args.find((a) => a.startsWith("query="))!;
    const fields: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const m of q.matchAll(/pullRequest\(number:(\d+)\)/g)) {
      const pr = table[`${owner}/${repo}#${m[1]}`];
      fields[`p${m[1]}`] = pr ? { state: pr.state, mergedAt: pr.mergedAt ?? null } : null;
      if (!pr) errors.push({ type: "NOT_FOUND", path: ["repository", `p${m[1]}`], message: "Could not resolve" });
    }
    return { exitCode: errors.length ? 1 : 0, stdout: JSON.stringify({ data: { repository: fields }, ...(errors.length ? { errors } : {}) }), stderr: "" };
  };
}

interface Setup {
  pages?: Record<string, string>;
  map?: string | null;
  gh?: GhRunner;
  disabled?: boolean;
  readonly?: boolean;
  noGhCheck?: boolean;
  now?: () => number;
}

function setup(o: Setup = {}) {
  const root = testTempDirSync(path.join(tmpdir(), "claim-check-"));
  mkdirSync(path.join(root, "plans"), { recursive: true });
  for (const [rel, text] of Object.entries(o.pages ?? {})) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  const map = o.map === undefined ? WORK_MAP : o.map;
  if (map !== null) writeFileSync(path.join(root, ".work-map.json"), map);
  const spawns: string[][] = [];
  const runGh = o.gh ?? stubGh({});
  const ghCheck: GhCheckDeps = {
    index: (r) => getWikiIndex({ root: r }),
    readBody: readWikiPage,
    runGh: async (args) => {
      spawns.push(args);
      return runGh(args);
    },
    disabled: () => o.disabled === true,
  };
  const deps = {
    now: o.now ?? (() => NOW),
    registry: () => [{ name: "w", root, source: "extra" }],
    isReadonlyRoot: () => o.readonly === true,
    readText: async (abs: string) => {
      try {
        return await Bun.file(abs).text();
      } catch {
        return null;
      }
    },
    ...(o.noGhCheck ? {} : { ghCheck }),
  } as unknown as WorkMapRunDeps;
  const app = new Hono();
  registerWikiClaimCheckRoute(app, {} as Config, { workMap: () => deps, index: (r) => getWikiIndex({ root: r, refresh: true }) });
  registerWikiWorkMapRoutes(app, {} as Config, () => deps);
  const get = async (q = "wiki=w&relPath=plans/a.mdx") => {
    const res = await app.request(`/api/wiki/claim-check?${q}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** The work map card's check, the same wiki and cache; with the spawns it caused. */
  const card = async () => {
    const before = spawns.length;
    const res = await app.request("/api/wiki/work-map/checks?wiki=w");
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, spawns: spawns.length - before };
  };
  return { get, card, spawns, root };
}

const LATE_PAGE = page("status_date: 2026-05-10\nprs: [acme/gears#7, https://github.com/acme/gears/pull/8]\n");
const TABLE: Record<string, Pr> = { "acme/gears#7": { state: "MERGED", mergedAt: "2026-05-12T08:00:00Z" }, "acme/gears#8": { state: "OPEN" } };

describe("verdicts", () => {
  test("late: status_date older than the newest merge", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE) });
    const r = await s.get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      wiki: "w",
      relPath: "plans/a.mdx",
      at: NOW,
      verdict: "late",
      statusDate: "2026-05-10",
      newest: { pr: "acme/gears#7", repo: "acme/gears", n: 7, mergedAt: "2026-05-12T08:00:00Z", mergedDay: "2026-05-12" },
    });
    expect(s.spawns.length).toBe(1);
  });

  test("clear: every PR known, none merged after status_date; a NOT_FOUND entry left out", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("status_date: 2026-05-12\nprs: [acme/gears#7, acme/gears#99]\n") }, gh: stubGh(TABLE) });
    const r = await s.get();
    expect(r.body).toMatchObject({ verdict: "clear", statusDate: "2026-05-12", newest: { pr: "acme/gears#7" } });
  });

  test("a second view of a healthy page spawns nothing", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE) });
    await s.get();
    const again = await s.get();
    expect(again.body.verdict).toBe("late");
    expect(s.spawns.length).toBe(1);
  });

  test("a page whose prs: are all NOT_FOUND is no-prs, and is not asked again", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("status_date: 2026-05-12\nprs: [acme/gears#98, acme/gears#99]\n") }, gh: stubGh({}) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-prs" });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-prs" });
    expect(s.spawns.length).toBe(1);
  });
});

describe("not checked", () => {
  test("no-prs: no prs: at all, and nothing spawns", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("status_date: 2026-05-12\n") } });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-prs" });
    expect(s.spawns.length).toBe(0);
  });

  test("no-status-date, and nothing spawns", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("prs: [acme/gears#7]\n") } });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-status-date" });
    expect(s.spawns.length).toBe(0);
  });

  test("no-state: a query that times out", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: async () => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-state" });
  });

  test("auth: not logged in", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: async () => ({ exitCode: 4, stdout: "", stderr: "gh auth login" }) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "auth", repos: ["acme/gears"] });
  });

  test("no-gh: no binary", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: async () => ({ exitCode: -1, stdout: "", stderr: "ENOENT", noBinary: true }) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-gh", repos: ["acme/gears"] });
  });

  test("FIVE views of a page whose repo fails spawn gh once, and the hold ends", async () => {
    let t = NOW;
    const result: GhResult = { exitCode: 4, stdout: "", stderr: "gh auth login" };
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: async () => result, now: () => t });
    for (let i = 0; i < 5; i++) expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "auth" });
    expect(s.spawns.length).toBe(1);
    t = NOW + GH_FAILED_REPO_HOLD_MS - 1;
    await s.get();
    expect(s.spawns.length).toBe(1);
    t = NOW + GH_FAILED_REPO_HOLD_MS;
    await s.get();
    expect(s.spawns.length).toBe(2);
  });

  test("a timed-out repo is held too", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: async () => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }) });
    for (let i = 0; i < 5; i++) expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-state" });
    expect(s.spawns.length).toBe(1);
  });

  test("budget: once the wiki's hour is spent, the next page says budget, not no-state", async () => {
    const many = Array.from({ length: GH_PRS_PER_HOUR }, (_, i) => `acme/widgets#${i + 1}`);
    const table = Object.fromEntries(many.map((k) => [k, { state: "OPEN" } as Pr]));
    const s = setup({
      pages: { "plans/big.mdx": page(`status_date: 2026-05-12\nprs: [${many.join(", ")}]\n`), "plans/a.mdx": LATE_PAGE },
      gh: stubGh({ ...table, ...TABLE }),
    });
    expect((await s.get("wiki=w&relPath=plans/big.mdx")).body).toMatchObject({ verdict: "clear" });
    const spent = s.spawns.length;
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "budget" });
    expect(s.spawns.length).toBe(spent);
  });

  describe("disabled, with zero spawns", () => {
    const cases: [string, Setup][] = [
      ["no .work-map.json", { map: null }],
      ["a map of another kind", { map: THEME_MAP }],
      ["an unreadable map", { map: "{not json" }],
      ["WORK_MAP_GH_CHECK off", { disabled: true }],
      ["a read-only root", { readonly: true }],
      ["no gh check seam", { noGhCheck: true }],
    ];
    for (const [name, o] of cases) {
      test(name, async () => {
        const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE), ...o });
        const r = await s.get();
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ wiki: "w", relPath: "plans/a.mdx", at: NOW, verdict: "notChecked", reason: "disabled" });
        expect(s.spawns.length).toBe(0);
      });
    }
  });
});

describe("only the card's live check pages", () => {
  const fm = "status_date: 2026-05-10\nprs: [acme/gears#7, acme/gears#8]\n";
  const cases: [string, string, string][] = [
    ["a blog", "blogs/b.mdx", `---\ntitle: B\ntype: blog\n${fm}---\n\n# B\n`],
    ["an archive page", "archive/r.md", `---\ntitle: R\ntype: report\n${fm}---\n\n# R\n`],
    ["a shipped plan", "plans/s.mdx", `---\ntitle: S\nplan_status: shipped\n${fm}---\n\n# S\n`],
    ["a shipped plan whose follow-ups are done", "plans/f.mdx", `---\ntitle: F\nplan_status: shipped\nfollowups: done\n${fm}---\n\n# F\n`],
  ];
  for (const [name, rel, text] of cases) {
    test(`${name} answers not-live with zero spawns`, async () => {
      const s = setup({ pages: { "plans/a.mdx": LATE_PAGE, [rel]: text }, gh: stubGh(TABLE) });
      const r = await s.get(`wiki=w&relPath=${rel}`);
      expect(s.spawns.length).toBe(0);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ wiki: "w", relPath: rel, at: NOW, verdict: "notChecked", reason: "not-live" });
    });
  }

  test("not-live comes before the gate: a blog on a wiki with no map is not-live, not disabled", async () => {
    const s = setup({ pages: { [cases[0]![1]]: cases[0]![2] }, map: null, gh: stubGh(TABLE) });
    expect((await s.get(`wiki=w&relPath=${cases[0]![1]}`)).body).toMatchObject({ verdict: "notChecked", reason: "not-live" });
    expect(s.spawns.length).toBe(0);
  });

  test("a live plan beside them still answers late", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE, [cases[0]![1]]: cases[0]![2] }, gh: stubGh(TABLE) });
    expect((await s.get()).body).toMatchObject({ verdict: "late" });
    expect(s.spawns.length).toBe(1);
  });

  test("a shipped plan with follow-ups open is live", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("plan_status: shipped\nfollowups: open\nstatus_date: 2026-05-10\nprs: [acme/gears#7]\n").replace("plan_status: in-flight\n", "") }, gh: stubGh(TABLE) });
    expect((await s.get()).body).toMatchObject({ verdict: "late" });
  });

  test("an unknown page is still 404", async () => {
    const s = setup({ pages: { [cases[0]![1]]: cases[0]![2] } });
    expect((await s.get("wiki=w&relPath=blogs/missing.mdx")).status).toBe(404);
  });
});

describe("prs: the rule cannot read", () => {
  test("an unreadable entry beside an earlier merge is unreadable-prs, not clear", async () => {
    const s = setup({ pages: { "plans/a.mdx": page('status_date: 2026-05-12\nprs: [acme/gears#7, "#838"]\n') }, gh: stubGh(TABLE) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ["#838"] });
  });

  test("an unreadable entry alone spawns nothing", async () => {
    const s = setup({ pages: { "plans/a.mdx": page('status_date: 2026-05-12\nprs: ["#838"]\n') }, gh: stubGh(TABLE) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ["#838"] });
    expect(s.spawns.length).toBe(0);
  });

  test("a block list is unreadable-prs, with zero spawns", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("status_date: 2026-05-12\nprs:\n  - acme/gears#7\n") }, gh: stubGh(TABLE) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ["prs:", "- acme/gears#7"] });
    expect(s.spawns.length).toBe(0);
  });
});

describe("request shape", () => {
  test("missing parameters are 400", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE } });
    expect((await s.get("relPath=plans/a.mdx")).status).toBe(400);
    expect((await s.get("wiki=w")).status).toBe(400);
    expect((await s.get("wiki=%20&relPath=plans/a.mdx")).status).toBe(400);
  });

  test("an unknown wiki is 404", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE } });
    expect((await s.get("wiki=nope&relPath=plans/a.mdx")).status).toBe(404);
  });

  test("an unknown page is 404, also under a read-only root, before the gate", async () => {
    for (const o of [{}, { readonly: true }, { map: null }] as Setup[]) {
      const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, ...o });
      const r = await s.get("wiki=w&relPath=plans/missing.mdx");
      expect(r.status).toBe(404);
      expect(s.spawns.length).toBe(0);
    }
  });

  test("a .html page is refused, with no spawn", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE, "plans/x.html": "<html><head><title>X</title></head><body></body></html>" }, gh: stubGh(TABLE) });
    const r = await s.get("wiki=w&relPath=plans/x.html");
    expect(r.status).toBe(400);
    expect(s.spawns.length).toBe(0);
  });
});

// ── The card and page views on one cache ─────────────────────────────────
const MIN = 60_000;
const ledgerPage = (title: string, rows: string[]) =>
  `---\ntitle: ${title}\nplan_status: in-flight\n---\n\n# ${title}\n\n**PR ledger.**\n\n| PR | State |\n|---|---|\n${rows.map((r) => `| [#${r.split("#")[1]}](https://github.com/${r.split("#")[0]}/pull/${r.split("#")[1]}) | open |`).join("\n")}\n`;
/** The card watches acme/gears#1; the viewed page names only acme/gears#99. */
const CARD_PAGES = { "plans/card.mdx": ledgerPage("Card", ["acme/gears#1"]), "plans/a.mdx": page("status_date: 2026-05-10\nprs: [acme/gears#99]\n") };
const CARD_TABLE: Record<string, Pr> = { "acme/gears#1": { state: "OPEN" }, "acme/gears#99": { state: "MERGED", mergedAt: "2026-05-12T08:00:00Z" } };

const AUTH: GhResult = { exitCode: 4, stdout: "", stderr: "gh auth login" };
const NO_GH: GhResult = { exitCode: -1, stdout: "", stderr: "ENOENT", noBinary: true };
const NO_ACCESS: GhResult = {
  exitCode: 1,
  stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository" }] }),
  stderr: "",
};
/** The repository answers, the asked aliases come back null and FORBIDDEN: no state, no NOT_FOUND. */
function forbiddenAliases(args: string[]): GhResult {
  const q = args.find((a) => a.startsWith("query="))!;
  const fields: Record<string, null> = {};
  const errors: unknown[] = [];
  for (const m of q.matchAll(/pullRequest\(number:(\d+)\)/g)) {
    fields[`p${m[1]}`] = null;
    errors.push({ type: "FORBIDDEN", path: ["repository", `p${m[1]}`], message: "Resource protected by organization SAML enforcement" });
  }
  return { exitCode: 1, stdout: JSON.stringify({ data: { repository: fields }, errors }), stderr: "" };
}

describe("a page view's failure stays out of the card's body", () => {
  /** t0 the card answers; t1 GitHub fails and (maybe) a page view asks #99; t2 the card again. */
  async function run(fail: (args: string[]) => GhResult, withPageView: boolean) {
    __resetGhCheckForTest();
    let t = NOW;
    let failing = false;
    const ok = stubGh(CARD_TABLE);
    const s = setup({ pages: CARD_PAGES, gh: async (a) => (failing ? fail(a) : ok(a)), now: () => t });
    const t0 = await s.card();
    failing = true;
    t = NOW + 10 * MIN;
    const view = withPageView ? await s.get() : null;
    t = NOW + 30 * MIN;
    const t2 = await s.card();
    return { t0, t2, view };
  }
  const cases: [string, (args: string[]) => GhResult, string][] = [
    ["auth", () => AUTH, "auth"],
    ["no gh", () => NO_GH, "no-gh"],
    ["a no-access answer", () => NO_ACCESS, "auth"],
    ["a partial sso answer", forbiddenAliases, "auth"],
  ];
  for (const [name, fail, pageReason] of cases) {
    test(name, async () => {
      const without = await run(fail, false);
      const withView = await run(fail, true);
      expect(withView.view!.body).toMatchObject({ verdict: "notChecked", reason: pageReason });
      expect(withView.t2.body.notChecked).toBeUndefined();
      expect(withView.t2.body).toEqual(without.t2.body);
      expect(withView.t2.spawns).toBe(without.t2.spawns);
      expect(withView.t0.body).toEqual(without.t0.body);
    });
  }
});

describe("joining the other one's flight", () => {
  /** A `gh` whose first call waits for `release`; every call answers AUTH. */
  function gatedAuth() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const gh: GhRunner = async () => {
      if (calls++ === 0) await gate;
      return AUTH;
    };
    return { gh, release };
  }
  const shared = { "plans/card.mdx": ledgerPage("Card", ["acme/gears#1"]), "plans/a.mdx": page("status_date: 2026-05-10\nprs: [acme/gears#1]\n") };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(2);
  };

  test("the card joining a page view's failing flight still gets its own failure", async () => {
    const { gh, release } = gatedAuth();
    const s = setup({ pages: shared, gh });
    const view = s.get();
    await until(() => s.spawns.length === 1);
    const card = s.card();
    await Bun.sleep(5);
    release();
    await view;
    const r = await card;
    expect(r.body.notChecked).toEqual({ reason: "auth", repos: ["acme/gears"] });
    expect(r.spawns).toBe(1);
  });

  test("a page view joining the card's failing flight gets its own failure and its own hold", async () => {
    const { gh, release } = gatedAuth();
    const s = setup({ pages: shared, gh });
    const card = s.card();
    await until(() => s.spawns.length === 1);
    const view = s.get();
    await Bun.sleep(5);
    release();
    await card;
    expect((await view).body).toMatchObject({ verdict: "notChecked", reason: "auth", repos: ["acme/gears"] });
    expect(s.spawns.length).toBe(2);
    await s.get();
    expect(s.spawns.length).toBe(2);
  });
});

describe("the failed-repo hold", () => {
  test("set by the card's failure? no: after the login is fixed a page view asks at once", async () => {
    let t = NOW;
    let failing = true;
    const ok = stubGh(CARD_TABLE);
    const s = setup({ pages: CARD_PAGES, gh: async (a) => (failing ? AUTH : ok(a)), now: () => t });
    expect((await s.card()).body.notChecked).toEqual({ reason: "auth", repos: ["acme/gears"] });
    failing = false;
    t = NOW + MIN;
    const view = await s.get();
    expect(view.body).toMatchObject({ verdict: "late", newest: { pr: "acme/gears#99" } });
    expect(s.spawns.length).toBe(2);
  });

  test("card fails, login fixed, the card answers: a page view right after gets a real verdict with one spawn", async () => {
    let t = NOW;
    let failing = true;
    const ok = stubGh(CARD_TABLE);
    const s = setup({ pages: CARD_PAGES, gh: async (a) => (failing ? AUTH : ok(a)), now: () => t });
    await s.card();
    failing = false;
    t = NOW + MIN;
    const again = await s.card();
    expect(again.spawns).toBe(1);
    expect(again.body.notChecked).toBeUndefined();
    t = NOW + 2 * MIN;
    const before = s.spawns.length;
    expect((await s.get()).body).toMatchObject({ verdict: "late" });
    expect(s.spawns.length - before).toBe(1);
  });

  test("a page view's failure is cleared by the card's later answer for that repo", async () => {
    let t = NOW;
    let failing = true;
    const ok = stubGh(CARD_TABLE);
    const s = setup({ pages: { ...CARD_PAGES, "plans/card.mdx": ledgerPage("Card", ["acme/gears#2"]) }, gh: async (a) => (failing ? AUTH : ok(a)), now: () => t });
    expect((await s.get()).body).toMatchObject({ reason: "auth" });
    failing = false;
    t = NOW + MIN;
    await s.card();
    t = NOW + 2 * MIN;
    const before = s.spawns.length;
    expect((await s.get()).body).toMatchObject({ verdict: "late" });
    expect(s.spawns.length - before).toBe(1);
  });

  /** 51 PRs in one repo: two jobs. The 51st's job answers; the first job times out. */
  async function twoJobs(answeredFirst: boolean) {
    __resetGhCheckForTest();
    const many = Array.from({ length: 51 }, (_, i) => `acme/gears#${i + 1}`);
    const ok = stubGh(Object.fromEntries(many.map((k) => [k, { state: "OPEN" } as Pr])));
    const s = setup({
      pages: { "plans/big.mdx": page(`status_date: 2026-05-12\nprs: [${many.join(", ")}]\n`), "plans/a.mdx": page("status_date: 2026-05-10\nprs: [acme/gears#99]\n") },
      gh: async (args) => {
        const second = args.some((a) => a.includes("number:51)"));
        await Bun.sleep(second === answeredFirst ? 0 : 30);
        return second ? ok(args) : { exitCode: -1, stdout: "", stderr: "", timedOut: true };
      },
    });
    await s.get("wiki=w&relPath=plans/big.mdx");
    expect(s.spawns.length).toBe(2);
    const again = s.spawns.length;
    await s.get("wiki=w&relPath=plans/big.mdx");
    const bigAgain = s.spawns.length - again;
    const other = s.spawns.length;
    await s.get();
    return { bigAgain, otherPage: s.spawns.length - other };
  }

  test("one flight, two jobs: the hold does not depend on which job finishes last", async () => {
    const answeredFirst = await twoJobs(true);
    const answeredLast = await twoJobs(false);
    expect(answeredFirst).toEqual(answeredLast);
    // The repo answered, so it is not held; the timed-out job's own PRs are.
    expect(answeredFirst).toEqual({ bigAgain: 0, otherPage: 1 });
  });
});

describe("a PR asked and left with no state and no NOT_FOUND", () => {
  const pages = { "plans/a.mdx": page("status_date: 2026-05-10\nprs: [acme/gears#7]\n"), "plans/card.mdx": ledgerPage("Card", ["acme/gears#7"]) };

  test("five page views spawn gh once, and it is asked again after the hold", async () => {
    let t = NOW;
    const s = setup({ pages, gh: async (a) => forbiddenAliases(a), now: () => t });
    for (let i = 0; i < 5; i++) expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "auth", repos: ["acme/gears"] });
    expect(s.spawns.length).toBe(1);
    t = NOW + GH_FAILED_REPO_HOLD_MS - 1;
    await s.get();
    expect(s.spawns.length).toBe(1);
    t = NOW + GH_FAILED_REPO_HOLD_MS;
    await s.get();
    expect(s.spawns.length).toBe(2);
  });

  test("the card still asks it on every request, page views or not", async () => {
    let t = NOW;
    const s = setup({ pages, gh: async (a) => forbiddenAliases(a), now: () => t });
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      t = NOW + i * 2 * MIN;
      counts.push((await s.card()).spawns);
      t += MIN;
      await s.get();
    }
    expect(counts).toEqual([1, 1, 1]);
  });
});

describe("the card's body and spawns are the same with page views interleaved", () => {
  const widgets = Array.from({ length: GH_PRS_PER_HOUR + 1 }, (_, i) => `acme/widgets#${i + 1}`);
  const scenarios: [string, Record<string, string>, GhRunner][] = [
    ["healthy", CARD_PAGES, stubGh(CARD_TABLE)],
    ["auth failure", CARD_PAGES, async () => AUTH],
    ["no gh", CARD_PAGES, async () => NO_GH],
    [
      "budget exhausted",
      { ...CARD_PAGES, "plans/card.mdx": ledgerPage("Card", widgets) },
      stubGh({ ...CARD_TABLE, ...Object.fromEntries(widgets.map((k) => [k, { state: "OPEN" } as Pr])) }),
    ],
  ];
  const CARD_AT = [0, 2 * MIN, 61 * MIN, 75 * MIN];

  async function run(pages: Record<string, string>, gh: GhRunner, withViews: boolean) {
    __resetGhCheckForTest();
    let t = NOW;
    const s = setup({ pages, gh, now: () => t });
    const out: { body: Record<string, unknown>; spawns: number }[] = [];
    const views: Record<string, unknown>[] = [];
    for (const at of CARD_AT) {
      t = NOW + at;
      const r = await s.card();
      out.push({ body: r.body, spawns: r.spawns });
      if (withViews) {
        t += MIN;
        views.push((await s.get()).body);
        views.push((await s.get()).body);
      }
    }
    return { out, views };
  }

  for (const [name, pages, gh] of scenarios) {
    test(name, async () => {
      const without = await run(pages, gh, false);
      const withViews = await run(pages, gh, true);
      expect(withViews.out).toEqual(without.out);
      expect(withViews.views.length).toBe(CARD_AT.length * 2);
    });
  }
});
