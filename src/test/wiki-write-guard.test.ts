import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "./temp-dir.ts";
import { ALLOWLIST, checkCounts, isWikiSide, parseCounts, scannedFiles, scanSource, siteMessage, type Site, type SiteKind } from "./wiki-write-scan.ts";

/**
 * Every raw filesystem write in wiki-side code is a counted site, and
 * `scripts/wiki-write-allowlist.txt` holds each file's count, so a new write starts
 * red and gets a reviewed reason. The scan, the directory set and what the guard
 * does not prove are in `wiki-write-scan.ts`.
 */

const ROOT = path.join(import.meta.dir, "..", "..");
const FSP = `import { writeFile, rename, rm, mkdir, appendFile, unlink, copyFile, cp, truncate } from "node:fs/promises";\n`;
const FS = `import { writeFileSync, renameSync, rmSync, mkdirSync, appendFileSync, unlinkSync, copyFileSync, cpSync, truncateSync, writeSync, createWriteStream } from "node:fs";\n`;

/** [case, source, site kinds in order]. */
const CASES: [string, string, SiteKind[]][] = [
  // each write form
  ["Bun.write", `await Bun.write(p, "x");`, ["write"]],
  ["globalThis.Bun.write", `await globalThis.Bun.write(p, "x");`, ["write"]],
  ["Bun.file(…).writer()", `const w = Bun.file(p).writer();`, ["write"]],
  ["Bun.file(…).write() and .delete()", `await Bun.file(p).write("x");\nvoid (Bun.file(p)).delete();`, ["write", "write"]],
  ["fs/promises write names", FSP + `await writeFile(p, s); await rename(a, b); await rm(d); await mkdir(d); await appendFile(p, s);\nawait unlink(p); await copyFile(a, b); await cp(a, b); await truncate(p);`,
    Array(9).fill("write")],
  ["node:fs *Sync names, writeSync and createWriteStream", FS + `writeFileSync(p, s); renameSync(a, b); rmSync(d); mkdirSync(d); appendFileSync(p, s); unlinkSync(p);\ncopyFileSync(a, b); cpSync(a, b); truncateSync(p); writeSync(fd, s); createWriteStream(p);`,
    Array(11).fill("write")],
  ["bare fs and fs/promises modules", `import { writeFileSync } from "fs";\nimport { rm } from "fs/promises";\nwriteFileSync(p, s);\nrm(p);`, ["write", "write"]],
  ["a namespace import", `import * as fs from "node:fs";\nfs.writeFileSync(p, s);\nfs.readFileSync(p);`, ["write"]],
  ["a default import", `import fs from "node:fs";\nfs.renameSync(a, b);`, ["write"]],
  ["fs.promises off a namespace", `import fs from "node:fs";\nawait fs.promises.writeFile(p, s);`, ["write"]],
  ["the promises named import", `import { promises as fsp } from "node:fs";\nawait fsp.rm(p);\nawait fsp.readFile(p);`, ["write"]],
  ["a write call through parentheses and a cast", FSP + `await (writeFile as any)(p, s);`, ["write"]],

  // evasions
  ["a write name renamed on import", `import { writeFile as wf } from "node:fs/promises";\nawait wf(p, s);`, ["rename"]],
  ["a Sync name renamed on import", `import { rmSync as nuke } from "node:fs";`, ["rename"]],
  ["a write name used as a value", FSP + `const w = opts.writeFile ?? writeFile;`, ["value"]],
  ["a write name in an object shorthand", FSP + `const deps = { writeFile };`, ["value"]],
  ["a write name passed as an argument", FSP + `use(unlink);`, ["value"]],
  ["write.call", FSP + `writeFile.call(null, p, s);`, ["value"]],
  ["a write name re-exported", FSP + `export { writeFile as save };`, ["value"]],
  ["Bun.write as a value", `const w = Bun.write;`, ["value"]],
  ["Bun[\"write\"]", `await Bun["write"](p, s);`, ["value"]],
  ["a computed key on Bun", `await Bun[k](p, s);`, ["value"]],
  ["const { write } = Bun", `const { write } = Bun;\nconst { write: w2 } = Bun;`, ["value", "value"]],
  ["a quoted write name on a namespace", `import * as fs from "node:fs";\nfs["writeFileSync"](p, s);`, ["value"]],
  ["a computed key on a namespace", `import * as fs from "node:fs";\nfs[k](p, s);`, ["namespace"]],
  ["a quoted promises key, then a write", `import fs from "node:fs";\nawait fs["promises"].rm(p);`, ["write"]],
  ["a write name destructured off a namespace", `import fs from "node:fs";\nconst { writeFileSync: w, readFileSync } = fs;`, ["value"]],
  ["a rest element off a namespace", `import fs from "node:fs";\nconst { ...all } = fs;`, ["namespace"]],
  ["a namespace passed along", `import * as fs from "node:fs";\nuse(fs);`, ["namespace"]],
  ["a namespace's promises passed along", `import fs from "node:fs";\nconst p2 = fs.promises;`, ["namespace"]],
  ["require", `const fs = require("node:fs");`, ["module"]],
  ["dynamic import", `const { writeFile } = await import("fs/promises");`, ["module"]],
  ["import = require", `import fs = require("fs");`, ["module"]],
  ["export … from", `export { writeFile } from "node:fs/promises";\nexport * from "fs";`, ["module", "module"]],

  // not a site
  ["reads only", `import { readFile, stat, realpath } from "node:fs/promises";\nimport { readFileSync } from "node:fs";\nawait readFile(p);`, []],
  ["type-only imports", `import type { WriteStream } from "node:fs";\nimport { type Stats } from "node:fs";\nlet w: WriteStream;`, []],
  ["typeof a write name in a type", FSP + `type W = typeof writeFile;\ninterface D { rm?: typeof rm }`, []],
  ["a deps field named writeFile", `const deps = { writeFile: async (p, c) => save(p, c) };\nawait deps.writeFile(p, c);\nawait opts.rename(a);`, []],
  ["a local function named rename, no fs import", `function rename(a) { return a; }\nrename(x);\nx.rm();`, []],
  ["Bun.file reads", `await Bun.file(p).text();\nawait Bun.file(p).exists();\nconst f = Bun.file(p);`, []],
  ["other modules' write names", `import { writeFile } from "./my-fs.ts";\nawait writeFile(p, s);`, []],
  ["line comment", `// await Bun.write(p, s);`, []],
  ["block comment", `/* writeFileSync(p) */`, []],
  ["a string holding a call", `const s = 'Bun.write(p, "x"); fs.rmSync(d)';\nconst t = \`writeFile(\${p})\`;`, []],
  ["a string spelled like a write name", FSP + `const reason = "writeFile";\nconst k = "rm";`, []],
  ["a syntax error reports the file", `await Bun.write(p, ;`, ["parse"]],
];

