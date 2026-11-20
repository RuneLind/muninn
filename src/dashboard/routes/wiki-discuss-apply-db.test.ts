/**
 * `POST /api/wiki/discuss/apply` against the REAL test database (the turn
 * rows and the Gardener-held check read it) and a temp git wiki with no
 * remote: the preview writes nothing; Apply writes the edit's range only,
 * keeps every fact wrapper, adds one `log.md` entry of kind `update` and one
 * commit, and marks the turn applied; and every refusal Done's sequence has,
 * plus the turn's own (not done, superseded, applied, no agent), leaves the
 * page as it was. Invented pages only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
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
import { finishDiscussTurn, getDiscussTurn, listDiscussTurns, markDiscussEditApplied, releaseDiscussEditClaim, startDiscussTurn, type DiscussTurn } from "../../db/wiki-discuss-turns.ts";
import { sha256 } from "../../utils/date-hash.ts";
import { WIKI_AGENT_RULES_FILE, WIKI_AGENT_RULES_MAX_BYTES } from "../../wiki/discuss-agent.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { registerWikiDiscussApplyRoute, WIKI_DISCUSS_APPLY_PATH, type DiscussApplyDeps } from "./wiki-discuss-apply.ts";
import type { DecisionCloseGuards } from "./wiki-decision-inbox.ts";

setupTestDb();

const WIKI = "discuss-apply-wiki";
const NOAGENT = "discuss-apply-noagent";
const RO = "discuss-apply-ro";
const REL = "plans/ferry.mdx";
const PAGE = [
  "---",
  "title: Ferry plan",
  "---",
  "",
  "# Ferry plan",
  "",
  '<Fold title="The berths">',
  "",
  "The north pier takes the morning ferry.",
  "",
  "</Fold>",
  "",
  'The check reads <Fact v="ok" n="1">the frontmatter status date</Fact> and nothing else.',
  "",
  '<Fact v="warn" n="2">',
  "The ferry runs every hour on Sundays.",
  "</Fact>",
  "",
  "The harbour opens at six. The harbour opens at six.",
  "",
  "- **R2, behind.** The check compares the frontmatter `status_date` with the date on the Brief's Status line.",
  "",
].join("\n");
const OLD = "with the date on the Brief's Status line.";
const NEW = "with the Brief's Status line, not with any date in the frontmatter.";

let root = "";
let noAgentRoot = "";
let app: Hono;
let guardRefusal: Response | null = null;
let commitResult: CommitWikiResult | null = null;
/** Runs after the commit, before Apply answers (a second tab's click while the push and the index rebuild run). */
let onCommit: (() => Promise<void>) | null = null;
let role = "admin";
/** Runs when Apply gives its claim back, before the release itself. */
let onRelease: (() => Promise<void>) | null = null;
/** The release's answer instead of the database's, when set. */
let releaseAnswer: boolean | null = null;
/** The next turn read answers this row: a second tab whose checks ran before the first Apply claimed the turn. */
let staleTurnRead: DiscussTurn | null = null;
const NOW = Date.parse("2026-11-20T12:00:00+01:00");

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
const git = (...args: string[]) => gitIn(root, ...args);

async function resetPage(text = PAGE): Promise<void> {
  await Bun.write(path.join(root, REL), text);
  git("add", "-A");
  try {
    git("commit", "-q", "-m", "fixture");
  } catch {
    /* nothing changed */
  }
  __resetWikiCacheForTest();
}

const pageText = () => Bun.file(path.join(root, REL)).text();
const logText = () => Bun.file(path.join(root, "log.md")).text().catch(() => "");
const commits = () => Number(git("rev-list", "--count", "HEAD").trim());

const edit = (old: string, neu: string) => ({ edits: [{ claimIndex: 0, verdict: "", old, new: neu, reason: "" }], dropped: [], overLimit: false });

