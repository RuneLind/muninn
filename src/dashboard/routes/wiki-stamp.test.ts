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
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest, getWikiIndex } from "../../wiki/store.ts";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  decideStampRequest,
  registerWikiStampRoute,
  stampChildEnv,
  STAMP_CHILD_ENV_NAMES,
  __resetStampRefusalWarnsForTest,
  type StampRouteDeps,
} from "./wiki-stamp.ts";
import { ProcTimeoutError } from "../../utils/run-proc.ts";
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

const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/wiki/provenance/stamp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
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
    await fakeCli(`printf '%s\\n' "$@" > "${argvFile}"\n echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(200);
    expect((await readFile(argvFile, "utf8")).trim().split("\n")).toEqual([
      "--session",
      NEW_REF,
      "--file",
      // The REALPATH, not `path.join(root, REL)`: on macOS a `mkdtemp` under
      // `/var/folders` is itself a symlink to `/private/var/folders`, and the
      // route resolves before it spawns so its gate and the CLI's classification
      // are asking about the same bytes.
      path.join(realpathSync(root), REL),
      "--report",
    ]);
  });

  test("the child environment is an ALLOWLIST: PATH and WIKI_STAMP_ROOTS in, DATABASE_URL out", async () => {
    // TWO failures in one assertion, and they pull in opposite directions.
    // `{ WIKI_STAMP_ROOTS }` alone REPLACES the environment, drops PATH, and
    // lands every Stamp in the 502 bucket with an empty stderr — so PATH has to
    // be there. `{ ...process.env, … }` hands a `.ts` file chosen by an env var
    // everything muninn holds — how much is measured once, in `stampChildEnv`'s
    // docstring, and this comment carries no count of its own: two independent
    // counts of one machine's `process.env` disagreed, which is how a second
    // number gets into the repo.
    const prior = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://muninn:muninn@127.0.0.1:5435/muninn";
    try {
      await fakeCli(
        `printf 'PATH=%s\\nROOTS=%s\\nHOME=%s\\nDB=%s\\n' "\${PATH:-missing}" "\${WIKI_STAMP_ROOTS:-missing}" "\${HOME:-missing}" "\${DATABASE_URL:-ABSENT}" > "${argvFile}"\n` +
          `echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`,
      );
      await stamp(appWith());
      const seen = await readFile(argvFile, "utf8");
      expect(seen).toContain(`ROOTS=${root}`);
      expect(seen).not.toContain("PATH=missing");
      expect(seen).not.toContain("HOME=missing");
      // The one that matters: the name is SET in this process and absent in the
      // child. Asserted on the sentinel rather than on `not.toContain("muninn")`,
      // which the roots line would satisfy on its own.
      expect(seen).toContain("DB=ABSENT");
    } finally {
      if (prior === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prior;
    }
  });

  test("a spawn that THROWS is 502, not the timeout's 409", async () => {
    // `Bun.spawn` throws synchronously for an argv it cannot build. The two used
    // to share a catch, so a NUL in `ref` — which fails in ~10 ms — was reported
    // as "the stamp CLI did not return" and sent an operator looking for a
    // wedged child that never existed.
    const res = await stamp(
      appWith({
        runProc: async () => {
          throw new TypeError("Invalid argument: contains a null byte");
        },
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.exitCode).toBeNull();
    expect(body.error).toContain("null byte");
  });

  test("and the timeout keeps its own 409 — the two are told apart by TYPE", async () => {
    const res = await stamp(
      appWith({
        runProc: async () => {
          throw new ProcTimeoutError("wiki-stamp", 15_000);
        },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("stamp-timeout");
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
        `echo '{"outcome":"written","path":"'"$4"'"}'`,
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
        `echo '{"outcome":"written","path":"'"$4"'"}'`,
    );
    const body = await (await stamp(appWith())).json();
    expect(body.provenance.sessions.map((s: { id: string }) => s.id)).toContain(NEW_ID);
  });

  test("an `unchanged` report is the same 200 — the append is idempotent", async () => {
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("unchanged");
    expect(body.provenance.sessions).toHaveLength(1);
  });

  test("a `skipped` report is 409 with the CLI's reason VERBATIM", async () => {
    await fakeCli(`echo '{"outcome":"skipped","reason":"outside-roots","path":"'"$4"'"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("outside-roots");
  });

  test("a skipped report with no reason still answers 409 rather than 200", async () => {
    await fakeCli(`echo '{"outcome":"skipped","path":"'"$4"'"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("skipped");
  });

  test("a non-JSON line before the report does not hide it", async () => {
    await fakeCli(
      `echo 'some warning from the runtime'\necho '{"outcome":"skipped","reason":"bom","path":"'"$4"'"}'`,
    );
    expect((await (await stamp(appWith())).json()).reason).toBe("bom");
  });

  test("the LAST report line is the answer, not the first", async () => {
    // A `--report` run prints exactly one, but the rule is what makes the
    // parse robust to anything printed ahead of it — including something that
    // happens to be a report-shaped JSON object.
    await fakeCli(
      `echo '{"outcome":"written","path":"stale"}'\n` +
        `echo '{"outcome":"skipped","reason":"lock-timeout","path":"'"$4"'"}'`,
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
  const explode = () => fakeCli(`echo '{"outcome":"written","path":"'"$4"'"}' ; touch "${argvFile}"`);

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
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
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

describe("the root-equality rule, SERVER-side", () => {
  /** A CLI that must never run. */
  const explode = () => fakeCli(`echo '{"outcome":"written","path":"'"$4"'"}' ; touch "${argvFile}"`);

  test("a wiki NESTED under a stamp root is refused 409 and never spawns", async () => {
    // The measured hole: with WIKI_STAMP_ROOTS = <parent> and the wiki
    // registered at <parent>/sub, the route answered `200 written` while the
    // same instance's payload said `stampable: false`. Two writers of one
    // frontmatter line, holding two different lock files.
    await explode();
    const parent = path.dirname(root);
    const res = await stamp(
      appWith({ stampConfig: () => config({ rootsRaw: parent, roots: [parent] }) }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("not-a-stamp-root");
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("a sibling root with a shared PREFIX is refused too", async () => {
    await explode();
    const sibling = `${root}-old`;
    const res = await stamp(
      appWith({ stampConfig: () => config({ rootsRaw: sibling, roots: [sibling] }) }),
    );
    expect(res.status).toBe(409);
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("the 409 comes AFTER the 501s — a missing variable is still named first", async () => {
    const parent = path.dirname(root);
    const res = await stamp(
      appWith({ stampConfig: () => config({ bin: null, rootsRaw: parent, roots: [parent] }) }),
    );
    expect(res.status).toBe(501);
  });

  test("the wiki's own root passes, spelled through a SYMLINK to it", async () => {
    // `isStampRoot` goes through `sameWikiRoot`, so a stamp root spelled as a
    // link to the wiki root is the same root. On macOS this is not hypothetical:
    // every `mkdtemp` under `/var/folders` is reached through one.
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
    const real = realpathSync(root);
    const res = await stamp(appWith({ stampConfig: () => config({ rootsRaw: real, roots: [real] }) }));
    expect(res.status).toBe(200);
  });
});

describe("the route-local CSRF check", () => {
  const explode = () => fakeCli(`echo '{"outcome":"written","path":"'"$4"'"}' ; touch "${argvFile}"`);

  test("decideStampRequest: same-origin JSON passes", () => {
    expect(
      decideStampRequest({
        contentType: "application/json",
        secFetchSite: "same-origin",
        origin: "http://127.0.0.1:3010",
        host: "127.0.0.1:3010",
      }),
    ).toBeNull();
  });

  test("decideStampRequest: a charset parameter is still application/json", () => {
    expect(
      decideStampRequest({ contentType: "application/json; charset=utf-8", host: "x" }),
    ).toBeNull();
  });

  test("decideStampRequest: no browser headers at all passes — curl and the health check send none", () => {
    expect(decideStampRequest({ contentType: "application/json" })).toBeNull();
  });

  test("decideStampRequest refuses the three types a no-cors fetch MAY set", () => {
    for (const type of [
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded",
      "",
    ]) {
      const out = decideStampRequest({ contentType: type, host: "x" });
      expect(out?.status).toBe(415);
      expect(out?.reason).toBe("unsupported-content-type");
    }
  });

  test("decideStampRequest refuses cross-site and same-site Sec-Fetch-Site", () => {
    for (const site of ["cross-site", "same-site", "Cross-Site"]) {
      const out = decideStampRequest({
        contentType: "application/json",
        secFetchSite: site,
        host: "127.0.0.1:3010",
      });
      expect(out?.status).toBe(403);
      expect(out?.reason).toBe("cross-origin");
    }
    // `none` is a user-initiated navigation and `same-origin` is this page.
    expect(
      decideStampRequest({ contentType: "application/json", secFetchSite: "none", host: "x" }),
    ).toBeNull();
  });

  test("decideStampRequest refuses an Origin that is not the request's own authority", () => {
    const out = decideStampRequest({
      contentType: "application/json",
      origin: "http://evil.example",
      host: "127.0.0.1:3010",
    });
    expect(out?.status).toBe(403);
    // `Origin: null` — a sandboxed iframe, a redirected cross-origin POST.
    expect(
      decideStampRequest({ contentType: "application/json", origin: "null", host: "127.0.0.1:3010" })
        ?.status,
    ).toBe(403);
    // The scheme is NOT compared: a reverse proxy terminates TLS, so the
    // browser's https says nothing about muninn's own http.
    expect(
      decideStampRequest({
        contentType: "application/json",
        origin: "https://muninn.tailnet.ts.net",
        host: "muninn.tailnet.ts.net",
      }),
    ).toBeNull();
  });

  test("the ROUTE refuses a cross-origin Origin with 403 and never spawns", async () => {
    await explode();
    const res = await post(
      appWith(),
      { wiki: "w", relPath: REL, ref: NEW_REF },
      { origin: "http://evil.example", host: "127.0.0.1:3010" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("cross-origin");
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("the ROUTE refuses a text/plain body with 415 and never spawns", async () => {
    // The measured attack under MUNINN_AUTH=off, verbatim: a no-cors fetch needs
    // no preflight and this is the content type it is allowed to set.
    await explode();
    const res = await appWith().request("/api/wiki/provenance/stamp", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ wiki: "w", relPath: REL, ref: NEW_REF }),
    });
    expect(res.status).toBe(415);
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("the ROUTE proceeds on same-origin JSON", async () => {
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
    const res = await post(
      appWith(),
      { wiki: "w", relPath: REL, ref: NEW_REF },
      { origin: "http://127.0.0.1:3010", host: "127.0.0.1:3010", "sec-fetch-site": "same-origin" },
    );
    expect(res.status).toBe(200);
  });

  test("the shape `tailscale serve` actually produces passes — measured, not assumed", async () => {
    // MEASURED 2026-09-17 on the author's laptop: the proxy passes `Host:`
    // through UNCHANGED as the tailnet name, adds `X-Forwarded-Host` carrying
    // the same value and `X-Forwarded-Proto: https`, and the browser's `Origin`
    // is `https://<that host>`. So rule 3 sees one authority under two schemes,
    // which is the case `originMatchesHost` compares host+port for. Asserted at
    // BOTH levels: the pure decision, and a real request through the route, so
    // a header muninn reads differently from the way it is spelled here cannot
    // hide behind the unit call.
    const proxied = {
      host: "rune-macbook-pro-m4-max.tail7b311e.ts.net",
      origin: "https://rune-macbook-pro-m4-max.tail7b311e.ts.net",
      "x-forwarded-host": "rune-macbook-pro-m4-max.tail7b311e.ts.net",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    };
    expect(
      decideStampRequest({
        contentType: "application/json",
        secFetchSite: proxied["sec-fetch-site"],
        origin: proxied.origin,
        host: proxied.host,
      }),
    ).toBeNull();
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
    const res = await post(appWith(), { wiki: "w", relPath: REL, ref: NEW_REF }, proxied);
    expect(res.status).toBe(200);
  });

  test("a REFUSED request warns ONCE per reason and drops to info after that", async () => {
    // Every refusal used to mint a `warn`, and these are exactly the requests a
    // cross-origin page makes — a loop on another origin filled the JSONL sink.
    // The line must not disappear either, so the second one is asserted as an
    // `info` rather than as an absence.
    __resetStampRefusalWarnsForTest();
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      const app = appWith();
      const body = { wiki: "w", relPath: REL, ref: NEW_REF };
      const evil = { origin: "http://evil.example", host: "127.0.0.1:3010" };
      expect((await post(app, body, evil)).status).toBe(403);
      expect((await post(app, body, evil)).status).toBe(403);
      const mine = records.filter((r) => r.category.join("/") === "muninn/wiki/stamp");
      expect(mine.map((r) => r.level)).toEqual(["warning", "info"]);
      // A DIFFERENT reason gets its own warn — the key is the reason, not a
      // single global "this route has warned once".
      const res = await app.request("/api/wiki/provenance/stamp", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(415);
      expect(
        records
          .filter((r) => r.category.join("/") === "muninn/wiki/stamp" && r.level === "warning")
          .map((r) => (r.properties as { reason?: string }).reason),
      ).toEqual(["cross-origin", "unsupported-content-type"]);
    } finally {
      await reset();
      __resetStampRefusalWarnsForTest();
    }
  });
});

