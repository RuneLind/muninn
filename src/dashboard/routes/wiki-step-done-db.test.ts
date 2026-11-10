/**
 * `GET`/`POST /api/wiki/step-done` against the REAL test database (the
 * Gardener-held check reads it) and a temp git wiki: the list, the preview, the
 * write with its log.md line and commit, a second Done on the returned base
 * hash, and every refusal (stale base, stale preview, read-only, scope, JSON,
 * dirty page, failed commit).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import type { Config } from "../../config.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { commitWikiChange, type CommitWikiResult } from "../../wiki/commit.ts";
import { registerWikiStepDoneRoutes, type StepDoneDeps } from "./wiki-step-done.ts";
import type { DecisionCloseGuards } from "./wiki-decision-inbox.ts";

setupTestDb();

const WIKI = "step-done-wiki";
const OUTSIDE = "step-done-outside";
const LOCKED = "step-done-locked";
const REL = "plans/step-done.mdx";
const PAGE = [
  "---\ntitle: Step fixture\n---\n",
  "<NextMoves>\n",
  '<Lane kind="you">\n',
  "1. **Restart the server:** so the bundle is fresh.",
  "2. Read the second note.",
  "3. Read the third note.",
  "\n</Lane>\n",
  '<Lane kind="waiting" who="Someone">\n',
  "- Waiting on O1.",
  "\n</Lane>\n",
  "</NextMoves>\n",
].join("\n");

let root = "";
let app: Hono;
let guardRefusal: Response | null = null;
let commitResult: CommitWikiResult | null = null;
const NOW = Date.parse("2026-11-10T12:00:00+01:00");

const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });

async function resetPage(): Promise<void> {
  await Bun.write(path.join(root, REL), PAGE);
  git("add", "-A");
  try {
    git("commit", "-q", "-m", "fixture");
  } catch {
    /* nothing changed */
  }
  __resetWikiCacheForTest();
}

const post = (body: Record<string, unknown>) =>
  app.request("/api/wiki/step-done", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: WIKI, relPath: REL, ...body }) });

interface Listed {
  baseHash: string;
  steps: { key: string; text: string; lane: number; row: number | null; refusal: string | null }[];
}
async function list(wiki = WIKI): Promise<{ status: number; body: Listed }> {
  const res = await app.request(`/api/wiki/step-done?wiki=${wiki}&relPath=${encodeURIComponent(REL)}`);
  return { status: res.status, body: (await res.json()) as Listed };
}
const keyOf = (l: Listed, text: string) => l.steps.find((s) => s.text === text)!.key;