describe("wiki write scan", () => {
  for (const [name, source, want] of CASES) {
    test(`${want.length ? "flags" : "passes"}: ${name}`, () => {
      expect(scanSource("src/wiki/x.ts", source).map((s) => s.kind)).toEqual(want);
    });
  }

  test("reports the line of each site, in source order", () => {
    const src = `import { rm } from "node:fs/promises";\n\nawait Bun.write(\n  p,\n  s,\n);\nawait rm(d);`;
    expect(scanSource("src/wiki/x.ts", src).map((s) => `${s.kind}:${s.line}`)).toEqual(["write:3", "write:7"]);
  });

  test("the message names the site, the queue and the allowlist way out; a parse error gets no way out", () => {
    const m = siteMessage(scanSource("src/wiki/x.ts", `\nawait Bun.write(p, s);`)[0]!);
    expect(m).toStartWith("src/wiki/x.ts:2 `Bun.write`.");
    for (const s of ["runWikiWriteExclusive", "read→CAS→write→log.md", ALLOWLIST, "give the reason in the PR"]) expect(m).toContain(s);
    const parse = siteMessage(scanSource("src/wiki/x.ts", `Bun.write(p, ;`)[0]!);
    expect(parse).toContain("TypeScript parse error");
    expect(parse).not.toContain(ALLOWLIST);
  });
});

