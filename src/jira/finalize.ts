/**
 * The tail every generated Jira draft runs through — one implementation, two
 * producers.
 *
 * The notes path (`jira-sse.ts`, one fenced one-shot over a fenced prompt) and
 * the thread path (`jira-routes.ts`, one turn in a chat thread) differ entirely
 * in how they get their text and not at all in what has to happen to it
 * afterwards: strip a wrapping fence, repair `[n]` markers, append the
 * server-built `## Referanser`, run both post-passes, land the row.
 *
 * It was extracted rather than copied because every step here is a defect this
 * feature has already shipped once — the `[n]` markers that resolved to nothing,
 * a `## Referanser` built from the stored set instead of what the model was
 * given, key verification against the wide set instead of the retained one. A
 * second copy would re-open all three on the new path only, where nothing tests
 * them together.
 */

import { stripCitationMarkers } from "./citation-markers.ts";
import { checkJiraMarkdown } from "./markdown-check.ts";
import { appendReferences, stripJiraWrappingFence } from "./prompt.ts";
import { verifyJiraKeys } from "./verify-keys.ts";
import type { JiraCitation, JiraKeyVerdict, JiraMarkdownFlag } from "./wire.ts";
import { failJiraDraft, finishJiraDraft } from "../db/jira-drafts.ts";

export interface FinalizeJiraDraftInput {
  draftId: string;
  /** The model's RAW output. The fence strip happens here, on both paths. */
  raw: string;
  /**
   * The citations the model was actually GIVEN (the depth slice), and how many of
   * them survived the `JIRA_BODY_MAX` trim. `## Referanser` is built from
   * `promptCitations.slice(0, citationsUsed)` — appending anything wider lists
   * sources the text never saw.
   */
  promptCitations: JiraCitation[];
  citationsUsed: number;
  /**
   * The RETAINED set — wider than the prompt slice at low depths. This is what
   * key verification judges `verified` against, so a key from a retrieved issue
   * that did not make the depth slice is still not called fabricated.
   */
  citations: JiraCitation[];
  /** The raw material, for the amber notes-only key state. */
  notes: string;
  knowledgeApiUrl: string;
  /** Thread path only — the assistant message this text came from. */
  messageId?: string;
}

export interface FinalizedJiraDraft {
  markdown: string;
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
}

/**
 * The reader-facing failure for a model that answered with nothing. Exported so
 * both callers report the empty case with the same sentence.
 */
export const JIRA_EMPTY_RESULT_MESSAGE =
  "Modellen returnerte ingen tekst — ingenting ble generert.";

/**
 * The reader-facing failure for a run that did not FINISH — a connector throw, a
 * timeout, a turn the chat pipeline reported internally and returned nothing for.
 *
 * Deliberately generic and deliberately not {@link JIRA_EMPTY_RESULT_MESSAGE}:
 * this is what lands on the row, which is read back through a CORS-open GET, so
 * it must never carry the exception's own text (stack-shaped strings with local
 * paths and internal host:port pairs). The detail goes to the log. Both runners
 * write it, which is why it lives here rather than as a literal in each.
 */
export const JIRA_UNFINISHED_MESSAGE =
  "Utkastet kunne ikke skrives ferdig. Se muninn-loggen for detaljer, og prøv igjen.";

/**
 * Post-process one generated draft and land it on the row.
 *
 * Returns `null` when the model produced nothing — an empty result is a FAILED
 * generation, not an empty task, and the row is marked `failed` before returning
 * so the poller has something terminal to read. The caller owns telling its own
 * client (an SSE `app_error` on one path, nothing at all on the other).
 */
export async function finalizeJiraDraft(
  input: FinalizeJiraDraftInput,
): Promise<FinalizedJiraDraft | null> {
  // The `[n]` REPAIR, before `## Referanser` is appended. The prompt no longer
  // asks for bracket markers and no longer numbers the source block, but a model
  // that writes them anyway would ship a Jira description full of footnote
  // numbers that resolve to nothing — the reference list is unnumbered and
  // key-deduped. Bounded by what the model was actually GIVEN, so a literal
  // `[2024]` survives. See `src/jira/citation-markers.ts`.
  const body = stripCitationMarkers(stripJiraWrappingFence(input.raw ?? ""), input.citationsUsed);
  if (!body) {
    await failJiraDraft(input.draftId, JIRA_EMPTY_RESULT_MESSAGE);
    return null;
  }

  // `## Referanser` is appended HERE, deterministically — never written by the
  // model. Every line then resolves by construction, which is what makes the
  // acceptance sentence "every Jira key it cites resolves to a real issue"
  // mechanically true for this section.
  //
  // It lists the citations the model was ACTUALLY GIVEN: the depth slice, minus
  // whatever the `JIRA_BODY_MAX` trim dropped from its tail. Measured on a real
  // `Ingen` draft over 24 stored hits, appending the retained set put 24 links
  // under a task the model had been shown 6 of; the `citationsUsed` half is the
  // same bug one layer in — a trimmed prompt still listed the trimmed-away
  // sources, i.e. references to material the model never saw. The toggle column
  // still renders the full stored set — a different question.
  const markdown = appendReferences(body, input.promptCitations.slice(0, input.citationsUsed));

  // `checkJiraMarkdown` is SYNC — no `Promise.resolve` wrap. It ran inside a
  // `Promise.all` that read as two concurrent awaits and was one.
  const markdownFlags = checkJiraMarkdown(markdown);
  const keyVerdicts = await verifyJiraKeys({
    markdown,
    citations: input.citations,
    notes: input.notes,
    knowledgeApiUrl: input.knowledgeApiUrl,
  });

  await finishJiraDraft(input.draftId, {
    markdown,
    keyVerdicts,
    markdownFlags,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  });

  return { markdown, keyVerdicts, markdownFlags };
}
