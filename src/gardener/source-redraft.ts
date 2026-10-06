/**
 * Redraft — replace a live `source` draft proposal with a fresh one drafted
 * from the doc as it reads now, after a summary fact-check (mimir
 * `plans/muninn-summary-factcheck.mdx`, D6).
 *
 * The state space, exhaustive:
 *  - the body is read through `fetchSummaryDoc`, like every other non-capture draft;
 *  - the two pre-model live checks ignore ONLY the row being replaced; the URL
 *    check against the wiki and every other live proposal still binds;
 *  - after the model call, ONE transaction (`replaceDraftProposal`): CAS the old
 *    row `draft → stale`, insert the new row, move the attempt row to it.
 *    CAS 1 + insert 1 → `drafted`; CAS 0 → `superseded_meanwhile`, rolled back;
 *    insert conflict → `covered`, rolled back;
 *  - a model failure or skip runs no transaction: the old draft and the attempt
 *    row stay as they were.
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
import { loadConfig } from "../config.ts";
import { DRAFT_TIMEOUT_MS } from "./backlog.ts";
import { runDrafterOneShot } from "./drafter-oneshot.ts";
import { todayOslo } from "./util.ts";
import { categoryFromDocId } from "./source-drafter-run.ts";
import { draftSourcePage, type SourceDraftOutcome } from "./source-drafter.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "source-redraft");

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";
const DOC_FETCH_TIMEOUT_MS = 15_000;

export type RedraftOutcome =
  | SourceDraftOutcome
  | { outcome: "superseded_meanwhile"; reason: string };

/** Why a proposal cannot be redrafted at all, or null when it can. */
export function redraftRefusal(p: WikiProposal): string | null {
  if (p.status !== "draft") return "only a draft proposal can be redrafted";
  if (p.kind !== "source" || p.mode !== "create" || p.wikiName) {
    return "only a create-mode source draft can be redrafted";
  }
  const doc = p.sourceDocs[0];
  if (!doc?.collection || !doc.docId) return "the proposal names no source document";
  return null;
}

export interface RedraftSeams {
  fetchDoc?: (collection: string, docId: string) => Promise<RawFetchedDoc | null>;
  callDrafter?: (prompt: string, title: string) => Promise<string>;
  replace?: typeof replaceDraftProposal;
  now?: () => number;
}

function firstHttpUrl(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return "";
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
  const url = firstHttpUrl(doc?.metadata?.url, doc?.url, src.url);
  if (!body) return { outcome: "skipped", reason: "doc has no body" };
  if (!url) return { outcome: "skipped", reason: "doc has no public URL" };

  const callDrafter =
    seams.callDrafter ??
    (async (prompt: string, title: string) => {
      const res = await runDrafterOneShot({
        title,
        url,
        prompt,
        config: loadConfig(),
        botConfig: bot,
        timeoutMs: DRAFT_TIMEOUT_MS,
      });
      return res.result;
    });
  const replace = seams.replace ?? replaceDraftProposal;

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
      ...(src.title ? { sourceTitle: src.title } : {}),
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
