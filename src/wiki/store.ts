/**
 * Knowledge-wiki read side — scans the huginn-jarvis Obsidian wiki on disk and
 * builds an in-memory index: page metadata (frontmatter), outgoing [[wikilinks]],
 * and inverted backlinks. Powers the dashboard `/wiki` reader page.
 *
 * Like `src/summaries/author-scores.ts`, the wiki is a sibling-checkout file
 * dependency: default path `../huginn/huginn-jarvis/data/wiki` relative to the
 * muninn repo root, overridable with `WIKI_DIR`. A missing/unreadable directory
 * degrades to null (one warn, not one per request) — the page then shows an
 * empty state instead of taking the dashboard down.
 */

import path from "node:path";
import { stat } from "node:fs/promises";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "store");

export type WikiPageType = "source" | "concept" | "entity" | "analysis" | "note";

export interface WikiPageMeta {
  /** Canonical page name — the filename stem; what [[wikilinks]] resolve against. */
  name: string;
  title: string;
  type: WikiPageType;
  /** Which wiki subtree the page lives in: the root AI wiki or the life/ split. */
  domain: "ai" | "life";
  tags: string[];
  aliases: string[];
  created?: string;
  updated?: string;
  /** External URL for source pages (YouTube video, X article, …). */
  url?: string;
  /** Path relative to the wiki root — unique even when stems collide. */
  relPath: string;
}

export interface WikiIndex {
  pages: WikiPageMeta[];
  /** Outgoing wikilink targets per page name, as canonical names (resolved). */
  outgoing: Map<string, string[]>;
  /** Inverted index: pages whose content links TO this page name. */
  backlinks: Map<string, string[]>;
  /** Resolve a wikilink target (name or alias, case-insensitive) to a page. */
  resolve: (target: string) => WikiPageMeta | undefined;
  scannedAt: number;
  root: string;
}

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REL_PATH = "../huginn/huginn-jarvis/data/wiki";

function resolveWikiRoot(): string {
  const override = process.env.WIKI_DIR;
  if (override && override.trim()) return override.trim();
  // import.meta.dir = <root>/src/wiki → repo root is two levels up.
  const repoRoot = path.resolve(import.meta.dir, "../../");
  return path.resolve(repoRoot, DEFAULT_REL_PATH);
}

/**
 * Parse the flat YAML-subset frontmatter used by the wiki (scalars, quoted
 * strings, and single-line inline arrays). Returns {} when the file has no
 * leading `---` fence. Not a general YAML parser — the wiki's generator only
 * ever emits this shape.
 */
export function parseFrontmatter(content: string): Record<string, string | string[]> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const body = content.slice(content.indexOf("\n") + 1, end);

  const out: Record<string, string | string[]> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!.trim();
    if (!raw) continue;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      out[key] = splitInlineArray(raw.slice(1, -1));
    } else {
      out[key] = unquote(raw);
    }
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split an inline-array body on top-level commas, honoring quoted strings. */
export function splitInlineArray(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      if (current.trim()) items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** Extract deduped [[wikilink]] targets from raw file content (frontmatter included). */
export function extractWikilinks(content: string): string[] {
  const targets = new Set<string>();
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = m[1]!.trim();
    if (target) targets.add(target);
  }
  return [...targets];
}

const VALID_TYPES: WikiPageType[] = ["source", "concept", "entity", "analysis", "note"];

function typeFromFrontmatter(fm: Record<string, string | string[]>, relPath: string): WikiPageType {
  const raw = typeof fm.type === "string" ? fm.type : "";
  if ((VALID_TYPES as string[]).includes(raw)) return raw as WikiPageType;
  if (raw === "analyses") return "analysis";
  // Fall back to the folder the page lives in.
  const folder = relPath.replace(/^life\//, "").split("/")[0] ?? "";
  if (folder === "sources") return "source";
  if (folder === "concepts") return "concept";
  if (folder === "entities") return "entity";
  if (folder === "analyses") return "analysis";
  return "note";
}

function asStringArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return [v];
  return [];
}

/**
 * Build the index by scanning every .md file under the wiki root (dot-dirs like
 * .obsidian excluded). ~700 small files — a full scan is well under a second,
 * and results are TTL-cached, so no incremental tracking is needed.
 */
