/**
 * A summary document's body as it is on disk.
 *
 * huginn's `GET /api/document/<c>/<id>` JSON `text` is a CLEANED copy: fenced
 * code removed, images rewritten, a breadcrumb prepended. A summary that quotes
 * a prompt or a config file in a fence loses it there. `?raw=1` (huginn #131)
 * serves the file itself, so every surface that SHOWS a summary reads that and
 * keeps the JSON copy only as the fallback.
 */
import { fetchKnowledgeApiSourceText } from "../ai/knowledge-api-client.ts";
import { stripFrontmatter } from "../wiki/store.ts";
import { getLog } from "../logging.ts";

const log = getLog("summaries", "source-text");

/**
 * The source file with its frontmatter stripped, or `null` when huginn cannot
 * serve it as text (an older huginn, a missing file, huginn down). Never throws.
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
    return raw === null ? null : stripFrontmatter(raw);
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
  return { ...doc, text: source };
}