/** A finished turn on `wiki`'s page carrying `proposedEdit`; its id. */
async function turnWith(proposedEdit: unknown, opts: { wiki?: string; discussionId?: string; endState?: "done" | "error" } = {}): Promise<{ id: string; discussionId: string }> {
  const discussionId = opts.discussionId ?? crypto.randomUUID();
  const t = await startDiscussTurn(
    { discussionId, wiki: opts.wiki ?? WIKI, relPath: REL, pageHash: sha256(await pageText()), selection: null, question: "Is R2 right?", location: null, botName: "b", connector: "claude-sdk", model: null, surface: {} },
    { staleRunningMs: 60_000 },
  );
  await finishDiscussTurn(t.id, { endState: opts.endState ?? "done", answer: "It reads the Status line.", proposedEdit });
  return { id: t.id, discussionId };
}

const post = (body: Record<string, unknown>) =>
  app.request(WIKI_DISCUSS_APPLY_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function preview(turnId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await post({ turnId, preview: true });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function previewed(turnId: string): Promise<Record<string, unknown>> {
  const { status, body } = await preview(turnId);
  expect(status).toBe(200);
  return { turnId, baseHash: body.baseHash, previewHash: body.previewHash };
}

beforeAll(async () => {
  root = await testTempDir(path.join(tmpdir(), "muninn-discuss-apply-"));
  noAgentRoot = `${root}-noagent`;
  for (const dir of [root, noAgentRoot]) {
    await Bun.write(path.join(dir, REL), PAGE);
    gitIn(dir, "init", "-q", "-b", "main");
    // The route's own commit runs without this file's env: a repo-local identity for a runner with no global one.
    gitIn(dir, "config", "user.name", "t");
    gitIn(dir, "config", "user.email", "t@example.invalid");
  }
  await Bun.write(path.join(root, WIKI_AGENT_RULES_FILE), "# Rules\n\nPropose one edit.\n");
  await resetPage();
  gitIn(noAgentRoot, "add", "-A");
  gitIn(noAgentRoot, "commit", "-q", "-m", "fixture");
  const registry: WikiRegistryEntry[] = [
    { name: WIKI, root, source: "extra" },
    { name: NOAGENT, root: noAgentRoot, source: "extra" },
    { name: RO, root: `${root}-ro`, source: "extra" },
  ];
  __setWikiRegistryForTest(registry);
  const config = { dashboardPort: 3010, profile: "default", knowledgeApiUrl: "http://127.0.0.1:9" } as unknown as Config;
  const guards: DecisionCloseGuards = { readonlyRefusal: () => guardRefusal, egressRefusal: () => null };
  const deps = (): DiscussApplyDeps => ({
    registry: () => registry,
    isReadonlyRoot: (r) => r === `${root}-ro`,
    bots: () => [],
    turns: {
      get: async (id) => {
        const stale = staleTurnRead;
        staleTurnRead = null;
        return stale ?? getDiscussTurn(id);
      },
      list: listDiscussTurns,
      markApplied: markDiscussEditApplied,
      releaseClaim: async (id, at) => {
        const hook = onRelease;
        onRelease = null;
        if (hook) await hook();
        return releaseAnswer ?? releaseDiscussEditClaim(id, at);
      },
    },
    commit: async (r, paths, message) => {
      const result = commitResult ?? (await commitWikiChange(r, paths, message, { push: false }));
      const hook = onCommit;
      onCommit = null;
      if (hook) await hook();
      return result;
    },
    now: () => NOW,
  });
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("role" as never, role as never);
    await next();
  });
  registerWikiDiscussApplyRoute(app, config, guards, deps);
});

beforeEach(async () => {
  guardRefusal = null;
  commitResult = null;
  onCommit = null;
  onRelease = null;
  releaseAnswer = null;
  staleTurnRead = null;
  role = "admin";
  __setStaleProposalStoreForTest(null);
  git("reset", "-q", "--hard");
  await resetPage();
});

afterAll(async () => {
  __setStaleProposalStoreForTest(null);
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(noAgentRoot, { recursive: true, force: true });
});

const wrappers = (s: string) => s.match(/<\/?Fact\b[^>\n]*>[^\n]*/g) ?? [];

