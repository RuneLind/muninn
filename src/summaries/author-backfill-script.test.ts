/**
 * `scripts/backfill-youtube-authors.ts` end to end, as real subprocesses over a
 * temp tree: pilot → a re-capture → full write → rollback, and an interrupted
 * write → rollback. The oEmbed cache is seeded and every run passes
 * `--no-update`, so nothing leaves the machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/backfill-youtube-authors.ts");
const scratch = mkdtempSync(join(tmpdir(), "yt-author-backfill-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const DAY = 86_400_000;
const T0 = Date.now() - 30 * DAY;

interface Fixture {
  path: string;
  id: string;
  ageMs: number;
  author?: string;
}

function doc(id: string, author?: string, marker = "body"): string {
  return [
    "---",
    'date: "2026-07-14"',
    `url: "https://www.youtube.com/watch?v=${id}"`,
    ...(author ? [`author: "${author}"`] : []),
    'category: "ai"',
    'tags: "ai"',
    "---",
    "",
    `### ${marker}`,
    "",
  ].join("\n");
}

function setup(name: string, files: Fixture[], cache: Record<string, unknown>) {
  const root = join(scratch, name, "tree");
  const state = join(scratch, name, "state");
  mkdirSync(state, { recursive: true });
  for (const f of files) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, doc(f.id, f.author));
    utimesSync(abs, new Date(), (T0 + f.ageMs) / 1000);
  }
  writeFileSync(join(state, "oembed-cache.json"), JSON.stringify(cache));
  const original = new Map(files.map((f) => [f.path, readFileSync(join(root, f.path))]));
  return { root, state, original };
}

async function run(
  args: string[],
  fx: { root: string; state: string },
  env: Record<string, string> = { ...(process.env as Record<string, string>) },
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args, "--root", fx.root, "--state-dir", fx.state, "--no-update"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
}

/** Paths by ascending mtime — the order huginn's `/update` and the shelf see. */
function mtimeOrder(root: string, paths: string[]): string[] {
  return [...paths].sort((a, b) => Number(statSync(join(root, a), { bigint: true }).mtimeNs - statSync(join(root, b), { bigint: true }).mtimeNs));
}

const TIZKOVA = "ai/general/What It Actually Takes to Build a Software Factory — Tereza Tížková, Factory.md".normalize("NFC");

describe("pilot → re-capture → full → rollback", () => {
  const files: Fixture[] = [
    { path: "a/Old Talk.md", id: "AAAAAAAAAAA", ageMs: 1_000 },
    { path: "a/Recapture Me Later.md", id: "DDDDDDDDDDD", ageMs: 2_000 },
    { path: "b/Has Author.md", id: "FFFFFFFFFFF", ageMs: 3_000, author: "Already" },
    { path: "c/Unavailable.md", id: "EEEEEEEEEEE", ageMs: 4_000 },
    { path: "b/Café Ñandú.md".normalize("NFC"), id: "CCCCCCCCCCC", ageMs: 5_000 },
    { path: TIZKOVA, id: "BBBBBBBBBBB", ageMs: 9_000 },
  ];
  const cache = {
    AAAAAAAAAAA: { kind: "ok", author: "Chan A", title: "Old Talk" },
    DDDDDDDDDDD: { kind: "ok", author: "Chan D", title: "Recapture Me Later" },
    EEEEEEEEEEE: { kind: "unavailable", status: 403 },
    CCCCCCCCCCC: { kind: "ok", author: "Chan C", title: "Café Ñandú" },
    BBBBBBBBBBB: { kind: "ok", author: "Tereza Tížková", title: "Software Factory" },
  };

  test(
    "restores every file still holding exactly the backfill's bytes, keeps re-captures, and puts the original order back",
    async () => {
      const fx = setup("full", files, cache);
      const originalOrder = mtimeOrder(fx.root, files.map((f) => f.path));

      const pilot = await run(["--limit", "2"], fx);
      expect(pilot.code).toBe(0);
      expect(pilot.out).toContain("wrote 2,");
      expect(readFileSync(join(fx.root, TIZKOVA), "utf8")).toContain('author: "Tereza Tížková"');

      // Re-captures after the pilot: one file the pilot wrote, one it never touched.
      const cafe = "b/Café Ñandú.md".normalize("NFC");
      const recapturedCafe = doc("CCCCCCCCCCC", "Chan C (new capture)", "re-captured");
      const recapturedHas = doc("FFFFFFFFFFF", "Already", "re-captured too");
      writeFileSync(join(fx.root, "b/Has Author.md"), recapturedHas);
      await Bun.sleep(5);
      writeFileSync(join(fx.root, cafe), recapturedCafe);

      const full = await run([], fx);
      expect(full.code).toBe(0);
      expect(full.out).toContain("wrote 2,");

      // No locale at all — bsdtar escapes non-ASCII names without one.
      const rb = await run(["--rollback"], fx, { PATH: process.env.PATH ?? "", HOME: scratch });
      expect(rb.code).toBe(0);
      expect(rb.out).toContain("restored 3,");
      expect(rb.out).toContain(`changed since: ${cafe}`);

      for (const p of ["a/Old Talk.md", "a/Recapture Me Later.md", TIZKOVA]) {
        expect(readFileSync(join(fx.root, p)).equals(fx.original.get(p)!)).toBe(true);
      }
      expect(readFileSync(join(fx.root, cafe), "utf8")).toBe(recapturedCafe);
      expect(readFileSync(join(fx.root, "b/Has Author.md"), "utf8")).toBe(recapturedHas);

      // The original order, with the two re-captures moved to the newest end.
      const expected = [...originalOrder.filter((p) => p !== cafe && p !== "b/Has Author.md"), "b/Has Author.md", cafe];
      expect(mtimeOrder(fx.root, files.map((f) => f.path))).toEqual(expected);

      // A second rollback finds nothing left to restore.
      const again = await run(["--rollback"], fx);
      expect(again.out).toContain("0 still hold exactly what it wrote");
    },
    60_000,
  );
});

