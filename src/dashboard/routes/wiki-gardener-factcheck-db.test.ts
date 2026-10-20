/**
 * The gate's fact-check lock when the marks read fails (architecture review
 * 2026-10, finding 31), against the REAL test database and a temp bot wiki:
 *
 *  - `GET /api/wiki/proposals` says the fact-check status is unknown, per card
 *    and for the listing, instead of serving `factcheck: null` as if no check
 *    existed — and still answers 200 (never a failed listing).
 *  - A missing `summary_factchecks` table (migration 079 not run) still means
 *    "no checks", not "unknown".
 *  - `POST …/:id/approve` re-checks the lock itself before the draft→approved
 *    CAS, so a stale tab or a failed listing cannot approve a draft built
 *    without the current check.
 *
 * Its own `bun test` link in the `test` and `test:db` chains.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import { getWikiProposalById, insertWikiProposal, type WikiProposal } from "../../db/wiki-proposals.ts";
import { upsertSummaryFactcheck } from "../../db/summary-factchecks.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest } from "../../wiki/readonly.ts";
import { sha256 } from "../../gardener/util.ts";
import type { BotConfig } from "../../bots/config.ts";
import {
  DEFAULT_BACKLOG_ROUTE_DEPS,
  __setBotsForTest,
  __setFactcheckMarkReadsForTest,
  registerWikiGardenerRoutes,
} from "./wiki-gardener-routes.ts";

setupTestDb();

const BOT = "fcbot";
const COLLECTION = "youtube-summaries";
const DOC = "2026-10-01-fixture-talk.md";
const ANSWER = "### ❌ Claim 1/1 — Synthesized fixture claim\n\nWrong.\n";
const JSON_POST = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-fc-gate-"));
  __setReadonlyWikiRootsForTest();
  __setWikiRegistryForTest([{ name: BOT, root, source: "bot", collections: ["wiki"] }]);
  __setBotsForTest([{ name: BOT, dir: root, wikiDir: root } as unknown as BotConfig]);
});

afterEach(() => {
  __setFactcheckMarkReadsForTest(null);
  claimed = [];
});

afterAll(async () => {
  __setBotsForTest(null);
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(root, { recursive: true, force: true });
});

/** A create-mode source draft built WITHOUT the saved check (no carried sha). */
async function seedSourceDraft(carriedSha?: string): Promise<WikiProposal> {
  const p = await insertWikiProposal({
    botName: BOT,
    topicKey: "fixture-talk",
    kind: "source",
    mode: "create",
    targetPath: "sources/Fixture Talk.mdx",
    baseHash: null,
    draft: "---\ntitle: Fixture Talk\ntype: source\n---\n\n# Fixture Talk\n\nSynthesized fixture body.\n",
    sourceDocs: [
      {
        collection: COLLECTION,
        docId: DOC,
        title: "Fixture talk",
        url: "https://example.invalid/talk",
        ...(carriedSha ? { factcheckSha256: carriedSha } : {}),
      },
    ],
  });
  if (!p) throw new Error("fixture proposal not inserted");
  return p;
}

async function saveCheck(): Promise<void> {
  await upsertSummaryFactcheck({
    collection: COLLECTION,
    docId: DOC,
    url: "https://example.invalid/talk",
    bodySha256: "0".repeat(64),
    answer: ANSWER,
    claims: [{ index: 1, title: "Synthesized fixture claim", verdict: "❌", outcome: "verified", sources: [] }],
    botName: BOT,
  });
}

/** Ids that reached the draft→approved CAS. The CAS answers null (as if the row
 *  had moved), so no test runs the apply — which would reindex a live huginn. */
let claimed: string[] = [];

function app(): Hono {
  const a = new Hono();
  registerWikiGardenerRoutes(a, {
    ...DEFAULT_BACKLOG_ROUTE_DEPS,
    approveProposal: async (id) => {
      claimed.push(id);
      return null;
    },
  });
  return a;
}

