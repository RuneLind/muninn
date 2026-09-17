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
 * ── Bounded, because the caller picks the size of the answer ────────────────
 * One query walks EVERY registered wiki and can match every page in all of them
 * (a `?jira=` on a key the stamper put everywhere, a wiki whose every page names
 * the same session). Both halves of the answer are capped —
 * {@link PROVENANCE_PAGES_MAX} rows and {@link PROVENANCE_REFS_MAX} distinct
 * session refs to price — with `truncated: true` saying the answer is a prefix.
 * Without the second cap one GET fans out into ⌈N/200⌉ claude-usage calls, which
 * is the amplification that puts this route on `SIDE_EFFECTING_GETS`.
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
  type ProvenancePayload,
} from "../../wiki/provenance.ts";
import { isSessionIdShape, SESSION_ID_MAX_CHARS } from "../../wiki/session-ledger.ts";
import {
  resolveProvenance,
  type ProvenanceContext,
} from "../../wiki/provenance-service.ts";
import { defaultSessionLedgerDeps } from "../../wiki/session-ledger.ts";
import { CLAUDE_USAGE_DEFAULT_URL } from "../claude-usage-overview.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "provenance");

/** Most page rows one answer carries. Past this the answer says `truncated`. */
export const PROVENANCE_PAGES_MAX = 500;

/** Most DISTINCT session refs one answer prices. Each 200 of them is one
 *  claude-usage call, so this is the bound on the fan-out a single GET buys. */
export const PROVENANCE_REFS_MAX = 1000;

/** Longest echo of the caller's own input in a 400 body. */
export const PROVENANCE_ECHO_MAX = 64;

/**
 * The production context, wired from `Config`.
 *
 * The `CLAUDE_USAGE_URL` default is applied HERE, not in `config.ts` — config
 * reports only whether the operator set it (null ⇒ unset), and that one fact
 * becomes `sessionLedger.urlConfigured`, which is the only place the join reads
 * it from. The `src/sync/` idiom, and the same line `registerClaudeUsageRoutes`
 * uses. Unset, the ledger is never FETCHED: the `/models` card's "left unset and
 * unreachable, hide it" rule, one layer down — an instance nobody pointed at a
 * claude-usage should not be paying a connection refusal on every stamped page
 * open.
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

/**
 * What a reverse lookup answers: the page rows plus the session/Jira halves
 * `resolveProvenance` builds.
 *
 * Stated as an `Omit` of the READER's payload rather than re-listed, so a field
 * added there lands here as a compile error instead of as drift — and the three
 * omitted members are the three this route deliberately does not produce.
 * `merges`/`mergesLedger` are `pageProvenance`'s: one lookup spans up to
 * `PROVENANCE_REFS_MAX` refs, and fanning the merges leg out over them would
 * multiply the claude-usage calls one GET buys on a route that renders no merge
 * row. `prs` comes off ONE page's frontmatter and a lookup answers about many.
 */
interface ProvenanceLookupBody
  extends Omit<
    ProvenancePayload,
    | "merges"
    | "mergesLedger"
    | "prs"
    // PR 3's four legs are `pageProvenance`'s for the same reason the merges leg
    // is: one lookup spans up to `PROVENANCE_REFS_MAX` refs, and a per-session
    // handoff read over them would be a thousand calls behind one GET.
    | "ghosts"
    | "handoffs"
    | "links"
    | "stampable"
    | "rulesStandardizedDate"
  > {
  /** The normalized key, on a `?jira=` lookup. */
  key?: string;
  /** The parsed ref, on a `?session=` lookup. */
  session?: string;
  pages: ProvenancePageRow[];
  /** The answer is a PREFIX — of the page rows, of the priced refs, or both. */
  truncated?: true;
}

/** The caller's own input, echoed back in a 400 — normalized and bounded.
 *  A 400 that reflects arbitrary caller bytes is a payload nobody asked this
 *  route to carry, and the useful half is the first few characters anyway. */