describe("preview", () => {
  test("answers the diff, the lines, the hashes and the log entry, and writes nothing", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const before = commits();
    const { status, body } = await preview(id);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, preview: true, relPath: REL, title: "Ferry plan", before: OLD, after: NEW, fromLine: 21, toLine: 21, tier: "exact", pageChangedSinceTurn: false, baseHash: sha256(PAGE) });
    expect(typeof body.previewHash).toBe("string");
    expect(body.logEntry).toBe(`## [2026-11-20] update | Ferry plan\n- Discuss: applied the wiki agent's edit (turn 1 of discussion ${(await getDiscussTurn(id))!.discussionId.slice(0, 8)}): "${OLD}" → "${NEW}"`);
    expect(body.findings).toEqual([]);
    expect(await pageText()).toBe(PAGE);
    expect(commits()).toBe(before);
  });

  test("findings: a finding the edit only moves to another line is not added; one the new text brings is", async () => {
    const page = PAGE.replace("# Ferry plan\n", "# Ferry plan\n\nIntro.\n\nSee [[broken link here\n");
    await resetPage(page);
    const shifted = await turnWith(edit("Intro.", "Intro.\n\nMore."));
    const moved = await preview(shifted.id);
    expect(moved.status).toBe(200);
    expect(moved.body.findings).toEqual([]);
    const added = await turnWith(edit(OLD, `${NEW} See [[open link`));
    const brought = await preview(added.id);
    expect(brought.status).toBe(200);
    expect(brought.body.findings).toEqual([expect.objectContaining({ check: "index-truncation", message: expect.stringContaining("([[open link)") })]);
    // The same text as the finding already on the page, a second time: one more finding, so it is added.
    const twice = await turnWith(edit("Intro.", "Intro.\n\nSee [[broken link here"));
    const again = await preview(twice.id);
    expect(again.status).toBe(200);
    expect(again.body.findings).toEqual([expect.objectContaining({ check: "index-truncation", message: expect.stringContaining("([[broken link here)") })]);
    expect(await pageText()).toBe(page);
  });

  test("refuses new text that adds a component (markup changes go to Claude Code)", async () => {
    const { id } = await turnWith(edit("The north pier takes the morning ferry.", 'The north pier takes the morning ferry.\n\n<Chart kind="bars" value="x">\n\nno table\n\n</Chart>'));
    const { status, body } = await preview(id);
    expect(status).toBe(409);
    expect(body).toMatchObject({ refused: true, code: "new-markup" });
    expect(await pageText()).toBe(PAGE);
  });

  const refusals: [string, ReturnType<typeof edit>, string][] = [
    ["old text in the frontmatter", edit("title: Ferry plan", "title: Boat plan"), "frontmatter"],
    ["old text on a block component's tag line", edit('<Fold title="The berths">', '<Fold title="Berths">'), "component-tag"],
    ["a range inside an inline fact wrapper", edit("frontmatter status date", "status_date field"), "fact-wrapper"],
    ["a range inside a block fact wrapper", edit("every hour on Sundays", "every second hour on Sundays"), "fact-wrapper"],
    ["a range across a wrapper's boundary", edit("The check reads the frontmatter", "It reads the frontmatter"), "fact-wrapper"],
    ["old text that matches twice", edit("The harbour opens at six.", "The harbour opens at seven."), "ambiguous"],
  ];
  for (const [name, e, code] of refusals) {
    test(`refuses ${name}, and writes nothing`, async () => {
      const { id } = await turnWith(e);
      const { status, body } = await preview(id);
      expect(status).toBe(409);
      expect(body).toMatchObject({ refused: true, code });
      expect(await pageText()).toBe(PAGE);
    });
  }

  test("a page with a BOM, unchanged since the turn, is not reported as changed", async () => {
    await resetPage(`\uFEFF${PAGE}`);
    const { id } = await turnWith(edit(OLD, NEW));
    const { status, body } = await preview(id);
    expect(status).toBe(200);
    expect(body.pageChangedSinceTurn).toBe(false);
    // The base hash is still of the file as read, BOM kept: the write's CAS reads it the same way.
    expect(body.baseHash).toBe(sha256(`\uFEFF${PAGE}`));
  });

  test("refuses an edit that changes nothing (no-change), writes nothing, and leaves the turn unclaimed", async () => {
    const same = "The north pier takes the morning ferry.";
    const { id } = await turnWith(edit(same, same));
    const before = commits();
    const { status, body } = await preview(id);
    expect(status).toBe(409);
    expect(body).toMatchObject({ refused: true, code: "no-change" });
    // Apply itself, with the page's hash: preview hands out no preview hash for a refused edit.
    const res = await post({ turnId: id, baseHash: sha256(PAGE), previewHash: "none" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ refused: true, code: "no-change" });
    expect(await pageText()).toBe(PAGE);
    expect(await logText()).toBe("");
    expect(commits()).toBe(before);
    expect((await getDiscussTurn(id))!.editAppliedAt).toBeNull();
  });

  test("refuses a range holding an inline component tag", async () => {
    await resetPage(PAGE.replace("The north pier takes", 'The north pier <Verdict tone="ok">takes</Verdict>'));
    const { id } = await turnWith(edit('pier <Verdict tone="ok">takes</Verdict> the', "pier serves the"));
    const { status, body } = await preview(id);
    expect(status).toBe(409);
    expect(body).toMatchObject({ refused: true, code: "component-tag" });
  });
});

