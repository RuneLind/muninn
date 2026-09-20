/**
 * `POST /api/wiki/series` — the SERIES EDITOR's one write: setting or clearing
 * `series:` (and optionally `series_label:`) on ONE page.
 *
 * It is the fourth writer to go through `writeWikiPage` (`src/wiki/page-write.ts`)
 * rather than a seam of its own, so it inherits the read-only refusals, the path
 * confinement, the per-wiki queue, the cross-process lockfile and the `baseHash`
 * CAS unchanged. What it adds is the frontmatter half — `setFrontmatterScalar`
 * (`src/plans/frontmatter.ts`), the line-scoped upsert PR C wrote for the wiki
 * lint's series fixes — and three rules of its own:
 *
 *  1. **ONE page per call.** Moving a series' head is two calls from the client
 *     (clear the label on the old head, set it on the new), each with its own
 *     CAS. A failure between them leaves a series with no labelled member, which
 *     renders under its bare key and which the lint's 8.3 reports — a visible,
 *     repairable state, where a two-page write would need a second transaction
 *     the wiki has no notion of.
 *  2. **The key is normalized to an existing member's spelling**
 *     ({@link normalizeSeriesKey}). The rail folds case-insensitively, so
 *     joining `alpha` from a menu listing `Alpha` must write `Alpha` or the fold
 *     is unchanged while the lint gains a variant nobody chose.
 *  3. **Clearing the key clears the label with it.** A `series_label:` on a page
 *     in no series names nothing: it is invisible to the rail (which reads the
 *     label off a MEMBER) and is exactly 8.3(a)'s finding. So `series: null`
 *     removes both lines whatever `seriesLabel` said.
 *
 * **No log.md entry, no reindex, no commit** — `writeWikiPage`'s no-log mode,
 * the `/plans` board's priority-flip discipline. A series edit is metadata: it
 * moves no prose, so re-embedding the page buys nothing, and a rail-menu click
 * is a triage-rate action whose curated log line would bury the log it sits in.
 * The commit is the repo-sync loop's job on a standalone wiki (mimir is in
 * `SYNC_REPOS`) and the bot's own `wikiAutoCommit` policy's on a bot wiki — see
 * the decision note on the PR; `groupApplyPolicy` is the policy for a gardener
 * GROUP APPLY, which writes page CONTENT at a review gate.
 *
 * It DOES refresh the wiki index (`defaultPageWriteIo`), unlike the plans board:
 * the rail renders from `GET /api/wiki/pages`, which reads that index behind a
 * 5-minute TTL, so a write that skipped the rebuild would leave the reader's own
 * fold unchanged for up to five minutes.
 *
 * ── Zones and CSRF ──────────────────────────────────────────────────────────
 * Admin-zone by default-deny, and it reuses {@link decideStampRequest} — the
 * same-origin write guard `wiki-stamp.ts` carries for the measured
 * `MUNINN_AUTH=off` hole, where none of the global middlewares are mounted. One
 * spelling, two routes; the name is the stamp route's because that is where it
 * was first needed.
 */

import type { Hono } from "hono";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { getWikiIndex, resolveWikiRoot, type WikiPageMeta } from "../../wiki/store.ts";
import { defaultPageWriteIo, writeWikiPage } from "../../wiki/page-write.ts";
import { setFrontmatterScalar } from "../../plans/frontmatter.ts";
import { sha256 } from "../../gardener/util.ts";
import { normalizeSeriesKey } from "../views/components/wiki-groups.ts";
import { decideStampRequest } from "./wiki-stamp.ts";
import { readonlyRefusal } from "./route-utils.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "series");

/** Test seams. Production passes nothing; `writeWikiPage`'s own defaults are
 *  what make the read-only guards fail closed for this call site too. */
export interface WikiSeriesRouteDeps {
  /** Shortens the cross-process lockfile wait so a refusal case costs
   *  milliseconds rather than the two seconds a human click may. */
  lockWaitMs?: number;
}

