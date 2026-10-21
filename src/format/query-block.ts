/**
 * `<Query>`: one prod query on a report page — question, answer, the reading,
 * the result table from a CSV beside the page and the SQL. Wiki-only, like
 * `Historic`: not in `COMPONENT_VOCABULARY_RULES`.
 *
 * Pure and dependency-free (the chat bundle carries `web-format.ts`): the file
 * IO lives in `src/wiki/page-files.ts`, which hands the renderer a synchronous
 * {@link PageFiles} lookup built before `renderWikiHtml` runs.
 */
import type { Block, CodeBlock } from "./markdown-ast.ts";
import { codeSpanContent, lineCodeSpanRanges } from "./code-spans.ts";
import { resolveEmbedRelPath } from "./embed.ts";

/** What the loader read for one `csv=`/`sql=` value. "Not found" and "outside
 *  the wiki root" are one reason, `unavailable`, so a page cannot tell them
 *  apart and probe for files outside the root. */
export type PageFileResult =
  | { ok: true; text: string; svg?: DiagramSvgResult }
  | { ok: false; reason: PageFileFailure };

/** What the loader made of a `<Diagram src=>` file's HTML sibling: the one
 *  sanitized `<svg>`, or why there is none. The three `unknown*` lists are
 *  what the sanitizer dropped that it has no rule for (the `diagram-svg` lint
 *  finding); a drop by design is not in them. */
export interface DiagramSvgResult {
  svg: string | null;
  problem?: "missing" | "unparsable" | "too-large" | "budget";
  unknownElements: string[];
  unknownAttrs: string[];
  unknownClasses: string[];
}
export type PageFileFailure = "unavailable" | "invalid" | "extension" | "too-large" | "limit" | "budget";

/** The loader's answer, keyed by the attribute value as written (trimmed). */
export interface PageFiles {
  get(ref: string): PageFileResult | undefined;
}

/** The kinds of file a page reads beside itself, each for its own attribute:
 *  `<Query csv=>` and `<DeltaTable src=>` a `csv`, `<Query sql=>` a `sql`,
 *  `<CaseBoard src=>` a `yaml`. */
export type PageFileKind = "csv" | "sql" | "yaml" | "diagram";
/** Stands in, in a sanitized `<Diagram>` SVG, for the per-block id prefix the
 *  renderer writes (`src/wiki/diagram-svg.ts` marks, `diagram-block.ts`
 *  replaces). Here so the pure renderer never imports the sanitizer. */
export const DIAGRAM_ID_MARK = "__dgm-id__";
/** The archify JSON suffixes, one per diagram flavor. Never bare `.json`. */
export const DIAGRAM_SUFFIXES = [".architecture.json", ".workflow.json", ".lifecycle.json"] as const;
export type DiagramFlavor = "architecture" | "workflow" | "lifecycle";
export const PAGE_FILE_KIND_EXTENSIONS: Readonly<Record<PageFileKind, readonly string[]>> = {
  csv: [".csv"],
  sql: [".sql"],
  yaml: [".yaml", ".yml"],
  diagram: DIAGRAM_SUFFIXES,
};
const ALL_KINDS = Object.keys(PAGE_FILE_KIND_EXTENSIONS) as PageFileKind[];

/** The kind a path's extension names, or null for none of them. */
export function pageFileKind(p: string): PageFileKind | null {
  const ext = pageFileExtension(p);
  return ALL_KINDS.find((k) => PAGE_FILE_KIND_EXTENSIONS[k].includes(ext)) ?? null;
}
export const PAGE_FILE_MAX_BYTES = 1024 * 1024;
export const PAGE_FILE_MAX_PER_PAGE = 50;
/** Bytes one page open may read across all its files; refs past it answer `budget`. */
export const PAGE_FILE_PAGE_BUDGET_BYTES = 8 * 1024 * 1024;
export const QUERY_CSV_MAX_ROWS = 2000;

/** A path's extension, lower-cased: one of the multi-part archify suffixes
 *  (`.architecture.json`) when the name ends in one after a non-empty stem,
 *  else from the last `.` of its last segment, and none for a dotfile
 *  (`.csv`), as `path.extname` reads it. The ONE rule the lexical gate, the
 *  loader's realpath check and the bucket mirror share. */
export function pageFileExtension(p: string): string {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  for (const suffix of DIAGRAM_SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) return suffix;
  }
  const dot = name.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot) : "";
}

/** The flavor a `<Diagram src=>` value names by its suffix, or null. */
export function diagramFlavor(ref: string): DiagramFlavor | null {
  const ext = pageFileExtension(ref);
  if (ext === ".architecture.json") return "architecture";
  if (ext === ".workflow.json") return "workflow";
  return ext === ".lifecycle.json" ? "lifecycle" : null;
}

/** The HTML sibling of a diagram file: the kind suffix dropped, `.html` added
 *  (`flows/x.architecture.json` → `flows/x.html`). Null for a non-diagram ref. */
export function diagramSiblingHtml(ref: string): string | null {
  if (!diagramFlavor(ref)) return null;
  return `${ref.slice(0, ref.length - pageFileExtension(ref).length)}.html`;
}

