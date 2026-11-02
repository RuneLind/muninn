import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { __resetGhCheckForTest, type GhCheckDeps } from "../../wiki/work-map/gh-check.ts";
import { readMapFile } from "../../wiki/work-map/map-file.ts";
import type { WorkMapRunDeps } from "../../wiki/work-map/run.ts";
import { registerWikiWorkMapRoutes } from "./wiki-work-map.ts";

const NOW = 1_800_000_000_000;
const WORK_MAP = {
  version: 1,
  wiki: "w",
  runAtMs: NOW,
  model: "m",
  coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
  summary: "",
  needsYou: [{ title: "Merge it", kind: "followup", why: "", action: "Merge #7", pages: ["plans/a.mdx"] }],
  themes: [],
  efforts: [],
  loose: [],
};

// It asks for #7 like the work map above, so only the kind can keep it from `gh`.
const THEME_MAP = JSON.stringify({
  version: 1,
  kind: "themes",
  wiki: "w",
  runAtMs: NOW,
  model: "m",
  coverage: { activeSources: 1, hubs: 0, driftHubs: 0, placed: 1, digestChars: 1, windowDays: 28, warnings: [] },
  summary: "",
  needsYou: [{ title: "Merge it", kind: "gap", why: "", action: "Merge #7", pages: ["plans/a.mdx"], hubs: [], count: 1 }],
  themes: [],
  efforts: [],
  retired: [],
  loose: [],
});

function setup(over: Partial<WorkMapRunDeps> = {}, mapText: string | null = JSON.stringify(WORK_MAP)) {
  const spawns: string[][] = [];
  const meta = { relPath: "plans/a.mdx", plan_status: "ready", prRefs: ["acme/gears#7"] };
  const ghCheck: GhCheckDeps = {
    index: async () => ({ pages: [meta], resolve: () => undefined, resolveRelPath: () => meta }) as never,
    readBody: async () => "---\ntitle: A\n---\n\n**PR ledger.**\n\n| PR | State |\n|---|---|\n| [#7](https://github.com/acme/gears/pull/7) | open |\n",
    runGh: async (args) => {
      spawns.push(args);
      return { exitCode: 0, stdout: JSON.stringify({ data: { repository: { p7: { state: "MERGED", mergedAt: "2026-10-29T08:00:00Z" } } } }), stderr: "" };
    },
    disabled: () => false,
  };
  const deps = {
    now: () => NOW,
    registry: () => [{ name: "w", root: "/w/w", source: "extra" }],
    isReadonlyRoot: () => false,
    readText: async () => mapText,
    ghCheck,
    config: { workMapWikis: [], workMapModel: "m", schedulerEnabled: true, profile: "default" },
    state: { read: async () => null, record: async () => ({}) },
    ...over,
  } as unknown as WorkMapRunDeps;
  const app = new Hono();
  registerWikiWorkMapRoutes(app, {} as Config, () => deps);
  return { app, spawns };
}
const get = (s: { app: Hono }, q = "wiki=w") => s.app.request(`/api/wiki/work-map/checks?${q}`);

afterEach(() => __resetGhCheckForTest());

describe("GET /api/wiki/work-map/checks", () => {
  test("answers the body for a work map, marks and contradictions included", async () => {
    const s = setup();
    const res = await get(s);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(1);
    expect(body.contradictions).toEqual([{ page: "plans/a.mdx", pr: 7, repo: "acme/gears", rowState: "open", ghState: "MERGED", mergedAt: "2026-10-29T08:00:00Z" }]);
    expect(body.needs).toEqual([{ kind: "followup", title: "Merge it", pr: 7, state: "MERGED", mergedAt: "2026-10-29T08:00:00Z", asksForIt: true }]);
    expect(s.spawns.length).toBe(1);
  });

  test("400 with no wiki, 404 for an unknown one, and neither reaches gh", async () => {
    const s = setup();
    expect((await s.app.request("/api/wiki/work-map/checks")).status).toBe(400);
    expect((await get(s, "wiki=nope")).status).toBe(404);
    expect(s.spawns).toEqual([]);
  });

  test("no map, an unreadable map and a map that fails its kind's parse answer 404 with no spawn", async () => {
    for (const text of [null, "{not json", JSON.stringify({ ...WORK_MAP, kind: "themes" })]) {
      const s = setup({}, text);
      expect((await get(s)).status).toBe(404);
      expect(s.spawns).toEqual([]);
    }
  });

  test("a valid themes map answers 404 with no spawn", async () => {
    expect(readMapFile(THEME_MAP)?.kind).toBe("themes");
    const s = setup({}, THEME_MAP);
    expect((await get(s)).status).toBe(404);
    expect(s.spawns).toEqual([]);
  });

  test("a read-only root, and an instance with no seam, answer disabled with no spawn", async () => {
    const readonly = setup({ isReadonlyRoot: () => true });
    expect((await (await get(readonly)).json()).notChecked).toEqual({ reason: "disabled", repos: [] });
    expect(readonly.spawns).toEqual([]);
    const noSeam = setup({ ghCheck: undefined });
    expect((await (await get(noSeam)).json()).notChecked).toEqual({ reason: "disabled", repos: [] });
  });

  test("the map GET never calls the check", async () => {
    const s = setup();
    await s.app.request("/api/wiki/work-map?wiki=w");
    expect(s.spawns).toEqual([]);
  });

  test("a throw in the check is a 500, not a rejected handler", async () => {
    const broken = setup({
      ghCheck: {
        index: async () => {
          throw new Error("boom");
        },
        readBody: async () => null,
        runGh: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        disabled: () => false,
      },
    });
    expect((await get(broken)).status).toBe(500);
  });
});
