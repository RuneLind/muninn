/**
 * `GET /api/wiki/proposals` against the REAL test database and a temp wiki:
 * an update row whose page changed since drafting carries `drifted`, so the gate
 * says so before the reviewer clicks Approve (architecture review 2026-10,
 * finding 63), and a page that already IS its draft is not flagged. Its own `bun test` link in the `test` and `test:db` chains.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import { insertWikiProposal } from "../../db/wiki-proposals.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest } from "../../wiki/readonly.ts";
import { sha256 } from "../../gardener/util.ts";
import { registerWikiGardenerRoutes } from "./wiki-gardener-routes.ts";

setupTestDb();

const WIKI = "driftwiki";
const SAME = "concepts/same.md";
const EDITED = "concepts/edited.md";
const APPLIED = "concepts/applied.md";
const RAW = "concepts/raw.md";
const page = (title: string) => `---\ntitle: ${title}\n---\n\nBody.\n`;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-drift-"));
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
