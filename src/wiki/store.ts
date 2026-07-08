/**
 * Knowledge-wiki read side — scans the huginn-jarvis Obsidian wiki on disk and
 * builds an in-memory index: page metadata (frontmatter), outgoing links
 * ([[wikilinks]] + relative markdown links), and inverted backlinks, keyed by
 * relPath. Powers the dashboard `/wiki` reader page.
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

export type WikiPageType = "source" | "concept" | "entity" | "analysis" | "note" | "explainer";

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
  /**
   * Outgoing link targets per page, keyed by normalized lowercased relPath
   * (`normalizeRelPath`); values are target relPaths in the same form.
   * relPath-keyed (not name-keyed) so same-stem pages in different folders
   * (e.g. mimir's three projects/<x>/architecture.md) keep distinct link sets.
   */
  outgoing: Map<string, string[]>;
  /** Inverted index: relPaths of pages whose content links TO this relPath. */
  backlinks: Map<string, string[]>;
  /** Resolve a wikilink target (name or alias, case-insensitive) to a page. */
  resolve: (target: string) => WikiPageMeta | undefined;
  /** Resolve a relPath (as stored in the graph's keys/values) back to its page. */
  resolveRelPath: (relPath: string) => WikiPageMeta | undefined;
  scannedAt: number;
  root: string;
}

/** Canonical graph key for a page path: posix-normalized, lowercased relPath. */
export function normalizeRelPath(relPath: string): string {
  return path.posix.normalize(relPath).toLowerCase();
}

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REL_PATH = "../huginn/huginn-jarvis/data/wiki";

/**
 * Resolve the wiki root to scan. An explicit `root` (a bot's configured
 * `wikiDir`) wins; otherwise fall back to today's behavior — the `WIKI_DIR` env
 * override, then the jarvis default. So a bare `/wiki` (no `?bot=`) is unchanged.
 */
function resolveWikiRoot(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
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

const MD_LINK_RE = /(!?)\[(?:[^\]]*)\]\(([^)]+)\)/g;

/**
 * Extract relative markdown link targets — `[text](target.md)` — from raw page
 * content. Wikis that use plain relative links instead of Obsidian [[wikilinks]]
 * (e.g. mimir, melosys-kode-wiki) join the same link graph through these. Returns
 * deduped, URL-decoded targets ending in `.md` (case-insensitive), with any
 * `#anchor` fragment stripped, still *relative to the linking page* (resolution
 * happens in `resolveMarkdownTargets`). Skips: images (`![...](...)`), absolute
 * URLs / any `scheme:` target (http:, https:, mailto:, …), absolute filesystem
 * paths (leading `/`), and non-`.md` targets. Like `extractWikilinks`, this does
 * not special-case fenced code blocks — matching that function's behavior.
 */
export function extractMarkdownLinks(content: string): string[] {
  const targets = new Set<string>();
  for (const m of content.matchAll(MD_LINK_RE)) {
    if (m[1]) continue; // leading '!' → image, not a link
    let target = (m[2] ?? "").trim();
    if (!target) continue;
    // Drop a link title: [text](url "title") → url
    const sp = target.search(/\s/);
    if (sp !== -1) target = target.slice(0, sp);
    // Strip an #anchor fragment; a bare same-page anchor (#foo) isn't a page link.
    const hash = target.indexOf("#");
    if (hash === 0) continue;
    if (hash > 0) target = target.slice(0, hash);
    if (!target) continue;
    // Ignore absolute URLs / any scheme: prefix and absolute filesystem paths.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
    if (target.startsWith("/")) continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // Malformed %-escape — keep the raw form so a real .md link isn't lost.
    }
    if (!decoded.toLowerCase().endsWith(".md")) continue;
    targets.add(decoded);
  }
  return [...targets];
}

/**
 * Resolve extracted relative `.md` targets against the linking page's own
 * location within the wiki, returning normalized, lowercased target relPaths
 * that stay inside the wiki root. Targets that escape the root via `../` are
 * dropped. Lowercasing mirrors the case-insensitive `resolve()` used for the
 * wikilink graph so both link kinds match pages the same way.
 */
