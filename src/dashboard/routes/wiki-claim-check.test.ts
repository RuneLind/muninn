import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { __resetGhCheckForTest, type GhCheckDeps, type GhResult } from "../../wiki/work-map/gh-check.ts";
import { registerWikiClaimCheckRoute, type ClaimCheckRouteDeps } from "./wiki-claim-check.ts";

const NOW = Date.parse("2026-03-20T12:00:00Z");

const FLAGGED = [
  "---",
  "title: Gears",
  "type: plan",
  "status_date: 2026-03-01",
  "prs: [acme/gears#7]",
  "---",
  "",
  "# Gears",
  "",
  "**Status:** [gears #7](https://github.com/acme/gears/pull/7) åpen, venter på review",
  "",
].join("\n");

const CLEAN = FLAGGED.replace("åpen, venter på review", "merget 10.03").replace("status_date: 2026-03-01", "status_date: 2026-03-12");
const NO_LINES = "---\ntitle: Plain\ntype: plan\n---\n\n# Plain\n\nNothing about a PR here.\n";

const merged = (n: number) => ({ [`p${n}`]: { state: "MERGED", mergedAt: "2026-03-10T09:00:00Z", closedAt: "2026-03-10T09:00:00Z" } });

function setup(opts: { content?: string; gh?: (args: string[]) => GhResult; readonlyRoot?: boolean; disabled?: boolean } = {}) {
  const spawns: string[][] = [];
  const meta = { relPath: "plans/gears.mdx", plan_status: "in-flight", prRefs: ["acme/gears#7"] };
  const gh: GhCheckDeps = {
    index: async () => ({ pages: [meta], resolve: () => undefined, resolveRelPath: (rel: string) => (rel === meta.relPath ? meta : undefined) }) as never,
    readBody: async () => opts.content ?? FLAGGED,
    runGh: async (args) => {
      spawns.push(args);
      return opts.gh ? opts.gh(args) : { exitCode: 0, stdout: JSON.stringify({ data: { repository: merged(7) } }), stderr: "" };
    },
    disabled: () => opts.disabled ?? false,
  };
  const deps: ClaimCheckRouteDeps = {
    registry: () => [{ name: "w", root: "/w/w", source: "extra" }] as never,
    isReadonlyRoot: () => opts.readonlyRoot ?? false,
    gh,
    now: () => NOW,
  };
  const app = new Hono();
  registerWikiClaimCheckRoute(app, () => deps);
  return { app, spawns };
}

const get = (s: { app: Hono }, q = "wiki=w&relPath=plans/gears.mdx") => s.app.request(`/api/wiki/claim-check?${q}`);

afterEach(() => __resetGhCheckForTest());

describe("GET /api/wiki/claim-check", () => {
  test("a flagged page: R1 and R2 with GitHub's dates", async () => {
    const s = setup();
    const res = await get(s);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      wiki: "w",
      page: "plans/gears.mdx",
      at: NOW,
      compared: 2,
      contradicted: 2,
      unchecked: 0,
      unresolved: 0,
      r1: [
        {
          line: 10,
          home: "status",
          text: "**Status:** [gears #7](https://github.com/acme/gears/pull/7) åpen, venter på review",
          pr: "acme/gears#7",
          says: "åpen",
          github: { state: "MERGED", at: "2026-03-10T09:00:00Z" },
        },
      ],
      r2: { state: "fires", statusDate: "2026-03-01", newest: { pr: "acme/gears#7", mergedAt: "2026-03-10T09:00:00Z" } },
    });
  });

  test("a second view is served from the cache: no second gh call", async () => {
    const s = setup();
    await get(s);
    await get(s);
    expect(s.spawns.length).toBe(1);
  });

  test("a clean page: compared, zero contradicted", async () => {
    const body = await (await get(setup({ content: CLEAN }))).json();
    expect(body).toMatchObject({ compared: 1, contradicted: 0, r1: [], r2: { state: "clear", statusDate: "2026-03-12" } });
    expect(body.notChecked).toBeUndefined();
  });

  test("no line a rule can read: not checked, never 0 contradicted, and no gh call", async () => {
    const s = setup({ content: NO_LINES });
    const body = await (await get(s)).json();
    expect(body).toMatchObject({ compared: 0, contradicted: null, notChecked: { reason: "no-lines" }, r2: { state: "not-checked", reason: "no-prs" } });
    expect(s.spawns).toEqual([]);
  });

  test("no state for the PR (GitHub says no such PR): not checked, no-state", async () => {
    const s = setup({
      gh: () => ({ exitCode: 1, stdout: JSON.stringify({ data: { repository: { p7: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "p7"] }] }), stderr: "" }),
    });
    const body = await (await get(s)).json();
    expect(body).toMatchObject({ compared: 0, contradicted: null, unchecked: 2, notChecked: { reason: "no-state" } });
  });

  test("no GitHub login: not checked with the login reason", async () => {
    const s = setup({ gh: () => ({ exitCode: 4, stdout: "", stderr: "gh auth login" }) });
    const body = await (await get(s)).json();
    expect(body).toMatchObject({ compared: 0, contradicted: null, notChecked: { reason: "auth", repos: ["acme/gears"] } });
  });

  test("no gh binary: not checked, no-gh", async () => {
    const s = setup({ gh: () => ({ exitCode: -1, stdout: "", stderr: "ENOENT", noBinary: true }) });
    expect((await (await get(s)).json()).notChecked).toEqual({ reason: "no-gh", repos: ["acme/gears"] });
  });

  test("the check switched off, or a read-only root: disabled, no gh call", async () => {
    for (const s of [setup({ disabled: true }), setup({ readonlyRoot: true })]) {
      const body = await (await get(s)).json();
      expect(body).toMatchObject({ compared: 0, contradicted: null, notChecked: { reason: "disabled" } });
      expect(s.spawns).toEqual([]);
    }
  });

  test("a wiki outside the registry is a 404, a missing parameter a 400, an unknown page a 404", async () => {
    const s = setup();
    expect((await get(s, "wiki=elsewhere&relPath=plans/gears.mdx")).status).toBe(404);
    expect((await get(s, "relPath=plans/gears.mdx")).status).toBe(400);
    expect((await get(s, "wiki=w")).status).toBe(400);
    expect((await get(s, "wiki=w&relPath=plans/none.mdx")).status).toBe(404);
    expect(s.spawns).toEqual([]);
  });
});
