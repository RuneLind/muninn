import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every spawned child leads its own process group, or is on a list that only
 * shrinks.
 *
 * A child spawned in this process's group is killed alone: a timeout's
 * `proc.kill()` never reaches its grandchildren (git's ssh, a test runner's
 * workers), and they keep the stdout/stderr pipes open, so the bounded call
 * does not return. Review found it in 21 PRs. The fix is `runProc(cmd, ms,
 * label, { processGroup: true })` (`src/utils/run-proc.ts`), or a raw spawn
 * with `detached: true` and a kill sent to `-proc.pid`.
 *
 * What the scan reads, in non-test `.ts` under `src/`, `scripts/` and `db/`
 * (`src/utils/run-proc.ts` excluded, it maps `processGroup` to `detached`):
 * - `Bun.spawn(` and `Bun.spawnSync(`, and `spawn`, `spawnSync`, `execFile`,
 *   `execFileSync`, `exec`, `execSync`, `fork` imported from `node:child_process`.
 *   `Bun.$` is out of scope: it has no process-group option.
 * - The call's options argument, found by matching its parentheses with
 *   comments, strings and template literals masked. It passes only as an
 *   object literal with a top-level `detached: true` and no spread after it.
 *   No options, a variable, a call or a spread with no `detached: true` after
 *   it fails closed, since the scan cannot see a process group there.
 * It checks that the group exists, not that the kill targets `-pid`.
 *
 * `scripts/spawn-group-allowlist.txt` holds today's sites as `<path> <count>`.
 */

const ROOT = path.join(import.meta.dir, "..", "..");
const ALLOWLIST = path.join(ROOT, "scripts", "spawn-group-allowlist.txt");
const SCAN_DIRS = ["src", "scripts", "db"];
const EXCLUDED = new Set(["src/utils/run-proc.ts"]);
const NODE_SPAWNERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

export interface Site {
  file: string;
  line: number;
  reason: string;
}

/**
 * The text with comment, string, template and regex bodies replaced by spaces,
 * newlines kept, so offsets and line numbers stay those of the source.
 */
export function maskSource(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  // Brace depth inside each open `${`, so a `}` can close the template hole.
  const holes: number[] = [];
  let lastSignificant = "";
  const scanTemplate = (start: number): number => {
    // start is just past the opening backtick or the closing `}` of a hole.
    let j = start;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") {
        blank(start, j);
        return j + 1;
      }
      if (c === "$" && src[j + 1] === "{") {
        blank(start, j);
        holes.push(0);
        return j + 2;
      }
      j++;
    }
    blank(start, j);
    return j;
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === "`") {
      i = scanTemplate(i + 1);
      lastSignificant = "`";
      continue;
    }
    if (c === "/" && (lastSignificant === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant))) {
      // A regex literal: a `/` where an expression starts.
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = "/";
      continue;
    }
    if (holes.length > 0) {
      if (c === "{") holes[holes.length - 1]!++;
      else if (c === "}") {
        if (holes[holes.length - 1] === 0) {
          holes.pop();
          i = scanTemplate(i + 1);
          lastSignificant = "`";
          continue;
        }
        holes[holes.length - 1]!--;
      }
    }
    if (!/\s/.test(c!)) lastSignificant = /[A-Za-z0-9_$)\]]/.test(c!) ? "a" : c!;
    i++;
  }
  return out.join("");
}

