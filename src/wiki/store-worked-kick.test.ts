import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetWikiCacheForTest, getWikiIndex } from "./store.ts";
import { __resetWorkedLedgerForTest } from "./worked-ledger.ts";
import { __resetWorkSessionsForTest } from "./work-sessions.ts";

/**
 * The index build's worked-ledger kick is gated on the wiki tool surface: under
 * `MUNINN_PROFILE=nais` (read slice only) a listing read must not dial
 * claude-usage with the host's wiki root. A local counting server stands in
 * for claude-usage.
 */
describe("buildWikiIndex's worked-ledger kick", () => {
  let root: string;
  let hits: string[];
  let server: ReturnType<typeof Bun.serve>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-kick-"));
    await Bun.write(path.join(root, "A.md"), "# A\n");
    hits = [];
    server = Bun.serve({ port: 0, fetch: (req) => { hits.push(new URL(req.url).pathname + new URL(req.url).search); return Response.json({ rows: [] }); } });
    for (const k of ["CLAUDE_USAGE_URL", "MUNINN_PROFILE"]) saved[k] = process.env[k];
    process.env.CLAUDE_USAGE_URL = `http://127.0.0.1:${server.port}`;
    __resetWikiCacheForTest();
    __resetWorkedLedgerForTest();
    __resetWorkSessionsForTest();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.stop(true);
    __resetWikiCacheForTest();
    __resetWorkedLedgerForTest();
    __resetWorkSessionsForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("nais: an index build sends nothing to claude-usage", async () => {
    process.env.MUNINN_PROFILE = "nais";
    expect(await getWikiIndex({ root })).not.toBeNull();
    await Bun.sleep(150);
    expect(hits).toEqual([]);
  });

  test("default (control): an index build asks claude-usage", async () => {
    delete process.env.MUNINN_PROFILE;
    expect(await getWikiIndex({ root })).not.toBeNull();
    for (let i = 0; i < 30 && hits.length < 3; i++) await Bun.sleep(10);
    expect(hits.length).toBeGreaterThan(0);
    // The work-sessions memo rides the same gate: both of its forms are asked.
    expect(hits.some((h) => h.includes("sessions=1"))).toBe(true);
    expect(hits.some((h) => h.includes("summary=1") && h.includes("until="))).toBe(true);
  });
});
