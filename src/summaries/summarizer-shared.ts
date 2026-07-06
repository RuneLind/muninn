import { getLog } from "../logging.ts";
import type { SimilarArticle } from "./job-store.ts";

const log = getLog("summaries", "ingest");

/** Default structured-summary bullet list under step 3 of the scaffold. */
const DEFAULT_STRUCTURE_BULLETS = [
  "- ### Section headers for key topics",
  "- Bullet points with emoji prefixes",
  "- **Bold** for key terms and takeaways",
  "- Keep it concise but comprehensive",
];

/**
 * Build the shared CATEGORY:/SUMMARY: system-prompt scaffold used by the
 * youtube / x-article / anthropic summarizers. Only the intro sentence, the
 * category allowlist, and (occasionally) the structure bullets vary; the
 * CATEGORY-line + blank-line + SUMMARY-line contract is identical so the shared
 * `parseSummaryResponse` parser works unchanged. (TikTok's prompt is a bespoke
 * multi-turn frame-reading variant and doesn't use this.)
 */
export function buildSummarySystemPrompt(
  intro: string,
  categories: readonly string[],
  structureBullets: readonly string[] = DEFAULT_STRUCTURE_BULLETS,
): string {
  return `${intro}

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${categories.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   ${structureBullets.join("\n   ")}`;
}

/**
 * Best-effort POST of a finished summary to a Huginn `<vertical>/ingest`
 * endpoint, shared by the youtube / x-article / tiktok summarizers. A failure
 * here never fails the job (the summary already streamed to the client) — it
 * logs a warn and skips the "similar" enrichment. On success, any returned
 * `similar` articles are handed back via `onSimilar`.
 *
 * (anthropic's ingest is intentionally NOT routed through this: it's blocking,
 * fails the job on a non-ok response, and returns a doc `file_path`.)
 */
export async function ingestSummary(opts: {
  knowledgeApiUrl: string;
  /** Ingest path, e.g. "/api/youtube/ingest". */
  ingestPath: string;
  /** JSON body — the caller assembles title/url/summary/category/date (+author). */
  body: Record<string, unknown>;
  /** Called with the returned similar articles when the ingest succeeds. */
  onSimilar: (similar: SimilarArticle[]) => void;
  /** Abort timeout (default 15s). */
  timeoutMs?: number;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${opts.knowledgeApiUrl}${opts.ingestPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as { similar?: SimilarArticle[] };
      if (data.similar && data.similar.length > 0) {
        opts.onSimilar(data.similar);
      }
    } else {
      log.warn("Knowledge API ingest returned {status}", { status: res.status });
    }
  } catch (err) {
    clearTimeout(timeout);
    log.warn("Knowledge API ingest failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