interface ListedCard {
  id: string;
  factcheck: { needsRedraft: boolean } | null;
  factcheckUnknown?: boolean;
}
async function list(): Promise<{ status: number; body: { proposals: ListedCard[]; factcheckUnavailable?: boolean } }> {
  const res = await app().request(`/api/wiki/proposals?wiki=${BOT}`);
  return { status: res.status, body: (await res.json()) as { proposals: ListedCard[]; factcheckUnavailable?: boolean } };
}

const failingRead = () => Promise.reject(new Error("connection reset by peer"));
const missingTable = () => Promise.reject(Object.assign(new Error('relation "summary_factchecks" does not exist'), { code: "42P01" }));

describe("GET /api/wiki/proposals — fact-check marks unavailable", () => {
  test("healthy: a saved ❌ check locks the draft and the payload carries no unknown fields", async () => {
    const p = await seedSourceDraft();
    await saveCheck();
    const { status, body } = await list();
    expect(status).toBe(200);
    const card = body.proposals.find((c) => c.id === p.id)!;
    expect(card.factcheck?.needsRedraft).toBe(true);
    expect("factcheckUnknown" in card).toBe(false);
    expect("factcheckUnavailable" in body).toBe(false);
  });

  test("a failed marks read says so — per card and for the listing — and still answers 200", async () => {
    const p = await seedSourceDraft();
    __setFactcheckMarkReadsForTest({ list: failingRead });
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.factcheckUnavailable).toBe(true);
    const card = body.proposals.find((c) => c.id === p.id)!;
    expect(card.factcheck).toBeNull();
    expect(card.factcheckUnknown).toBe(true);
  });

  test("a missing summary_factchecks table still means no checks, not unknown", async () => {
    const p = await seedSourceDraft();
    __setFactcheckMarkReadsForTest({ list: missingTable });
    const { status, body } = await list();
    expect(status).toBe(200);
    expect("factcheckUnavailable" in body).toBe(false);
    const card = body.proposals.find((c) => c.id === p.id)!;
    expect(card.factcheck).toBeNull();
    expect("factcheckUnknown" in card).toBe(false);
  });

  test("only a card the lock could apply to is marked unknown", async () => {
    await seedSourceDraft();
    const concept = await insertWikiProposal({
      botName: BOT,
      topicKey: "fixture-concept",
      kind: "concept",
      mode: "create",
      targetPath: "concepts/Fixture Concept.md",
      baseHash: null,
      draft: "---\ntitle: Fixture Concept\n---\n\nBody.\n",
      sourceDocs: [],
    });
    __setFactcheckMarkReadsForTest({ list: failingRead });
    const { body } = await list();
    const card = body.proposals.find((c) => c.id === concept!.id)!;
    expect("factcheckUnknown" in card).toBe(false);
  });
});

describe("POST /api/wiki/proposals/:id/approve — the fact-check lock on the server", () => {
  test("a draft built without the current check is refused 409 before the CAS", async () => {
    const p = await seedSourceDraft();
    await saveCheck();
    const res = await app().request(`/api/wiki/proposals/${p.id}/approve`, JSON_POST);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; factcheck?: boolean };
    expect(body.factcheck).toBe(true);
    expect(body.error).toContain("fact-check");
    expect(claimed).toEqual([]);
    expect((await getWikiProposalById(p.id))?.status).toBe("draft");
  });

  test("a failed fact-check read refuses 503 before the CAS", async () => {
    const p = await seedSourceDraft();
    __setFactcheckMarkReadsForTest({ one: failingRead });
    const res = await app().request(`/api/wiki/proposals/${p.id}/approve`, JSON_POST);
    expect(res.status).toBe(503);
    expect(claimed).toEqual([]);
  });

  test("a draft carrying the current check reaches the CAS", async () => {
    const p = await seedSourceDraft(sha256(ANSWER));
    await saveCheck();
    await app().request(`/api/wiki/proposals/${p.id}/approve`, JSON_POST);
    expect(claimed).toEqual([p.id]);
  });

  test("a missing summary_factchecks table means no lock", async () => {
    const p = await seedSourceDraft();
    __setFactcheckMarkReadsForTest({ one: missingTable });
    await app().request(`/api/wiki/proposals/${p.id}/approve`, JSON_POST);
    expect(claimed).toEqual([p.id]);
  });
});
