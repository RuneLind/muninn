/**
 * `POST /api/wiki/provenance/stamp` — the first WRITE the provenance feature
 * makes, and it makes it through claude-usage's `wiki-stamp` CLI rather than by
 * touching the frontmatter itself. muninn has exactly one writer of those lines
 * and it is not muninn.
 *
 * Every case here drives a FAKE CLI on disk — one per outcome, including one
 * that exits 1 with stderr and prints no report at all — because the route's
 * whole contract is how it reads that process: the last stdout line as JSON, the
 * exit code as information only when there is no report line.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest, getWikiIndex } from "../../wiki/store.ts";
import { registerWikiStampRoute, type StampRouteDeps } from "./wiki-stamp.ts";
import type { ProvenanceContext } from "../../wiki/provenance-service.ts";
import type { StampConfig } from "../../wiki/stamp-roots.ts";

const STAMPED = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const NEW_ID = "617e67b3-13d7-4407-a2fe-37ce79df9634";
const NEW_REF = `claude-code:${NEW_ID}`;
const REL = "page.md";

let root = "";
let bin = "";
/** Where a fake CLI records the argv and the environment it was handed. */
let argvFile = "";

const PAGE = [
  "---",
  "type: plan",
  "title: A stamped page",
  `sessions: [claude-code:${STAMPED}]`,
  "sessions_backfilled: 2026-09-01",
  "---",
  "",
  "# A stamped page",
  "",
].join("\n");

/** A ledger that answers nothing — every case here is about the WRITE, and a
 *  bare chip is a perfectly good re-resolve. */
const ctx = (): ProvenanceContext => ({
  sessionLedger: {
    baseUrl: "http://ledger.test",
    urlConfigured: false,
    fetchSessions: async () => ({ sessions: [] }),
    fetchMerges: async () => ({ merges: [] }),
    fetchHandoff: async () => ({ available: false }),
    fetchMergesForPrs: async () => ({ merges: [], unmapped: [] }),
  },
  knowledgeApiUrl: "http://huginn.test",
  publicUrl: null,
  loadJiraIndex: async () => null,
  stampable: () => true,
});

const config = (over: Partial<StampConfig> = {}): StampConfig => ({
  bin,
  bun: "/bin/bash",
  rootsRaw: root,
  roots: [root],
  ...over,
});

