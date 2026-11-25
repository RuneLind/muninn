/**
 * `GET /api/wiki/mentions` (Discuss v2 PR 2) on a real temp git repo: files
 * with page titles, commits, `log.md` entries with their date and kind, PR refs
 * resolved through the wiki's `prGrammar`, key kinds from `trackers` and
 * `keys`, and the background `gh` refresh (one flight, never on a read-only
 * root, never with the check off). The nais half is in `routes-profile.test.ts`.
 * Invented content only.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { realGit } from "../../wiki/decision-triage/git.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { __mentionPrsSettledForTest, __resetGhCheckForTest, type GhResult } from "../../wiki/work-map/gh-check.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { registerWikiMentionsRoute, type WikiMentionsRouteDeps } from "./wiki-mentions.ts";
import type { MentionsBody } from "../../wiki/mentions.ts";

const WIKI = "mentions-fixture";
let root = "";

async function git(...args: string[]) {
  const res = await realGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
  if (!res.ok) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

async function put(rel: string, text: string) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

const READER_CONFIG = {
  prGrammar: { owner: "acme", aliases: { api: "acme-api" } },
  trackers: [{ id: "jira", projects: ["ABC"] }],
  keys: [{ name: "case", pattern: "CASE-\\d+" }, { name: "broken", pattern: "(" }],
};

beforeAll(async () => {
  root = path.join(await realpath(await testTempDir(path.join(tmpdir(), "muninn-mentions-"))), "wiki");
  await mkdir(root, { recursive: true });
  await git("init", "-q", "-b", "main");
  await put(".wiki-reader.json", JSON.stringify(READER_CONFIG));
  await put("log.md", "# Log\n\nIntro naming CASE-7 before any entry.\n\n## [2026-11-01] decide | CASE-7 goes first\nbody line\n\n## [2026-11-03] build | other work\nThe fix for CASE-7 is api #12.\n");
  await put("plans/alpha.md", "---\ntitle: Alpha plan\n---\n# Alpha plan\n\nCASE-7 is the one case. See acme/acme-web#40 and ABC-12.\n");
  await put("plans/beta.md", "# Beta\n\nNothing here.\n");
  await put("plans/q/Q-1.csv", "id,case\n1,CASE-7\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "first: CASE-7 in alpha, log and csv");
  await put("plans/beta.md", "# Beta\n\nNow CASE-7 too.\n");
  await git("commit", "-q", "-am", "second: CASE-7 into beta");
});

afterEach(() => __resetGhCheckForTest());

function appWith(over: Partial<WikiMentionsRouteDeps> = {}, opts: { disabled?: boolean; gate?: Promise<void> } = {}) {
  const calls: string[][] = [];
  const runGh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    await opts.gate;
    return { exitCode: 0, stdout: JSON.stringify({ data: { repository: { p12: { state: "MERGED", mergedAt: "2026-11-04T10:00:00Z" }, p40: { state: "OPEN", mergedAt: null } } } }), stderr: "" };
  };
  const app = new Hono();
  registerWikiMentionsRoute(app, {
    registry: () => [{ name: WIKI, root } as never],
    index: (r) => getWikiIndex({ root: r }),
    gh: () => ({ runGh, disabled: () => opts.disabled === true }),
    isReadonlyRoot: () => false,
    now: Date.now,
    authMode: () => "off",
    ...over,
  });
  return { app, calls };
}

const get = (app: Hono, q: string) => app.request(`/api/wiki/mentions?${q}`);

describe("GET /api/wiki/mentions", () => {
  test("files with page titles, commits, log entries and PR refs for a key", async () => {
    const { app, calls } = appWith();
    const res = await get(app, `wiki=${WIKI}&key=CASE-7`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MentionsBody;
    expect(body.key).toBe("CASE-7");
    expect(body.kind).toBe("case");
    expect(body.truncated).toBe(false);
    const files = Object.fromEntries(body.files.map((f) => [f.relPath, f]));
    expect(Object.keys(files).sort()).toEqual(["log.md", "plans/alpha.md", "plans/beta.md", "plans/q/Q-1.csv"]);
    expect(files["plans/alpha.md"]!.title).toBe("Alpha plan");
    expect(files["plans/alpha.md"]!.lines).toEqual([{ n: 6, text: "CASE-7 is the one case. See acme/acme-web#40 and ABC-12." }]);
    expect(files["plans/q/Q-1.csv"]!.title).toBeNull();
    expect(body.commits.map((c) => c.subject)).toEqual(["second: CASE-7 into beta", "first: CASE-7 in alpha, log and csv"]);
    expect(body.commits[0]!.files).toEqual(["plans/beta.md"]);
    expect(body.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.log).toEqual([
      { date: null, kind: null, line: "Intro naming CASE-7 before any entry.", n: 3 },
      { date: "2026-11-01", kind: "decide", line: "## [2026-11-01] decide | CASE-7 goes first", n: 5 },
      { date: "2026-11-03", kind: "build", line: "The fix for CASE-7 is api #12.", n: 9 },
    ]);
    // `api #12` through the alias, `acme/acme-web#40` qualified; a cold cache answers unknown and stale.
    expect(body.prs).toEqual([
      { repo: "acme/acme-api", number: 12, state: "unknown", mergedAt: null, url: "https://github.com/acme/acme-api/pull/12", stale: true },
      { repo: "acme/acme-web", number: 40, state: "unknown", mergedAt: null, url: "https://github.com/acme/acme-web/pull/40", stale: true },
    ]);
    await __mentionPrsSettledForTest(WIKI);
    expect(calls.length).toBe(2); // one query per repo, in one flight
    const warm = (await (await get(app, `wiki=${WIKI}&key=CASE-7`)).json()) as MentionsBody;
    expect(warm.prs.map((p) => [p.number, p.state, p.stale, p.mergedAt])).toEqual([
      [12, "merged", false, "2026-11-04T10:00:00Z"],
      [40, "open", false, null],
    ]);
    await __mentionPrsSettledForTest(WIKI);
    expect(calls.length).toBe(2); // a warm cache asks nothing
  });

  test("one background flight at a time: misses while it runs start none", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, calls } = appWith({}, { gate });
    for (let i = 0; i < 3; i++) expect((await get(app, `wiki=${WIKI}&key=CASE-7`)).status).toBe(200);
    expect(calls.length).toBe(2); // the first request's flight, one query per repo, still held at the gate
    release();
    await __mentionPrsSettledForTest(WIKI);
    expect(calls.length).toBe(2);
  });

  test("a repo whose last query failed is not asked again within the hour", async () => {
    let n = 0;
    const app = new Hono();
    registerWikiMentionsRoute(app, {
      registry: () => [{ name: WIKI, root } as never],
      index: (r) => getWikiIndex({ root: r }),
      gh: () => ({ runGh: async () => (n++, { exitCode: -1, stdout: "", stderr: "spawn gh ENOENT", noBinary: true }), disabled: () => false }),
      isReadonlyRoot: () => false,
      now: Date.now,
      authMode: () => "off",
    });
    await get(app, `wiki=${WIKI}&key=CASE-7`);
    await __mentionPrsSettledForTest(WIKI);
    expect(n).toBe(2);
    const body = (await (await get(app, `wiki=${WIKI}&key=CASE-7`)).json()) as MentionsBody;
    await __mentionPrsSettledForTest(WIKI);
    expect(n).toBe(2);
    expect(body.prs.every((p) => p.state === "unknown" && p.stale)).toBe(true);
  });

  test("a read-only root and a disabled check start no gh", async () => {
    for (const [over, opts] of [[{ isReadonlyRoot: () => true }, {}], [{}, { disabled: true }]] as const) {
      const { app, calls } = appWith(over, opts);
      const body = (await (await get(app, `wiki=${WIKI}&key=CASE-7`)).json()) as MentionsBody;
      expect(body.prs.every((p) => p.state === "unknown" && p.stale)).toBe(true);
      await __mentionPrsSettledForTest(WIKI);
      expect(calls.length).toBe(0);
    }
  });

  test("kind: a tracker project's key is the tracker's, a keys pattern names its own, else null", async () => {
    const { app } = appWith();
    const kind = async (key: string) => ((await (await get(app, `wiki=${WIKI}&key=${key}`)).json()) as MentionsBody).kind;
    expect(await kind("ABC-12")).toBe("jira");
    expect(await kind("CASE-7")).toBe("case");
    expect(await kind("XYZ-12")).toBeNull();
    // A keys pattern matches the whole key, not a part of it.
    expect(await kind("OLDCASE-7")).toBeNull();
  });

  test("a key with no hits is an empty answer, not an error", async () => {
    const { app } = appWith();
    const res = await get(app, `wiki=${WIKI}&key=CASE-999`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MentionsBody;
    expect([body.files, body.commits, body.log, body.prs]).toEqual([[], [], [], []]);
  });

  test("the key is searched as a fixed string, never a pattern", async () => {
    const { app } = appWith();
    const body = (await (await get(app, `wiki=${WIKI}&key=${encodeURIComponent("CASE-.")}`)).json()) as MentionsBody;
    expect(body.files).toEqual([]);
  });

  test("refusals: no wiki, a bad key, an unknown wiki", async () => {
    const { app } = appWith();
    expect((await get(app, "key=CASE-7")).status).toBe(400);
    expect((await get(app, `wiki=${WIKI}`)).status).toBe(400);
    expect((await get(app, `wiki=${WIKI}&key=ab`)).status).toBe(400);
    expect((await get(app, `wiki=${WIKI}&key=${"x".repeat(81)}`)).status).toBe(400);
    expect((await get(app, `wiki=${WIKI}&key=${"x".repeat(80)}`)).status).toBe(200);
    expect((await get(app, `wiki=${WIKI}&key=CASE%0A7`)).status).toBe(400);
    expect((await get(app, `wiki=nope&key=CASE-7`)).status).toBe(404);
  });

  test("404 on an authenticating instance, before anything is read", async () => {
    let indexed = 0;
    const { app, calls } = appWith({ authMode: () => "entra", index: async () => (indexed++, null) });
    const res = await get(app, `wiki=${WIKI}&key=CASE-7`);
    expect(res.status).toBe(404);
    expect([indexed, calls.length]).toEqual([0, 0]);
    expect((await get(appWith({ authMode: () => "local" }).app, `wiki=${WIKI}&key=CASE-7`)).status).toBe(404);
  });

  test("the real deps read MUNINN_AUTH through the auth policy", async () => {
    const { __setAuthPolicyForTest } = await import("../../auth/policy.ts");
    const { realWikiMentionsDeps } = await import("./wiki-mentions.ts");
    try {
      __setAuthPolicyForTest({ mode: "entra" } as never);
      expect(realWikiMentionsDeps().authMode()).toBe("entra");
    } finally {
      __setAuthPolicyForTest(null);
    }
    expect(realWikiMentionsDeps().authMode()).toBe("off");
  });
});