describe("an interrupted write", () => {
  test(
    "SIGINT mid-run: the journal already holds the whole plan, and rollback restores every file written",
    async () => {
      const files: Fixture[] = Array.from({ length: 8 }, (_, i) => ({
        path: `x/Doc ${i}.md`,
        id: `ID${String(i).padStart(9, "0")}`,
        ageMs: (i + 1) * 1_000,
      }));
      const cache = Object.fromEntries(files.map((f) => [f.id, { kind: "ok", author: `Author ${f.id}`, title: f.path }]));
      const fx = setup("sigint", files, cache);
      const journal = join(fx.state, "journal.jsonl");

      const proc = Bun.spawn(["bun", SCRIPT, "--root", fx.root, "--state-dir", fx.state, "--no-update"], {
        env: { ...(process.env as Record<string, string>), BACKFILL_DEBUG_SLEEP_MS: "300" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const written = () => (existsSync(journal) ? readFileSync(journal, "utf8").split('"status":"written"').length - 1 : 0);
      const deadline = Date.now() + 20_000;
      while (written() < 2 && Date.now() < deadline) await Bun.sleep(20);
      proc.kill("SIGINT");
      await proc.exited;

      const lines = readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { t: string });
      expect(lines.filter((l) => l.t === "plan").length).toBe(8);
      expect(lines.some((l) => l.t === "end")).toBe(false);
      const withAuthor = files.filter((f) => readFileSync(join(fx.root, f.path), "utf8").includes("author:")).length;
      expect(withAuthor).toBeGreaterThanOrEqual(2);
      expect(withAuthor).toBeLessThan(8);

      const rb = await run(["--rollback"], fx);
      expect(rb.code).toBe(0);
      expect(rb.out).toContain(`restored ${withAuthor},`);
      for (const f of files) expect(readFileSync(join(fx.root, f.path)).equals(fx.original.get(f.path)!)).toBe(true);
      expect(mtimeOrder(fx.root, files.map((f) => f.path))).toEqual(files.map((f) => f.path));
    },
    60_000,
  );
});

describe("usage errors never write", () => {
  test("an unknown flag or a missing value exits 2 and leaves the tree alone", async () => {
    const fx = setup("usage", [{ path: "a.md", id: "AAAAAAAAAAA", ageMs: 1_000 }], {
      AAAAAAAAAAA: { kind: "ok", author: "A" },
    });
    for (const argv of [["--dryrun"], ["--limit"], ["--rollback", "backup.tar.gz"]]) {
      const r = await run(argv, fx);
      expect(r.code).toBe(2);
    }
    expect(readFileSync(join(fx.root, "a.md")).equals(fx.original.get("a.md")!)).toBe(true);
    expect(existsSync(join(fx.state, "journal.jsonl"))).toBe(false);
  }, 30_000);
});

describe("huginn failures exit nonzero", () => {
  test(
    "a failed /update, an author mismatch after a good one, and a non-JSON /update-status each exit 1",
    async () => {
      let updateStatus = 500;
      let statusBody: "json" | "html" = "json";
      let documentAuthor = "Somebody Else";
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname.endsWith("/update")) return new Response("boom", { status: updateStatus });
          if (u.pathname.endsWith("/update-status")) {
            return statusBody === "json" ? Response.json({ status: "succeeded" }) : new Response("<html>proxy error</html>");
          }
          if (u.pathname.startsWith("/api/document/")) return Response.json({ metadata: { author: documentAuthor } });
          return new Response("no", { status: 404 });
        },
      });
      try {
        const cache = { AAAAAAAAAAA: { kind: "ok", author: "A" }, BBBBBBBBBBB: { kind: "ok", author: "B" } };
        const cases = [
          ["upd500", 500, "AAAAAAAAAAA", "json", "Somebody Else", "update: HTTP 500"],
          ["mismatch", 200, "BBBBBBBBBBB", "json", "Somebody Else", "MISMATCH a.md"],
          // The document then matches, so only the unreadable status can fail the run.
          ["status-not-json", 200, "BBBBBBBBBBB", "html", "B", "update-status: HTTP 200, not JSON"],
        ] as const;
        for (const [name, status, id, body, author, expected] of cases) {
          updateStatus = status;
          statusBody = body;
          documentAuthor = author;
          const fx = setup(name, [{ path: "a.md", id, ageMs: 1_000 }], cache);
          const proc = Bun.spawn(
            ["bun", SCRIPT, "--root", fx.root, "--state-dir", fx.state, "--huginn", `http://127.0.0.1:${server.port}`],
            { env: { ...(process.env as Record<string, string>) }, stdout: "pipe", stderr: "pipe" },
          );
          const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
          expect({ name, code: await proc.exited }).toEqual({ name, code: 1 });
          expect(out).toContain(expected);
        }
      } finally {
        server.stop(true);
      }
    },
    30_000,
  );
});