/** The wiki-relative path the loader reads a `<Diagram src>`'s HTML sibling
 *  from: the ref must pass the lexical gate for a diagram file, and its
 *  sibling ({@link diagramSiblingHtml}) is joined onto the page's path by the
 *  `<Embed>` rule. Null when the ref is no diagram file or the sibling climbs
 *  above the root. The wiki index pairs the sibling under its page with it. */
export function diagramSiblingRelPath(pageRelPath: string, ref: string): string | null {
  if (checkPageFileRef(ref, ["diagram"]) !== "ok") return null;
  const sibling = diagramSiblingHtml(ref);
  return sibling === null ? null : resolveEmbedRelPath(pageRelPath.replace(/\\/g, "/"), sibling);
}

/** True when a segment of `p` is one the wiki index never scans: a dot
 *  segment (`.git`, `.hidden`, a dotfile) or `node_modules`. `.` and `..` are
 *  navigation, not names. */
export function hasExcludedSegment(p: string): boolean {
  return p.split("/").some((s) => s !== "." && s !== ".." && (s.startsWith(".") || s === "node_modules"));
}

/** The lexical gate on a file value, before any IO: relative to the page's
 *  folder with `/` separators. An absolute path, a backslash, a `\0`, a
 *  segment the index never scans (`hasExcludedSegment`) or an extension of no
 *  kind in `kinds` (default: any kind) is refused. `..` passes here; the
 *  loader refuses one that climbs above the root, then checks containment on
 *  the realpath. */
export function checkPageFileRef(
  ref: string,
  kinds: Iterable<PageFileKind> = ALL_KINDS,
): "ok" | "invalid" | "extension" {
  if (!ref || ref.startsWith("/") || ref.includes("\\") || ref.includes("\0") || /^[A-Za-z]:/.test(ref)) {
    return "invalid";
  }
  if (hasExcludedSegment(ref)) return "invalid";
  const kind = pageFileKind(ref);
  return kind !== null && [...kinds].includes(kind) ? "ok" : "extension";
}

export interface QueryAttrs {
  id: string;
  /** The card's `id` as a slug: NFC, then Unicode letters, combining marks,
   *  digits, `_` and `-`, lower-cased (`Spørring 8` → `spørring-8`, whether the
   *  file spells `ø` precomposed or not). Empty when `id` has no usable character.
   *  Not unique: the web renderer suffixes a repeat within one render. */
  anchor: string;
  question: string;
  answer: string;
  csv: string;
  sql: string;
  run: string;
  uses: string[];
}

/** An id as an anchor slug — the `QueryAttrs.anchor` rule, shared with the
 *  `<CaseBoard>` rows. */
export function anchorSlug(id: string): string {
  return id.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
}

export function parseQueryAttrs(attrs: Record<string, string>): QueryAttrs {
  const id = (attrs.id ?? "").trim();
  return {
    id,
    anchor: anchorSlug(id),
    question: (attrs.question ?? "").trim(),
    answer: (attrs.answer ?? "").trim(),
    csv: (attrs.csv ?? "").trim(),
    sql: (attrs.sql ?? "").trim(),
    run: (attrs.run ?? "").trim(),
    uses: (attrs.uses ?? "").split(",").map((u) => u.trim()).filter(Boolean),
  };
}

/** The body split from its SQL: without `sql=`, the FIRST `sql` fence that is a
 *  direct child of the body moves out into the disclosure; every other fence,
 *  and that one too when `sql=` is set, stays in the body. */
export function splitQuerySql(children: Block[], hasSqlFile: boolean): { sql: CodeBlock | null; body: Block[] } {
  if (hasSqlFile) return { sql: null, body: children };
  const k = children.findIndex((b) => b.type === "code_block" && b.lang.toLowerCase() === "sql");
  if (k === -1) return { sql: null, body: children };
  return { sql: children[k] as CodeBlock, body: [...children.slice(0, k), ...children.slice(k + 1)] };
}

/** The components that name a file beside the page, and the tag text a page
 *  must contain for the loader to parse it at all. */
export const PAGE_FILE_COMPONENTS = ["Query", "CaseBoard", "DeltaTable", "Diagram"] as const;

/** Every file value in `blocks`, at any depth, in source order, deduplicated:
 *  a `Query`'s `csv=`/`sql=`, a `CaseBoard`'s or `DeltaTable`'s `src=`. Walks
 *  the AST, so a tag written inside a code fence (a `code_block`) contributes
 *  nothing. */
export function pageFileRefs(blocks: Block[]): string[] {
  return [...pageFileRefKinds(blocks).keys()];
}

/** {@link pageFileRefs} with the kinds each ref is read as. One ref named by a
 *  `Query csv=` and a `DeltaTable src=` is one read, of kind `csv`. */