async function previewOf(text: string, baseHash?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { body: l } = await list();
  const res = await post({ step: keyOf(l, text), baseHash: baseHash ?? l.baseHash, preview: true });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const pageText = () => Bun.file(path.join(root, REL)).text();

beforeAll(async () => {
  root = await testTempDir(path.join(tmpdir(), "muninn-step-done-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.invalid");
  await resetPage();
  const registry = [
    { name: WIKI, root, source: "extra" as const },
    { name: OUTSIDE, root, source: "extra" as const },
    { name: LOCKED, root: `${root}-locked`, source: "extra" as const },
  ];
  __setWikiRegistryForTest(registry);
  const config = { dashboardPort: 3010, profile: "default", knowledgeApiUrl: "http://127.0.0.1:9" } as unknown as Config;
  const guards: DecisionCloseGuards = { readonlyRefusal: () => guardRefusal, egressRefusal: () => null };
  const deps = (): StepDoneDeps => ({
    registry: () => registry,
    workMapWikis: () => [WIKI, LOCKED],
    answerConfig: () => ({ wikis: new Set([WIKI, OUTSIDE, LOCKED]), owner: null, groups: new Map() }),
    now: () => NOW,
    isReadonlyRoot: (r) => r === `${root}-locked`,
    commit: async (r, paths, message) => commitResult ?? (await commitWikiChange(r, paths, message, { push: false })),
  });
  app = new Hono();
  registerWikiStepDoneRoutes(app, config, guards, deps);
});

beforeEach(async () => {
  guardRefusal = null;
  commitResult = null;
  git("reset", "-q", "--hard");
  await resetPage();
});

afterAll(() => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
});

describe("/api/wiki/step-done", () => {
  test("the list names each open you step, and the preview writes nothing", async () => {
    const { status, body: l } = await list();
    expect(status).toBe(200);
    expect(l.steps.map((s) => [s.text, s.lane, s.row])).toEqual([
      ["**Restart the server:** so the bundle is fresh.", 0, 0],
      ["Read the second note.", 0, 1],
      ["Read the third note.", 0, 2],
    ]);
    const { status: ps, body: p } = await previewOf("**Restart the server:** so the bundle is fresh.");
    expect(ps).toBe(200);
    expect(p.removed).toEqual([{ line: 9, text: "1. **Restart the server:** so the bundle is fresh." }]);
    expect(p.renumbered).toEqual({ line: 10, before: "2. Read the second note.", after: "1. Read the second note." });
    expect(p.logEntry).toBe("## [2026-11-10] step-done | Step fixture\n- Step done: Restart the server — so the bundle is fresh.");
    expect(String(p.logNote)).toContain("if appending it fails");
    expect(await pageText()).toBe(PAGE);
  });

  test("a write removes the step, logs, commits, and its new base hash serves a second Done", async () => {
    const { body: p } = await previewOf("Read the second note.");
    const { body: l } = await list();
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: p.baseHash, previewHash: p.previewHash });
    expect(res.status).toBe(200);
    const w = (await res.json()) as Record<string, unknown>;
    expect(w).toMatchObject({ ok: true, committed: true });
    const after = await pageText();
    expect(after).not.toContain("Read the second note.");
    expect(w.baseHash).toBe(new Bun.CryptoHasher("sha256").update(after).digest("hex"));
    expect(await Bun.file(path.join(root, "log.md")).text()).toContain("- Step done: Read the second note.");
    expect(git("log", "-1", "--format=%s")).toBe(`[step-done] Read the second note.: ${REL}\n`);
    expect(git("status", "--porcelain")).toBe("");

    // The second Done on the same page, from the returned hash alone.
    const { body: l2 } = await list();
    const third = keyOf(l2, "Read the third note.");
    const p2 = (await (await post({ step: third, baseHash: w.baseHash, preview: true })).json()) as Record<string, unknown>;
    const res2 = await post({ step: third, baseHash: w.baseHash, previewHash: p2.previewHash });
    expect(res2.status).toBe(200);
    expect(await pageText()).not.toContain("Read the third note.");
  });

  test("the last step takes its lane with it", async () => {
    for (const t of ["Read the third note.", "Read the second note.", "**Restart the server:** so the bundle is fresh."]) {
      const { body: l } = await list();
      const key = keyOf(l, t);
      const p = (await (await post({ step: key, baseHash: l.baseHash, preview: true })).json()) as Record<string, unknown>;
      expect((await post({ step: key, baseHash: l.baseHash, previewHash: p.previewHash })).status).toBe(200);
      if (t.startsWith("**")) expect(p.laneRemoved).toBe(true);
    }
    const after = await pageText();
    expect(after).not.toContain('<Lane kind="you">');
    expect(after).toContain('<Lane kind="waiting" who="Someone">');
  });

  test("a stale base hash is refused and the page stays as it was", async () => {
    const { body: l } = await list();
    const key = keyOf(l, "Read the second note.");
    const p = (await (await post({ step: key, baseHash: l.baseHash, preview: true })).json()) as Record<string, unknown>;
    const edited = PAGE.replace("Waiting on O1.", "Waiting on O1, edited.");
    await Bun.write(path.join(root, REL), edited);
    git("commit", "-q", "-am", "edit");
    const res = await post({ step: key, baseHash: l.baseHash, previewHash: p.previewHash });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ stale: true });
    expect(await pageText()).toBe(edited);
    // A preview on the old hash is refused too.
    expect((await post({ step: key, baseHash: l.baseHash, preview: true })).status).toBe(409);
  });

  test("a preview hash that no longer fits is refused", async () => {
    const { body: l } = await list();
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: l.baseHash, previewHash: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ changed: true });
    expect(await pageText()).toBe(PAGE);
  });

  test("a read-only wiki is refused: the instance guard and a read-only root", async () => {
    const { body: l } = await list();
    guardRefusal = new Response(JSON.stringify({ error: "readonly", readonly: true }), { status: 403 });
    expect((await post({ step: keyOf(l, "Read the second note."), baseHash: l.baseHash, preview: true })).status).toBe(403);
    guardRefusal = null;
    const locked = await post({ wiki: LOCKED, step: keyOf(l, "Read the second note."), baseHash: l.baseHash, preview: true });
    expect(locked.status).toBe(403);
    expect(await locked.json()).toMatchObject({ readonly: true });
    expect((await list(LOCKED)).status).toBe(403);
  });

  test("a wiki outside the scope is 404, a non-JSON request 415, a missing hash 400", async () => {
    const { body: l } = await list();
    const key = keyOf(l, "Read the second note.");
    expect((await post({ wiki: OUTSIDE, step: key, baseHash: l.baseHash, preview: true })).status).toBe(404);
    expect((await list(OUTSIDE)).status).toBe(404);
    const form = await app.request("/api/wiki/step-done", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(form.status).toBe(415);
    expect((await post({ step: key, baseHash: l.baseHash })).status).toBe(400);
  });

  test("a page with uncommitted edits is refused as a session editing it", async () => {
    const dirty = `${PAGE}\nA hand edit.\n`;
    await Bun.write(path.join(root, REL), dirty);
    __resetWikiCacheForTest();
    const { body: p } = await previewOf("Read the second note.");
    const { body: l } = await list();
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: p.baseHash, previewHash: p.previewHash });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dirty).toBe(true);
    expect(String(body.error)).toContain("A session is editing");
    expect(await pageText()).toBe(dirty);
  });

  test("a failed commit says the page is left uncommitted", async () => {
    commitResult = { committed: false, reason: "error" };
    const { body: p } = await previewOf("Read the second note.");
    const { body: l } = await list();
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: p.baseHash, previewHash: p.previewHash });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, committed: false, uncommitted: true });
  });

  test("a step with a nested list is refused, not written", async () => {
    await Bun.write(path.join(root, REL), PAGE.replace("2. Read the second note.", "2. Read the second note.\n   - a child"));
    git("commit", "-q", "-am", "nested");
    __resetWikiCacheForTest();
    const { body: l } = await list();
    expect(l.steps.find((s) => s.text === "Read the second note.")!.refusal).toContain("nested list");
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: l.baseHash, preview: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ refused: true, code: "nested" });
  });
});