/** Every file under `dir` whose name ends `.tmp`, dot entries included. */
function tempsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (ent.isFile() && ent.name.endsWith(".tmp")) out.push(relative(dir, join(ent.parentPath, ent.name)));
  }
  return out;
}

async function spawnIn(cwd: string, args: string[], env: Record<string, string> = { ...(process.env as Record<string, string>) }) {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err };
}

describe("the atomic write's temp file", () => {
  test(
    "lives in the state dir, never under the root huginn indexes",
    async () => {
      const files: Fixture[] = [1, 2, 3].map((i) => ({ path: `health/Doc ${i}.md`, id: `TMP${String(i).padStart(8, "0")}`, ageMs: i * 1_000 }));
      const fx = setup("tmp-location", files, Object.fromEntries(files.map((f) => [f.id, { kind: "ok", author: `A ${f.id}` }])));
      const proc = Bun.spawn(["bun", SCRIPT, "--root", fx.root, "--state-dir", fx.state, "--no-update"], {
        env: { ...(process.env as Record<string, string>), BACKFILL_DEBUG_TEMP_PAUSE_MS: "1500" },
        stdout: "pipe",
        stderr: "pipe",
      });
      let inRoot: string[] = [];
      let inState: string[] = [];
      const deadline = Date.now() + 20_000;
      while (inRoot.length === 0 && inState.length === 0 && Date.now() < deadline) {
        await Bun.sleep(20);
        inRoot = tempsUnder(fx.root);
        inState = tempsUnder(fx.state).filter((p) => !p.startsWith("oembed-cache"));
      }
      proc.kill("SIGINT");
      await proc.exited;
      expect({ inRoot }).toEqual({ inRoot: [] });
      expect(inState.length).toBe(1);
      expect(tempsUnder(fx.root)).toEqual([]);
    },
    30_000,
  );

  test(
    "a temp an earlier build left in the root is removed and reported by every mode",
    async () => {
      for (const mode of [["--dry-run"], [], ["--rollback"]]) {
        const fx = setup(`tmp-sweep${mode.join("")}`, [{ path: "health/Creatine.md", id: "SWEEP000001", ageMs: 1_000, author: "Has" }], {});
        const leftover = join(fx.root, "health/.Creatine.md.author-backfill.tmp");
        writeFileSync(leftover, "half a file");
        const r = await run(mode, fx);
        expect({ mode, code: r.code }).toEqual({ mode, code: 0 });
        expect({ mode, left: existsSync(leftover) }).toEqual({ mode, left: false });
        expect(r.out).toContain("removed a temp file an earlier build left in the root: health/.Creatine.md.author-backfill.tmp");
      }
    },
    30_000,
  );
});