/** The two frontmatter keys this route owns. */
const SERIES_KEY = "series";
const SERIES_LABEL_KEY = "series_label";

/** A series key and a label are one line of frontmatter each; a value past this
 *  is a paste accident, and the rail clips a label to a fraction of it anyway. */
const SERIES_VALUE_MAX = 200;

/** A page a series member may be. `writeWikiPage`'s confinement admits the same
 *  two extensions, but it answers `error` ⇒ 500 — this is a 400 that says which
 *  rule refused, before the queue is entered. */
function isMarkdownPage(meta: WikiPageMeta): boolean {
  return /\.mdx?$/i.test(meta.relPath) && meta.type !== "explainer";
}

/** `string | null | absent`, the three states this route's two value fields
 *  take. `undefined` means the caller did not mention the key. */
type ScalarInput = { ok: true; value: string | null | undefined } | { ok: false; error: string };

/** Read one optional scalar off the body. A value that is neither a string nor
 *  `null` is a 400, never a silent fall-through: `""` here would mean "clear",
 *  and clearing a key the caller never asked about is data loss. */
function readScalar(raw: unknown, field: string): ScalarInput {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `${field} must not be blank — send null to clear it` };
  }
  if (trimmed.length > SERIES_VALUE_MAX) {
    return { ok: false, error: `${field} must be at most ${SERIES_VALUE_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

export function registerWikiSeriesRoutes(app: Hono, deps: WikiSeriesRouteDeps = {}): void {
  app.post("/api/wiki/series", async (c) => {
    // 0. The request itself, before the body is read — see the header.
    const refused = decideStampRequest({
      contentType: c.req.header("content-type"),
      secFetchSite: c.req.header("sec-fetch-site"),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
    });
    if (refused) return c.json({ error: refused.error, reason: refused.reason }, refused.status);

    // 1. Read-only instance: refuse before anything is resolved, the
    //    `plans-routes.ts` order. `writeWikiPage` refuses again on its own.
    const readonly = readonlyRefusal(c, log);
    if (readonly) return readonly;

    try {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (body === null || typeof body !== "object") {
        return c.json({ error: "a JSON object body is required" }, 400);
      }
      if (body.wiki !== undefined && typeof body.wiki !== "string") {
        return c.json({ error: "wiki must be a string" }, 400);
      }
      const wiki = typeof body.wiki === "string" ? body.wiki.trim() : "";
      const relPath = typeof body.relPath === "string" ? body.relPath.trim() : "";
      const baseHash = typeof body.baseHash === "string" ? body.baseHash.trim() : "";
      if (!relPath) return c.json({ error: "relPath is required" }, 400);
      if (!baseHash) return c.json({ error: "baseHash is required" }, 400);
      // `series` is REQUIRED as a key — a caller that omits it is a buggy client,
      // and reading the omission as "clear" is the accidental-data-loss shape
      // `/api/plans/priority` refuses for the same reason.
      if (body.series === undefined) {
        return c.json({ error: "series is required — send null to clear it" }, 400);
      }
      const wantedSeries = readScalar(body.series, "series");
      if (!wantedSeries.ok) return c.json({ error: wantedSeries.error }, 400);
      const wantedLabel = readScalar(body.seriesLabel, "seriesLabel");
      if (!wantedLabel.ok) return c.json({ error: wantedLabel.error }, 400);

      // The same resolution every other `/api/wiki/*` route makes, `WIKI_DIR`
      // env-override shape included (`resolveWikiRequest` returns no entry there).
      const { entry, envOverride, unknownWiki } = resolveWikiRequest(
        getWikiRegistry(),
        wiki || undefined,
        undefined,
        process.env.WIKI_DIR,
      );
      if (unknownWiki) return c.json({ error: "no wiki configured for that name" }, 404);
      const root = entry?.root ?? (envOverride ? resolveWikiRoot(undefined) : null);
      if (!root) return c.json({ error: "no wiki configured for that name" }, 404);

      const index = await getWikiIndex({ root });
      if (!index) return c.json({ error: "wiki directory not found" }, 503);
      const meta = index.resolveRelPath(relPath);
      if (!meta) return c.json({ error: `no wiki page for relPath "${relPath}"` }, 404);
      if (!isMarkdownPage(meta)) {
        return c.json({ error: "a series member is a markdown page" }, 400);
      }

      // Rule 2: the spelling an existing member already uses.
      const series =
        wantedSeries.value == null ? null : normalizeSeriesKey(index.pages, wantedSeries.value);
      // Rule 3: no key, no label.
      const label = series === null ? null : wantedLabel.value;

      // `writeWikiPage`'s `transform` seam speaks `null` for "nothing to do", so
      // the refusal reason and the written bytes ride out on closure variables —
      // the `/api/plans/priority` idiom.
      let written: string | null = null;
      let refusedReason: string | null = null;
      const result = await writeWikiPage({
        wikiDir: root,
        relPath: meta.relPath,
        baseHash,
        staleReason: `${meta.relPath} changed since the page was loaded`,
        ...(deps.lockWaitMs !== undefined ? { lockWaitMs: deps.lockWaitMs } : {}),
        // No-log mode skips the reindex fan-out anyway; `[]` says the same thing
        // where the call is read.
        collections: [],
        logKind: null,
        now: () => Date.now(),
        transform: (raw) => {
          written = null;
          refusedReason = null;
          // Two line edits, one write. The second runs on the first's OUTPUT, so
          // a page gaining both lines gains them in one pass and the guard
          // `setFrontmatterScalar` closes with checks the final bytes.
          const edits: Array<[string, string | null]> = [[SERIES_KEY, series]];
          if (label !== undefined) edits.push([SERIES_LABEL_KEY, label]);
          let current = raw;
          for (const [key, value] of edits) {
            const edit = setFrontmatterScalar(current, key, value);
            if (edit.kind === "refused") {
              refusedReason = edit.reason;
              return null;
            }
            if (edit.kind === "changed") current = edit.content;
          }
          if (current === raw) return null;
          written = current;
          return current;
        },
        ...defaultPageWriteIo(root),
        // Unreachable in no-log mode (`writeWikiPage` skips the fan-out), and
        // required by the type — stated rather than relied on.
        reindex: async () => {},
      });

      if (refusedReason) {
        log.warn("wiki series: refused {path}: {reason}", {
          path: meta.relPath,
          reason: refusedReason,
        });
        return c.json({ error: refusedReason }, 422);
      }
      if (result.outcome === "forbidden") {
        return c.json({ error: result.reason, readonly: true }, 403);
      }
      if (result.outcome === "stale") {
        return c.json({ error: result.reason, stale: true }, 409);
      }
      // The cross-process wiki lockfile was held throughout (claude-usage's
      // `wiki-stamp` is the other holder). Nothing was written — a retryable
      // conflict, so 409 beside `stale`.
      if (result.outcome === "locked") {
        return c.json({ error: result.reason, locked: true }, 409);
      }
      if (result.outcome === "error") {
        log.error("wiki series: write failed for {path}: {error}", {
          path: meta.relPath,
          error: result.reason,
        });
        return c.json({ error: result.reason }, 500);
      }

      // The 200 reports what is ON DISK, never what was asked for — a `noop` (the
      // same key re-set, a clear on a page carrying none) echoes the unchanged
      // pair, which the CAS just proved. `written` is the transform's own output,
      // so the hash is of the bytes this call produced rather than of a re-read
      // that another writer may have moved.
      const changed = written !== null;
      return c.json({
        relPath: meta.relPath,
        hash: changed ? sha256(written!) : baseHash,
        written: changed,
        series: changed ? series : meta.series ?? null,
        seriesLabel: changed
          ? label === undefined
            ? meta.seriesLabel ?? null
            : label
          : meta.seriesLabel ?? null,
      });
    } catch (err) {
      log.error("wiki series: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });
}
