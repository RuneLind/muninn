/**
 * Redraft — replace a live `source` draft proposal with a fresh one drafted
 * from the doc as it reads now, after a summary fact-check (mimir
 * `plans/muninn-summary-factcheck.mdx`, D6).
 *
 * The state space, exhaustive:
 *  - the body is read through `fetchSummaryDoc`, like every other non-capture
 *    draft; a doc with no public URL drafts URL-less, the way its capture did
 *    (the pending-ingestion callout instead of a pinned `url:`);
 *  - the old draft's title rides as the title override, so a doc first drafted
 *    through the collision-rename path does not walk back into that collision;
 *  - the two pre-model live checks ignore ONLY the row being replaced; the URL
 *    check against the wiki and every other live proposal still binds;
 *  - after the model call, ONE transaction (`replaceDraftProposal`): CAS the old
 *    row `draft → stale`, insert the new row, move the attempt row to it.
 *    CAS 1 + insert 1 → `drafted`; CAS 0 → `superseded_meanwhile`, rolled back;
 *    insert conflict → `covered`, rolled back;
 *  - a model failure or skip runs no transaction: the old draft and the attempt
 *    row stay as they were.
 *
 * Not caught: a same-URL proposal ANOTHER vertical inserts during the model
 * call (a different topic key, so the index does not refuse it). The capture
 * drafter has the same window.
 */

import type { BotConfig } from "../bots/config.ts";
import type { RawFetchedDoc } from "./types.ts";
import { fetchSummaryDoc } from "./summary-doc.ts";
import { getWikiIndex, parseFrontmatter } from "../wiki/store.ts";
import { collectWikiRefs } from "../wiki/ingest-backlog.ts";
import {
  getLiveSourceDocUrls,
  getLiveTopicKeys,
  replaceDraftProposal,
  type ReplaceDraftOutcome,
  type WikiProposal,
} from "../db/wiki-proposals.ts";
import { getSummaryFactcheck } from "../db/summary-factchecks.ts";
import { todayOslo } from "./util.ts";
import {
  categoryFromDocId,
  DEFAULT_API_URL,
  DOC_FETCH_TIMEOUT_MS,
  errMsg,
  firstHttpUrl,
  oneShotDrafter,
  titleFromDocId,
} from "./source-drafter-run.ts";
import { draftSourcePage, type SourceDraftOutcome } from "./source-drafter.ts";
import { redraftRefusal } from "./factcheck-carry.ts";
import { getLog } from "../logging.ts";

export { redraftRefusal };

const log = getLog("gardener", "source-redraft");

export type RedraftOutcome =
  | SourceDraftOutcome
  | { outcome: "superseded_meanwhile"; reason: string };

export interface RedraftSeams {
  fetchDoc?: (collection: string, docId: string) => Promise<RawFetchedDoc | null>;
  callDrafter?: (prompt: string, title: string) => Promise<string>;
  replace?: typeof replaceDraftProposal;
  now?: () => number;
}

/** The title the old draft was reviewed under: its frontmatter title, else its
 *  target file's stem. */
export function redraftTitle(old: Pick<WikiProposal, "draft" | "targetPath">): string {
  const fm = parseFrontmatter(old.draft);
  const title = Array.isArray(fm.title) ? fm.title[0] : fm.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  const base = old.targetPath.split("/").pop() ?? "";
  return base.replace(/\.mdx?$/i, "").trim();
}

/**
 * Old row id → the row that replaced it, for every row Redraft staled. Derived,
 * not stored: `replaceDraftProposal` stales the old row and inserts the new one
 * in one transaction, so the old row's `resolved_at` and the new row's
 * `created_at` are the same `now()`. No other path writes that pair.
 */