describe("the dry run against an oEmbed server", () => {
  const ID = { ok: "OKOKOKOKOK1", wrong: "WRONGWRONG1", s401: "S401S401S41", s403: "S403S403S43", s404: "S404S404S44", s400: "S400S400S40" };
  const files: Fixture[] = [
    { path: "a/Right Title Here.md", id: ID.ok, ageMs: 1_000 },
    { path: "a/Kubernetes Operators Deep Dive.md", id: ID.wrong, ageMs: 2_000 },
    { path: "u/Gone 401.md", id: ID.s401, ageMs: 3_000 },
    { path: "u/Gone 403.md", id: ID.s403, ageMs: 4_000 },
    { path: "u/Gone 404.md", id: ID.s404, ageMs: 5_000 },
    { path: "u/Gone 400.md", id: ID.s400, ageMs: 6_000 },
  ];
  const hits = new Map<string, number>();
  let server: ReturnType<typeof Bun.serve>;
  const env = () => ({ ...(process.env as Record<string, string>), BACKFILL_OEMBED_BASE: `http://127.0.0.1:${server.port}` });

  function startServer() {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const id = new URL(new URL(req.url).searchParams.get("url") ?? "").searchParams.get("v") ?? "";
        hits.set(id, (hits.get(id) ?? 0) + 1);
        if (id === ID.ok) return Response.json({ author_name: "Chan OK", title: "Right Title Here" });
        if (id === ID.wrong) return Response.json({ author_name: "Chan Pasta", title: "Cooking Pasta Tonight" });
        const status = Number(id.slice(1, 4));
        return new Response("no", { status: Number.isInteger(status) ? status : 500 });
      },
    });
  }

  test(
    "caches ok (with its title) and 400/401/403/404 as unavailable, and fetches none of them again",
    async () => {
      startServer();
      try {
        const fx = setup("dry-cache", files, {});
        const first = await run(["--dry-run"], fx, env());
        expect(first.code).toBe(0);
        expect(Object.fromEntries(hits)).toEqual(Object.fromEntries(Object.values(ID).map((id) => [id, 1])));
        const cache = JSON.parse(readFileSync(join(fx.state, "oembed-cache.json"), "utf8"));
        expect(cache[ID.ok]).toEqual({ kind: "ok", author: "Chan OK", title: "Right Title Here" });
        for (const [id, status] of [[ID.s401, 401], [ID.s403, 403], [ID.s404, 404], [ID.s400, 400]] as const) {
          expect(cache[id]).toEqual({ kind: "unavailable", status });
        }

        const second = await run(["--dry-run"], fx, env());
        expect(second.code).toBe(0);
        expect(second.out).toContain("0 to fetch");
        expect(Object.fromEntries(hits)).toEqual(Object.fromEntries(Object.values(ID).map((id) => [id, 1])));
      } finally {
        server.stop(true);
        hits.clear();
      }
    },
    30_000,
  );

  test(
    "the title review covers every candidate, and never overwrites the operator's pruned file",
    async () => {
      startServer();
      try {
        const fx = setup("dry-review", files, {});
        const reviewPath = join(fx.state, "title-review.txt");
        expect((await run(["--dry-run"], fx, env())).code).toBe(0);
        const firstReview = readFileSync(reviewPath, "utf8");
        expect(firstReview).toContain("a/Kubernetes Operators Deep Dive.md\n");

        // The operator keeps the flagged line and passes the file back.
        const again = await run(["--dry-run", "--exclude", reviewPath], fx, env());
        expect(again.code).toBe(0);
        expect(readFileSync(reviewPath, "utf8")).toBe(firstReview);
        const stamped = readdirSync(fx.state).filter((n) => /^title-review-.+\.txt$/.test(n));
        expect(stamped.length).toBe(1);
        const second = readFileSync(join(fx.state, stamped[0]!), "utf8");
        expect(second).toContain("(already --exclude'd)\na/Kubernetes Operators Deep Dive.md\n");
        expect(again.out).toContain("title-review.txt exists and was left untouched");
      } finally {
        server.stop(true);
        hits.clear();
      }
    },
    30_000,
  );
});

