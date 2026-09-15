/**
 * A summary document's body as it is on disk.
 *
 * huginn's `GET /api/document/<c>/<id>` JSON `text` is a CLEANED copy: fenced
 * code removed, images filtered, S3 links rewritten, a breadcrumb prepended. A
 * summary that quotes a prompt or a config file in a fence loses it there.
 * `?raw=1` (huginn #131) serves the file itself, so every surface that SHOWS a
 * summary reads that — with an image filter at least as strict as huginn's and
 * huginn's S3 rewrite, and only its fence removal left out — and keeps the JSON
 * copy as the fallback.
 */
import { stripFrontmatter } from "../wiki/store.ts";
import { getLog } from "../logging.ts";

const log = getLog("summaries", "source-text");

/** The knowledge API's default request budget, applied to the WHOLE read. */
const SOURCE_READ_TIMEOUT_MS = 5_000;

/**
 * The source file with its frontmatter stripped and {@link filterDocumentText}
 * applied, or `null` when huginn cannot serve it as text within the budget (an
 * older huginn answers JSON, a missing file, a stalled body, huginn down). Never
 * throws.
 *
 * Its own fetch rather than the knowledge-API helper, because that helper's
 * timer stops at the headers: one AbortController here covers the body too, so
 * a stalled read is aborted, not merely abandoned with its connection open.
 *
 * `docIdPath` is already segment-encoded (`encodeDocIdPath`, or the doc route's
 * still-encoded URL segment).
 */
export async function readSummarySourceText(
  knowledgeApiUrl: string,
  collection: string,
  docIdPath: string,
  timeoutMs: number = SOURCE_READ_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${knowledgeApiUrl}/api/document/${encodeURIComponent(collection)}/${docIdPath}?raw=1`, {
      signal: controller.signal,
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("text/")) {
      controller.abort();
      return null;
    }
    return filterDocumentText(stripFrontmatter(await res.text()));
  } catch (err) {
    log.debug("source file unavailable for {collection}/{docIdPath}, using the cleaned copy: {error}", {
      collection,
      docIdPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `doc` with its `text` replaced by the source body when there is one. */
export function withSourceText<T>(doc: T, source: string | null): T {
  if (source === null || doc === null || typeof doc !== "object") return doc;
  return { ...doc, text: source, textSource: "file" };
}

// ---------------------------------------------------------------------------
// Images: NARROWER than huginn's `_document_text_image` by construction.
//
// Porting huginn's rules clause by clause meant reproducing Python's urlsplit,
// ipaddress and Unicode tables, and each verify round found new inputs where the
// port kept an image huginn drops. So this is an allowlist instead: an image is
// kept only when its destination is a plain ASCII relative path or an http(s)
// URL on a plain DNS host, and its alt only when it is ASCII caption words.
// Everything else is dropped (or its alt cleared). The contract checked against
// huginn's own answers (`__fixtures__/huginn-document-text.json`) is therefore
// one-directional: a kept image is huginn's answer, or that answer with its alt
// cleared — never an image huginn drops.
// ---------------------------------------------------------------------------

/** Python's `str.isspace()` set — what huginn's `\s`, `.split()` and `.strip()` use. */
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RUN_RE = new RegExp(`[${PY_WS}]+`, "g");

const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;
const MD_IMAGE_PARTS_RE = new RegExp(`^!\\[([^\\]]*)\\]\\([${PY_WS}]*(?:<([^>]*)>|([^)${PY_WS}]*))`);
const AFTER_DEST_RE = new RegExp(`^[${PY_WS}]*(?:["')']|$)`);
/** huginn's `_S3_URL_RE`, with Python's whitespace set: JS `\s` stops early at a BOM. */
const S3_URL_RE = new RegExp(`https://[a-zA-Z0-9._-]+\\.s3\\.[a-zA-Z0-9-]+\\.amazonaws\\.com/[^${PY_WS})]*`, "g");

const SEGMENT = "[A-Za-z0-9._~%-]+";
const QUERY = "(?:\\?[A-Za-z0-9._~%=&-]*)?";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const RELATIVE_DEST_RE = new RegExp(`^/?${SEGMENT}(?:/${SEGMENT})*${QUERY}$`);
const HTTP_DEST_RE = new RegExp(`^https?://(${LABEL}(?:\\.${LABEL})*)(?::[0-9]{1,5})?(?:/(?:${SEGMENT}/?)*)?${QUERY}$`, "i");
const SIGNED_QUERY_RE = /(?:^|[?&])(?:x-amz-[^=&]*|signature|sig|x-goog-[^=&]*|key-pair-id)=/i;
const DEST_MAX = 2048;

const ALT_TOKEN_RE = /^[A-Za-z0-9_.,:!'()\-’–—…]{1,20}$/;
const ALT_SCHEME_RE = /^[a-z][a-z0-9+.\-]*:\S/i;
const ALT_MAX = 80;

/** Images and S3 links rewritten over the WHOLE body, code included: cutting it
 *  at code spans let a backtick in an alt or a URL hide an image that marked
 *  still renders. */
export function filterDocumentText(body: string): string {
  return body.replace(MD_IMAGE_RE, (m) => documentTextImage(m) ?? "").replace(S3_URL_RE, "[file]");
}

function plainAlt(alt: string): string {
  const collapsed = alt.split(PY_WS_RUN_RE).filter(Boolean).join(" ");
  if (collapsed.length > ALT_MAX) return "";
  return collapsed.split(" ").every((t) => !t || (ALT_TOKEN_RE.test(t) && !ALT_SCHEME_RE.test(t))) ? collapsed : "";
}

function destinationAllowed(dest: string): boolean {
  if (dest.length > DEST_MAX) return false;
  const http = HTTP_DEST_RE.exec(dest);
  if (http) {
    const host = http[1]!.toLowerCase();
    if (host === "amazonaws.com" || host.endsWith(".amazonaws.com")) return false;
  } else if (!RELATIVE_DEST_RE.test(dest)) {
    return false;
  }
  return !SIGNED_QUERY_RE.test(dest.slice(dest.indexOf("?") + 1 || dest.length));
}

/** `null` to drop the image, else a normalized `![alt](dest)` with no title. */
export function documentTextImage(image: string): string | null {
  const m = MD_IMAGE_PARTS_RE.exec(image);
  if (!m) return null;
  const angled = m[2] !== undefined;
  const dest = angled ? m[2]! : m[3]!;
  if (!destinationAllowed(dest) || !AFTER_DEST_RE.test(image.slice(m[0].length))) return null;
  const alt = plainAlt(m[1]!);
  return angled ? `![${alt}](<${dest}>)` : `![${alt}](${dest})`;
}