export function redraftReplacements(
  rows: Pick<WikiProposal, "id" | "botName" | "wikiName" | "topicKey" | "kind" | "status" | "createdAt" | "resolvedAt">[],
): Map<string, string> {
  const key = (r: Pick<WikiProposal, "botName" | "wikiName" | "topicKey">, at: number) =>
    `${r.wikiName ?? ""}\u0000${r.botName}\u0000${r.topicKey}\u0000${at}`;
  const byCreated = new Map<string, string>();
  for (const r of rows) if (r.kind === "source") byCreated.set(key(r, r.createdAt), r.id);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.kind !== "source" || r.status !== "stale" || r.resolvedAt === null) continue;
    const next = byCreated.get(key(r, r.resolvedAt));
    if (next && next !== r.id) out.set(r.id, next);
  }
  return out;
}

/** Redraft `old` for `bot` into `wikiDir`. Never throws. */
export async function redraftSourceProposal(
  bot: BotConfig,
  wikiDir: string,
  old: WikiProposal,
  seams: RedraftSeams = {},
): Promise<RedraftOutcome> {
  const refusal = redraftRefusal(old);
  if (refusal) return { outcome: "skipped", reason: refusal };
  const src = old.sourceDocs[0]!;
  const fetchDoc =
    seams.fetchDoc ??
    ((collection: string, docId: string) => fetchSummaryDoc(DEFAULT_API_URL, collection, docId, DOC_FETCH_TIMEOUT_MS));

  let doc: RawFetchedDoc | null;
  try {
    doc = await fetchDoc(src.collection, src.docId);
  } catch (err) {
    return { outcome: "error", reason: `fetching ${src.collection}/${src.docId} failed: ${errMsg(err)}` };
  }
  const body = (doc?.text ?? "").trim();
  // "" when the doc has no public URL: `draftSourcePage` then takes the URL-less
  // path a pasted article's capture took.
  const url = firstHttpUrl(doc?.metadata?.url, doc?.url, src.url);
  if (!body) return { outcome: "skipped", reason: "doc has no body" };

  const callDrafter = seams.callDrafter ?? oneShotDrafter(bot, url);
  const replace = seams.replace ?? replaceDraftProposal;
  const titleOverride = redraftTitle(old);

  let replaced: ReplaceDraftOutcome | null = null;
  let index;
  try {
    index = await getWikiIndex({ root: wikiDir });
  } catch (err) {
    return { outcome: "error", reason: `wiki index failed: ${errMsg(err)}` };
  }
  const outcome = await draftSourcePage({
    botName: bot.name,
    wikiDir,
    input: {
      collection: src.collection,
      docId: src.docId,
      url,
      body,
      category: categoryFromDocId(src.docId),
      sourceTitle: titleFromDocId(src.docId),
      ...(titleOverride ? { titleOverride } : {}),
    },
    index,
    today: todayOslo((seams.now ?? Date.now)()),
    callDrafter,
    collectWikiRefs,
    liveTopicKeys: () => getLiveTopicKeys(bot.name, old.id),
    liveSourceDocUrls: () => getLiveSourceDocUrls(bot.name, old.id),
    getFactcheck: getSummaryFactcheck,
    insertProposal: async (params) => {
      const fm = parseFrontmatter(params.draft);
      const title = (Array.isArray(fm.title) ? fm.title[0] : fm.title) ?? null;
      replaced = await replace(old.id, params, (newId) => ({
        botName: bot.name,
        collection: src.collection,
        docId: src.docId,
        outcome: "drafted",
        degraded: false,
        reason: null,
        title: typeof title === "string" ? title.trim() : null,
        collidingPath: null,
        proposalId: newId,
        trigger: "redraft",
      }));
      return replaced.outcome === "drafted" ? replaced.row : null;
    },
  });

  const final: RedraftOutcome =
    (replaced as ReplaceDraftOutcome | null)?.outcome === "superseded_meanwhile"
      ? {
          outcome: "superseded_meanwhile",
          reason: "the draft was approved, rejected or replaced meanwhile; nothing changed",
        }
      : outcome;
  log.info("Redraft of proposal {id} ({collection}/{docId}): {outcome}", {
    botName: bot.name,
    id: old.id,
    collection: src.collection,
    docId: src.docId,
    outcome: final.outcome,
    ...("reason" in final ? { reason: final.reason } : {}),
  });
  return final;
}