describe("--exclude on the write", () => {
  test("an excluded document is not written; the rest are", async () => {
    const fx = setup(
      "exclude-write",
      [
        { path: "a/Keep Out.md", id: "EXCLUDE0001", ageMs: 1_000 },
        { path: "a/Write Me.md", id: "EXCLUDE0002", ageMs: 2_000 },
      ],
      { EXCLUDE0001: { kind: "ok", author: "Wrong Channel" }, EXCLUDE0002: { kind: "ok", author: "Right Channel" } },
    );
    const excludeFile = join(fx.state, "exclude.txt");
    writeFileSync(excludeFile, "# checked by hand\na/Keep Out.md\n");
    const r = await run(["--exclude", excludeFile], fx);
    expect(r.code).toBe(0);
    expect(readFileSync(join(fx.root, "a/Keep Out.md")).equals(fx.original.get("a/Keep Out.md")!)).toBe(true);
    expect(readFileSync(join(fx.root, "a/Write Me.md"), "utf8")).toContain('author: "Right Channel"');
  }, 30_000);
});

describe("relative paths", () => {
  test(
    "a write run with a relative --root (trailing slash) and --state-dir rolls back from another cwd",
    async () => {
      const fx = setup("relative", [{ path: "a/Doc.md", id: "RELATIVE001", ageMs: 1_000 }], { RELATIVE001: { kind: "ok", author: "Rel" } });
      const base = dirname(fx.root);
      const w = await spawnIn(base, ["--root", "tree/", "--state-dir", "state", "--no-update"]);
      expect(w.code).toBe(0);
      expect(readFileSync(join(fx.root, "a/Doc.md"), "utf8")).toContain('author: "Rel"');

      const rb = await spawnIn(scratch, ["--rollback", "--root", relative(scratch, fx.root), "--state-dir", relative(scratch, fx.state), "--no-update"]);
      expect({ code: rb.code, out: rb.out }).toMatchObject({ code: 0 });
      expect(rb.out).toContain("restored 1,");
      expect(readFileSync(join(fx.root, "a/Doc.md")).equals(fx.original.get("a/Doc.md")!)).toBe(true);

      const runLine = readFileSync(join(fx.state, "journal.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; root?: string; tarball?: string })
        .find((l) => l.t === "run")!;
      expect(runLine.root).toBe(realpathSync(fx.root));
      expect(runLine.tarball!.startsWith(`${realpathSync(fx.state)}/`)).toBe(true);
    },
    30_000,
  );

  test("a journal made against another root: the refusal names both roots and sends nobody to another state dir", async () => {
    const fx = setup("other-root", [{ path: "a/Doc.md", id: "OTHERROOT01", ageMs: 1_000 }], { OTHERROOT01: { kind: "ok", author: "O" } });
    expect((await run([], fx)).code).toBe(0);
    const otherRoot = join(dirname(fx.root), "other");
    mkdirSync(otherRoot);
    const r = await spawnIn(scratch, ["--rollback", "--root", otherRoot, "--state-dir", fx.state, "--no-update"]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("--state-dir");
    expect(r.out).toContain(`root ${realpathSync(fx.root)},`);
    expect(r.out).toContain(`--root is ${realpathSync(otherRoot)}`);
  }, 30_000);
});

describe("rollback without its snapshot", () => {
  test("a missing tarball exits 2 and restores nothing", async () => {
    const fx = setup("lost-tarball", [{ path: "a/Doc.md", id: "LOSTTARBAL1", ageMs: 1_000 }], { LOSTTARBAL1: { kind: "ok", author: "L" } });
    expect((await run([], fx)).code).toBe(0);
    const written = readFileSync(join(fx.root, "a/Doc.md"));
    for (const n of readdirSync(fx.state)) if (n.startsWith("backup-")) unlinkSync(join(fx.state, n));
    const r = await run(["--rollback"], fx);
    expect(r.code).toBe(2);
    expect(r.out).toContain("snapshot tarball(s) missing — nothing restored");
    expect(readFileSync(join(fx.root, "a/Doc.md")).equals(written)).toBe(true);
  }, 30_000);
});