export function echoQuery(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > PROVENANCE_ECHO_MAX ? `${flat.slice(0, PROVENANCE_ECHO_MAX)}…` : flat;
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
    // the normalized form, so the 400 is about the KEY and not about its case,
    // and the ECHO is the normalized form too — never the caller's raw bytes.
    const key = jiraQ ? normalizeJiraKey(jiraQ) : "";
    if (jiraQ && !isJiraKeyShape(key)) {
      return c.json(
        { error: `"${echoQuery(key)}" is not a Jira key (expected e.g. MELOSYS-8045)` },
        400,
      );
    }
    // `?session=` gets the same treatment: a value that cannot BE a session id
    // is refused here rather than walking every wiki to match nothing and then
    // asking claude-usage about it.
    if (sessionQ && !isSessionIdShape(parseSessionRef(sessionQ).id)) {
      return c.json(
        {
          error: `"${echoQuery(sessionQ)}" is not a session id (up to ${SESSION_ID_MAX_CHARS} of A–Z a–z 0–9 . _ -, optionally prefixed "provider:")`,
        },
        400,
      );
    }

    const rows: ProvenancePageRow[] = [];
    const refs: string[] = [];
    // Deduped as they arrive so the REF cap counts distinct sessions rather than
    // mentions: one session naming 400 pages must not fill the budget alone.
    const seenRefs = new Set<string>();
    let truncated = false;
    for (const entry of getWikiRegistry()) {
      // One TTL-cached index read per wiki. A wiki whose directory is missing
      // contributes nothing rather than failing the whole answer — a laptop
      // registering a root the mini does not have is the normal case.
      const index = await getWikiIndex({ root: entry.root });
      if (!index) continue;
      for (const page of index.pages) {
        if (!matches(page, key, sessionQ)) continue;
        if (rows.length >= PROVENANCE_PAGES_MAX) {
          truncated = true;
          continue;
        }
        rows.push({
          wiki: entry.name,
          relPath: page.relPath,
          title: page.displayTitle ?? page.title,
          type: page.type,
          sessions: page.sessions ?? [],
        });
        for (const ref of page.sessions ?? []) {
          if (seenRefs.has(ref)) continue;
          if (seenRefs.size >= PROVENANCE_REFS_MAX) {
            truncated = true;
            continue;
          }
          seenRefs.add(ref);
          refs.push(ref);
        }
      }
    }

    // For a `?session=` lookup the asked-for session is part of the answer even
    // when no page names it in that exact spelling — the reader asked about IT,
    // and an empty sessions list beside a page list would read as "this session
    // does not exist". `dedupeSessionRefs` keeps this position while preferring
    // a matched page's PREFIXED spelling, so a bare query still gets its glyph.
    if (sessionQ) refs.unshift(sessionQ);

    // On a `?session=` lookup the money is about the session ASKED ABOUT, not
    // about every session that happens to share a page with it: summing those
    // would answer "what did these pages cost" under a heading that says
    // "what did this session cost". The page rows keep their own full lists.
    const costOver = sessionQ
      ? (chip: { ref: string }) => sessionRefMatches(chip.ref, sessionQ)
      : undefined;

    const resolved = await resolveProvenance(
      { refs, keys: key ? [key] : [], costOver },
      ctx,
    );
    log.debug("wiki provenance lookup {which} matched {pages} page(s)", {
      which: key || sessionQ,
      pages: rows.length,
    });

    const body: ProvenanceLookupBody = {
      ...(key ? { key } : { session: parseSessionRef(sessionQ).ref }),
      pages: rows,
      ...(truncated ? { truncated: true } : {}),
      ...resolved,
    };
    return c.json(body);
  });
}

function matches(page: WikiPageMeta, key: string, session: string): boolean {
  if (key) return (page.jira ?? []).includes(key);
  return (page.sessions ?? []).some((entry) => sessionRefMatches(entry, session));
}
