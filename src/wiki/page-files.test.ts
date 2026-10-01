import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPageFiles, resolveContainedFile } from "./page-files.ts";
import { PAGE_FILE_MAX_BYTES, PAGE_FILE_MAX_PER_PAGE, PAGE_FILE_PAGE_BUDGET_BYTES } from "../format/query-block.ts";
import { renderWikiHtml } from "./render.ts";

let base = "";
let root = "";
const PAGE = "plans/report.mdx";
const q = (csv: string) => `<Query id="Q" csv="${csv}">\n\n</Query>`;
const load = async (...refs: string[]) => loadPageFiles(root, PAGE, refs.map(q).join("\n\n"));

/** Load one ref repeatedly for `ms`, counting what was served. */
async function raceReads(ref: string, ms: number) {
  let leaks = 0;
  let oversize = 0;
  let served = 0;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = (await load(ref)).get(ref);
    if (r?.ok) {
      served++;
      if (r.text.includes("SECRET")) leaks++;
      if (r.text.length > PAGE_FILE_MAX_BYTES) oversize++;
    }
  }
  return { leaks, oversize, served };
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-page-files-"));
  root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans", "res"), { recursive: true });
  await writeFile(path.join(root, "plans", "res", "Q-1.csv"), "A,B\n1,2\n");
  await writeFile(path.join(root, "plans", "res", "Q-1.sql"), "SELECT 1;\n");
  await writeFile(path.join(root, "top.csv"), "T\n1\n");
  await writeFile(path.join(root, "plans", ".env"), "SECRET=1\n");
  await writeFile(path.join(root, "plans", "big.csv"), "x".repeat(PAGE_FILE_MAX_BYTES + 1));
  await writeFile(path.join(root, "plans", "nul.csv"), "A\na\0b\n");
  await writeFile(path.join(base, "outside.csv"), "OUTSIDE,SECRET\n1,2\n");
  await mkdir(path.join(base, "outside-dir"));
  await writeFile(path.join(base, "outside-dir", "x.csv"), "OUTSIDE\n1\n");
  await symlink(path.join(base, "outside.csv"), path.join(root, "plans", "link.csv"));
  await symlink(path.join(base, "outside-dir"), path.join(root, "plans", "linkdir"));
  await symlink(path.join(root, "plans", ".env"), path.join(root, "plans", "env-link.csv"));
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe("loadPageFiles", () => {
  test("reads csv and sql beside the page, relative to its folder; `..` inside the root is fine", async () => {
    const files = await loadPageFiles(
      root,
      PAGE,
      `<Query id="Q" csv="res/Q-1.csv" sql="res/Q-1.sql">\n\n</Query>\n\n${q("../top.csv")}`,
    );
    expect(files.get("res/Q-1.csv")).toEqual({ ok: true, text: "A,B\n1,2\n" });
    expect(files.get("res/Q-1.sql")).toEqual({ ok: true, text: "SELECT 1;\n" });
    expect(files.get("../top.csv")).toEqual({ ok: true, text: "T\n1\n" });
  });

  test("a file outside the root reads as unavailable — the same answer as a missing one", async () => {
    const files = await load("../../outside.csv", "res/nope.csv");
    expect(files.get("../../outside.csv")).toEqual({ ok: false, reason: "unavailable" });
    expect(files.get("res/nope.csv")).toEqual({ ok: false, reason: "unavailable" });
  });

  test("a symlinked file and a symlinked folder pointing outside the root are unavailable", async () => {
    const files = await load("link.csv", "linkdir/x.csv");
    expect(files.get("link.csv")).toEqual({ ok: false, reason: "unavailable" });
    expect(files.get("linkdir/x.csv")).toEqual({ ok: false, reason: "unavailable" });
  });

  test("an absolute path is invalid; a disallowed extension is refused, on the ref and on the real file", async () => {
    const files = await load(path.join(base, "outside.csv"), ".env", "env-link.csv");
    expect(files.get(path.join(base, "outside.csv"))).toEqual({ ok: false, reason: "invalid" });
    expect(files.get(".env")).toEqual({ ok: false, reason: "invalid" });
    expect(files.get("env-link.csv")).toEqual({ ok: false, reason: "extension" });
  });

  test("a file over 1 MB is not read", async () => {
    expect((await load("big.csv")).get("big.csv")).toEqual({ ok: false, reason: "too-large" });
  });

  test("a NUL in the file (the wikilink sentinel delimiter) is replaced", async () => {
    expect((await load("nul.csv")).get("nul.csv")).toEqual({ ok: true, text: "A\na�b\n" });
  });

  test(`past ${PAGE_FILE_MAX_PER_PAGE} distinct files the rest are not read`, async () => {
    const refs = Array.from({ length: PAGE_FILE_MAX_PER_PAGE + 2 }, (_, i) => `res/f${i}.csv`);
    const files = await load(...refs);
    expect(files.get(refs[PAGE_FILE_MAX_PER_PAGE - 1]!)).toEqual({ ok: false, reason: "unavailable" });
    expect(files.get(refs[PAGE_FILE_MAX_PER_PAGE]!)).toEqual({ ok: false, reason: "limit" });
    expect(files.get(refs[PAGE_FILE_MAX_PER_PAGE + 1]!)).toEqual({ ok: false, reason: "limit" });
  });

  test("a Query inside a code fence, or in the frontmatter, reads nothing", async () => {
    // A YAML block scalar whose lines WOULD parse as a Query block if the
    // frontmatter were not stripped first.
    const fm = ["---", "note: |", '  <Query id="F" csv="res/Q-1.csv">', "", "  </Query>", "---"];
    const md = [...fm, "", "```mdx", q("res/Q-1.csv"), "```"].join("\n");
    expect((await loadPageFiles(root, PAGE, md)).size).toBe(0);
  });

  test("end to end: the outside file's content never reaches the rendered page", async () => {
    const md = `${q("../../outside.csv")}\n\n${q("link.csv")}`;
    const html = renderWikiHtml(md, () => undefined, { files: await loadPageFiles(root, PAGE, md) });
    expect(html).not.toContain("SECRET");
    expect(html.match(/File not available/g)).toHaveLength(2);
  });
});

