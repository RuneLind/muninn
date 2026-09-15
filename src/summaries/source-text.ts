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
import { getLog } from "../logging.ts";

const log = getLog("summaries", "source-text");

/** The fetch helper's default budget, applied to the whole read here. */
const SOURCE_READ_TIMEOUT_MS = 5_000;

/**
 * The source file with its frontmatter stripped and {@link filterDocumentText}
 * applied, or `null` when huginn cannot serve it as text within the budget (an
 * older huginn, a missing file, a stalled body, huginn down). Never throws.
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
  // The fetch helper's own timer stops once the HEADERS arrive, so a body that
  // stalls mid-stream would hold the caller forever; this bound covers the body.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      fetchKnowledgeApiSourceText(
        knowledgeApiUrl,
        `/api/document/${encodeURIComponent(collection)}/${docIdPath}?raw=1`,
        { timeoutMs },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("source read timed out")), timeoutMs);
      }),
    ]);
    return raw === null ? null : filterDocumentText(stripFrontmatter(raw));
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
// huginn's document-text rules, minus fence removal
// (`FilesDocumentConverter._clean_document_text` / `_document_text_image`).
// The rationale for every clause lives in that docstring; this is a port, held
// to huginn's own answers by `__fixtures__/huginn-document-text.json`. Python's
// character classes differ from JavaScript's, so they are spelled out below.
// ---------------------------------------------------------------------------

/** Python's `str.isspace()` set, which `\s`, `.split()` and `.strip()` use. */
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RUN_RE = new RegExp(`[${PY_WS}]+`, "g");
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;
const MD_IMAGE_PARTS_RE = new RegExp(`^!\\[([^\\]]*)\\]\\([${PY_WS}]*(?:<([^>]*)>|([^)${PY_WS}]*))`);
const AFTER_DEST_RE = new RegExp(`^[${PY_WS}]*(?:["')']|$)`);
const S3_URL_RE = /https:\/\/[a-zA-Z0-9._-]+\.s3\.[a-zA-Z0-9-]+\.amazonaws\.com\/[^\s)]*/g;
const SIGNED_QUERY_RE = /(?:^|[&;])(?:x-amz-[^=&;]*|signature|sig|x-goog-[^=&;]*|key-pair-id)=/i;
/** Python's `\w` is letters, digits and `_` — no combining marks. */
const ALT_CHARS_RE = /^[\p{L}\p{N}_.,:!'’()\-–—…]{1,20}$/u;
/** Python's IGNORECASE `[a-z]` also matches K (U+212A), ſ (U+017F), İ and ı. */
const ALT_SCHEME_RE = /^[a-zKſİı][a-z0-9+.\-Kſİı]*:\S/i;
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ALT_MAX = 80;
const DEST_MAX = 2048;

/** Images and S3 links rewritten as huginn's document text does, over the WHOLE
 *  body: cutting it at code spans let a backtick in an alt or a URL hide an
 *  image that marked still renders. */
export function filterDocumentText(body: string): string {
  return body.replace(MD_IMAGE_RE, (m) => documentTextImage(m) ?? "").replace(S3_URL_RE, "[file]");
}

function plainAlt(alt: string): string {
  const collapsed = alt.split(PY_WS_RUN_RE).filter(Boolean).join(" ");
  if (collapsed.length > ALT_MAX) return "";
  return collapsed.split(" ").every((t) => !t || (ALT_CHARS_RE.test(t) && !ALT_SCHEME_RE.test(t))) ? collapsed : "";
}

/** urlsplit's `_checknetloc`: a netloc that NFKC-normalizes into a separator is
 *  a ValueError, and huginn drops the image. */
function netlocRaises(netloc: string): boolean {
  if (/^[\x00-\x7f]*$/.test(netloc)) return false;
  const n = netloc.replace(/[@:#?]/g, "");
  const normalized = n.normalize("NFKC");
  if (n === normalized) return false;
  return /[/?#@:]/.test(normalized);
}

/** urlsplit's bracket rule: `[` and `]` only as a whole valid IPv6 host. */
function bracketsInvalid(netloc: string): boolean {
  if (!netloc.includes("[") && !netloc.includes("]")) return false;
  const m = /^(?:[^@]*@)?\[([^\]]*)\](?::[^\[\]]*)?$/.exec(netloc);
  return !m || !/^[0-9a-f:.]+$/i.test(m[1]!) || !m[1]!.includes(":");
}

/** `null` to drop the image, else a normalized `![alt](dest)` with no title. */
export function documentTextImage(image: string): string | null {
  const m = MD_IMAGE_PARTS_RE.exec(image);
  if (!m) return null;
  const alt = plainAlt(m[1]!);
  const angled = m[2] !== undefined;
  const dest = (angled ? m[2]! : m[3]!).replace(PY_STRIP_RE, "");
  if (dest.length > DEST_MAX || NON_PRINTABLE_RE.test(dest)) return null;
  if (!dest || !AFTER_DEST_RE.test(image.slice(m[0].length))) return null;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(dest)?.[1]?.toLowerCase() ?? "";
  const rest = scheme ? dest.slice(scheme.length + 1) : dest;
  let netloc = "";
  let tail = rest;
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end);
    tail = end < 0 ? "" : rest.slice(2 + end);
  }
  if (netlocRaises(netloc) || bracketsInvalid(netloc)) return null;
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
