/**
 * The import-direction ratchet (architecture review 2026-11, B1): five layers,
 * lowest first, and a file may import only from its own layer or a lower one.
 * `LAYER_MAP` places every non-test `.ts` file under `src/` and `db/` by its
 * longest matching prefix; `layer-direction.test.ts` fails on a file no entry
 * matches, so a new directory is classified here first. Today's upward imports
 * sit in `scripts/layer-allowlist.txt`, which may only shrink: the test fails on a
 * stale entry (`bun scripts/layer-ratchet.ts --update` removes it), and CI's
 * `--check-base` step fails a PR whose list adds an entry.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { BUN_TEST_FILE } from "./mock-isolation.ts";
import { parseAllowlist } from "./layer-allowlist.ts";

export { parseAllowlist };

export const LAYERS = ["platform", "render", "wiki-core", "features", "routes/views"] as const;
export type Layer = (typeof LAYERS)[number];

/** Directory (trailing `/`) or file prefixes; the longest match wins, so a file entry overrides its directory. */
export const LAYER_MAP: readonly (readonly [prefix: string, layer: Layer])[] = [
  ["db/", "platform"],
  ["src/db/", "platform"],
  ["src/logging.ts", "platform"],
  ["src/config.ts", "platform"],
  ["src/types.ts", "platform"],
  ["src/gcp/", "platform"],
  ["src/auth/", "platform"], // policy every route reads; its two imports of chat code are listed debt
  ["src/utils/", "platform"],
  ["src/tracing/", "platform"], // spans, written from every layer
  ["src/observability/", "platform"],
  ["src/startup/", "platform"],
  ["src/test/test-db-url.ts", "platform"], // imported by db/setup-test-db.ts

  ["src/format/", "render"],
  ["src/web/", "render"], // web-format.ts: markdown to HTML for chat and wiki alike

  ["src/wiki/", "wiki-core"],

  ["src/ai/", "features"],
  ["src/anthropic/", "features"],
  ["src/article/", "features"],
  ["src/benchmarks/", "features"],
  ["src/bot/", "features"],
  ["src/bots/", "features"], // bot config imports ai, gardener, hivemind and wiki types
  ["src/core/", "features"],
  ["src/gardener/", "features"],
  ["src/goals/", "features"],
  ["src/hivemind/", "features"],
  ["src/jira/", "features"],
  ["src/memory/", "features"],
  ["src/plans/", "features"],
  ["src/profile/", "features"],
  ["src/research/", "features"],
  ["src/scheduler/", "features"],
  ["src/serena/", "features"],
  ["src/share/", "features"],
  ["src/slack/", "features"],
  ["src/summaries/", "features"],
  ["src/sync/", "features"],
  ["src/tiktok/", "features"],
  ["src/video/", "features"],
  ["src/vimeo/", "features"],
  ["src/voice/", "features"],
  ["src/watchers/", "features"],
  ["src/x-article/", "features"],
  ["src/youtube/", "features"],

  ["src/chat/", "routes/views"],
  ["src/dashboard/", "routes/views"],
  ["src/index.ts", "routes/views"],
  ["src/test/", "routes/views"], // test helpers assemble fixtures from any layer
];

export function layerOf(file: string): Layer | null {
  let best: { len: number; layer: Layer } | null = null;
  for (const [prefix, layer] of LAYER_MAP) {
    const hit = prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix;
    if (hit && (!best || prefix.length > best.len)) best = { len: prefix.length, layer };
  }
  return best?.layer ?? null;
}

export const rank = (layer: Layer): number => LAYERS.indexOf(layer);

/** Every non-test `.ts` file under `src/` and `db/`, repo-relative, sorted. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules") walk(p);
      } else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !BUN_TEST_FILE.test(e.name)) {
        out.push(p);
      }
    }
  };
  for (const top of ["src", "db"]) walk(top);
  return out.sort();
}

/**
 * Module specifiers a file imports: static `import`/`export … from`, `import()`
 * with a string literal and `require()`. Type-only imports count: a type import
 * from a UI module still makes the lower layer's code depend on the upper one's.
 */
export function importSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

/** A relative specifier resolved to a repo-relative `.ts` file, or null for packages and non-`.ts` targets. */
export function resolveSpecifier(from: string, spec: string, exists: (rel: string) => boolean): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const cand of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (cand.endsWith(".ts") && exists(cand)) return cand;
  }
  return null;
}

export interface Edge {
  from: string;
  to: string;
}

export const edgeLine = (e: Edge): string => `${e.from} -> ${e.to}`;

/** Upward edges: an import whose target sits in a higher layer than its importer. */
export function violations(edges: readonly Edge[], layer: (f: string) => Layer | null = layerOf): Edge[] {
  return edges.filter((e) => {
    const a = layer(e.from);
    const b = layer(e.to);
    return a !== null && b !== null && rank(b) > rank(a);
  });
}

/** Every import edge between two of `files` (targets outside `src/` and `db/` are not edges). */
export function importEdges(root: string, files: readonly string[] = sourceFiles(root)): Edge[] {
  const known = new Set(files);
  const exists = (rel: string) => known.has(rel);
  const out: Edge[] = [];
  for (const from of files) {
    const seen = new Set<string>();
    for (const spec of importSpecifiers(readFileSync(path.join(root, from), "utf8"))) {
      const to = resolveSpecifier(from, spec, exists);
      if (to && to !== from && !seen.has(to)) {
        seen.add(to);
        out.push({ from, to });
      }
    }
  }
  return out;
}

export interface AllowlistCheck {
  /** Violations not on the list. */
  unlisted: string[];
  /** List entries that are no longer violations: delete them (`--update`). */
  stale: string[];
  /** Order and duplicate problems in the file itself. */
  format: string[];
}

export function checkAllowlist(listed: readonly string[], current: readonly string[]): AllowlistCheck {
  const format: string[] = [];
  for (let i = 1; i < listed.length; i++) {
    if (listed[i] === listed[i - 1]) format.push(`duplicate entry: ${listed[i]}`);
    else if (listed[i]! < listed[i - 1]!) format.push(`out of order: ${listed[i]} after ${listed[i - 1]}`);
  }
  const have = new Set(listed);
  const now = new Set(current);
  return {
    unlisted: [...now].filter((l) => !have.has(l)).sort(),
    stale: [...have].filter((l) => !now.has(l)).sort(),
    format,
  };
}

/** `--update`: keep only listed lines that are still violations, sorted and unique. Never adds a line. */
export function shrinkAllowlist(listed: readonly string[], current: readonly string[]): string[] {
  const now = new Set(current);
  return [...new Set(listed.filter((l) => now.has(l)))].sort();
}

/**
 * `--update`'s new file text: entries that are no longer violations, and repeats, are
 * dropped; comments and blank lines (recognised trimmed, as `parseAllowlist` does) stay
 * where they are. Entries keep their order, so an unsorted list stays a test failure.
 */
export function rewriteAllowlist(text: string, current: readonly string[]): string {
  const now = new Set(current);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) out.push(line);
    else if (now.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join("\n") + "\n";
}

/** Violation counts by `importer layer -> imported layer`. */
export function countByLayerPair(edges: readonly Edge[], layer: (f: string) => Layer | null = layerOf): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of edges) {
    const key = `${layer(e.from)} -> ${layer(e.to)}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return new Map([...out].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
