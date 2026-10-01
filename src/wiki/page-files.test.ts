import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPageFiles, resolveContainedFile } from "./page-files.ts";
import { PAGE_FILE_MAX_BYTES, PAGE_FILE_MAX_PER_PAGE } from "../format/query-block.ts";
import { renderWikiHtml } from "./render.ts";

let base = "";
let root = "";
const PAGE = "plans/report.mdx";
const q = (csv: string) => `<Query id="Q" csv="${csv}">\n\n</Query>`;
const load = async (...refs: string[]) => loadPageFiles(root, PAGE, refs.map(q).join("\n\n"));

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
    expect(files.get(".env")).toEqual({ ok: false, reason: "extension" });
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
    const md = ["---", `description: '${q("../../outside.csv")}'`, "---", "", "```mdx", q("res/Q-1.csv"), "```"].join("\n");
    expect((await loadPageFiles(root, PAGE, md)).size).toBe(0);
  });

  test("end to end: the outside file's content never reaches the rendered page", async () => {
    const md = `${q("../../outside.csv")}\n\n${q("link.csv")}`;
    const html = renderWikiHtml(md, () => undefined, { files: await loadPageFiles(root, PAGE, md) });
    expect(html).not.toContain("SECRET");
    expect(html.match(/File not available/g)).toHaveLength(2);
  });
});

describe("resolveContainedFile", () => {
  test("keeps the three reasons /api/wiki/html maps to status codes", async () => {
    expect(await resolveContainedFile(root, "plans/res/Q-1.csv")).toEqual({
      ok: true,
      real: path.join(await realpath(root), "plans", "res", "Q-1.csv"),
    });
    expect(await resolveContainedFile(root, "../outside.csv")).toEqual({ ok: false, reason: "outside" });
    expect(await resolveContainedFile(root, "plans/missing.csv")).toEqual({ ok: false, reason: "missing" });
    expect(await resolveContainedFile(root, "plans/link.csv")).toEqual({ ok: false, reason: "outside-real" });
    expect(await resolveContainedFile(root, "plans/linkdir/x.csv")).toEqual({ ok: false, reason: "outside-real" });
  });
});

