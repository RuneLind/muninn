/**
 * `GET /api/wiki/claim-check` against real temp wikis read through the real
 * index, with the work map card's route (`GET /api/wiki/work-map/checks`) on
 * the same app and cache and a stubbed `gh`. The page route never asks: every
 * verdict here comes from what a card request cached. Repos, numbers and dates
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
import { __pagePrsSettledForTest, __resetGhCheckForTest, GH_PRS_PER_HOUR, GH_STATE_TTL_MS, type GhCheckDeps, type GhResult, type GhRunner } from "../../wiki/work-map/gh-check.ts";
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
  /** The work map card's check on the same wiki, then the end of the flight it starts for the pages' `prs:`; with the spawns both caused. */
  const card = async () => {
    const before = spawns.length;
    const res = await app.request("/api/wiki/work-map/checks?wiki=w");
    await __pagePrsSettledForTest("w");
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, spawns: spawns.length - before };
  };
  return { get, card, spawns, root };
}

const url = (repo: string, n: number) => `[#${n}](https://github.com/${repo}/pull/${n})`;
/** A PR ledger, so the page has rows of its own for the card. */
const ledger = (rows: [string, string][]) => `\n**PR ledger.**\n\n| PR | What | State |\n|---|---|---|\n${rows.map(([pr, state]) => `| ${pr} | x | ${state} |`).join("\n")}\n`;

const LATE_PAGE = page("status_date: 2026-05-10\nprs: [acme/gears#7, https://github.com/acme/gears/pull/8]\n");
const TABLE: Record<string, Pr> = { "acme/gears#7": { state: "MERGED", mergedAt: "2026-05-12T08:00:00Z" }, "acme/gears#8": { state: "OPEN" } };
const LATE = {
  wiki: "w",
  relPath: "plans/a.mdx",
  at: NOW,
  verdict: "late",
  statusDate: "2026-05-10",
  newest: { pr: "acme/gears#7", repo: "acme/gears", n: 7, mergedAt: "2026-05-12T08:00:00Z", mergedDay: "2026-05-12" },
};
const NOT_ASKED = { wiki: "w", relPath: "plans/a.mdx", at: NOW, verdict: "notChecked", reason: "not-asked" };
const failing = (result: GhResult): GhRunner => async () => result;

describe("a page view asks GitHub nothing", () => {
  test("before the card's check has run: not-asked, with no spawn", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE) });
    for (let i = 0; i < 5; i++) expect(await s.get()).toEqual({ status: 200, body: NOT_ASKED });
    expect(s.spawns.length).toBe(0);
  });

  test("after the card's check: the verdict, and still no spawn of its own", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE) });
    expect((await s.card()).spawns).toBe(1);
    for (let i = 0; i < 5; i++) expect(await s.get()).toEqual({ status: 200, body: LATE });
    expect(s.spawns.length).toBe(1);
  });

  test("an hour after the card asked, the page is not-asked again until the card asks", async () => {
    let now = NOW;
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE), now: () => now });
    await s.card();
    now = NOW + GH_STATE_TTL_MS - 1;
    expect((await s.get()).body).toMatchObject({ verdict: "late", at: now });
    now = NOW + GH_STATE_TTL_MS;
    expect((await s.get()).body).toEqual({ ...NOT_ASKED, at: now });
    expect(s.spawns.length).toBe(1);
    await s.card();
    expect((await s.get()).body).toMatchObject({ verdict: "late" });
    expect(s.spawns.length).toBe(2);
  });
});