function resolveMarkdownTargets(fromRelPath: string, targets: string[]): string[] {
  const dir = path.posix.dirname(fromRelPath);
  const out: string[] = [];
  for (const t of targets) {
    const joined = path.posix.normalize(path.posix.join(dir, t));
    if (joined === ".." || joined.startsWith("../")) continue; // escaped the root
    out.push(normalizeRelPath(joined));
  }
  return out;
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

/** Bounded prefix (bytes) read from an .html explainer to sniff its <title>. */
const HTML_TITLE_SNIFF_BYTES = 4096;
const HTML_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/**
 * Build metadata for a standalone HTML explainer. Unlike markdown pages these
 * carry no frontmatter and don't join the wikilink graph — title comes from the
 * file's <title> (sniffed from a bounded prefix) or the filename stem, and the
 * created/updated dates are the file's mtime (yyyy-mm-dd). Returns null when the
 * file is unreadable so the rest of the wiki stays browsable.
 */
async function buildExplainerMeta(root: string, relPath: string): Promise<WikiPageMeta | null> {
  const abs = path.join(root, relPath);
  const stem = path.basename(relPath, ".html");
  let title = stem;
  try {
    const prefix = await Bun.file(abs).slice(0, HTML_TITLE_SNIFF_BYTES).text();
    const m = prefix.match(HTML_TITLE_RE);
    if (m && m[1]!.trim()) title = m[1]!.trim();
  } catch {
    return null; // unreadable — skip, keep the rest of the wiki browsable
  }
  let date: string | undefined;
  try {
    date = (await stat(abs)).mtime.toISOString().slice(0, 10);
  } catch {
    date = undefined;
  }
  return {
    name: stem,
    title,
    type: "explainer",
    domain: relPath.startsWith("life/") ? "life" : "ai",
    tags: [],
    aliases: [],
    created: date,
    updated: date,
    relPath,
  };
}

/**
 * Build the index by scanning every .md and .html file under the wiki root
 * (dot-dirs like .obsidian excluded). ~700 small files — a full scan is well
 * under a second, and results are TTL-cached, so no incremental tracking is
 * needed. Markdown pages carry frontmatter + [[wikilinks]] and join the link
 * graph; standalone HTML explainers do not (title/mtime only, no backlinks).
 */
export async function buildWikiIndex(root: string): Promise<WikiIndex> {
  const glob = new Bun.Glob("**/*.{md,html}");
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
  /** Per-page resolved relative-markdown-link targets (normalized relPaths). */
  const rawMdTargets = new Map<string, string[]>();

  const register = (key: string, meta: WikiPageMeta) => {
    const k = key.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, meta);
  };

  await Promise.all(
    relPaths.map(async (relPath) => {
      if (relPath.endsWith(".html")) {
        const meta = await buildExplainerMeta(root, relPath);
        if (meta) {
          pages.push(meta);
          rawOutgoing.set(relPath, []); // explainers don't join the link graph
        }
        return;
      }
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
      rawOutgoing.set(relPath, extractWikilinks(content).filter((t) => t !== name));
      rawMdTargets.set(relPath, resolveMarkdownTargets(relPath, extractMarkdownLinks(content)));
    }),
  );

  // An explainer whose stem collides with a markdown page would make resolve()
  // (and wikilinks to that stem) ambiguous — markdown wins, the explainer is
  // dropped from the index.
  const mdNames = new Set(
    pages.filter((p) => p.type !== "explainer").map((p) => p.name.toLowerCase()),
  );
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i]!;
    if (p.type === "explainer" && mdNames.has(p.name.toLowerCase())) {
      log.debug("explainer {relPath} shadowed by same-stem markdown page — dropped", {
        relPath: p.relPath,
      });
      pages.splice(i, 1);
    }
  }

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

  // relPath lookup for the graph: both link kinds resolve to a target *page* and
  // are stored as that page's normalized relPath — unique even when stems collide,
  // so same-stem pages in different folders keep distinct link sets and counts.
  const byRelPath = new Map<string, WikiPageMeta>();
  for (const meta of pages) {
    const key = normalizeRelPath(meta.relPath);
    if (!byRelPath.has(key)) byRelPath.set(key, meta);
  }
  const resolveRelPath = (relPath: string) => byRelPath.get(normalizeRelPath(relPath));

  const outgoing = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const meta of pages) {
    const key = normalizeRelPath(meta.relPath);
    const resolved = new Set<string>();
    // Wikilinks resolve by name/alias (ambiguous stems go to the first-registered
    // winner, as before) — then join the graph as the winner's relPath.
    for (const target of rawOutgoing.get(meta.relPath) ?? []) {
      const targetMeta = resolve(target);
      if (!targetMeta) continue;
      const targetKey = normalizeRelPath(targetMeta.relPath);
      if (targetKey !== key) resolved.add(targetKey);
    }
    // Relative markdown links resolve by path and feed the same set — a page
    // linked both by [[wikilink]] and [text](path.md) counts once. Explainers
    // can't be markdown-link targets (targets always end in .md).
    for (const rel of rawMdTargets.get(meta.relPath) ?? []) {
      if (rel !== key && byRelPath.has(rel)) resolved.add(rel);
    }
    outgoing.set(key, [...resolved]);
    for (const targetKey of resolved) {
      let arr = backlinks.get(targetKey);
      if (!arr) {
        arr = [];
        backlinks.set(targetKey, arr);
      }
      arr.push(key);
    }
  }
  for (const arr of backlinks.values()) arr.sort();

  return { pages, outgoing, backlinks, resolve, resolveRelPath, scannedAt: Date.now(), root };
}

