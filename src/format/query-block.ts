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

/** What the loader read for one `csv=`/`sql=` value. "Not found" and "outside
 *  the wiki root" are one reason, `unavailable`, so a page cannot tell them
 *  apart and probe for files outside the root. */
export type PageFileResult =
  | { ok: true; text: string }
  | { ok: false; reason: PageFileFailure };
export type PageFileFailure = "unavailable" | "invalid" | "extension" | "too-large" | "limit";

/** The loader's answer, keyed by the attribute value as written (trimmed). */
export interface PageFiles {
  get(ref: string): PageFileResult | undefined;
}

/** Extensions a page may read beside itself. */
export const PAGE_FILE_EXTENSIONS: readonly string[] = [".csv", ".sql"];
export const PAGE_FILE_MAX_BYTES = 1024 * 1024;
export const PAGE_FILE_MAX_PER_PAGE = 50;
export const QUERY_CSV_MAX_ROWS = 2000;

/** The lexical gate on a `csv=`/`sql=` value, before any IO: relative to the
 *  page's folder with `/` separators. An absolute path, a backslash, a `\0` or
 *  a disallowed extension is refused. `..` passes here; containment is the
 *  loader's realpath check. */
export function checkPageFileRef(ref: string): "ok" | "invalid" | "extension" {
  if (!ref || ref.startsWith("/") || ref.includes("\\") || ref.includes("\0") || /^[A-Za-z]:/.test(ref)) {
    return "invalid";
  }
  const dot = ref.lastIndexOf(".");
  const ext = dot > ref.lastIndexOf("/") ? ref.slice(dot).toLowerCase() : "";
  return PAGE_FILE_EXTENSIONS.includes(ext) ? "ok" : "extension";
}

export interface QueryAttrs {
  id: string;
  /** The card's `id`: `Q-8` → `q-8`. Empty when `id` has no usable character. */
  anchor: string;
  question: string;
  answer: string;
  csv: string;
  sql: string;
  run: string;
  uses: string[];
}

export function parseQueryAttrs(attrs: Record<string, string>): QueryAttrs {
  const id = (attrs.id ?? "").trim();
  return {
    id,
    anchor: id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""),
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

/** Every `csv=`/`sql=` value on a `Query` in `blocks`, at any depth, in source
 *  order, deduplicated. Walks the AST, so a `<Query>` written inside a code
 *  fence (a `code_block`) contributes nothing. */
export function queryFileRefs(blocks: Block[]): string[] {
  const out = new Set<string>();
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type !== "component") continue;
      if (b.name === "Query") {
        const q = parseQueryAttrs(b.attrs);
        if (q.csv) out.add(q.csv);
        if (q.sql) out.add(q.sql);
      }
      walk(b.children);
    }
  };
  walk(blocks);
  return [...out];
}

/** The file name a fallback line shows: the last path segment. */
export function pageFileName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/** The text a card shows in place of a file it could not use. English: the
 *  page's language is unknown here. The same text for a missing file and one
 *  outside the root. */
export function pageFileFailureText(reason: PageFileFailure | "not-loaded", ref: string): string {
  const name = pageFileName(ref);
  switch (reason) {
    case "not-loaded":
      return `Result not loaded here: ${name}`;
    case "unavailable":
      return `File not available: ${name}`;
    case "invalid":
      return `Invalid file path: ${name}`;
    case "extension":
      return `File type not allowed: ${name}`;
    case "too-large":
      return `File over 1 MB, not shown: ${name}`;
    case "limit":
      return `Over ${PAGE_FILE_MAX_PER_PAGE} files on this page, not loaded: ${name}`;
  }
}

/** A `csv=`/`sql=` value resolved against the lookup: `files` absent (a surface
 *  with no reader — chat, the gardener preview) is `not-loaded`; a value the
 *  lookup does not hold reads as `unavailable`. */
export function lookupPageFile(
  files: PageFiles | undefined,
  ref: string,
): { ok: true; text: string } | { ok: false; reason: PageFileFailure | "not-loaded" } {
  if (!files) return { ok: false, reason: "not-loaded" };
  return files.get(ref) ?? { ok: false, reason: "unavailable" };
}

/** The plain-text surfaces' lead lines (Slack, Telegram, email): `Q-8 — <question>`
 *  and `Svar: <answer>`, unescaped. The `Resultat:` line goes after the body. */
export function queryLeadLines(q: QueryAttrs): string[] {
  const head = [q.id, q.question].filter(Boolean).join(" — ");
  return [head, q.answer ? `Svar: ${q.answer}` : ""].filter(Boolean);
}

export function queryResultLine(q: QueryAttrs): string {
  return q.csv ? `Resultat: ${pageFileName(q.csv)}` : "";
}