describe("verdicts", () => {
  test("clear: every PR known, none merged after status_date; a NOT_FOUND entry left out", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("status_date: 2026-05-12\nprs: [acme/gears#7, acme/gears#99]\n") }, gh: stubGh(TABLE) });
    await s.card();
    expect((await s.get()).body).toEqual({
      wiki: "w",
      relPath: "plans/a.mdx",
      at: NOW,
      verdict: "clear",
      statusDate: "2026-05-12",
      newest: { pr: "acme/gears#7", repo: "acme/gears", n: 7, mergedAt: "2026-05-12T08:00:00Z", mergedDay: "2026-05-12" },
    });
  });

  test("a page whose prs: are all NOT_FOUND is no-prs", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("status_date: 2026-05-12\nprs: [acme/gears#98, acme/gears#99]\n") }, gh: stubGh({}) });
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "not-asked" });
    await s.card();
    expect((await s.get()).body).toEqual({ wiki: "w", relPath: "plans/a.mdx", at: NOW, verdict: "notChecked", reason: "no-prs" });
  });

  test("no prs: at all is no-prs, and no status_date is no-status-date, card or no card", async () => {
    const s = setup({ pages: { "plans/a.mdx": page("status_date: 2026-05-12\n"), "plans/b.mdx": page("prs: [acme/gears#7]\n") }, gh: stubGh(TABLE) });
    for (const round of [0, 1]) {
      expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "no-prs" });
      expect((await s.get("wiki=w&relPath=plans/b.mdx")).body).toMatchObject({ verdict: "notChecked", reason: "no-status-date" });
      if (round === 0) await s.card();
    }
  });

  test("an entry that is no PR reference: unreadable-prs beside an earlier merge, late beside a later one", async () => {
    const s = setup({
      pages: {
        "plans/a.mdx": page("status_date: 2026-05-12\nprs: [acme/gears#7, TBD]\n"),
        "plans/b.mdx": page("status_date: 2026-05-10\nprs: [acme/gears#7, TBD]\n"),
        "plans/c.mdx": page("status_date: 2026-05-10\nprs: [TBD]\n"),
      },
      gh: stubGh(TABLE),
    });
    expect((await s.get("wiki=w&relPath=plans/c.mdx")).body).toMatchObject({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ["TBD"] });
    await s.card();
    expect((await s.get()).body).toEqual({ wiki: "w", relPath: "plans/a.mdx", at: NOW, verdict: "notChecked", reason: "unreadable-prs", unreadable: ["TBD"] });
    expect((await s.get("wiki=w&relPath=plans/b.mdx")).body).toMatchObject({ verdict: "late", newest: { pr: "acme/gears#7" } });
  });
});

describe("what the card's check could not read", () => {
  test("a login refusal reads auth with the repo, and clears once the card's check answers", async () => {
    let gh: GhRunner = failing({ exitCode: 4, stdout: "", stderr: "gh auth login" });
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: (args) => gh(args) });
    await s.card();
    expect((await s.get()).body).toEqual({ wiki: "w", relPath: "plans/a.mdx", at: NOW, verdict: "notChecked", reason: "auth", repos: ["acme/gears"] });
    gh = stubGh(TABLE);
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "auth" });
    await s.card();
    expect((await s.get()).body).toEqual(LATE);
  });

  test("a refusal the card recorded more than an hour ago reads not-asked", async () => {
    let now = NOW;
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: failing({ exitCode: 4, stdout: "", stderr: "gh auth login" }), now: () => now });
    await s.card();
    now = NOW + GH_STATE_TTL_MS - 1;
    expect((await s.get()).body).toMatchObject({ verdict: "notChecked", reason: "auth", repos: ["acme/gears"] });
    now = NOW + GH_STATE_TTL_MS;
    expect((await s.get()).body).toEqual({ ...NOT_ASKED, at: now });
  });

  test("a repo written in another case on the page finds its failure record, and is listed as written", async () => {
    const pageFm = "status_date: 2026-05-10\nprs: [Acme/Gears#7]\n";
    const s = setup({ pages: { "plans/a.mdx": page(pageFm) }, gh: failing({ exitCode: 4, stdout: "", stderr: "gh auth login" }) });
    await s.card();
    expect((await s.get()).body).toEqual({ wiki: "w", relPath: "plans/a.mdx", at: NOW, verdict: "notChecked", reason: "auth", repos: ["Acme/Gears"] });
  });

  test("no gh binary reads no-gh", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: failing({ exitCode: -1, stdout: "", stderr: "", noBinary: true }) });
    await s.card();
    expect((await s.get()).body).toEqual({ wiki: "w", relPath: "plans/a.mdx", at: NOW, verdict: "notChecked", reason: "no-gh", repos: ["acme/gears"] });
  });

  test("a query that timed out leaves the page not-asked", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: failing({ exitCode: -1, stdout: "", stderr: "", timedOut: true }) });
    await s.card();
    expect((await s.get()).body).toEqual(NOT_ASKED);
  });

  test("the card's rows filling its hour leave the pages' prs: their own", async () => {
    const rows = Array.from({ length: GH_PRS_PER_HOUR }, (_, i) => [url("acme/widgets", i + 1), "open"] as [string, string]);
    const table = Object.fromEntries(rows.map((_, i) => [`acme/widgets#${i + 1}`, { state: "OPEN" } as Pr]));
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE + ledger(rows) }, gh: stubGh({ ...table, ...TABLE }) });
    const card = await s.card();
    expect(card.body).toMatchObject({ checked: GH_PRS_PER_HOUR, unchecked: 0 });
    expect((await s.get()).body).toEqual(LATE);
  });

  test("a PR past the pages' own hourly cap is not-asked", async () => {
    const prs = Array.from({ length: GH_PRS_PER_HOUR + 1 }, (_, i) => `acme/gears#${i + 100}`);
    const table = Object.fromEntries(prs.map((k) => [k, { state: "OPEN" } as Pr]));
    const s = setup({ pages: { "plans/a.mdx": page(`status_date: 2026-05-10\nprs: [${prs.join(", ")}]\n`) }, gh: stubGh(table) });
    await s.card();
    expect((await s.get()).body).toEqual(NOT_ASKED);
  });
});