describe("loadPageFiles — containment beyond the realpath", () => {
  test("a hard link to a file outside the root is unavailable", async () => {
    await link(path.join(base, "outside.csv"), path.join(root, "plans", "hard.csv"));
    try {
      expect((await load("hard.csv")).get("hard.csv")).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      await unlink(path.join(root, "plans", "hard.csv"));
    }
  });

  test("a `..` that climbs above the root and comes back in is unavailable, from any depth", async () => {
    const rootName = path.basename(root);
    const top = await loadPageFiles(root, "top.mdx", q(`../${rootName}/top.csv`));
    expect(top.get(`../${rootName}/top.csv`)).toEqual({ ok: false, reason: "unavailable" });
    const deep = await load(`../../${rootName}/top.csv`);
    expect(deep.get(`../../${rootName}/top.csv`)).toEqual({ ok: false, reason: "unavailable" });
  });

  test("a dot segment or a node_modules segment is refused, like the index scan", async () => {
    await mkdir(path.join(root, "plans", ".hidden"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "plans", ".hidden", "s.csv"), "S\n1\n");
    await writeFile(path.join(root, "node_modules", "n.csv"), "N\n1\n");
    const md = [q("../.hidden/s.csv"), q("../../node_modules/n.csv")].join("\n\n");
    const files = await loadPageFiles(root, "plans/sub/page.mdx", md);
    expect(files.get("../.hidden/s.csv")).toEqual({ ok: false, reason: "invalid" });
    expect(files.get("../../node_modules/n.csv")).toEqual({ ok: false, reason: "invalid" });
  });

  test(`past ${PAGE_FILE_PAGE_BUDGET_BYTES / 1024 / 1024} MB of files on one page the rest are not read`, async () => {
    const n = PAGE_FILE_PAGE_BUDGET_BYTES / PAGE_FILE_MAX_BYTES + 1;
    await mkdir(path.join(root, "plans", "budget"), { recursive: true });
    const refs = Array.from({ length: n }, (_, i) => `budget/b${i}.csv`);
    for (const r of refs) await writeFile(path.join(root, "plans", r), "x".repeat(PAGE_FILE_MAX_BYTES));
    const files = await load(...refs);
    for (const r of refs.slice(0, -1)) expect(files.get(r)?.ok).toBe(true);
    expect(files.get(refs[n - 1]!)).toEqual({ ok: false, reason: "budget" });
  });

  test("a file swapped for a symlink or a bigger file mid-read is never served", async () => {
    // A writer racing the loader: the in-root file is replaced, atomically and
    // repeatedly, by a symlink to the outside file and by a file over the cap.
    const dir = path.join(root, "plans", "race");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, "r.csv");
    await writeFile(target, "A\n1\n");
    let stop = false;
    const swapper = (async () => {
      for (let k = 0; !stop; k++) {
        const tmp = path.join(dir, `t${k}.tmp`);
        try {
          if (k % 3 === 0) await writeFile(tmp, "A\n1\n");
          else if (k % 3 === 1) await symlink(path.join(base, "outside.csv"), tmp);
          else await writeFile(tmp, "x".repeat(PAGE_FILE_MAX_BYTES * 2));
          await rename(tmp, target);
        } catch {
          await rm(tmp, { force: true });
        }
      }
    })();
    const seen = await raceReads("race/r.csv", 3000);
    stop = true;
    await swapper;
    expect({ leaks: seen.leaks, oversize: seen.oversize }).toEqual({ leaks: 0, oversize: 0 });
    expect(seen.served).toBeGreaterThan(0);
  }, 15_000);

  test("a file grown past the cap between the size check and the read is never served whole", async () => {
    // Same file, rewritten IN PLACE: small, then over the cap, then small.
    const dir = path.join(root, "plans", "grow");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, "g.csv");
    await writeFile(target, "A\n1\n");
    const big = "x".repeat(PAGE_FILE_MAX_BYTES * 3);
    let stop = false;
    const writer = (async () => {
      for (let k = 0; !stop; k++) await writeFile(target, k % 2 ? big : "A\n1\n");
    })();
    const seen = await raceReads("grow/g.csv", 3000);
    stop = true;
    await writer;
    expect(seen.oversize).toBe(0);
    expect(seen.served).toBeGreaterThan(0);
  }, 15_000);
});

describe("resolveContainedFile", () => {
  test("keeps the three reasons /api/wiki/html maps to status codes", async () => {
    expect(await resolveContainedFile(root, "plans/res/Q-1.csv")).toEqual({
      ok: true,
      real: path.join(await realpath(root), "plans", "res", "Q-1.csv"),
      rootReal: await realpath(root),
    });
    expect(await resolveContainedFile(root, "../outside.csv")).toEqual({ ok: false, reason: "outside" });
    expect(await resolveContainedFile(root, "plans/missing.csv")).toEqual({ ok: false, reason: "missing" });
    expect(await resolveContainedFile(root, "plans/link.csv")).toEqual({ ok: false, reason: "outside-real" });
    expect(await resolveContainedFile(root, "plans/linkdir/x.csv")).toEqual({ ok: false, reason: "outside-real" });
  });
});

