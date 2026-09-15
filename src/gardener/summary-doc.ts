/**
 * A summary document as the gardener reads it back from huginn: the source file's
 * body, without the `## Transcript` appendix.
 *
 * huginn's JSON `text` removes every fenced block, so a page drafted or clustered
 * from it cannot keep the prompt, config file or snippet a summary quotes. The
 * capture trigger never had that problem (it hands the summarizer's own output to
 * the drafter in-process), but the run-now, backlog, per-doc and weekly-harvest
 * paths read huginn. They now overlay `text` with the source file the way the
 * `/summaries` surfaces do (`readSummarySourceText`, which falls back to the
 * cleaned copy on any failure), and cut the appendix so they see the same body a
 * capture draft saw. The cut applies to the fallback copy too.
 */
import type { RawFetchedDoc } from "./types.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { readSummarySourceText, withSourceText } from "../summaries/source-text.ts";
import { encodeDocIdPath } from "../summaries/sources.ts";
import { splitTranscript } from "../summaries/transcript-split.ts";

export async function fetchSummaryDoc(
  apiUrl: string,
  collection: string,
  id: string,
  timeoutMs: number,
): Promise<RawFetchedDoc> {
  const source = readSummarySourceText(apiUrl, collection, encodeDocIdPath(id), timeoutMs);
  const doc: RawFetchedDoc = withSourceText(
    await fetchKnowledgeApi(apiUrl, `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
      timeoutMs,
    }),
    await source,
  );
  return typeof doc?.text === "string" ? { ...doc, text: splitTranscript(doc.text).body } : doc;
}
