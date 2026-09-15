/**
 * A summary document's body as it is on disk.
 *
 * huginn's `GET /api/document/<c>/<id>` JSON `text` is a CLEANED copy: fenced
 * code removed, images filtered, S3 links rewritten, a breadcrumb prepended. A
 * summary that quotes a prompt or a config file in a fence loses it there.
 * `?raw=1` (huginn #131) serves the file itself, so every surface that SHOWS a
 * summary reads that — with huginn's image and S3 rules re-applied, and only its
 * fence removal left out — and keeps the JSON copy as the fallback.
 */
import { fetchKnowledgeApiSourceText } from "../ai/knowledge-api-client.ts";
import { stripFrontmatter } from "../wiki/store.ts";
import { markdownCodeRegions } from "../format/markdown-ast.ts";
import { getLog } from "../logging.ts";

const log = getLog("summaries", "source-text");

/**
 * The source file with its frontmatter stripped and {@link filterDocumentText}
 * applied, or `null` when huginn cannot serve it as text (an older huginn, a
 * missing file, huginn down). Never throws.
 *
 * `docIdPath` is already segment-encoded (`encodeDocIdPath`, or the doc route's
 * still-encoded URL segment).
 */
export async function readSummarySourceText(
  knowledgeApiUrl: string,
  collection: string,
  docIdPath: string,
  timeoutMs?: number,
): Promise<string | null> {
  try {
    const raw = await fetchKnowledgeApiSourceText(
      knowledgeApiUrl,
      `/api/document/${encodeURIComponent(collection)}/${docIdPath}?raw=1`,
      { timeoutMs },
    );
    return raw === null ? null : filterDocumentText(stripFrontmatter(raw));
  } catch (err) {
    log.debug("source file unavailable for {collection}/{docIdPath}, using the cleaned copy: {error}", {
      collection,
      docIdPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** `doc` with its `text` replaced by the source body when there is one. */
export function withSourceText<T>(doc: T, source: string | null): T {
  if (source === null || doc === null || typeof doc !== "object") return doc;
  return { ...doc, text: source, textSource: "file" };
}

// ---------------------------------------------------------------------------
// huginn's document-text rules, minus fence removal
// (`FilesDocumentConverter._clean_document_text` / `_document_text_image`).
// The rationale for every clause lives in that docstring; this is a port.
// ---------------------------------------------------------------------------

const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;
const MD_IMAGE_PARTS_RE = /^!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]*))/;
const S3_URL_RE = /https:\/\/[a-zA-Z0-9._-]+\.s3\.[a-zA-Z0-9-]+\.amazonaws\.com\/[^\s)]*/g;
const SIGNED_QUERY_RE = /(?:^|[&;])(?:x-amz-[^=&;]*|signature|sig|x-goog-[^=&;]*|key-pair-id)=/i;
const ALT_TOKEN_RE = /^(?![a-z][a-z0-9+.\-]*:\S)[\p{L}\p{M}\p{N}_.,:!'’()\-–—…]{1,20}$/iu;
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ALT_MAX = 80;
const DEST_MAX = 2048;

/** Images and S3 links rewritten as huginn's document text does, fenced and
 *  inline code left verbatim — code is rendered as text, never loaded. */
export function filterDocumentText(body: string): string {
  let out = "";
  let pos = 0;
  for (const region of markdownCodeRegions(body)) {
    out += filterProse(body.slice(pos, region.start)) + body.slice(region.start, region.end);
    pos = region.end;
  }
  return out + filterProse(body.slice(pos));
}

function filterProse(text: string): string {
  return text.replace(MD_IMAGE_RE, (m) => documentTextImage(m) ?? "").replace(S3_URL_RE, "[file]");
}

function plainAlt(alt: string): string {
  const collapsed = alt.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed.length > ALT_MAX) return "";
  return collapsed.split(" ").every((t) => !t || ALT_TOKEN_RE.test(t)) ? collapsed : "";
}

/** `null` to drop the image, else a normalized `![alt](dest)` with no title. */
export function documentTextImage(image: string): string | null {
  const m = MD_IMAGE_PARTS_RE.exec(image);
  if (!m) return null;
  const alt = plainAlt(m[1]!);
  const angled = m[2] !== undefined;
  const dest = (angled ? m[2]! : m[3]!).trim();
  if (!dest || dest.length > DEST_MAX || NON_PRINTABLE_RE.test(dest)) return null;
  if (!/^\s*(?:["')']|$)/.test(image.slice(m[0].length))) return null;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(dest)?.[1]?.toLowerCase() ?? "";
  const rest = scheme ? dest.slice(scheme.length + 1) : dest;
  let netloc = "";
  let tail = rest;
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end);
    tail = end < 0 ? "" : rest.slice(2 + end);
  }
  if (scheme && scheme !== "http" && scheme !== "https") return null;
  if (scheme && !netloc) return null;
  if (netloc) {
    if (netloc.includes("@")) return null;
    const hostPart = netloc.startsWith("[") ? netloc.slice(0, netloc.indexOf("]") + 1) : netloc.split(":")[0]!;
    const host = hostPart.normalize("NFKC").replace(/[。．｡]/g, ".").replace(/\.+$/, "").toLowerCase();
    if (host === "amazonaws.com" || host.endsWith(".amazonaws.com")) return null;
  }
  const beforeFragment = tail.split("#")[0]!;
  const query = beforeFragment.includes("?") ? beforeFragment.slice(beforeFragment.indexOf("?") + 1) : "";
  const path = beforeFragment.split("?")[0]!;
  const params = path.includes(";") ? path.slice(path.indexOf(";") + 1) : "";
  if (SIGNED_QUERY_RE.test(query) || SIGNED_QUERY_RE.test(params)) return null;
  return angled ? `![${alt}](<${dest}>)` : `![${alt}](${dest})`;
}
