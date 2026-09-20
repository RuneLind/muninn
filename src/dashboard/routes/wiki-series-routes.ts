/**
 * `POST /api/wiki/series` — the SERIES EDITOR's one write: setting or clearing
 * `series:` (and optionally `series_label:`) on ONE page.
 *
 * It goes through `writeWikiPage` (`src/wiki/page-write.ts`) rather than a seam
 * of its own — the fifth call site of that function, and the third of the three
 * that write METADATA in no-log mode (the two `/plans` flips are the others;
 * the fact-check append and the integrate apply both log and commit) — so it
 * inherits the read-only refusals, the path confinement, the per-wiki queue,
 * the cross-process lockfile and the `baseHash` CAS unchanged. What it adds is
 * the frontmatter half — `setFrontmatterScalar` (`src/plans/frontmatter.ts`),
 * the line-scoped upsert PR C wrote for the wiki lint's series fixes — and four
 * rules of its own:
 *
 *  1. **ONE page per call.** Moving a series' head is two calls from the client
 *     (clear the label on the old head, set it on the new), each with its own
 *     CAS. A failure between them leaves a series with no labelled member, which
 *     the rail's fold and the reader header then render under its BARE KEY — a
 *     visible, repairable state, where a two-page write would need a second
 *     transaction the wiki has no notion of. Visible is all it is: measured
 *     against a copy of mimir's `plans/`, a series whose only labelled member
 *     had left produced NO `series-inconsistent` finding. What lint 8.3 reports
 *     is the opposite state — two labelled members, its (b) — which is the one
 *     the other write order would have left and which no surface shows at all.
 *  2. **The key is normalized to an existing member's spelling**
 *     ({@link normalizeSeriesKey}). The rail folds case-insensitively, so
 *     joining `alpha` from a menu listing `Alpha` must write `Alpha` or the fold
 *     is unchanged while the lint gains a variant nobody chose.
 *  3. **A label belongs to a SERIES, not to a page.** `series: null` removes both
 *     lines whatever `seriesLabel` said — a `series_label:` on a page in no
 *     series names nothing and is invisible to every surface there is: the rail
 *     reads the label off a MEMBER, and `seriesMembersByFoldKey` skips a page
 *     with no key, so lint 8.3 never sees it either (measured). And a page MOVING
 *     to another series drops its label the same way when the request names none:
 *     measured, the menu's join and new-key verbs send `{relPath, series}` with
 *     no `seriesLabel`, so a page that was the head of the series it is leaving
 *     carried that name into the one it joins — two labelled members there, and
 *     the series it left silently un-named. The 200 says so (`clearedLabel`), so
 *     the reader learns which series is now label-less rather than reading it off
 *     the rail later.
 *  4. **One labelled member per series.** Naming a series another member already
 *     names is a 409, not a second label: `seriesHead` picks one of two silently,
 *     so the fork would be invisible on every surface that reads the label. The
 *     check runs INSIDE the transform, against the label that will be ON DISK
 *     when it returns rather than against the one the request carried — the two
 *     differ on exactly the write that produced the defect above. It fires only
 *     where THIS write is what puts that label on that series (the label line
 *     changes, or the series fold does); a write that leaves both alone cannot
 *     have created the fork it would be refusing, and refusing it would fail a
 *     noop over somebody else's hand edit. The editor's own head move clears the
 *     old head first and is unaffected.
 *
 * **No log.md entry, no reindex, no commit** — `writeWikiPage`'s no-log mode,
 * the `/plans` board's priority-flip discipline. A series edit is metadata: it
 * moves no prose, so re-embedding the page buys nothing, and a rail-menu click
 * is a triage-rate action whose curated log line would bury the log it sits in.
 * `groupApplyPolicy` is the policy for a gardener GROUP APPLY, which writes page
 * CONTENT at a review gate.
 *
 * **Who commits it, then — and the wiki where nobody does.** On mimir the
 * repo-sync loop is the committer (it is in `SYNC_REPOS`). On a BOT wiki the
 * daily `wiki-committer` sweeper is, up to ~24 h later, under a `[sweep]`
 * subject and bypassing that bot's own `wikiAutoCommit` policy — late, not lost.
 * On a standalone `WIKI_EXTRA` wiki that no `SYNC_REPOS` entry covers there is
 * NO committer at all, so the write logs one `warn` naming that
 * ({@link seriesCommitterWarning}); the reader's edit sits in the working tree
 * until a human commits it.
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
 * was first needed. It inherits that guard's KNOWN GAP with it, stated rather
 * than papered over: a request carrying neither `origin` nor `sec-fetch-site`
 * (curl, an old client) is ALLOWED, so under `MUNINN_AUTH=off` anything that
 * can reach the port can write this line. Same class, same answer as the stamp
 * route — the fix is the auth switch, not a header check that only bothers
 * browsers.
 */