/** Per-root TTL cache — bots point at different wikis, so caches can't be shared. */
const caches = new Map<string, WikiIndex>();
/** Roots we've already warned about being unreadable (one warn per root). */
const warnedRoots = new Set<string>();

/**
 * TTL-cached index over a wiki root. Pass `root` (a bot's `wikiDir`) to browse a
 * specific bot's wiki; omit it to keep today's behavior (`WIKI_DIR` env → jarvis
 * default). Each root is cached and degraded independently — a missing melosys
 * wiki never affects the jarvis cache. Returns null (and warns once per root)
 * when the directory is missing — the caller renders an empty state.
 */
export async function getWikiIndex(opts?: { root?: string; refresh?: boolean }): Promise<WikiIndex | null> {
  const root = resolveWikiRoot(opts?.root);
  const cached = caches.get(root);
  if (cached && !opts?.refresh && Date.now() - cached.scannedAt < CACHE_TTL_MS) {
    return cached;
  }
  try {
    const st = await stat(root);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    if (!warnedRoots.has(root)) {
      log.warn("Wiki directory not readable at {path} — /wiki disabled: {error}", {
        path: root,
        error: err instanceof Error ? err.message : String(err),
      });
      warnedRoots.add(root);
    }
    caches.delete(root);
    return null;
  }

  const started = Date.now();
  const index = await buildWikiIndex(root);
  caches.set(root, index);
  warnedRoots.delete(root);
  log.info("Wiki index built: {pages} pages in {ms}ms from {path}", {
    pages: index.pages.length,
    ms: Date.now() - started,
    path: root,
  });
  return index;
}

/** Raw markdown of one page (by resolved meta). Null when the file vanished. */
export async function readWikiPage(index: WikiIndex, meta: WikiPageMeta): Promise<string | null> {
  try {
    return await Bun.file(path.join(index.root, meta.relPath)).text();
  } catch {
    return null;
  }
}

/** Test-only: drop all per-root caches + re-arm the one-shot warnings between cases. */
export function __resetWikiCacheForTest(): void {
  caches.clear();
  warnedRoots.clear();
}
