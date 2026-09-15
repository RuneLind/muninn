/**
 * `GET /api/wiki/provenance` — the two REVERSE lookups over the provenance keys
 * (`src/wiki/provenance.ts`):
 *
 *   `?jira=MELOSYS-8045`  → every page, in every registered wiki, that serves
 *                           that issue, plus the sessions that wrote them.
 *   `?session=claude-code:<id>` → every page that session wrote.
 *
 * **It iterates the whole registry**, unlike every other `/api/wiki/*` route,
 * which answers about the ONE wiki `?wiki=`/`?bot=` resolved. That is the point:
 * a Jira issue is served by a page in the kode-wiki and discussed in a mimir
 * plan, and "which pages serve MELOSYS-8045" has no useful per-wiki answer. Each
 * row therefore names its own `wiki`, and a caller that wants one wiki filters
 * the rows.
 *
 * Registered as part of the `wiki` route GROUP (see `route-groups.ts`) rather
 * than as a group of its own: it reads the same working trees, so it must be
 * absent under `MUNINN_PROFILE=nais` for exactly the same reason.
 *
 * Never 5xx on a degraded ledger — a page list with bare chips is the answer
 * (`/api/wiki/similar`'s rule, one layer up).
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getWikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import {
  isJiraKeyShape,
  normalizeJiraKey,
  parseSessionRef,
  sessionRefMatches,
} from "../../wiki/provenance.ts";
import {
  resolveProvenance,
  type ProvenanceContext,
} from "../../wiki/provenance-service.ts";
import { defaultSessionLedgerDeps } from "../../wiki/session-ledger.ts";
import { CLAUDE_USAGE_DEFAULT_URL } from "../claude-usage-overview.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "provenance");

/**
 * The production context, wired from `Config`.
 *
 * The `CLAUDE_USAGE_URL` default is applied HERE, not in `config.ts` — config
 * reports only whether the operator set it (null ⇒ unset) and `configured` is
 * derived from that one fact at this layer. The `src/sync/` idiom, and the same
 * line `registerClaudeUsageRoutes` uses.
 */
export function defaultProvenanceContext(config: Config): ProvenanceContext {
  return {
    sessionLedger: defaultSessionLedgerDeps(
      config.claudeUsageUrl ?? CLAUDE_USAGE_DEFAULT_URL,
      config.claudeUsageUrl != null,
    ),
    knowledgeApiUrl: config.knowledgeApiUrl,
    publicUrl: config.claudeUsagePublicUrl?.trim() || null,
  };
}

/** One page row on a reverse-lookup answer. Deliberately NOT a `WikiListing`:
 *  this is a cross-wiki list, so it carries the wiki name and only the fields a
 *  result row renders — a full listing row per page would ship the link counts
 *  and git dates of pages nobody opened. */
export interface ProvenancePageRow {
  wiki: string;
  relPath: string;
  title: string;
  type: string;
  /** This page's own session refs, verbatim — so a row can say "this page, by
   *  these two sessions" without a second call. */
  sessions: string[];
}

export function registerWikiProvenanceRoutes(
  app: Hono,
  config: Config,
  ctx: ProvenanceContext = defaultProvenanceContext(config),
): void {
  app.get("/api/wiki/provenance", async (c) => {
    const jiraQ = c.req.query("jira")?.trim() ?? "";
    const sessionQ = c.req.query("session")?.trim() ?? "";

    if (jiraQ && sessionQ) {
      return c.json({ error: "pass either jira or session, not both" }, 400);
    }
    if (!jiraQ && !sessionQ) {
      return c.json({ error: "jira or session query param required" }, 400);
    }

    // NORMALIZED, not matched verbatim: `melosys-8045` is what a shared URL
    // carries and `MELOSYS-8045` is what the page carries. The shape check is on
    // the normalized form, so the 400 is about the KEY and not about its case.
    const key = jiraQ ? normalizeJiraKey(jiraQ) : "";
    if (jiraQ && !isJiraKeyShape(key)) {
      return c.json({ error: `"${jiraQ}" is not a Jira key (expected e.g. MELOSYS-8045)` }, 400);
    }

    const rows: ProvenancePageRow[] = [];
    const refs: string[] = [];
    for (const entry of getWikiRegistry()) {
      // One TTL-cached index read per wiki. A wiki whose directory is missing
      // contributes nothing rather than failing the whole answer — a laptop
      // registering a root the mini does not have is the normal case.
      const index = await getWikiIndex({ root: entry.root });
      if (!index) continue;
      for (const page of index.pages) {
        if (!matches(page, key, sessionQ)) continue;
        rows.push({
          wiki: entry.name,
          relPath: page.relPath,
          title: page.displayTitle ?? page.title,
          type: page.type,
          sessions: page.sessions ?? [],
        });
        refs.push(...(page.sessions ?? []));
      }
    }

    // For a `?session=` lookup the asked-for session is part of the answer even
    // when no page names it in that exact spelling — the reader asked about IT,
    // and an empty sessions list beside a page list would read as "this session
    // does not exist".
    if (sessionQ) refs.unshift(sessionQ);

    const resolved = await resolveProvenance({ refs, keys: key ? [key] : [] }, ctx);
    log.debug("wiki provenance lookup {which} matched {pages} page(s)", {
      which: key || sessionQ,
      pages: rows.length,
    });

    return c.json({
      ...(key ? { key } : { session: parseSessionRef(sessionQ).ref }),
      pages: rows,
      ...resolved,
    });
  });
}

function matches(page: WikiPageMeta, key: string, session: string): boolean {
  if (key) return (page.jira ?? []).includes(key);
  return (page.sessions ?? []).some((entry) => sessionRefMatches(entry, session));
}
