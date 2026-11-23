/**
 * `GET /api/wiki/proposals` against the REAL test database and a temp wiki:
 * an update row whose page changed since drafting carries `drifted`, so the gate
 * says so before the reviewer clicks Approve (architecture review 2026-10,
 * finding 63), and a page that already IS its draft is not flagged. Also the
 * single-row approve over a real git wiki: a commit that did not land is
 * reported in Done's shape. Its own `bun test` link in the `test` and `test:db` chains.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import { approveWikiProposal, getWikiProposalById, insertWikiProposal } from "../../db/wiki-proposals.ts";
import { getDb } from "../../db/client.ts";
import { runGit } from "../../wiki/commit.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest } from "../../wiki/readonly.ts";
import { sha256 } from "../../gardener/util.ts";
import { DEFAULT_BACKLOG_ROUTE_DEPS, registerWikiGardenerRoutes } from "./wiki-gardener-routes.ts";
import { testTempDir } from "../../test/temp-dir.ts";

setupTestDb();

const WIKI = "driftwiki";
const SAME = "concepts/same.md";
const EDITED = "concepts/edited.md";
const APPLIED = "concepts/applied.md";
const RAW = "concepts/raw.md";
const page = (title: string) => `---\ntitle: ${title}\n---\n\nBody.\n`;

let root: string;

beforeAll(async () => {
  root = await testTempDir(path.join(tmpdir(), "wiki-drift-"));
  __setReadonlyWikiRootsForTest();
  __setWikiRegistryForTest([{ name: WIKI, root, source: "extra", collections: ["driftwiki"] }]);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/wiki/proposals — base-hash drift", () => {
  test("flags only the update row whose page changed since drafting", async () => {
    // Seeded here, not in beforeAll: `setupTestDb` truncates before every test.
    await Bun.write(path.join(root, SAME), page("Same"));
    await Bun.write(path.join(root, EDITED), page("Edited"));
    await Bun.write(path.join(root, APPLIED), page("Applied"));
    await Bun.write(path.join(root, RAW), page("Raw"));
    __resetWikiCacheForTest();
    for (const [topic, rel] of [["same", SAME], ["edited", EDITED], ["applied", APPLIED], ["raw", RAW]] as const) {
      const current = await Bun.file(path.join(root, rel)).text();
      await insertWikiProposal({
        botName: "jarvis",
        wikiName: WIKI,
        topicKey: topic,
        kind: "concept",
        mode: "update",
        targetPath: rel,
        baseHash: sha256(current),
        draft: current.replace("Body.", rel === RAW ? "Body, see [[Gone Page]]." : "Body, revised."),
        sourceDocs: [],
      });
    }
    // A hand edit lands after the draft was written.
    await Bun.write(path.join(root, EDITED), page("Edited") + "\nA reviewer's own paragraph.\n");
    // A page that already carries its draft (a hand-apply, or a crash after the
    // write): the apply passes it as a no-op, so the gate must not call it drift.
    await Bun.write(path.join(root, APPLIED), page("Applied").replace("Body.", "Body, revised."));
    // A page that carries the RAW draft, whose body link has no target: the
    // apply contains the link, so the page is not its draft and Approve goes
    // stale — the listing must say so (fix round 2 batch 2).
    await Bun.write(path.join(root, RAW), page("Raw").replace("Body.", "Body, see [[Gone Page]]."));

    const app = new Hono();
    registerWikiGardenerRoutes(app, {} as Parameters<typeof registerWikiGardenerRoutes>[1]);
    const res = await app.request(`/api/wiki/proposals?wiki=${WIKI}`);
    expect(res.status).toBe(200);
    const { proposals } = (await res.json()) as {
      proposals: { targetPath: string; drifted?: string | null; diff: unknown[] | null }[];
    };
    expect(proposals).toHaveLength(4);
    const byPath = new Map(proposals.map((p) => [p.targetPath, p]));
    expect(byPath.get(SAME)?.drifted).toBeNull();
    expect(byPath.get(EDITED)?.drifted).toBe("target file changed since drafting");
    expect(byPath.get(APPLIED)?.drifted).toBeNull();
    expect(byPath.get(RAW)?.drifted).toBe("target file changed since drafting");
    // The diff is still shown, against the page as it is now.
    expect(byPath.get(EDITED)?.diff?.length).toBeGreaterThan(0);
  });
});

describe("POST /api/wiki/proposals/:id/approve — a commit that did not land", () => {
  const GIT_WIKI = "commitwiki";
  const TARGET = "concepts/Commit Probe.md";
  let gitRoot: string;

  const git = async (...args: string[]) => {
    const r = await runGit(gitRoot, args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };

  beforeEach(async () => {
    gitRoot = await testTempDir(path.join(tmpdir(), "wiki-approve-commit-"));
    await git("init", "-q", "-b", "main");
    // Local config only: the commit seam runs a plain `git commit`.
    await git("config", "user.email", "t@example.invalid");
    await git("config", "user.name", "t");
    await git("config", "commit.gpgsign", "false");
    await git("config", "core.hooksPath", path.join(gitRoot, ".git", "hooks"));
    await Bun.write(path.join(gitRoot, "concepts", "Seed.md"), page("Seed"));
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
    // No collections: the apply reindexes nothing.
    __setWikiRegistryForTest([
      { name: WIKI, root, source: "extra", collections: ["driftwiki"] },
      { name: GIT_WIKI, root: gitRoot, source: "extra", collections: [] },
    ]);
    __resetWikiCacheForTest();
  });

  afterEach(async () => {
    __setWikiRegistryForTest([{ name: WIKI, root, source: "extra", collections: ["driftwiki"] }]);
    __resetWikiCacheForTest();
    await rm(gitRoot, { recursive: true, force: true });
  });

  async function approve(
    over: Partial<Parameters<typeof insertWikiProposal>[0]> = {},
    routeDeps: Partial<typeof DEFAULT_BACKLOG_ROUTE_DEPS> = {},
  ): Promise<{ status: number; body: Record<string, unknown>; rowStatus: string | undefined }> {
    const p = await insertWikiProposal({
      botName: "jarvis",
      wikiName: GIT_WIKI,
      topicKey: "commit-probe",
      kind: "concept",
      mode: "create",
      targetPath: TARGET,
      draft: "---\ntitle: Commit Probe\ntype: concept\n---\n\n# Commit Probe\n\nSynthesized fixture body.\n",
      sourceDocs: [],
      ...over,
    });
    if (!p) throw new Error("fixture proposal not inserted");
    const app = new Hono();
    registerWikiGardenerRoutes(app, { ...DEFAULT_BACKLOG_ROUTE_DEPS, ...routeDeps });
    const res = await app.request(`/api/wiki/proposals/${p.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, rowStatus: (await getWikiProposalById(p.id))?.status };
  }

  test("a commit that landed: the answer is unchanged, no commit field", async () => {
    const r = await approve();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["outcome", "writtenPath"]);
    expect(r.rowStatus).toBe("applied");
  });

  test("a rejecting hook: `commitReason: error`, `uncommitted: true`, the row still `applied`", async () => {
    const hook = path.join(gitRoot, ".git", "hooks", "pre-commit");
    await Bun.write(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const r = await approve();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: "applied", writtenPath: TARGET, commitReason: "error", uncommitted: true });
    expect(r.rowStatus).toBe("applied");
    expect(await Bun.file(path.join(gitRoot, TARGET)).exists()).toBe(true);
  });

  test("a rejecting hook and a row moved during the apply: the 409 carries the commit fields", async () => {
    const hook = path.join(gitRoot, ".git", "hooks", "pre-commit");
    await Bun.write(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const r = await approve(
      {},
      {
        // Another verb rejects the row right after this request claims it, so
        // the terminal approved→applied CAS loses.
        approveProposal: async (id) => {
          const claimed = await approveWikiProposal(id);
          await getDb()`UPDATE wiki_proposals SET status = 'rejected' WHERE id = ${id}`;
          return claimed;
        },
      },
    );
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "proposal state changed during apply", commitReason: "error", uncommitted: true });
    expect(r.rowStatus).toBe("rejected");
  });

  test("a non-default branch: `uncommitted: true`, the row still `applied`", async () => {
    await git("checkout", "-q", "-b", "feature");
    const r = await approve();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: "applied", writtenPath: TARGET, commitReason: "not-default-branch", uncommitted: true });
    expect(r.rowStatus).toBe("applied");
  });

  // A no-op approve (the page already IS its draft) still runs the commit
  // tail, which answers `not-default-branch` before it looks at what is staged,
  // and that answer is reported as is.
  const SEED = "concepts/Seed.md";
  const seedDraft = page("Seed").replace("Body.", "Body, revised.");
  const noopRow = { topicKey: "seed-update", mode: "update" as const, targetPath: SEED, baseHash: sha256(page("Seed")), draft: seedDraft };

  test("a no-op over a COMMITTED page on a feature branch still warns (known limitation)", async () => {
    await Bun.write(path.join(gitRoot, SEED), seedDraft);
    await git("commit", "-q", "-am", "the draft landed earlier");
    await git("checkout", "-q", "-b", "feature");
    const r = await approve(noopRow);
    expect(r.status).toBe(200);
    // Known limitation: nothing is uncommitted, but the branch answer comes before any staging check.
    expect(r.body).toEqual({ outcome: "applied", writtenPath: SEED, commitReason: "not-default-branch", uncommitted: true });
    expect(r.rowStatus).toBe("applied");
    expect((await runGit(gitRoot, ["status", "--porcelain"])).stdout).toBe("");
  });

  test("a no-op over an UNCOMMITTED page on a feature branch is still `uncommitted`", async () => {
    await git("checkout", "-q", "-b", "feature");
    await Bun.write(path.join(gitRoot, SEED), seedDraft);
    const r = await approve(noopRow);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: "applied", writtenPath: SEED, commitReason: "not-default-branch", uncommitted: true });
    expect(r.rowStatus).toBe("applied");
  });

  // `git status` never lists an ignored file, so a dirtiness check reads an
  // ignored page as committed. It is not: the answer must keep the warning.
  test("a no-op over a git-IGNORED page on a feature branch is still `uncommitted`", async () => {
    const SECRET = "concepts/Secret.md";
    await Bun.write(path.join(gitRoot, ".gitignore"), `${SECRET}\n`);
    await git("add", ".gitignore");
    await git("commit", "-q", "-m", "ignore the secret page");
    await git("checkout", "-q", "-b", "feature");
    const draft = page("Secret").replace("Body.", "Body, revised.");
    await Bun.write(path.join(gitRoot, SECRET), draft);
    __resetWikiCacheForTest();
    const r = await approve({ topicKey: "secret-update", mode: "update", targetPath: SECRET, baseHash: sha256(page("Secret")), draft });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ outcome: "applied", writtenPath: SECRET, commitReason: "not-default-branch", uncommitted: true });
    expect(r.rowStatus).toBe("applied");
  });
});