describe("the ref shape pre-check", () => {
  const explode = () => fakeCli(`echo '{"outcome":"written","path":"'"$4"'"}' ; touch "${argvFile}"`);

  test("a ref the CLI's own regex would refuse is 400 and never spawns", async () => {
    await explode();
    for (const bad of [
      "claude-code", // no colon
      "Claude-Code:abc", // the provider is lowercase
      "claude-code:has space",
      `claude-code:${"x".repeat(129)}`,
      "claude-code:has\nnewline", // would split this route's own log line
      "claude-code:has\u0000nul", // Bun.spawn throws SYNCHRONOUSLY for this
    ]) {
      const res = await post(appWith(), { wiki: "w", relPath: REL, ref: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("bad-ref");
    }
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("the shapes the CLI accepts pass the pre-check", async () => {
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
    for (const ok of [`claude-code:${NEW_ID}`, "opencode:ses_7f3a9b2c1d", "x:a"]) {
      expect((await post(appWith(), { wiki: "w", relPath: REL, ref: ok })).status).toBe(200);
    }
  });
});

describe("realpath containment", () => {
  const explode = () => fakeCli(`echo '{"outcome":"written","path":"'"$4"'"}' ; touch "${argvFile}"`);

  test("a symlink inside the wiki pointing OUTSIDE it is 400 and never spawns", async () => {
    // `isPathConfined` is lexical, so this page passes it. The CLI would then
    // read the target and rename over the link — destroying the link and copying
    // an outside page in.
    const outsideDir = await mkdtemp(path.join(tmpdir(), "muninn-stamp-outside-"));
    const outside = path.join(outsideDir, "secret.md");
    await writeFile(outside, "---\ntype: plan\ntitle: Outside\n---\n", "utf8");
    const link = path.join(root, "link.md");
    await symlink(outside, link);
    try {
      await explode();
      const res = await post(appWith(), { wiki: "w", relPath: "link.md", ref: NEW_REF });
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("outside-root");
      expect(await Bun.file(argvFile).exists()).toBe(false);
    } finally {
      await rm(link, { force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("a symlink to a SIBLING directory sharing the root's prefix is refused", async () => {
    // The containment test is a prefix test, and a prefix test with no
    // separator lets `<root>-evil/x.md` through — a directory whose NAME starts
    // with the root's. Lexical confinement cannot reach it, a symlink can.
    const sibling = `${realpathSync(root)}-evil`;
    await mkdir(sibling, { recursive: true });
    const outside = path.join(sibling, "x.md");
    await writeFile(outside, "---\ntype: plan\ntitle: Sibling\n---\n", "utf8");
    const link = path.join(root, "sibling.md");
    await symlink(outside, link);
    try {
      await explode();
      const res = await post(appWith(), { wiki: "w", relPath: "sibling.md", ref: NEW_REF });
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("outside-root");
      expect(await Bun.file(argvFile).exists()).toBe(false);
    } finally {
      await rm(link, { force: true });
      await rm(sibling, { recursive: true, force: true });
    }
  });

  test("a page whose DIRECTORY is not on disk reads as `no such page`, not as a traversal", async () => {
    // The CLI's own `realOf` keeps a path whose directory does not resolve and
    // lets `existsSync` answer `missing-file`; muninn used to answer
    // `400 outside-root` for it, so a typo'd folder read as an escape attempt.
    // The CLI is still the authority on "no such page" — muninn spawns it and
    // relays the 409.
    await fakeCli(
      `printf '%s\\n' "$@" > "${argvFile}"\n` +
        `echo '{"outcome":"skipped","reason":"missing-file","path":"'"$4"'"}'`,
    );
    const res = await post(appWith(), { wiki: "w", relPath: "nosuchdir/page.md", ref: NEW_REF });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("missing-file");
    // …and the path it was handed is anchored in the RESOLVED root, with the
    // missing tail re-appended: on macOS the wiki really lives under
    // `/private/var/…`, and handing over the spelled `/var/…` form would make
    // the CLI's own containment test refuse the page for being outside its root.
    const argv = (await readFile(argvFile, "utf8")).trim().split("\n");
    expect(argv[3]).toBe(path.join(realpathSync(root), "nosuchdir/page.md"));
  });

  test("a symlink to a page INSIDE the wiki is fine, and the CLI is handed the target", async () => {
    const link = path.join(root, "alias.md");
    await symlink(path.join(root, REL), link);
    try {
      await fakeCli(
        `printf '%s\\n' "$@" > "${argvFile}"\n` +
          `echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`,
      );
      const res = await post(appWith(), { wiki: "w", relPath: "alias.md", ref: NEW_REF });
      expect(res.status).toBe(200);
      const argv = (await readFile(argvFile, "utf8")).trim().split("\n");
      expect(argv[3]).toBe(path.join(realpathSync(root), REL));
    } finally {
      await rm(link, { force: true });
    }
  });
});

describe("resolving which wiki", () => {
  test("a non-string `wiki` is 400, never a silent write to the DEFAULT wiki", async () => {
    for (const bad of [3, true, { name: "w" }, ["w"]]) {
      const res = await post(appWith(), { wiki: bad, relPath: REL, ref: NEW_REF });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("wiki must be a string");
    }
  });

  test("the WIKI_DIR env-override shape resolves rather than 404ing", async () => {
    // `resolveWikiRequest` returns `{envOverride: true, entry: undefined}` here,
    // so a guard keyed on the entry answered "no wiki configured for that name"
    // on an instance where no name was sent.
    __setWikiRegistryForTest([]);
    const prior = process.env.WIKI_DIR;
    process.env.WIKI_DIR = root;
    try {
      __resetWikiCacheForTest();
      await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped","path":"'"$4"'"}'`);
      const res = await post(appWith(), { relPath: REL, ref: NEW_REF });
      expect(res.status).toBe(200);
      expect((await res.json()).outcome).toBe("unchanged");
    } finally {
      if (prior === undefined) delete process.env.WIKI_DIR;
      else process.env.WIKI_DIR = prior;
      __setWikiRegistryForTest([{ name: "w", root, source: "extra" }]);
      __resetWikiCacheForTest();
    }
  });
});

describe("the report's own path", () => {
  test("a report naming a DIFFERENT file is 502, not a green Stamp", async () => {
    await fakeCli(`echo '{"outcome":"written","path":"/somewhere/else.md"}'`);
    const res = await stamp(appWith());
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe("path-mismatch");
  });

  test("a report with NO path is tolerated — an older CLI printed none", async () => {
    await fakeCli(`echo '{"outcome":"unchanged","reason":"already-stamped"}'`);
    expect((await stamp(appWith())).status).toBe(200);
  });
});

describe("stampChildEnv", () => {
  test("keeps only the three runtime names plus WIKI_STAMP_ROOTS", () => {
    const env = stampChildEnv("/a:/b", {
      PATH: "/usr/bin",
      HOME: "/home/x",
      TMPDIR: "/tmp/",
      DATABASE_URL: "postgresql://…",
      TELEGRAM_BOT_TOKEN_JARVIS: "secret",
      ANTHROPIC_API_KEY: "sk-…",
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "TMPDIR", "WIKI_STAMP_ROOTS"]);
    expect(env.WIKI_STAMP_ROOTS).toBe("/a:/b");
  });

  test("an unset inherited name is simply absent — never an undefined value", () => {
    // `{TMPDIR: undefined}` reaching `Bun.spawn` is not the same as omitting the
    // key. Asserted on KEYS: `toEqual` treats `{a: 1, b: undefined}` and
    // `{a: 1}` as equal, so an object comparison here is a can't-fail assertion
    // — measured, the mutant that writes every name through survived it.
    const env = stampChildEnv("/a", { PATH: "/usr/bin" });
    expect(Object.keys(env).sort()).toEqual(["PATH", "WIKI_STAMP_ROOTS"]);
    expect(env).toEqual({ PATH: "/usr/bin", WIKI_STAMP_ROOTS: "/a" });
  });

  test("the allowlist is the one in STAMP_CHILD_ENV_NAMES", () => {
    expect([...STAMP_CHILD_ENV_NAMES]).toEqual(["PATH", "HOME", "TMPDIR"]);
  });
});

describe("the { tracker, key } form (Connections' Link)", () => {
  let troot = "";
  const TREL = "notes/demo.md";
  const TPAGE = "---\ntitle: DEMO-101 notater\ntags: [demo-120]\n---\n\n# Notater\n";
  const tconfig = () => config({ rootsRaw: troot, roots: [troot] });
  const tapp = (deps: StampRouteDeps = {}) => appWith({ stampConfig: tconfig, ...deps });
  const link = (app: Hono, body: Record<string, unknown> = {}) =>
    post(app, { wiki: "t", relPath: TREL, tracker: "jira", key: "DEMO-120", ...body });
  /** A fake CLI that appends `jira: [KEY]` when absent, like the real one. */
  const writingCli = () =>
    fakeCli(
      [
        `printf '%s\\n' "$@" > "${argvFile}"`,
        'key="$2"; file="$4"',
        'if grep -q "^jira:" "$file"; then echo \'{"outcome":"unchanged","reason":"already-stamped","path":"\'"$file"\'"}\'; exit 0; fi',
        'sed -i.bak "s|^title:|jira: [$key]\\ntitle:|" "$file"; rm -f "$file.bak"',
        'echo \'{"outcome":"written","path":"\'"$file"\'"}\'',
      ].join("\n"),
    );

  beforeAll(async () => {
    troot = await mkdtemp(path.join(tmpdir(), "muninn-stamp-trk-"));
    await mkdir(path.join(troot, "notes"), { recursive: true });
    await writeFile(path.join(troot, TREL), TPAGE, "utf8");
    await writeFile(
      path.join(troot, ".wiki-reader.json"),
      JSON.stringify({ trackers: [{ id: "jira", projects: ["DEMO"], hosts: ["example.invalid"] }] }),
      "utf8",
    );
    __setWikiRegistryForTest([
      { name: "w", root, source: "extra" },
      { name: "t", root: troot, source: "extra" },
    ]);
  });
  afterEach(async () => {
    await writeFile(path.join(troot, TREL), TPAGE, "utf8");
  });
  afterAll(async () => {
    __setWikiRegistryForTest([{ name: "w", root, source: "extra" }]);
    await rm(troot, { recursive: true, force: true });
  });

  test("spawns the adapter's own flag with the normalized key", async () => {
    await writingCli();
    const res = await link(tapp(), { key: " demo-120 " });
    expect(res.status).toBe(200);
    const argv = (await readFile(argvFile, "utf8")).trim().split("\n");
    expect(argv.slice(0, 3)).toEqual(["--jira", "DEMO-120", "--file"]);
    expect(argv.at(-1)).toBe("--report");
  });

  test("a written Link answers the re-resolved block with the key now STAMPED", async () => {
    await writingCli();
    const body = (await (await link(tapp())).json()) as {
      outcome: string;
      provenance?: { issues?: { key: string; relations: string[] }[] };
    };
    expect(body.outcome).toBe("written");
    expect(body.provenance?.issues?.find((r) => r.key === "DEMO-120")?.relations[0]).toBe("stamped");
  });

  test("`unchanged` is a 200 and REFRESHES the index too — a hand edit the cache has not seen", async () => {
    await writingCli();
    // Warm the cache on the page as it is, then edit it behind the cache.
    await getWikiIndex({ root: troot, refresh: true });
    await writeFile(path.join(troot, TREL), TPAGE.replace("title:", "jira: [DEMO-120]\ntitle:"), "utf8");
    const res = await link(tapp());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; provenance?: { issues?: { key: string; relations: string[] }[] } };
    expect(body.outcome).toBe("unchanged");
    expect(body.provenance?.issues?.find((r) => r.key === "DEMO-120")?.relations[0]).toBe("stamped");
  });

  test("a skip is 409 with the CLI's reason — the row's named state", async () => {
    await fakeCli(`echo '{"outcome":"skipped","reason":"not-inline-list","path":"'"$4"'"}'`);
    const res = await link(tapp());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("not-inline-list");
  });

  test("a key the adapter's keyPattern refuses, an unknown tracker, or both forms at once: 400, no spawn", async () => {
    await fakeCli(`printf x > "${argvFile}"; exit 1`);
    for (const body of [{ key: "not a key" }, { key: "DEMO-12x" }, { tracker: "nope" }, { tracker: 3 }, { ref: NEW_REF }]) {
      const res = await link(tapp(), body);
      expect(res.status).toBe(400);
    }
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("a wiki whose .wiki-reader.json names no such tracker is refused 409 and never spawns", async () => {
    await fakeCli(`printf x > "${argvFile}"; exit 1`);
    const res = await post(appWith(), { wiki: "w", relPath: REL, tracker: "jira", key: "DEMO-120" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("no-tracker");
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });

  test("every guard applies unchanged: a read-only root is 403", async () => {
    await fakeCli(`printf x > "${argvFile}"; exit 1`);
    const res = await link(tapp({ isReadonlyRoot: () => true }));
    expect(res.status).toBe(403);
    expect(await Bun.file(argvFile).exists()).toBe(false);
  });
});