describe("pages and wikis the card's check never asks about", () => {
  test("a blog, an archive page and a shipped plan are not-live, with their prs: never asked", async () => {
    const s = setup({
      pages: {
        "blogs/b.mdx": `---\ntitle: A blog\nstatus_date: 2026-05-10\nprs: [acme/gears#7]\n---\n\n# B\n`,
        "archive/x.mdx": `---\ntitle: Old\nplan_status: shipped\nfollowups: none\nstatus_date: 2026-05-10\nprs: [acme/gears#7]\n---\n\n# X\n`,
      },
      gh: stubGh(TABLE),
    });
    expect((await s.card()).spawns).toBe(0);
    for (const rel of ["blogs/b.mdx", "archive/x.mdx"]) {
      expect((await s.get(`wiki=w&relPath=${rel}`)).body).toEqual({ wiki: "w", relPath: rel, at: NOW, verdict: "notChecked", reason: "not-live" });
    }
  });

  test("a shipped plan with follow-ups open is live", async () => {
    const s = setup({ pages: { "plans/a.mdx": `---\ntitle: A\nplan_status: shipped\nfollowups: open\nstatus_date: 2026-05-10\nprs: [acme/gears#7]\n---\n\n# A\n` }, gh: stubGh(TABLE) });
    await s.card();
    expect((await s.get()).body).toMatchObject({ verdict: "late" });
  });

  const neverAsked: [string, Setup][] = [
    ["no work map", { map: null }],
    ["a theme map", { map: THEME_MAP }],
    ["a read-only root", { readonly: true }],
    ["the check switched off", { disabled: true }],
    ["no gh seam", { noGhCheck: true }],
  ];
  for (const [name, o] of neverAsked) {
    test(`${name}: the card asks nothing, so a live page stays not-asked`, async () => {
      const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE), ...o });
      await s.card();
      expect((await s.get()).body).toEqual(NOT_ASKED);
      expect(s.spawns.length).toBe(0);
    });
  }
});