/** Write the fake CLI. `body` is bash; it runs with the route's own argv. */
async function fakeCli(body: string): Promise<void> {
  await writeFile(bin, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(bin, 0o755);
}

function appWith(deps: StampRouteDeps = {}): Hono {
  const app = new Hono();
  registerWikiStampRoute(app, ctx(), {
    stampConfig: () => config(),
    isReadonly: () => false,
    isReadonlyRoot: () => false,
    ...deps,
  });
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request("/api/wiki/provenance/stamp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const stamp = (app: Hono) => post(app, { wiki: "w", relPath: REL, ref: NEW_REF });

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-stamp-"));
  bin = path.join(root, "..", `fake-wiki-stamp-${process.pid}.sh`);
  argvFile = path.join(root, "..", `fake-wiki-stamp-argv-${process.pid}.txt`);
  await writeFile(path.join(root, REL), PAGE, "utf8");
  __setWikiRegistryForTest([{ name: "w", root, source: "extra" }]);
});

afterEach(async () => {
  __resetWikiCacheForTest();
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await rm(argvFile, { force: true });
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(root, { recursive: true, force: true });
  await rm(bin, { force: true });
  await rm(argvFile, { force: true });
});

describe("the spawn", () => {
  test("is exactly the hook's own command line, plus --report", async () => {
    await fakeCli(`printf '%s\\n' "$@" > "${argvFile}"\n echo '{"outcome":"unchanged","reason":"already-stamped","path":"x"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(200);
    expect((await readFile(argvFile, "utf8")).trim().split("\n")).toEqual([
      "--session",
      NEW_REF,
      "--file",
      path.join(root, REL),
      "--report",
    ]);
  });

  test("the child environment carries BOTH PATH and WIKI_STAMP_ROOTS", async () => {
    // The trap: `{ WIKI_STAMP_ROOTS }` alone replaces the environment, drops
    // PATH, and lands every Stamp in the 502 bucket with an empty stderr.
    await fakeCli(
      `printf 'PATH=%s\\nROOTS=%s\\nHOME=%s\\n' "\${PATH:-missing}" "\${WIKI_STAMP_ROOTS:-missing}" "\${HOME:-missing}" > "${argvFile}"\n` +
        `echo '{"outcome":"unchanged","reason":"already-stamped","path":"x"}'`,
    );
    await stamp(appWith());
    const seen = await readFile(argvFile, "utf8");
    expect(seen).toContain(`ROOTS=${root}`);
    expect(seen).not.toContain("PATH=missing");
    expect(seen).not.toContain("HOME=missing");
  });
});

describe("the answer table", () => {
  test("a `written` report is 200 with the RE-RESOLVED provenance", async () => {
    // The fake CLI does what the real one does: append the ref and retire the
    // backfilled marker.
    await fakeCli(
      `f="${path.join(root, REL)}"\n` +
        `sed -i.bak "s|sessions: \\[claude-code:${STAMPED}\\]|sessions: [claude-code:${STAMPED}, ${NEW_REF}]|" "$f"\n` +
        `sed -i.bak "/^sessions_backfilled:/d" "$f"\n` +
        `rm -f "$f.bak"\n` +
        `echo '{"outcome":"written","path":"'"$f"'"}'`,
    );
    const res = await stamp(appWith());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("written");
    expect(body.provenance.sessions.map((s: { id: string }) => s.id)).toEqual([STAMPED, NEW_ID]);
    // The CLI retired the marker, so the `· inferred from history` tail is gone.
    expect(body.provenance.backfilled).toBeUndefined();
  });

  test("the index is REFRESHED before the re-resolve, so a cached one cannot answer stale", async () => {
    // Prime the cache with the pre-stamp frontmatter — this is exactly what a
    // page open a moment earlier does, and the TTL is five minutes.
    const before = await getWikiIndex({ root });
    expect(before!.resolveRelPath(REL)!.sessions).toEqual([`claude-code:${STAMPED}`]);
    await fakeCli(
      `f="${path.join(root, REL)}"\n` +
        `sed -i.bak "s|sessions: \\[claude-code:${STAMPED}\\]|sessions: [claude-code:${STAMPED}, ${NEW_REF}]|" "$f"\n` +
        `rm -f "$f.bak"\n` +
        `echo '{"outcome":"written","path":"'"$f"'"}'`,
    );
    const body = await (await stamp(appWith())).json();
    expect(body.provenance.sessions.map((s: { id: string }) => s.id)).toContain(NEW_ID);
  });

  test("an `unchanged` report is the same 200 — the append is idempotent", async () => {
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"x"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("unchanged");
    expect(body.provenance.sessions).toHaveLength(1);
  });

  test("a `skipped` report is 409 with the CLI's reason VERBATIM", async () => {
    await fakeCli(`echo '{"outcome":"skipped","reason":"outside-roots","path":"x"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("outside-roots");
  });

  test("a skipped report with no reason still answers 409 rather than 200", async () => {
    await fakeCli(`echo '{"outcome":"skipped","path":"x"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("skipped");
  });

  test("a non-JSON line before the report does not hide it", async () => {
    await fakeCli(
      `echo 'some warning from the runtime'\necho '{"outcome":"skipped","reason":"bom","path":"x"}'`,
    );
    expect((await (await stamp(appWith())).json()).reason).toBe("bom");
  });

  test("the LAST report line is the answer, not the first", async () => {
    // A `--report` run prints exactly one, but the rule is what makes the
    // parse robust to anything printed ahead of it — including something that
    // happens to be a report-shaped JSON object.
    await fakeCli(
      `echo '{"outcome":"written","path":"stale"}'\n` +
        `echo '{"outcome":"skipped","reason":"lock-timeout","path":"x"}'`,
    );
    const res = await stamp(appWith());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("lock-timeout");
  });

  test("no parseable report line is 502 with the exit code and the first stderr line", async () => {
    await fakeCli(`echo 'error: cannot find module' >&2\necho 'more detail' >&2\nexit 1`);
    const res = await stamp(appWith());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.exitCode).toBe(1);
    expect(body.stderr).toBe("error: cannot find module");
  });

  test("a zero exit with no report line is ALSO 502 — the exit code is not the answer", async () => {
    await fakeCli(`exit 0`);
    const res = await stamp(appWith());
    expect(res.status).toBe(502);
    expect((await res.json()).exitCode).toBe(0);
  });

  test("muninn's own spawn timeout is 409 `stamp-timeout`", async () => {
    await fakeCli(`sleep 5`);
    const res = await stamp(appWith({ timeoutMs: 120 }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("stamp-timeout");
  });
});

describe("the checks, in order, each BEFORE any spawn", () => {
  /** A CLI that must never run. */
  const explode = () => fakeCli(`echo '{"outcome":"written","path":"x"}' ; touch "${argvFile}"`);

  test("a traversal `relPath` is 400 and never spawns", async () => {
    await explode();
    const res = await post(appWith(), { wiki: "w", relPath: "../escape.md", ref: NEW_REF });
    expect(res.status).toBe(400);
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("an absolute `relPath` is 400", async () => {
    const res = await post(appWith(), { wiki: "w", relPath: "/etc/passwd.md", ref: NEW_REF });
    expect(res.status).toBe(400);
  });

  test("a non-markdown `relPath` is 400", async () => {
    const res = await post(appWith(), { wiki: "w", relPath: "notes.txt", ref: NEW_REF });
    expect(res.status).toBe(400);
  });

  test("an unknown wiki is 404", async () => {
    const res = await post(appWith(), { wiki: "nope", relPath: REL, ref: NEW_REF });
    expect(res.status).toBe(404);
  });

  test("a missing `relPath` or `ref` is 400", async () => {
    expect((await post(appWith(), { wiki: "w", relPath: REL })).status).toBe(400);
    expect((await post(appWith(), { wiki: "w", ref: NEW_REF })).status).toBe(400);
  });

  test("an omitted `wiki` means the DEFAULT wiki, as on every other /api/wiki route", async () => {
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"x"}'`);
    const res = await post(appWith(), { relPath: REL, ref: NEW_REF });
    expect(res.status).toBe(200);
  });

  test("a read-only INSTANCE is 403 and never spawns — the mini's shape", async () => {
    await explode();
    const res = await stamp(appWith({ isReadonly: () => true }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("MUNINN_WIKI_READONLY");
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("a read-only ROOT is 403", async () => {
    const res = await stamp(appWith({ isReadonlyRoot: () => true }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("WIKI_READONLY_ROOTS");
  });

  test("the traversal is refused BEFORE the read-only test — a path must resolve first", async () => {
    const res = await post(appWith({ isReadonly: () => true }), {
      wiki: "w",
      relPath: "../escape.md",
      ref: NEW_REF,
    });
    expect(res.status).toBe(400);
  });

  test("no WIKI_STAMP_BIN is 501 NAMING the variable", async () => {
    const res = await stamp(appWith({ stampConfig: () => config({ bin: null }) }));
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain("WIKI_STAMP_BIN");
  });

  test("no WIKI_STAMP_ROOTS is 501 naming that one", async () => {
    const res = await stamp(appWith({ stampConfig: () => config({ rootsRaw: null, roots: [] }) }));
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain("WIKI_STAMP_ROOTS");
  });

  test("501 comes AFTER the read-only 403 — an unwritable instance is unwritable however it is configured", async () => {
    const res = await stamp(
      appWith({ isReadonly: () => true, stampConfig: () => config({ bin: null }) }),
    );
    expect(res.status).toBe(403);
  });
});