import type { Hono } from "hono";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import {
  getWikiIndex,
  parseFrontmatter,
  resolveWikiRoot,
  normalizeRelPath,
  type WikiPageMeta,
} from "../../wiki/store.ts";
import {
  PAGE_GONE_REASON,
  defaultPageWriteIo,
  writeWikiPage,
} from "../../wiki/page-write.ts";
import { setFrontmatterScalar } from "../../plans/frontmatter.ts";
import { sha256 } from "../../gardener/util.ts";
import { normalizeSeriesKey, seriesCensusKey, seriesKeyOf } from "../views/components/wiki-groups.ts";
import { canEditSeriesPage, SERIES_VALUE_MAX } from "../views/components/wiki-series-menu.ts";
import { decideStampRequest } from "./wiki-stamp.ts";
import { readonlyRefusal } from "./route-utils.ts";
import { seriesCommitterWarning } from "../../wiki/series-committer.ts";
import { getSyncRepos } from "../../sync/config.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "series");

/** Test seams. Production passes nothing; `writeWikiPage`'s own defaults are
 *  what make the read-only guards fail closed for this call site too. */
export interface WikiSeriesRouteDeps {
  /** Shortens the cross-process lockfile wait so a refusal case costs
   *  milliseconds rather than the two seconds a human click may. */
  lockWaitMs?: number;
  /**
   * The write's own read of the target, overriding `defaultPageWriteIo`'s.
   *
   * It exists for the two outcomes that live in the gap between the index read
   * and the CAS — the file VANISHING (⇒ 404) and the file CHANGING (⇒ 409) —
   * which are a race by definition and therefore unreachable from a test that
   * can only act before the request or after it.
   */
  readFile?: (absPath: string) => Promise<string | null>;
}

/** The two frontmatter keys this route owns. */
const SERIES_KEY = "series";
const SERIES_LABEL_KEY = "series_label";

/**
 * A page a series member may be — {@link canEditSeriesPage}, the SAME predicate
 * the rail and the `Related work` block render their openers from.
 *
 * `writeWikiPage`'s confinement admits the same two extensions AND refuses the
 * same reserved basenames, but it answers `error` ⇒ 500: measured, a POST for
 * `index.md` logged an error and returned 500 for a rule this route knows before
 * the queue is entered. Here it is a 400 that says which rule refused.
 *
 * Deliberately no test on `meta.type`: a wiki's `.wiki-reader.json` can type an
 * ordinary `.md` page `explainer`, and the extension test is what excludes a
 * real HTML one.
 */
function isMarkdownPage(meta: WikiPageMeta): boolean {
  return canEditSeriesPage(meta.relPath);
}

/** The two keys this route owns, read back out of the bytes it is about to
 *  return a hash for — so the 200 reports the FILE rather than the wiki index,
 *  which is a TTL cache the write has not refreshed yet. */