describe("request shape", () => {
  test("missing parameters are 400", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE } });
    expect(await s.get("relPath=plans/a.mdx")).toEqual({ status: 400, body: { error: "wiki is required" } });
    expect(await s.get("wiki=w")).toEqual({ status: 400, body: { error: "relPath is required" } });
  });

  test("a failure before the page is read is a 500 with a JSON body, after the parameter checks", async () => {
    const throwing: (() => WorkMapRunDeps)[] = [
      () => {
        throw new Error("no deps");
      },
      () =>
        ({
          now: () => NOW,
          registry: () => {
            throw new Error("no registry");
          },
        }) as unknown as WorkMapRunDeps,
    ];
    for (const workMap of throwing) {
      const app = new Hono();
      registerWikiClaimCheckRoute(app, {} as Config, { workMap, index: async () => null });
      const res = await app.request("/api/wiki/claim-check?wiki=w&relPath=plans/a.mdx");
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "the status date check failed" });
      expect((await app.request("/api/wiki/claim-check?relPath=plans/a.mdx")).status).toBe(400);
      expect((await app.request("/api/wiki/claim-check?wiki=w")).status).toBe(400);
    }
  });

  test("an unknown wiki and an unknown page are 404", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE } });
    expect(await s.get("wiki=nope&relPath=plans/a.mdx")).toEqual({ status: 404, body: { error: "no wiki configured for that name" } });
    expect(await s.get("wiki=w&relPath=plans/nope.mdx")).toEqual({ status: 404, body: { error: "no such page in this wiki" } });
  });

  test("the wiki's name in another case is the same wiki, answered under its own name", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE }, gh: stubGh(TABLE) });
    await s.card();
    expect(await s.get("wiki=W&relPath=plans/a.mdx")).toEqual({ status: 200, body: LATE });
  });

  test("a .html page is refused", async () => {
    const s = setup({ pages: { "plans/a.mdx": LATE_PAGE, "plans/x.html": "<html><title>X</title></html>" } });
    expect(await s.get("wiki=w&relPath=plans/x.html")).toEqual({ status: 400, body: { error: "only .md and .mdx pages carry a status date" } });
  });
});

describe("the card beside the flight for the pages' prs:", () => {
  const ROWS: [string, string][] = [[url("acme/widgets", 1), "open"], [url("acme/widgets", 2), "merged"]];
  const CARD_TABLE: Record<string, Pr> = { "acme/widgets#1": { state: "MERGED", mergedAt: "2026-05-11T08:00:00Z" }, "acme/widgets#2": { state: "MERGED", mergedAt: "2026-05-01T08:00:00Z" } };
  const askedOf = (spawns: string[][]) =>
    spawns.map((args) => `${args.find((a) => a.startsWith("owner="))!.slice(6)}/${args.find((a) => a.startsWith("repo="))!.slice(5)}: ${[...args.find((a) => a.startsWith("query="))!.matchAll(/number:(\d+)/g)].map((m) => m[1]).join(",")}`);

  test("the card's flight asks for the rows' PRs, a second one for the pages' prs: it does not ask itself", async () => {
    const s = setup({
      pages: {
        "plans/a.mdx": page("status_date: 2026-05-10\nprs: [acme/gears#7, acme/widgets#1, acme/widgets#3]\n") + ledger(ROWS),
        "blogs/b.mdx": `---\ntitle: A blog\nprs: [acme/blog#1]\n---\n\n# B\n`,
      },
      gh: stubGh({ ...CARD_TABLE, ...TABLE }),
    });
    expect((await s.card()).spawns).toBe(3);
    // widgets#1 is a row's PR, so the pages' flight leaves it to the card's.
    expect(askedOf(s.spawns).sort()).toEqual(["acme/gears: 7", "acme/widgets: 1,2", "acme/widgets: 3"]);
    // The page reads #1 from the card's cache and the other two from the pages'.
    expect((await s.get()).body).toMatchObject({ verdict: "late", newest: { pr: "acme/gears#7" } });
    // And a second card request asks nothing.
    expect((await s.card()).spawns).toBe(0);
  });

  test("the card's body is the same with prs: on the pages and without, healthy and with their repo failing", async () => {
    const plain = { "plans/a.mdx": page("status_date: 2026-05-10\n") + ledger(ROWS) };
    const withPrs = { "plans/a.mdx": page("status_date: 2026-05-10\nprs: [acme/gears#7, acme/gears#8, acme/widgets#1]\n") + ledger(ROWS) };
    const gearsDown: GhRunner = async (args) => (args.includes("repo=gears") ? { exitCode: 4, stdout: "", stderr: "gh auth login" } : stubGh(CARD_TABLE)(args));
    for (const gh of [stubGh({ ...CARD_TABLE, ...TABLE }), gearsDown]) {
      const a = await setup({ pages: plain, gh }).card();
      __resetGhCheckForTest();
      const withThem = setup({ pages: withPrs, gh });
      const b = await withThem.card();
      // Also once the pages' flight has ended, failed or not.
      const again = await withThem.card();
      __resetGhCheckForTest();
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(again.body).toEqual(a.body);
      expect(a.body).toMatchObject({ checked: 2, contradictions: [{ pr: 1 }] });
      expect(a.body.notChecked).toBeUndefined();
    }
  });
});