export async function buildWikiIndex(root: string): Promise<WikiIndex> {
  const glob = new Bun.Glob("**/*.md");
  const relPaths: string[] = [];
  for await (const p of glob.scan({ cwd: root, dot: false })) {
    // Bun.Glob's dot:false skips dot FILES but still descends dot DIRS on some
    // versions — filter path segments explicitly.
    if (p.split("/").some((seg) => seg.startsWith("."))) continue;
    relPaths.push(p);
  }
  relPaths.sort();

  const pages: WikiPageMeta[] = [];
  const byKey = new Map<string, WikiPageMeta>();
  const rawOutgoing = new Map<string, string[]>();

  const register = (key: string, meta: WikiPageMeta) => {
    const k = key.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, meta);
  };

  await Promise.all(
    relPaths.map(async (relPath) => {
      let content: string;
      try {
        content = await Bun.file(path.join(root, relPath)).text();
      } catch {
        return; // unreadable file — skip, keep the rest of the wiki browsable
      }
      const fm = parseFrontmatter(content);
      const name = path.basename(relPath, ".md");
      const meta: WikiPageMeta = {
        name,
        title: typeof fm.title === "string" && fm.title ? fm.title : name,
        type: typeFromFrontmatter(fm, relPath),
        domain: relPath.startsWith("life/") ? "life" : "ai",
        tags: asStringArray(fm.tags),
        aliases: asStringArray(fm.aliases),
        created: typeof fm.created === "string" ? fm.created : undefined,
        updated: typeof fm.updated === "string" ? fm.updated : undefined,
        url: typeof fm.url === "string" ? fm.url : undefined,
        relPath,
      };
      pages.push(meta);
      rawOutgoing.set(name, extractWikilinks(content).filter((t) => t !== name));
    }),
  );

  pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
  // Registration order decides stem-collision winners: root AI pages sort before
  // life/ and register first, matching Obsidian's ambiguous-link behavior closely
  // enough for a read-only viewer.
  for (const meta of pages) register(meta.name, meta);
  for (const meta of pages) {
    register(meta.title, meta);
    for (const alias of meta.aliases) register(alias, meta);
  }

  const resolve = (target: string) => byKey.get(target.trim().toLowerCase());

  const outgoing = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const [source, targets] of rawOutgoing) {
    const resolved = new Set<string>();
    for (const target of targets) {
      const meta = resolve(target);
      if (meta && meta.name !== source) resolved.add(meta.name);
    }
    outgoing.set(source, [...resolved]);
    for (const targetName of resolved) {
      let arr = backlinks.get(targetName);
      if (!arr) {
        arr = [];
        backlinks.set(targetName, arr);
      }
      arr.push(source);
    }
  }
  for (const arr of backlinks.values()) arr.sort();

  return { pages, outgoing, backlinks, resolve, scannedAt: Date.now(), root };
}

let cache: WikiIndex | null = null;
let warnedDegraded = false;

/**
 * TTL-cached index over the configured wiki root. Returns null (and warns once)
 * when the wiki directory is missing — the caller renders an empty state.
 */
export async function getWikiIndex(opts?: { refresh?: boolean }): Promise<WikiIndex | null> {
  const root = resolveWikiRoot();
  if (cache && cache.root === root && !opts?.refresh && Date.now() - cache.scannedAt < CACHE_TTL_MS) {
    return cache;
  }
  try {
    const st = await stat(root);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    if (!warnedDegraded) {
      log.warn("Wiki directory not readable at {path} — /wiki disabled: {error}", {
        path: root,
        error: err instanceof Error ? err.message : String(err),
      });
      warnedDegraded = true;
    }
    cache = null;
    return null;
  }

  const started = Date.now();
  cache = await buildWikiIndex(root);
  warnedDegraded = false;
  log.info("Wiki index built: {pages} pages in {ms}ms from {path}", {
    pages: cache.pages.length,
    ms: Date.now() - started,
    path: root,
  });
  return cache;
}

/** Raw markdown of one page (by resolved meta). Null when the file vanished. */
export async function readWikiPage(index: WikiIndex, meta: WikiPageMeta): Promise<string | null> {
  try {
    return await Bun.file(path.join(index.root, meta.relPath)).text();
  } catch {
    return null;
  }
}

/** Test-only: drop the TTL cache + re-arm the one-shot warning between cases. */
export function __resetWikiCacheForTest(): void {
  cache = null;
  warnedDegraded = false;
}