describe("apply", () => {
  test("writes the range only, keeps every fact wrapper, one log entry, one commit, and marks the turn applied", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const before = commits();
    const res = await post(await previewed(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, page: REL, committed: true });
    const text = await pageText();
    expect(text).toBe(PAGE.replace(OLD, NEW));
    expect(wrappers(text)).toEqual(wrappers(PAGE));
    expect(commits()).toBe(before + 1);
    expect(git("log", "-1", "--format=%s").trim()).toBe(`[discuss] Apply the wiki agent's edit (turn 1): ${REL}`);
    expect(git("status", "--porcelain")).toBe("");
    const log = await logText();
    expect(log.match(/^## \[/gm)?.length).toBe(1);
    expect(log).toContain("## [2026-11-20] update | Ferry plan\n- Discuss: applied the wiki agent's edit");
    expect((await getDiscussTurn(id))!.editAppliedAt).not.toBeNull();
    // A second Apply of the same turn is refused.
    expect((await preview(id)).body).toMatchObject({ reason: "applied" });
  });

  test("a concurrent edit between preview and apply: 409 stale, nothing written", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    const edited = PAGE.replace("The north pier", "The south pier");
    await resetPage(edited);
    const res = await post(p);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The page changed since the edit was shown. Preview it again.", stale: true });
    expect(await pageText()).toBe(edited);
  });

  test("a page that changes after the route's own compare is refused by the write's compare", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    const edited = PAGE.replace("The north pier", "The south pier");
    __setStaleProposalStoreForTest({
      ...dbStaleProposalStore,
      liveHolders: async () => {
        await Bun.write(path.join(root, REL), edited);
        git("commit", "-q", "-am", "an edit from elsewhere");
        return [];
      },
    });
    const res = await post(p);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The page changed while the edit was applied. Preview it again.", stale: true });
    expect(await pageText()).toBe(edited);
  });

  test("a page a Gardener card holds: 409 held, nothing written; unreadable cards: 503", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    const holder: LivePageHolder = { id: "00000000-0000-4000-8000-000000000001", groupKey: "stale:2026-11-20", topicKey: "t", targetPath: REL, kind: "stale-check", status: "draft" };
    __setStaleProposalStoreForTest({ ...dbStaleProposalStore, liveHolders: async () => [holder] });
    const res = await post(p);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ held: true });
    expect(await pageText()).toBe(PAGE);
    __setStaleProposalStoreForTest({
      ...dbStaleProposalStore,
      liveHolders: async () => {
        throw new Error("down");
      },
    });
    expect((await post(p)).status).toBe(503);
    expect(await pageText()).toBe(PAGE);
  });

  test("a page with uncommitted changes: 409 dirty, nothing written", async () => {
    const dirty = `${PAGE}\nA hand edit.\n`;
    await Bun.write(path.join(root, REL), dirty);
    __resetWikiCacheForTest();
    const { id } = await turnWith(edit(OLD, NEW));
    const res = await post(await previewed(id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ dirty: true });
    expect(await pageText()).toBe(dirty);
    expect((await getDiscussTurn(id))!.editAppliedAt).toBeNull();
  });

  test("a preview hash that no longer fits: 409 changed; missing hashes: 400", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    expect((await post({ ...p, previewHash: "x" })).status).toBe(409);
    expect((await post({ turnId: id, baseHash: p.baseHash })).status).toBe(400);
    expect(await pageText()).toBe(PAGE);
  });

  test("an edit whose new text still holds its old text is written once, even when a second tab applies it during the commit", async () => {
    const neu = `${OLD} It is checked daily.`;
    const { id } = await turnWith(edit(OLD, neu));
    const before = commits();
    const entries = async () => (await logText()).match(/^## \[/gm)?.length ?? 0;
    const logBefore = await entries();
    let second: { preview: number; apply: number | null } | null = null;
    onCommit = async () => {
      // The page now holds the new text, which still holds the old text exactly once.
      const p = await preview(id);
      let apply: number | null = null;
      if (p.status === 200) apply = (await post({ turnId: id, baseHash: p.body.baseHash, previewHash: p.body.previewHash })).status;
      second = { preview: p.status, apply };
    };
    const res = await post(await previewed(id));
    expect(res.status).toBe(200);
    expect(second).not.toBeNull();
    expect(second!.apply === 200).toBe(false);
    expect(await pageText()).toBe(PAGE.replace(OLD, neu));
    expect(await entries()).toBe(logBefore + 1);
    expect(commits()).toBe(before + 1);
    expect((await getDiscussTurn(id))!.editAppliedAt).not.toBeNull();
  });

  test("a turn claimed by another Apply after this one\x27s checks: 409 applied, nothing written", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    const before = commits();
    __setStaleProposalStoreForTest({
      ...dbStaleProposalStore,
      liveHolders: async () => {
        await markDiscussEditApplied(id);
        return [];
      },
    });
    const res = await post(p);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "applied" });
    expect(await pageText()).toBe(PAGE);
    expect(commits()).toBe(before);
  });

  test("a write that fails leaves the turn un-applied, so it can be applied again", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    const file = path.join(root, REL);
    chmodSync(file, 0o444);
    try {
      const res = await post(p);
      expect(res.status).toBe(500);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain("write failed");
      expect(error).not.toContain("still marked applied");
    } finally {
      chmodSync(file, 0o644);
    }
    expect(await pageText()).toBe(PAGE);
    expect((await getDiscussTurn(id))!.editAppliedAt).toBeNull();
    expect((await post(await previewed(id))).status).toBe(200);
    expect(await pageText()).toBe(PAGE.replace(OLD, NEW));
  });

  test("a failed write gives the claim back inside the write section: a second Apply waiting on the section is not told the edit is applied", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    const unclaimed = (await getDiscussTurn(id))!;
    const file = path.join(root, REL);
    let second: Promise<Response> | null = null;
    onRelease = async () => {
      chmodSync(file, 0o644);
      staleTurnRead = unclaimed;
      second = Promise.resolve(post(p));
      // With the section already free, the second Apply runs to its end here; inside the section it waits for this one.
      await Promise.race([second, Bun.sleep(1000)]);
    };
    chmodSync(file, 0o444);
    try {
      expect((await post(p)).status).toBe(500);
    } finally {
      chmodSync(file, 0o644);
    }
    expect(second).not.toBeNull();
    const res = await second!;
    expect(await res.json()).not.toMatchObject({ reason: "applied" });
    expect(res.status).toBe(200);
    expect(await pageText()).toBe(PAGE.replace(OLD, NEW));
  });

  test("a claim that cannot be given back after a failed write: 500 that says the turn is still marked applied", async () => {
    const { id } = await turnWith(edit(OLD, NEW));
    const p = await previewed(id);
    releaseAnswer = false;
    const file = path.join(root, REL);
    chmodSync(file, 0o444);
    try {
      const res = await post(p);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain("the turn is still marked applied");
    } finally {
      chmodSync(file, 0o644);
    }
    expect(await pageText()).toBe(PAGE);
    expect((await getDiscussTurn(id))!.editAppliedAt).not.toBeNull();
  });

  test("a failed commit says the page is left uncommitted", async () => {
    commitResult = { committed: false, reason: "error" };
    const { id } = await turnWith(edit(OLD, NEW));
    const body = (await (await post(await previewed(id))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, committed: false, commitReason: "error", uncommitted: true });
  });
});

