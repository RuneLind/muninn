/**
 * `scripts/backfill-youtube-authors.ts` end to end, as real subprocesses over a
 * temp tree: pilot → a re-capture → full write → rollback, and an interrupted
 * write → rollback. The oEmbed cache is seeded and every run passes
 * `--no-update`, so nothing leaves the machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
    "a failed /update, and an author mismatch after a good one, each exit 1",
    async () => {
      let updateStatus = 500;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname.endsWith("/update")) return new Response("boom", { status: updateStatus });
          if (u.pathname.endsWith("/update-status")) return Response.json({ status: "succeeded" });
          if (u.pathname.startsWith("/api/document/")) return Response.json({ metadata: { author: "Somebody Else" } });
          return new Response("no", { status: 404 });
        },
      });
      try {
        const cache = { AAAAAAAAAAA: { kind: "ok", author: "A" }, BBBBBBBBBBB: { kind: "ok", author: "B" } };
        for (const [name, status, id] of [["upd500", 500, "AAAAAAAAAAA"], ["mismatch", 200, "BBBBBBBBBBB"]] as const) {
          updateStatus = status;
          const fx = setup(name, [{ path: "a.md", id, ageMs: 1_000 }], cache);
          const proc = Bun.spawn(
            ["bun", SCRIPT, "--root", fx.root, "--state-dir", fx.state, "--huginn", `http://127.0.0.1:${server.port}`],
            { env: { ...(process.env as Record<string, string>) }, stdout: "pipe", stderr: "pipe" },
          );
          const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
          expect({ name, code: await proc.exited }).toEqual({ name, code: 1 });
          expect(out).toContain(status === 500 ? "update: HTTP 500" : "MISMATCH a.md");
        }
      } finally {
        server.stop(true);
      }
    },
    30_000,
  );
});
