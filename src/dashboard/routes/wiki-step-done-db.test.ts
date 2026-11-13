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
import { __setStaleProposalStoreForTest, dbStaleProposalStore } from "../../gardener/stale-proposals.ts";
import type { LivePageHolder } from "../../db/wiki-proposals.ts";
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
    // Off the runner's global and system config, as `src/test/hermetic-git.ts` runs git.
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
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
  __setStaleProposalStoreForTest(null);
  git("reset", "-q", "--hard");
  await resetPage();
});

afterAll(() => {
  __setStaleProposalStoreForTest(null);
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
    expect(p.renumbered).toEqual([
      { line: 10, before: "2. Read the second note.", after: "1. Read the second note." },
      { line: 11, before: "3. Read the third note.", after: "2. Read the third note." },
    ]);
    expect(p.logEntry).toBe("## [2026-11-10] step-done | Step fixture\n- Step done: Restart the server: so the bundle is fresh.");
    expect(String(p.logNote)).toContain("if appending it fails");
    expect(await pageText()).toBe(PAGE);
  });

  test("a write removes the step, logs and commits; a second Done starts from a new list", async () => {
    const { body: p } = await previewOf("Read the second note.");
    const { body: l } = await list();
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: p.baseHash, previewHash: p.previewHash });
    expect(res.status).toBe(200);
    const w = (await res.json()) as Record<string, unknown>;
    expect(w).toMatchObject({ ok: true, committed: true });
    const after = await pageText();
    expect(after).not.toContain("Read the second note.");
    expect("baseHash" in w).toBe(false);
    expect(await Bun.file(path.join(root, "log.md")).text()).toContain("- Step done: Read the second note.");
    expect(git("log", "-1", "--format=%s")).toBe(`[step-done] Read the second note.: ${REL}\n`);
    expect(git("status", "--porcelain")).toBe("");

    // The second Done on the same page: the list of the page as it now is.
    const { body: l2 } = await list();
    expect(l2.baseHash).toBe(new Bun.CryptoHasher("sha256").update(after).digest("hex"));
    const third = keyOf(l2, "Read the third note.");
    const p2 = (await (await post({ step: third, baseHash: l2.baseHash, preview: true })).json()) as Record<string, unknown>;
    const res2 = await post({ step: third, baseHash: l2.baseHash, previewHash: p2.previewHash });
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

  test("a misplaced <Check> on the step reaches neither the log line nor the commit subject", async () => {
    const step = 'Read the <Check env="X" /> second note.';
    await Bun.write(path.join(root, REL), PAGE.replace("Read the second note.", step));
    git("commit", "-q", "-am", "tag");
    __resetWikiCacheForTest();
    const { body: l } = await list();
    const key = keyOf(l, step);
    const p = (await (await post({ step: key, baseHash: l.baseHash, preview: true })).json()) as Record<string, unknown>;
    expect(p.logEntry).toBe("## [2026-11-10] step-done | Step fixture\n- Step done: Read the  second note.");
    expect((await post({ step: key, baseHash: l.baseHash, previewHash: p.previewHash })).status).toBe(200);
    expect(git("log", "-1", "--format=%s")).toBe(`[step-done] Read the  second note.: ${REL}\n`);
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

  test("outside the scope the write is 404 and the list has no steps; a non-JSON request 415, a missing hash 400", async () => {
    const { body: l } = await list();
    const key = keyOf(l, "Read the second note.");
    expect((await post({ wiki: OUTSIDE, step: key, baseHash: l.baseHash, preview: true })).status).toBe(404);
    // The list is asked on every page view, so there it is an answer with no steps and no base hash.
    const outside = await app.request(`/api/wiki/step-done?wiki=${OUTSIDE}&relPath=${encodeURIComponent(REL)}`);
    expect(outside.status).toBe(200);
    expect(await outside.json()).toEqual({ relPath: REL, offered: false, reason: `${OUTSIDE}: not in WORK_MAP_WIKIS`, steps: [], laneRows: [], readable: false });
    // So is a wiki with no name: a bare /wiki on an unregistered WIKI_DIR sends an empty one.
    for (const q of [`wiki=&relPath=${encodeURIComponent(REL)}`, `relPath=${encodeURIComponent(REL)}`]) {
      const unnamed = await app.request(`/api/wiki/step-done?${q}`);
      expect([unnamed.status, await unnamed.json()]).toEqual([200, { relPath: REL, offered: false, reason: "the wiki has no registry name", steps: [], laneRows: [], readable: false }]);
    }
    const noPage = await app.request(`/api/wiki/step-done?wiki=${OUTSIDE}`);
    expect([noPage.status, await noPage.json()]).toEqual([400, { error: "relPath is required" }]);
    const unknown = await app.request(`/api/wiki/step-done?wiki=no-such-wiki&relPath=${encodeURIComponent(REL)}`);
    expect([unknown.status, ((await unknown.json()) as { offered: boolean; steps: unknown[] }).offered]).toEqual([200, false]);
    // A read-only root still refuses the list: the reader does not ask there.
    expect((await list(LOCKED)).status).toBe(403);
    const form = await app.request("/api/wiki/step-done", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(form.status).toBe(415);
    expect((await post({ step: key, baseHash: l.baseHash })).status).toBe(400);
  });

  test("a page with uncommitted edits is refused, naming both causes", async () => {
    const dirty = `${PAGE}\nA hand edit.\n`;
    await Bun.write(path.join(root, REL), dirty);
    __resetWikiCacheForTest();
    const { body: p } = await previewOf("Read the second note.");
    const { body: l } = await list();
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: p.baseHash, previewHash: p.previewHash });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dirty).toBe(true);
    expect(body.error).toBe(`${REL} has changes that are not committed yet: a session is editing it, or an earlier Done could not be committed. Commit or discard them, then try again.`);
    expect(await pageText()).toBe(dirty);
  });

  test("after a failed commit, the next Done's refusal does not blame a session (fix round 2, finding 2)", async () => {
    commitResult = { committed: false, reason: "error" };
    const { body: p } = await previewOf("Read the second note.");
    const { body: l } = await list();
    const w = (await (await post({ step: keyOf(l, "Read the second note."), baseHash: p.baseHash, previewHash: p.previewHash })).json()) as Record<string, unknown>;
    expect(w).toMatchObject({ ok: true, uncommitted: true });
    const { body: p2 } = await previewOf("Read the third note.");
    const { body: l2 } = await list();
    const res = await post({ step: keyOf(l2, "Read the third note."), baseHash: p2.baseHash, previewHash: p2.previewHash });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dirty).toBe(true);
    expect(String(body.error)).toContain("an earlier Done could not be committed");
    expect(String(body.error)).not.toMatch(/^A session is editing/);
  });

  test("a failed commit says the page is left uncommitted", async () => {
    commitResult = { committed: false, reason: "error" };
    const { body: p } = await previewOf("Read the second note.");
    const { body: l } = await list();
    const res = await post({ step: keyOf(l, "Read the second note."), baseHash: p.baseHash, previewHash: p.previewHash });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, committed: false, uncommitted: true });
  });

  test("a key read before a Done names no step on the page that Done left", async () => {
    const nine = PAGE.replace(
      "1. **Restart the server:** so the bundle is fresh.\n2. Read the second note.\n3. Read the third note.",
      Array.from({ length: 9 }, (_, k) => `${k % 2 ? "Twin step." : `Nine-step ${k + 1}.`}`).map((t, k) => `${k + 1}. ${t}`).join("\n"),
    );
    await Bun.write(path.join(root, REL), nine);
    git("commit", "-q", "-am", "nine");
    __resetWikiCacheForTest();
    const { body: l } = await list();
    const k1 = keyOf(l, "Nine-step 1.");
    const p1 = (await (await post({ step: k1, baseHash: l.baseHash, preview: true })).json()) as Record<string, unknown>;
    const w1 = (await (await post({ step: k1, baseHash: l.baseHash, previewHash: p1.previewHash })).json()) as Record<string, unknown>;
    expect(w1).toMatchObject({ ok: true, committed: true });
    const left = await pageText();
    const { body: l2 } = await list();
    // Every old key, twins among them, with the hash of the page as it now is: refused, nothing written.
    for (const old of l.steps) {
      const r = await post({ step: old.key, baseHash: l2.baseHash, preview: true });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ refused: true, code: "no-step" });
    }
    expect(await pageText()).toBe(left);
    expect(l2.steps.map((x) => x.text)).toEqual(l.steps.slice(1).map((x) => x.text));
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

  describe("the list form: steps", () => {
    const ALL = ["**Restart the server:** so the bundle is fresh.", "Read the second note.", "Read the third note."];
    const logEntries = async () => {
      const log = await Bun.file(path.join(root, "log.md")).text().catch(() => "");
      return log.split("\n").filter((l) => l.startsWith("## ["));
    };
    async function previewMany(texts: string[]) {
      const { body: l } = await list();
      const steps = texts.map((t) => keyOf(l, t));
      const res = await post({ steps, baseHash: l.baseHash, preview: true });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, steps, baseHash: l.baseHash };
    }

    test("step and steps together, or neither, is a 400; so is a malformed list", async () => {
      const { body: l } = await list();
      const key = keyOf(l, "Read the second note.");
      for (const body of [
        { step: key, steps: [key] },
        { step: "", steps: [key] },
        {},
        { steps: [] },
        { steps: key },
        { steps: [key, 3] },
        { steps: [key, " "] },
        { steps: [key, key] },
        { steps: Array.from({ length: 201 }, (_, i) => `${key}${i}`) },
      ]) {
        const res = await post({ ...body, baseHash: l.baseHash, preview: true });
        expect([JSON.stringify(Object.keys(body)), res.status]).toEqual([JSON.stringify(Object.keys(body)), 400]);
      }
      expect(await pageText()).toBe(PAGE);
    });

    test("a preview lists every removal and renumbering and writes nothing; the write is one log entry and one commit", async () => {
      const commitsBefore = Number(git("rev-list", "--count", "HEAD").trim());
      const entriesBefore = (await logEntries()).length;
      const p = await previewMany([ALL[2]!, ALL[0]!]);
      expect(p.status).toBe(200);
      expect(p.body.removed).toEqual([
        { line: 9, text: "1. **Restart the server:** so the bundle is fresh." },
        { line: 11, text: "3. Read the third note." },
      ]);
      expect(p.body.renumbered).toEqual([{ line: 10, before: "2. Read the second note.", after: "1. Read the second note." }]);
      expect((p.body.steps as { text: string }[]).map((s) => s.text)).toEqual([ALL[0]!, ALL[2]!]);
      expect(p.body).toMatchObject({ laneRemoved: false, nextMovesRemoved: false, lanesRemoved: 0, blocksRemoved: 0 });
      expect(p.body.logEntry).toBe("## [2026-11-10] step-done | Step fixture\n- Steps done (2): Restart the server: so the bundle is fresh; Read the third note.");
      expect(await pageText()).toBe(PAGE);

      const res = await post({ steps: p.steps, baseHash: p.baseHash, previewHash: p.body.previewHash });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, committed: true });
      const after = await pageText();
      expect(after).toBe(PAGE.replace("1. **Restart the server:** so the bundle is fresh.\n2. Read the second note.\n3. Read the third note.", "1. Read the second note."));
      const entries = await logEntries();
      expect(entries.slice(entriesBefore)).toEqual(["## [2026-11-10] step-done | Step fixture"]);
      expect(await Bun.file(path.join(root, "log.md")).text()).toContain("- Steps done (2): Restart the server: so the bundle is fresh; Read the third note.");
      expect(Number(git("rev-list", "--count", "HEAD").trim())).toBe(commitsBefore + 1);
      expect(git("log", "-1", "--format=%s")).toBe(`[step-done] 2 steps: ${REL}\n`);
      expect(git("status", "--porcelain")).toBe("");
    });

    test("a one-key list writes the single form's log entry and commit subject for that step, through its own preview hash", async () => {
      const single = await previewOf(ALL[0]!);
      const p = await previewMany([ALL[0]!]);
      expect(p.status).toBe(200);
      expect(p.body.logEntry).toBe(single.body.logEntry);
      const res = await post({ steps: p.steps, baseHash: p.baseHash, previewHash: p.body.previewHash });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, committed: true });
      const subject = git("log", "-1", "--format=%s");
      const logged = await Bun.file(path.join(root, "log.md")).text();
      // The single form on the same page and step, for comparison.
      git("reset", "-q", "--hard", "HEAD~1");
      await resetPage();
      const { body: l } = await list();
      const s = await previewOf(ALL[0]!);
      expect((await post({ step: keyOf(l, ALL[0]!), baseHash: l.baseHash, previewHash: s.body.previewHash })).status).toBe(200);
      expect(subject).toBe(git("log", "-1", "--format=%s"));
      expect(subject).toBe(`[step-done] Restart the server: so the bundle is fresh.: ${REL}\n`);
      expect(logged).toBe(await Bun.file(path.join(root, "log.md")).text());
    });

    test("every step: the lane goes, the preview says so", async () => {
      const p = await previewMany(ALL);
      expect(p.body).toMatchObject({ laneRemoved: true, lanesRemoved: 1, nextMovesRemoved: false });
      expect((await post({ steps: p.steps, baseHash: p.baseHash, previewHash: p.body.previewHash })).status).toBe(200);
      const after = await pageText();
      expect(after).not.toContain('<Lane kind="you">');
      expect(after).toContain("- Waiting on O1.");
    });

    test("a preview hash of another list, or of the single form, is refused", async () => {
      const two = await previewMany([ALL[0]!, ALL[1]!]);
      const one = await previewOf(ALL[0]!);
      const { body: l } = await list();
      // The single step's preview hash does not let the list write through, nor a two-step hash a three-step list.
      for (const previewHash of [one.body.previewHash, two.body.previewHash]) {
        const res = await post({ steps: ALL.map((t) => keyOf(l, t)), baseHash: l.baseHash, previewHash });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ changed: true });
      }
      expect(await pageText()).toBe(PAGE);
    });

    test("a page changed between preview and write: 409 stale, nothing removed", async () => {
      const p = await previewMany([ALL[1]!, ALL[2]!]);
      const edited = PAGE.replace("Waiting on O1.", "Waiting on O1, edited.");
      await Bun.write(path.join(root, REL), edited);
      git("commit", "-q", "-am", "edit");
      const res = await post({ steps: p.steps, baseHash: p.baseHash, previewHash: p.body.previewHash });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ stale: true });
      expect(await pageText()).toBe(edited);
    });

    test("a key of another hash, or a refused step, refuses the whole list", async () => {
      const { body: l } = await list();
      const good = keyOf(l, ALL[1]!);
      const foreign = `${"0".repeat(16)}.0`;
      const res = await post({ steps: [good, foreign], baseHash: l.baseHash, preview: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ refused: true, code: "no-step", key: foreign });

      await Bun.write(path.join(root, REL), PAGE.replace("2. Read the second note.", "2. Read the second note.\n   - a child"));
      git("commit", "-q", "-am", "nested");
      __resetWikiCacheForTest();
      const { body: l2 } = await list();
      const nested = keyOf(l2, ALL[1]!);
      const mixed = await post({ steps: [keyOf(l2, ALL[2]!), nested], baseHash: l2.baseHash, preview: true });
      expect(mixed.status).toBe(409);
      const body = (await mixed.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ refused: true, code: "nested", key: nested });
      expect(String(body.error)).toContain("«Read the second note.»");
      // A write with a made-up preview hash: the refusal comes first, nothing goes.
      expect((await post({ steps: [keyOf(l2, ALL[2]!), nested], baseHash: l2.baseHash, previewHash: "0".repeat(64) })).status).toBe(409);
      expect(await pageText()).toContain("3. Read the third note.");
    });

    test("a read-only instance and a read-only root refuse the list form", async () => {
      const { body: l } = await list();
      const steps = [keyOf(l, ALL[1]!), keyOf(l, ALL[2]!)];
      guardRefusal = new Response(JSON.stringify({ error: "readonly", readonly: true }), { status: 403 });
      expect((await post({ steps, baseHash: l.baseHash, preview: true })).status).toBe(403);
      guardRefusal = null;
      const locked = await post({ wiki: LOCKED, steps, baseHash: l.baseHash, preview: true });
      expect(locked.status).toBe(403);
      expect((await post({ wiki: OUTSIDE, steps, baseHash: l.baseHash, preview: true })).status).toBe(404);
      expect(await pageText()).toBe(PAGE);
    });

    test("a Gardener card holding the page refuses the list write", async () => {
      const p = await previewMany([ALL[1]!, ALL[2]!]);
      __setStaleProposalStoreForTest({
        ...dbStaleProposalStore,
        liveHolders: async () => [{ id: "00000000-0000-4000-8000-000000000002", groupKey: "g", topicKey: "t", targetPath: REL, kind: "stale-check", status: "draft" }],
      });
      const res = await post({ steps: p.steps, baseHash: p.baseHash, previewHash: p.body.previewHash });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ held: true });
      expect(await pageText()).toBe(PAGE);
    });
  });

  // Fix round 1 batch 5: the two checks between the first read and the write.
  describe("between the first read and the write", () => {
    const holder = (targetPath: string): LivePageHolder => ({ id: "00000000-0000-4000-8000-000000000001", groupKey: "stale:2026-11-10", topicKey: "t", targetPath, kind: "stale-check", status: "draft" });
    const holders = (liveHolders: (wiki: string) => Promise<LivePageHolder[]>) => __setStaleProposalStoreForTest({ ...dbStaleProposalStore, liveHolders });
    async function previewed() {
      const { body: l } = await list();
      const key = keyOf(l, "Read the second note.");
      const p = (await (await post({ step: key, baseHash: l.baseHash, preview: true })).json()) as Record<string, unknown>;
      return { step: key, baseHash: l.baseHash, previewHash: p.previewHash };
    }

    test("a Gardener card holding the page refuses the write and names the card; the preview still answers", async () => {
      const asked: string[] = [];
      holders(async (wiki) => (asked.push(wiki), [holder(REL)]));
      const ready = await previewed();
      expect(asked).toEqual([]);
      const res = await post(ready);
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ held: true });
      expect(body.error).toBe(`${REL} is held by another Gardener card (Stale check, stale:2026-11-10): accept or dismiss it first.`);
      expect(asked).toEqual([WIKI]);
      expect(await pageText()).toBe(PAGE);
      expect(git("status", "--porcelain")).toBe("");
    });

    test("a card holding another page does not refuse it", async () => {
      holders(async () => [holder("plans/another.mdx")]);
      const res = await post(await previewed());
      expect(res.status).toBe(200);
      expect(await pageText()).not.toContain("Read the second note.");
    });

    test("cards that cannot be read: 503, and nothing written", async () => {
      holders(async () => {
        throw new Error("connection refused");
      });
      const res = await post(await previewed());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "The Gardener's cards could not be read, so the page's claim is unknown." });
      expect(await pageText()).toBe(PAGE);
    });

    test("a page that changes after the first read is refused by the write itself, and the other edit stays", async () => {
      // The card read runs after the route compared the base hash and before the
      // write queue: an edit committed there is one only the write's own compare can see.
      const edited = PAGE.replace("Waiting on O1.", "Waiting on O1, edited.");
      holders(async () => {
        await Bun.write(path.join(root, REL), edited);
        git("commit", "-q", "-am", "an edit from elsewhere");
        return [];
      });
      const res = await post(await previewed());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "The page changed while the step was marked done. Reload it and try again.", stale: true });
      expect(await pageText()).toBe(edited);
      expect(git("status", "--porcelain")).toBe("");
    });
  });
});