/** Index of the bracket closing the one at `open` in masked text, or -1. */
function closingBracket(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const c = masked[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** The top-level comma-separated parts of a span of masked text. */
function splitTopLevel(span: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < span.length; k++) {
    const c = span[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(span.slice(from, k));
      from = k + 1;
    }
  }
  parts.push(span.slice(from));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Why an options argument gives the child no process group, or null when it does. */
export function optionsVerdict(options: string | undefined): string | null {
  if (options === undefined) return "it passes no options, so the child stays in this process's group";
  if (!options.startsWith("{")) {
    return `its options are \`${options.replace(/\s+/g, " ").slice(0, 40)}\`, not an object literal, so the scan cannot see a process group`;
  }
  const props = splitTopLevel(options.slice(1, closingBracket(options, 0)));
  let detachedAt = -1;
  let spreadAt = -1;
  props.forEach((p, k) => {
    if (/^detached\s*:\s*true$/.test(p)) detachedAt = k;
    else if (p.startsWith("...")) spreadAt = k;
  });
  if (detachedAt < 0) {
    return spreadAt < 0
      ? "its options set no `detached: true`, so a kill reaches only the direct child"
      : "its options spread another object and set no literal `detached: true`, so the scan cannot see a process group";
  }
  if (spreadAt > detachedAt) return "a spread after `detached: true` can override it";
  return null;
}

/** Names this file binds to node:child_process spawners: `spawn(` → "spawn", `cp.spawn(` → "cp.spawn". */
function nodeSpawnerNames(src: string, masked: string): string[] {
  const names: string[] = [];
  // Read off the source (masking blanked the module string); an import inside
  // a comment or string is skipped by checking the masked text.
  const re = /\bimport\s+(?:type\s+)?([^;]*?)\s+from\s+(["'])(node:)?child_process\2/g;
  for (const m of src.matchAll(re)) {
    if (masked.slice(m.index!, m.index! + 6) !== "import") continue;
    const clause = m[1]!;
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1]!.split(",")) {
        const t = part.trim();
        if (t.startsWith("type ")) continue;
        const [orig, alias] = t.split(/\s+as\s+/);
        if (orig && NODE_SPAWNERS.has(orig)) names.push(alias ?? orig);
      }
    }
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause) ?? /^([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) for (const s of NODE_SPAWNERS) names.push(`${ns[1]}.${s}`);
  }
  return names;
}

/** Every spawn call in one file whose child gets no process group. */
export function violationsIn(file: string, src: string): Site[] {
  const masked = maskSource(src);
  const lineAt = (offset: number) => masked.slice(0, offset).split("\n").length;
  const sites: Site[] = [];
  const check = (callStart: number, open: number, optionsOf: (args: string[]) => string | undefined) => {
    const close = closingBracket(masked, open);
    if (close < 0) {
      sites.push({ file, line: lineAt(callStart), reason: `its call has no closing parenthesis the scan can find` });
      return;
    }
    const reason = optionsVerdict(optionsOf(splitTopLevel(masked.slice(open + 1, close))));
    if (reason) sites.push({ file, line: lineAt(callStart), reason });
  };
  for (const m of masked.matchAll(/\bBun\s*\.\s*spawn(Sync)?\s*\(/g)) {
    check(m.index!, m.index! + m[0].length - 1, (args) => (args[1] ?? (args[0]?.startsWith("{") ? args[0] : undefined)));
  }
  const names = nodeSpawnerNames(src, masked);
  for (const name of names) {
    const escaped = name.replace(/[.$]/g, (c) => `\\${c}`);
    for (const m of masked.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`, "g"))) {
      check(m.index!, m.index! + m[0].length - 1, (args) => {
        // (cmd, options) or (cmd, argv, options); exec/execSync take (cmd, options).
        if (args.length >= 3) return args[2];
        return args[1] && !args[1].startsWith("[") ? args[1] : undefined;
      });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** Non-test `.ts` files under the scanned directories, repo-relative, sorted. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(path.join(root, dir), { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.split(path.sep).join("/")}`;
      if (rel.includes("node_modules/")) continue;
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel.endsWith(".d.ts")) continue;
      if (EXCLUDED.has(rel)) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

export function parseAllowlist(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)\s+(\d+)$/.exec(line);
    if (!m) throw new Error(`spawn-group-allowlist.txt: unreadable line "${line}" (want "<path> <count>")`);
    out.set(m[1]!, Number(m[2]));
  }
  return out;
}

/** One sentence per file whose live sites differ from the allowlist. */
export function compareToAllowlist(sites: Site[], listed: Map<string, number>): { unlisted: string[]; stale: string[] } {
  const byFile = new Map<string, Site[]>();
  for (const s of sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  const unlisted: string[] = [];
  const stale: string[] = [];
  for (const [file, live] of byFile) {
    const allowed = listed.get(file) ?? 0;
    if (live.length > allowed) {
      const where = live.map((s) => `${s.file}:${s.line} spawns a child without its own process group: ${s.reason}.`).join("\n");
      unlisted.push(
        `${where}\n  ${file} has ${live.length} such site(s), the allowlist allows ${allowed}. Spawn through runProc(cmd, ms, label, { processGroup: true }) in src/utils/run-proc.ts, or pass detached: true and kill -proc.pid.`,
      );
    }
  }
  for (const [file, allowed] of listed) {
    const live = byFile.get(file)?.length ?? 0;
    if (live < allowed) {
      stale.push(`${file} is allowlisted for ${allowed} site(s) but has ${live}: lower its count in scripts/spawn-group-allowlist.txt (the list only shrinks).`);
    }
  }
  return { unlisted: unlisted.sort(), stale: stale.sort() };
}

describe("the live tree", () => {
  const files = sourceFiles(ROOT);
  const sites = files.flatMap((f) => violationsIn(f, readFileSync(path.join(ROOT, f), "utf8")));
  const allowText = readFileSync(ALLOWLIST, "utf8");
  const listed = parseAllowlist(allowText);
  const total = [...listed.values()].reduce((a, b) => a + b, 0);
  const { unlisted, stale } = compareToAllowlist(sites, listed);

  test("the scan reads src/, scripts/ and db/", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(["src/", "scripts/", "db/"].map((d) => files.some((f) => f.startsWith(d)))).toEqual([true, true, true]);
  });

  test(`no spawn without a process group outside the allowlist (${total} sites in ${listed.size} files allowlisted)`, () => {
    console.log(`spawn-process-group: ${sites.length} live sites without a process group, ${total} allowlisted in ${listed.size} files`);
    expect(unlisted.join("\n\n")).toBe("");
  });

  test("no stale allowlist entries: a fixed site lowers its file's count", () => {
    expect(stale.join("\n")).toBe("");
  });

  test("the allowlist is sorted, without duplicates or zero counts", () => {
    const paths = allowText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/\s+/)[0]!);
    expect(paths).toEqual([...new Set(paths)].sort());
    expect([...listed.values()].filter((n) => n < 1)).toEqual([]);
  });
});

