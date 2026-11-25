/**
 * `GET /api/wiki/mentions` (Discuss v2 PR 2) on a real temp git repo: files
 * with page titles, commits, `log.md` entries with their date and kind, PR refs
 * resolved through the wiki's `prGrammar`, key kinds from `trackers` and
 * `keys`, and the background `gh` refresh (one flight at a time with one
 * follow-up for what arrived meanwhile, an unanswered repo left alone for a
 * few minutes, never on a read-only root, never with the check off). The nais half is in `routes-profile.test.ts`.
 * The second block pins the bounds (exactly 50 commits is not truncated, the
 * totals count past the line cap), `log.md` searched on its own budget, refs
 * read past the 300-character display cut, and that every read goes through
 * the tracked-files seam.
 * Invented content only.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { MENTION_UNANSWERED_RETRY_MS, __mentionPrsSettledForTest, __resetGhCheckForTest, type GhResult } from "../../wiki/work-map/gh-check.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { registerWikiMentionsRoute, type WikiMentionsRouteDeps } from "./wiki-mentions.ts";
import { MENTIONS_MAX_COMMITS, MENTIONS_MAX_LINES, type MentionsBody } from "../../wiki/mentions.ts";

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
  await put("plans/gamma.md", "# Gamma\n\nCASE-8 waits on api #13.\n");
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
    // A state for every number asked: #12 merged, any other open.
    const repository = Object.fromEntries(
      [...args.join(" ").matchAll(/p(\d+):pullRequest/g)].map(([, n]) => [`p${n}`, n === "12" ? { state: "MERGED", mergedAt: "2026-11-04T10:00:00Z" } : { state: "OPEN", mergedAt: null }]),
    );
    return { exitCode: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
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

  test("a miss while a flight runs is asked once that flight ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, calls } = appWith({}, { gate });
    await get(app, `wiki=${WIKI}&key=CASE-7`); // starts the flight for acme-api#12 and acme-web#40
    await get(app, `wiki=${WIKI}&key=CASE-8`); // acme-api#13 while it runs
    expect(calls.length).toBe(2);
    release();
    await __mentionPrsSettledForTest(WIKI);
    expect(calls.length).toBe(3);
    expect(calls[2]!.join(" ")).toContain("p13:pullRequest");
    const body = (await (await get(app, `wiki=${WIKI}&key=CASE-8`)).json()) as MentionsBody;
    expect(body.prs.map((p) => [p.number, p.state, p.stale])).toEqual([[13, "open", false]]);
    await __mentionPrsSettledForTest(WIKI);
    expect(calls.length).toBe(3);
  });

  const unanswering: [string, GhResult][] = [
    ["a timeout", { exitCode: -1, stdout: "", stderr: "", timedOut: true }],
    ["exit 1 with stdout that is no JSON", { exitCode: 1, stdout: "<html>bad gateway</html>", stderr: "HTTP 502" }],
    ["an answer with none of the aliases", { exitCode: 0, stdout: JSON.stringify({ data: { repository: {} } }), stderr: "" }],
  ];
  for (const [what, result] of unanswering) {
    test(`an unanswered query (${what}) is not asked again by the next request`, async () => {
      let n = 0;
      const app = new Hono();
      registerWikiMentionsRoute(app, {
        registry: () => [{ name: WIKI, root } as never],
        index: (r) => getWikiIndex({ root: r }),
        gh: () => ({ runGh: async () => (n++, result), disabled: () => false }),
        isReadonlyRoot: () => false,
        now: Date.now,
        authMode: () => "off",
      });
      await get(app, `wiki=${WIKI}&key=CASE-8`);
      await __mentionPrsSettledForTest(WIKI);
      expect(n).toBe(1);
      const body = (await (await get(app, `wiki=${WIKI}&key=CASE-8`)).json()) as MentionsBody;
      await __mentionPrsSettledForTest(WIKI);
      expect(n).toBe(1);
      expect(body.prs.map((p) => [p.state, p.stale])).toEqual([["unknown", true]]);
    });
  }

  test("an unanswered repo is asked again once the retry window has passed", async () => {
    let n = 0;
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const app = new Hono();
    registerWikiMentionsRoute(app, {
      registry: () => [{ name: WIKI, root } as never],
      index: (r) => getWikiIndex({ root: r }),
      gh: () => ({ runGh: async () => (n++, { exitCode: -1, stdout: "", stderr: "", timedOut: true }), disabled: () => false }),
      isReadonlyRoot: () => false,
      now: () => clock,
      authMode: () => "off",
    });
    await get(app, `wiki=${WIKI}&key=CASE-8`);
    await __mentionPrsSettledForTest(WIKI);
    clock += MENTION_UNANSWERED_RETRY_MS - 1;
    await get(app, `wiki=${WIKI}&key=CASE-8`);
    await __mentionPrsSettledForTest(WIKI);
    expect(n).toBe(1);
    clock += 1;
    await get(app, `wiki=${WIKI}&key=CASE-8`);
    await __mentionPrsSettledForTest(WIKI);
    expect(n).toBe(2);
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

  test("a failed repo stays skipped for the hour, past the unanswered retry window", async () => {
    let n = 0;
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const app = new Hono();
    registerWikiMentionsRoute(app, {
      registry: () => [{ name: WIKI, root } as never],
      index: (r) => getWikiIndex({ root: r }),
      gh: () => ({ runGh: async () => (n++, { exitCode: 4, stdout: "", stderr: "gh auth login" }), disabled: () => false }),
      isReadonlyRoot: () => false,
      now: () => clock,
      authMode: () => "off",
    });
    await get(app, `wiki=${WIKI}&key=CASE-8`);
    await __mentionPrsSettledForTest(WIKI);
    clock += MENTION_UNANSWERED_RETRY_MS + 1;
    await get(app, `wiki=${WIKI}&key=CASE-8`);
    await __mentionPrsSettledForTest(WIKI);
    expect(n).toBe(1);
  });

  test("the follow-up skips a repo the flight before it found failing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    const app = new Hono();
    registerWikiMentionsRoute(app, {
      registry: () => [{ name: WIKI, root } as never],
      index: (r) => getWikiIndex({ root: r }),
      gh: () => ({ runGh: async (args) => (calls.push(args), await gate, { exitCode: 4, stdout: "", stderr: "gh auth login" }), disabled: () => false }),
      isReadonlyRoot: () => false,
      now: Date.now,
      authMode: () => "off",
    });
    await get(app, `wiki=${WIKI}&key=CASE-7`); // acme-api#12 and acme-web#40, held
    await get(app, `wiki=${WIKI}&key=CASE-8`); // acme-api#13 waits
    release();
    await __mentionPrsSettledForTest(WIKI);
    expect(calls.length).toBe(2); // acme-api failed, so #13 is not due
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

describe("GET /api/wiki/mentions: bounds, totals, the log and long lines", () => {
  const BUSY_WIKI = "mentions-busy";
  let busy = "";
  async function bgit(...args: string[]) {
    const res = await realGit(busy, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
    if (!res.ok) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  }
  async function bput(rel: string, text: string) {
    await mkdir(path.dirname(path.join(busy, rel)), { recursive: true });
    await writeFile(path.join(busy, rel), text);
  }
  const filler = "y".repeat(310);

  beforeAll(async () => {
    busy = path.join(await realpath(await testTempDir(path.join(tmpdir(), "muninn-mentions-busy-"))), "wiki");
    await mkdir(busy, { recursive: true });
    await bgit("init", "-q", "-b", "main");
    await bput(".wiki-reader.json", JSON.stringify(READER_CONFIG));
    // archive/ sorts before log.md and holds more matching lines than the cap.
    await bput("archive/old.md", Array.from({ length: MENTIONS_MAX_LINES + 100 }, (_, i) => `BUSY-1 line ${i}`).join("\n") + "\n");
    await bput("log.md", "# Log\n\n## [2026-10-01] build | BUSY-1 begins\nbody\n\n## [2026-10-02] decide | other\nThen BUSY-1 again, after api #13.\n");
    await bput("plans/long.md", `# Long\n\nLONG-1 ${filler} then api #12 settles it.\n`);
    await bgit("add", "-A");
    await bgit("commit", "-q", "-m", "busy and long");
    // EXACT-1 changes in exactly MENTIONS_MAX_COMMITS commits, MORE-1 in one more.
    let counter = "";
    for (let i = 0; i < MENTIONS_MAX_COMMITS + 1; i++) {
      counter += i < MENTIONS_MAX_COMMITS ? `EXACT-1 MORE-1 ${i}\n` : `MORE-1 ${i}\n`;
      await bput("counter.md", counter);
      await bgit("add", "counter.md");
      await bgit("commit", "-q", "-m", `count ${i}`);
    }
  });

  function busyApp(git?: GitRun) {
    const app = new Hono();
    registerWikiMentionsRoute(app, {
      registry: () => [{ name: BUSY_WIKI, root: busy } as never],
      index: (r) => getWikiIndex({ root: r }),
      gh: () => ({ runGh: async () => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }), disabled: () => true }),
      isReadonlyRoot: () => false,
      now: Date.now,
      authMode: () => "off",
      git,
    });
    return app;
  }
  const body = async (app: Hono, key: string) => (await (await get(app, `wiki=${BUSY_WIKI}&key=${key}`)).json()) as MentionsBody;

  test("exactly MENTIONS_MAX_COMMITS commits is not truncated; one more is", async () => {
    const app = busyApp();
    const exact = await body(app, "EXACT-1");
    expect([exact.commits.length, exact.truncated]).toEqual([MENTIONS_MAX_COMMITS, false]);
    const more = await body(app, "MORE-1");
    expect([more.commits.length, more.truncated]).toEqual([MENTIONS_MAX_COMMITS, true]);
  });

  test("the totals count every matching line and file, past the line cap", async () => {
    const b = await body(busyApp(), "BUSY-1");
    expect(b.files.reduce((n, f) => n + f.lines.length, 0)).toBe(MENTIONS_MAX_LINES);
    expect([b.totalLines, b.totalFiles, b.totalsAtLeast, b.truncated]).toEqual([MENTIONS_MAX_LINES + 102, 2, false, true]);
  });

  test("log.md is searched on its own budget: files earlier in git's order cannot use it up", async () => {
    const b = await body(busyApp(), "BUSY-1");
    expect(b.files.map((f) => f.relPath)).toEqual(["archive/old.md"]);
    expect(b.log).toEqual([
      { date: "2026-10-01", kind: "build", line: "## [2026-10-01] build | BUSY-1 begins", n: 3 },
      { date: "2026-10-02", kind: "decide", line: "Then BUSY-1 again, after api #13.", n: 7 },
    ]);
    // A ref on a log line past the whole-wiki cap is still read.
    expect(b.prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["acme/acme-api#13"]);
  });

  test("a whole-wiki search stopped at its scan bound makes the totals lower bounds", async () => {
    const capped: GitRun = async (cwd, args, opts) => {
      const res = await realGit(cwd, args, opts);
      return args.includes("grep") && args.at(-1) === "." ? { ...res, capped: true } : res;
    };
    const b = await body(busyApp(capped), "BUSY-1");
    expect([b.totalsAtLeast, b.truncated]).toEqual([true, true]);
  });

  test("past the last header read when the header bound was hit, a log line has no date: an unread header may own it", async () => {
    const firstHeaderOnly: GitRun = async (cwd, args, opts) => {
      const res = await realGit(cwd, args, opts);
      return args.includes("^##[^#]") ? { ...res, stdout: `${res.stdout.split("\n")[0]!}\n`, capped: true } : res;
    };
    // CASE-7 is otherwise untruncated, so only the header bound can set `truncated`.
    const b = (await (await get(appWith({ git: firstHeaderOnly }).app, `wiki=${WIKI}&key=CASE-7`)).json()) as MentionsBody;
    expect(b.log.map((l) => [l.n, l.date])).toEqual([[3, null], [5, "2026-11-01"], [9, null]]);
    expect(b.truncated).toBe(true);
  });

  test("a PR ref past the display cut of a long line is still listed; the line's text stays cut", async () => {
    const b = await body(busyApp(), "LONG-1");
    expect(b.prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["acme/acme-api#12"]);
    expect(b.files[0]!.lines[0]!.text.endsWith("…")).toBe(true);
  });

  test("the log's dates come through the tracked-files seam, not a read of the file", async () => {
    // A git runner that changes one header date in what grep returns: the answer can only show it if the headers came through git.
    const spy: GitRun = async (cwd, args, opts) => {
      const res = await realGit(cwd, args, opts);
      return args.includes("grep") ? { ...res, stdout: res.stdout.replaceAll("2026-11-03", "2026-12-31") } : res;
    };
    const { app } = appWith({ git: spy });
    const b = (await (await get(app, `wiki=${WIKI}&key=CASE-7`)).json()) as MentionsBody;
    expect(b.log.map((l) => l.date)).toEqual([null, "2026-11-01", "2026-12-31"]);
  });

  test("mentions.ts reads no file itself", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "../../wiki/mentions.ts")).text();
    expect(src).not.toMatch(/node:fs|Bun\.file|readLog/);
  });
});