describe("the wiki side", () => {
  test("directories, the five wiki watchers and wiki-/plans- routes; nothing else", () => {
    for (const f of ["src/wiki/page-write.ts", "src/wiki/work-map/write.ts", "src/gardener/apply.ts", "src/share/wire.ts", "src/plans/write.ts", "src/sync/run.ts",
      "src/watchers/wiki-committer.ts", "src/watchers/consolidation-gardener.ts", "src/dashboard/routes/wiki-routes.ts", "src/dashboard/routes/plans-routes.ts"]) {
      expect(isWikiSide(f)).toBe(true);
    }
    for (const f of ["src/watchers/email.ts", "src/dashboard/routes/summaries-rerun.ts", "src/dashboard/routes/sub/wiki-x.ts", "src/summaries/frames.ts", "src/wikis/x.ts", "scripts/backfill-wiki-pubdates.ts"]) {
      expect(isWikiSide(f)).toBe(false);
    }
  });

  test("scannedFiles takes non-test TS on the wiki side only", () => {
    const root = testTempDirSync(path.join(tmpdir(), "wiki-write-tree-"));
    for (const f of ["src/wiki/a.ts", "src/wiki/a.test.ts", "src/wiki/k.d.ts", "src/wiki/m.md", "src/gardener/b.ts", "src/watchers/wiki-linter.ts", "src/watchers/email.ts",
      "src/dashboard/routes/wiki-x.ts", "src/dashboard/routes/jira-routes.ts", "src/core/c.ts", "scripts/s.ts"]) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), "");
    }
    expect(scannedFiles(root)).toEqual(["src/dashboard/routes/wiki-x.ts", "src/gardener/b.ts", "src/watchers/wiki-linter.ts", "src/wiki/a.ts"]);
  });
});

describe("allowlist rules", () => {
  const site = (p: string, line: number, kind: SiteKind = "write"): Site => ({ path: p, line, kind, what: "`Bun.write`" });

  test("an unlisted file fails with each of its sites", () => {
    const { over, stale } = checkCounts([site("src/wiki/new.ts", 4), site("src/wiki/new.ts", 9)], new Map());
    expect(stale).toEqual([]);
    const [head, a, b] = over[0]!.split("\n");
    expect(head).toBe(`src/wiki/new.ts: 2 site(s), not listed in ${ALLOWLIST}`);
    expect(a).toStartWith("  src/wiki/new.ts:4 `Bun.write`.");
    expect(b).toStartWith("  src/wiki/new.ts:9 ");
  });

  test("a listed count is respected; one more site fails", () => {
    expect(checkCounts([site("src/wiki/a.ts", 1), site("src/wiki/a.ts", 2)], new Map([["src/wiki/a.ts", 2]]))).toEqual({ over: [], stale: [] });
    const { over } = checkCounts([site("src/wiki/a.ts", 1), site("src/wiki/a.ts", 2), site("src/wiki/a.ts", 3)], new Map([["src/wiki/a.ts", 2]]));
    expect(over[0]!.split("\n")[0]).toBe("src/wiki/a.ts: 3 sites, listed 2: one of them is new (the list is keyed by file and count, so it cannot say which)");
  });

  test("a stale entry fails: a lower live count, or none left", () => {
    const r = checkCounts([site("src/wiki/a.ts", 3)], new Map([["src/wiki/a.ts", 2], ["src/wiki/gone.ts", 1]]));
    expect(r.over).toEqual([]);
    expect(r.stale).toEqual([
      `src/wiki/a.ts: listed 2, live 1: lower the count to 1 in ${ALLOWLIST}`,
      `src/wiki/gone.ts: listed 1, no sites left: remove the line from ${ALLOWLIST}`,
    ]);
  });

  test("a listed file that stops parsing fails whatever its count", () => {
    expect(checkCounts([site("src/wiki/a.ts", 1, "parse")], new Map([["src/wiki/a.ts", 5]])).over).toHaveLength(1);
  });

  test("the list's format: malformed, duplicate and unsorted lines reported", () => {
    const { format } = parseCounts(["# c", "src/b.ts 1", "src/b.ts 2", "src/a.ts 1", "src/c.ts 0"].join("\n"));
    expect(format).toEqual(["duplicate entry: src/b.ts", "out of order: src/a.ts after src/b.ts", `malformed (want "<path> <count>", count 1 or more): src/c.ts 0`]);
  });
});

describe("the live tree", () => {
  const files = scannedFiles(ROOT);
  const sites = files.flatMap((f) => scanSource(f, readFileSync(path.join(ROOT, f), "utf8")));
  const { counts, format } = parseCounts(readFileSync(path.join(ROOT, ALLOWLIST), "utf8"));
  const check = checkCounts(sites, counts);

  test("scans the wiki side, including the known writers", () => {
    for (const f of ["src/wiki/page-write.ts", "src/wiki/work-map/write.ts", "src/plans/write.ts", "src/gardener/apply.ts", "src/sync/run.ts"]) expect(files).toContain(f);
  });

  test(`no raw wiki-side write beyond ${ALLOWLIST}`, () => {
    expect(check.over).toEqual([]);
  });

  test("no stale allowlist counts: a removed write lowers its count", () => {
    expect(check.stale).toEqual([]);
  });

  test("the allowlist is well-formed, sorted and has no duplicates", () => {
    expect(format).toEqual([]);
  });
});