export function pageFileRefKinds(blocks: Block[]): Map<string, Set<PageFileKind>> {
  const out = new Map<string, Set<PageFileKind>>();
  const add = (ref: string, kind: PageFileKind) => {
    if (!ref) return;
    const set = out.get(ref) ?? new Set<PageFileKind>();
    set.add(kind);
    out.set(ref, set);
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type !== "component") continue;
      if (b.name === "Query") {
        const q = parseQueryAttrs(b.attrs);
        add(q.csv, "csv");
        add(q.sql, "sql");
      } else if (b.name === "CaseBoard") add((b.attrs.src ?? "").trim(), "yaml");
      else if (b.name === "DeltaTable") add((b.attrs.src ?? "").trim(), "csv");
      else if (b.name === "Diagram") add((b.attrs.src ?? "").trim(), "diagram");
      walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** The file name a fallback line shows: the last path segment. */
export function pageFileName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

const mb = (bytes: number) => `${+(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The ONE count format on the `Query`, `CaseBoard` and `DeltaTable` lines:
 *  `209,710`. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** The text a card shows in place of a file it could not use. English: the
 *  page's language is unknown here. The same text for a missing file and one
 *  outside the root. `what` names the content on the not-loaded line
 *  (`Result`, `Cases`, `Table`). */
export function pageFileFailureText(reason: PageFileFailure | "not-loaded", ref: string, what = "Result"): string {
  const name = pageFileName(ref);
  switch (reason) {
    case "not-loaded":
      return `${what} not loaded here: ${name}`;
    case "unavailable":
      return `File not available: ${name}`;
    case "invalid":
      return `Invalid file path: ${name}`;
    case "extension":
      return `File type not allowed: ${name}`;
    case "too-large":
      return `File over ${mb(PAGE_FILE_MAX_BYTES)}, not shown: ${name}`;
    case "limit":
      return `Over ${PAGE_FILE_MAX_PER_PAGE} files on this page, not loaded: ${name}`;
    case "budget":
      return `Over ${mb(PAGE_FILE_PAGE_BUDGET_BYTES)} of files on this page, not loaded: ${name}`;
  }
}

/** A file value resolved against the lookup for one component's `kind`: an
 *  extension of another kind is `extension` before the lookup is asked (the
 *  loader reads one ref once, whichever components name it); `files` absent
 *  (a surface with no reader — chat, the gardener preview) is `not-loaded`; a
 *  value the lookup does not hold reads as `unavailable`. */
export function lookupPageFile(
  files: PageFiles | undefined,
  ref: string,
  kind: PageFileKind,
): Extract<PageFileResult, { ok: true }> | { ok: false; reason: PageFileFailure | "not-loaded" } {
  if (checkPageFileRef(ref, [kind]) === "extension") return { ok: false, reason: "extension" };
  if (!files) return { ok: false, reason: "not-loaded" };
  return files.get(ref) ?? { ok: false, reason: "unavailable" };
}

/** The plain-text surfaces' lead lines (Slack, Telegram, email), unescaped:
 *  `head` is `Q-8 — <question>` (empty with neither; the one line a surface
 *  bolds), `answer` is `Svar: <answer>` (empty without one). The `Resultat:`
 *  line goes after the body. */
export function queryLead(q: QueryAttrs): { head: string; answer: string } {
  return {
    head: [q.id, q.question].filter(Boolean).join(" — "),
    answer: q.answer ? `Svar: ${q.answer}` : "",
  };
}

/** `text` with each inline code span rendered by `code` (given the span's
 *  content) and every other run by `plain`. Spans pair by CommonMark's exact-N
 *  rule (`lineCodeSpanRanges`), the grammar every renderer shares, so
 *  `` `` a ` b `` `` is one span. */
export function renderCodeSpans(text: string, plain: (s: string) => string, code: (s: string) => string): string {
  let out = "";
  let last = 0;
  for (const r of lineCodeSpanRanges(text)) {
    out += plain(text.slice(last, r.start)) + code(codeSpanContent(text, r));
    last = r.end;
  }
  return out + plain(text.slice(last));
}

export function queryResultLine(q: QueryAttrs): string {
  return q.csv ? `Resultat: ${pageFileName(q.csv)}` : "";
}

export const CASEBOARD_NO_SRC = "CaseBoard without src";
export const DIAGRAM_NO_SRC = "Diagram without src";

/** The plain-text surfaces' line for a `<CaseBoard>`, a `<DeltaTable src>` or
 *  a `<Diagram>`, unescaped: `Cases: cases.yaml`, `Table: runs.csv`,
 *  `Diagram: x.architecture.json (interactive: x.html)`. Those surfaces read no
 *  file, so the line names it. A CaseBoard or Diagram without `src` says so,
 *  as the web does; a DeltaTable without one renders its body table, so no line. */
export function blockFileLine(name: "CaseBoard" | "DeltaTable" | "Diagram", attrs: Record<string, string>): string {
  const src = (attrs.src ?? "").trim();
  if (!src) return name === "CaseBoard" ? CASEBOARD_NO_SRC : name === "Diagram" ? DIAGRAM_NO_SRC : "";
  if (name === "Diagram") {
    const html = diagramSiblingHtml(src);
    return `Diagram: ${pageFileName(src)}${html ? ` (interactive: ${pageFileName(html)})` : ""}`;
  }
  return `${name === "CaseBoard" ? "Cases" : "Table"}: ${pageFileName(src)}`;
}