function seriesPairOf(content: string): { series: string | null; seriesLabel: string | null } {
  const fm = parseFrontmatter(content);
  const scalar = (v: string | string[] | undefined): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return { series: scalar(fm[SERIES_KEY]), seriesLabel: scalar(fm[SERIES_LABEL_KEY]) };
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

      // `refresh: true`, the gardener approve-guard's rule: the normalization
      // below and the two-headed check are DECISIONS made off this index, and
      // the cached one is up to five minutes old — long enough for the previous
      // write of this very editor's own head move to be invisible to the next.
      // One rebuild per human click, and the write refreshes it again anyway.
      const index = await getWikiIndex({ root, refresh: true });
      if (!index) return c.json({ error: "wiki directory not found" }, 503);
      const meta = index.resolveRelPath(relPath);
      if (!meta) return c.json({ error: `no wiki page for relPath "${relPath}"` }, 404);
      if (!isMarkdownPage(meta)) {
        return c.json(
          { error: "a series member is a markdown page, and never index/log/CLAUDE" },
          400,
        );
      }

      // Rule 2: the spelling an existing member already uses.
      const series =
        wantedSeries.value == null ? null : normalizeSeriesKey(index.pages, wantedSeries.value);

      /**
       * Rule 4's census: the OTHER member of `series` that already carries a
       * label, if one does. The rail reads the label off a member
       * (`seriesHead`) and silently picks one when two carry it, so a second
       * `series_label:` is an invisible fork of what the series is called.
       *
       * The fold, not the spelling: the rail folds `Alpha` and `alpha` into one
       * series, so a member spelling the key the other way is the very member
       * this must find.
       */
      const otherLabelledMember = (): WikiPageMeta | undefined => {
        const fold = seriesCensusKey(series ?? "");
        const mine = normalizeRelPath(meta.relPath);
        return index.pages.find(
          (p) =>
            normalizeRelPath(p.relPath) !== mine &&
            !!seriesKeyOf(p) &&
            seriesCensusKey(seriesKeyOf(p)) === fold &&
            !!(p.seriesLabel ?? "").trim(),
        );
      };

      // `writeWikiPage`'s `transform` seam speaks `null` for "nothing to do", so
      // the refusal reason and the written bytes ride out on closure variables —
      // the `/api/plans/priority` idiom. Rules 3 and 4 ride the same seam,
      // because both are decisions about the bytes the CAS has just proved.
      let written: string | null = null;
      let refusedReason: string | null = null;
      let onDisk: { series: string | null; seriesLabel: string | null } | null = null;
      /** The label this write took off, when it took it off as a consequence of
       *  the MOVE rather than because the caller asked. */
      let clearedLabel: { series: string; label: string } | null = null;
      /** Rule 4's loser — the member that already names this series. */
      let twoHeaded: WikiPageMeta | null = null;
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
          onDisk = null;
          clearedLabel = null;
          twoHeaded = null;
          // Rule 3, off the bytes the CAS proved rather than off the request:
          // the label is dropped when the key goes, and when the page MOVES to
          // another series without the caller naming a label for it. A label
          // names a series; carried along, it names the new series a second time
          // and leaves the old one anonymous. `undefined` is the third state —
          // the line is not edited at all.
          const before = seriesPairOf(raw);
          const foldChanged =
            seriesCensusKey(before.series ?? "") !== seriesCensusKey(series ?? "");
          const label: string | null | undefined =
            series === null
              ? null
              : wantedLabel.value !== undefined
                ? wantedLabel.value
                : foldChanged
                  ? null
                  : undefined;
          // Rule 4, against what will be on disk when this returns. The guard is
          // what keeps it from failing a write that did not create the fork:
          // touching neither the label line nor the fold cannot introduce a
          // second head, and a noop over a wiki somebody else hand-edited into
          // that state is not this write's to refuse.
          const labelAfter = label === undefined ? before.seriesLabel : label;
          if (labelAfter && series && (labelAfter !== before.seriesLabel || foldChanged)) {
            const other = otherLabelledMember();
            if (other) {
              twoHeaded = other;
              return null;
            }
          }
          // Two line edits, one write. The second runs on the first's OUTPUT, so
          // a page gaining both lines gains them in one pass and the guard
          // `setFrontmatterScalar` closes with checks the final bytes. The label
          // is anchored under `series:` so the pair stays together — without it
          // a head move's clear-then-set round trip re-ordered every fence it
          // touched (the label left the pair and came back at the fence's end).
          const edits: Array<[string, string | null, { after?: string }]> = [
            [SERIES_KEY, series, {}],
          ];
          if (label !== undefined) edits.push([SERIES_LABEL_KEY, label, { after: SERIES_KEY }]);
          let current = raw;
          for (const [key, value, opts] of edits) {
            const edit = setFrontmatterScalar(current, key, value, opts);
            if (edit.kind === "refused") {
              refusedReason = edit.reason;
              return null;
            }
            if (edit.kind === "changed") current = edit.content;
          }
          // Read back from the BYTES, on both paths: the 200 reports the file,
          // and on a noop `current` is the file the CAS just proved.
          onDisk = seriesPairOf(current);
          if (current === raw) return null;
          // Reported only for the label this write took off ON ITS OWN — an
          // explicit `seriesLabel: null` is the caller's own decision, and a
          // label on a page that was in NO series named nothing to begin with,
          // so there is no series to tell the reader has lost its name.
          if (
            label === null &&
            wantedLabel.value === undefined &&
            before.seriesLabel &&
            before.series
          ) {
            clearedLabel = { series: before.series, label: before.seriesLabel };
          }
          written = current;
          return current;
        },
        ...defaultPageWriteIo(root),
        ...(deps.readFile ? { readFile: deps.readFile } : {}),
        // Unreachable in no-log mode (`writeWikiPage` skips the fan-out), and
        // required by the type — stated rather than relied on.
        reindex: async () => {},
      });

      // Rule 4's refusal. Ahead of every other outcome for the same reason the
      // refusal reason is: the transform ran, decided, and wrote nothing.
      const conflict = twoHeaded as WikiPageMeta | null;
      if (conflict) {
        return c.json(
          {
            error:
              `"${conflict.relPath}" already names this series ("${conflict.seriesLabel}") — ` +
              `clear its label before naming it here`,
            twoHeaded: true,
            headRelPath: conflict.relPath,
          },
          409,
        );
      }
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
        // The writer folds "the file is gone" into `stale`, and the two
        // recoveries are opposite: a 409 says "reload and try again", which on a
        // page that no longer exists is a loop. It is the index's own 404 a beat
        // later, so it answers 404.
        if (result.reason === PAGE_GONE_REASON) {
          return c.json({ error: `no wiki page for relPath "${meta.relPath}"` }, 404);
        }
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

      // The 200 reports what is ON DISK, never what was asked for and never the
      // wiki INDEX — which is a 5-minute TTL cache this write has not refreshed
      // yet, so echoing `meta.series` reported the pre-write value on every noop
      // and on every omitted field (measured). `onDisk` is parsed out of the
      // exact bytes the transform ended with — the written ones, or, on a noop,
      // the ones the CAS just proved — and `written` is that same string, so the
      // hash is of this call's own output rather than of a re-read another
      // writer may have moved.
      const changed = written !== null;
      if (changed) {
        const warning = seriesCommitterWarning(
          entry ? { name: entry.name, root: entry.root, source: entry.source } : null,
          getSyncRepos().repos,
        );
        if (warning) log.warn("wiki series: {warning}", { warning, path: meta.relPath });
      }
      // The cast is the `written`/`refusedReason` idiom above: TypeScript cannot
      // see that the closure ran, so it narrows every one of these to `null`.
      const pair = onDisk as { series: string | null; seriesLabel: string | null } | null;
      const dropped = clearedLabel as { series: string; label: string } | null;
      return c.json({
        relPath: meta.relPath,
        hash: changed ? sha256(written!) : baseHash,
        written: changed,
        series: pair?.series ?? null,
        seriesLabel: pair?.seriesLabel ?? null,
        // Absent on every write that kept or was never given a label — the
        // client renders a note off its PRESENCE.
        ...(dropped ? { clearedLabel: dropped } : {}),
      });
    } catch (err) {
      log.error("wiki series: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });
}