describe("violationsIn", () => {
  const scan = (src: string) => violationsIn("x.ts", src).map((s) => s.line);

  test("a spawn with no options, options without detached, or a variable fails", () => {
    expect(scan(`Bun.spawn(["git"]);`)).toEqual([1]);
    expect(scan(`const p = Bun.spawn(\n  ["git"],\n  { stdout: "pipe" },\n);`)).toEqual([1]);
    expect(scan(`Bun.spawnSync(cmd, opts);`)).toEqual([1]);
    expect(scan(`Bun.spawn({ cmd: ["git"], stdout: "pipe" });`)).toEqual([1]);
  });

  test("detached: true at the top level passes, in either call form", () => {
    expect(scan(`Bun.spawn(["git"], { stdout: "pipe", detached: true });`)).toEqual([]);
    expect(scan(`Bun.spawn({ cmd: ["git"], detached: true });`)).toEqual([]);
    expect(scan(`Bun.spawn(["git"], { ...base, detached: true });`)).toEqual([]);
  });

  test("detached nested, false, a variable, or overridden by a later spread fails", () => {
    expect(scan(`Bun.spawn(["git"], { env: { detached: true } });`)).toEqual([1]);
    expect(scan(`Bun.spawn(["git"], { detached: false });`)).toEqual([1]);
    expect(scan(`Bun.spawn(["git"], { detached });`)).toEqual([1]);
    expect(scan(`Bun.spawn(["git"], { detached: true, ...more });`)).toEqual([1]);
    expect(scan(`Bun.spawn(["git"], { ...more });`)).toEqual([1]);
  });

  test("brackets and calls inside strings, templates, regexes and comments do not count", () => {
    expect(scan(`// Bun.spawn(["git"]);\n/* Bun.spawn(x) */\nconst s = "Bun.spawn(";`)).toEqual([]);
    expect(scan(`Bun.spawn([")", \`\${a + "}"}(\`, "{"], { cwd: /[)}]/.source, detached: true });`)).toEqual([]);
    expect(scan(`const t = \`Bun.spawn(\${x})\`;\nBun.spawn(["a"]);`)).toEqual([2]);
  });

  test("node:child_process spawners are read too, under an alias or a namespace", () => {
    expect(scan(`import { spawn } from "node:child_process";\nspawn("bun", ["x"], { stdio: "inherit" });`)).toEqual([2]);
    expect(scan(`import { spawn } from "node:child_process";\nspawn("bun", ["x"], { detached: true });`)).toEqual([]);
    expect(scan(`import { execFile as ef } from "child_process";\nef("git", { cwd });`)).toEqual([2]);
    expect(scan(`import * as cp from "node:child_process";\ncp.spawn("bun");`)).toEqual([2]);
    expect(scan(`// import { spawn } from "node:child_process";\nspawn("bun");`)).toEqual([]);
  });

  test("the reason names the missing group", () => {
    const [site] = violationsIn("x.ts", `Bun.spawn(["git"], { stdout: "pipe" });`);
    expect(site?.reason).toBe("its options set no `detached: true`, so a kill reaches only the direct child");
    expect(violationsIn("x.ts", `Bun.spawn(cmd, opts);`)[0]?.reason).toContain("not an object literal");
  });
});

describe("compareToAllowlist", () => {
  const site = (file: string, line: number): Site => ({ file, line, reason: "r" });

  test("a site above its file's count is unlisted, naming file:line and runProc", () => {
    const { unlisted, stale } = compareToAllowlist([site("a.ts", 3), site("a.ts", 9)], new Map([["a.ts", 1]]));
    expect(stale).toEqual([]);
    expect(unlisted).toHaveLength(1);
    expect(unlisted[0]).toContain("a.ts:3 spawns a child without its own process group");
    expect(unlisted[0]).toContain("a.ts:9");
    expect(unlisted[0]).toContain("runProc");
  });

  test("a count above the live sites is stale, and an unlisted file allows 0", () => {
    expect(compareToAllowlist([site("a.ts", 1)], new Map([["a.ts", 2], ["b.ts", 1]])).stale).toHaveLength(2);
    expect(compareToAllowlist([site("c.ts", 1)], new Map()).unlisted).toHaveLength(1);
    expect(compareToAllowlist([site("a.ts", 1)], new Map([["a.ts", 1]]))).toEqual({ unlisted: [], stale: [] });
  });

  test("parseAllowlist reads <path> <count> and refuses anything else", () => {
    expect(parseAllowlist("# c\n\nsrc/a.ts 2\n")).toEqual(new Map([["src/a.ts", 2]]));
    expect(() => parseAllowlist("src/a.ts\n")).toThrow("unreadable line");
  });
});