describe("the turn and the wiki", () => {
  test("only the newest turn of a discussion applies; a turn that did not end done does not", async () => {
    const first = await turnWith(edit(OLD, NEW));
    await turnWith(edit("The north pier", "The south pier"), { discussionId: first.discussionId });
    expect((await preview(first.id))).toMatchObject({ status: 409, body: { reason: "superseded" } });
    const failed = await turnWith(edit(OLD, NEW), { endState: "error" });
    expect((await preview(failed.id))).toMatchObject({ status: 409, body: { reason: "not-done" } });
  });

  test("a wiki without the agent: 404; a read-only root and a read-only instance: 403; an unknown turn: 404; a viewer: 403", async () => {
    const noAgent = await turnWith(edit(OLD, NEW), { wiki: NOAGENT });
    expect((await preview(noAgent.id))).toMatchObject({ status: 404, body: { reason: "no-agent" } });
    const ro = await turnWith(edit(OLD, NEW), { wiki: RO });
    expect((await preview(ro.id))).toMatchObject({ status: 403, body: { readonly: true } });
    const { id } = await turnWith(edit(OLD, NEW));
    guardRefusal = new Response(JSON.stringify({ error: "readonly", readonly: true }), { status: 403 });
    expect((await post({ turnId: id, preview: true })).status).toBe(403);
    guardRefusal = null;
    expect((await preview(crypto.randomUUID())).status).toBe(404);
    expect((await post({ turnId: "nope", preview: true })).status).toBe(400);
    role = "viewer";
    expect((await post({ turnId: id, preview: true })).status).toBe(403);
    role = "admin";
    const notJson = await app.request(WIKI_DISCUSS_APPLY_PATH, { method: "POST", body: "x" });
    expect(notJson.status).toBe(415);
    expect(await pageText()).toBe(PAGE);
  });

  test("a .wiki-agent.md over the bound: 422 rules-too-large; one that cannot be read: 503 rules-unreadable (as the discuss route answers)", async () => {
    const rules = path.join(root, WIKI_AGENT_RULES_FILE);
    const kept = await Bun.file(rules).text();
    try {
      await Bun.write(rules, "x".repeat(WIKI_AGENT_RULES_MAX_BYTES + 1));
      const big = await turnWith(edit(OLD, NEW));
      expect(await preview(big.id)).toMatchObject({ status: 422, body: { reason: "rules-too-large", error: `the wiki's .wiki-agent.md is ${WIKI_AGENT_RULES_MAX_BYTES + 1} bytes, over the ${WIKI_AGENT_RULES_MAX_BYTES}-byte bound` } });
      await Bun.write(rules, kept);
      chmodSync(rules, 0o000);
      const locked = await turnWith(edit(OLD, NEW));
      expect(await preview(locked.id)).toMatchObject({ status: 503, body: { reason: "rules-unreadable", error: "the wiki's .wiki-agent.md cannot be read" } });
    } finally {
      chmodSync(rules, 0o644);
      await Bun.write(rules, kept);
    }
    expect(await pageText()).toBe(PAGE);
  });
});
