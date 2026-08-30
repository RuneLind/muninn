/**
 * Apply stage — muninn's FIRST write path into the knowledge wiki.
 *
 * On approve, the review gate calls `applyWikiProposal` with the bot's `wikiDir`
 * and injected filesystem/index/reindex seams (real ones in the route, fakes in
 * tests). It re-checks path confinement (defense in depth), verifies the target
 * hasn't drifted since drafting, writes the draft, inserts a reverse-chron
 * `log.md` entry, refreshes the read cache, and fire-and-forgets a huginn
 * reindex.
 *
 * Two safety properties beyond the happy path:
 *  - **Re-run safe**: if the target already contains exactly the draft, the
 *    apply short-circuits to `applied` — so a crash between the file write and
 *    the terminal status CAS is recovered by re-approving the stuck `approved`
 *    row, and a double-click is harmless.
 *  - **Serialized per wiki root**: applies against the same `wikiDir` run one at
 *    a time, so two create proposals racing to the same targetPath resolve
 *    deterministically — one applies, the other sees the file and goes stale.
 *    (The DB unique index is on topic_key, not target_path.) Since 2026-07-30
 *    that serialization is the SHARED wiki-write queue (`src/wiki/queue.ts`), the
 *    same chain `writeWikiPage` holds — see `applyWikiProposal` below.
 *
 * Filesystem writes are the point — but nothing here touches the DB. The route
 * owns the status CAS (approved → applied | stale | error) based on the returned
 * outcome, keeping this stage unit-testable with temp dirs alone.
 */

import path from "node:path";
import type { WikiProposal } from "../db/wiki-proposals.ts";
import type { WikiIndex } from "../wiki/store.ts";
import { containDraftBodyLinks, isPathConfined, stripOwnedAliases } from "./draft.ts";
import { buildIndexEntry, buildSeeAlsoEdit, insertIndexLine, selectWirablePages } from "./wire.ts";
import { parseFrontmatter, wikiPageStem } from "../wiki/store.ts";
import { findStemTwin, stemCollisionMessage } from "./source-drafter.ts";
import { stripFrontmatter } from "../wiki/render.ts";
import { runWikiWriteExclusive } from "../wiki/queue.ts";
import {
  isReadonlyWikiRoot,
  isWikiReadonly,
  WIKI_READONLY_REASON,
  wikiReadonlyRootReason,
} from "../wiki/readonly.ts";
import { sha256, todayOslo } from "./util.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "apply");

export type ApplyOutcome =
  | { outcome: "applied"; writtenPath: string }
  | { outcome: "stale"; reason: string }
  /**
   * This instance is wiki-readonly (`MUNINN_WIKI_READONLY=1`). A REFUSAL, not a
   * failure — the route answers 403 and leaves the proposal's status alone, so
   * the write-owning instance can still approve it later.
   */
  | { outcome: "forbidden"; reason: string }
  | { outcome: "error"; reason: string };

export interface ApplyDeps {
  /** Absolute wiki root (the bot's `wikiDir`) — the path-confinement anchor. */
  wikiDir: string;
  now: () => number;
  /** Read a file's text, or null when it doesn't exist / is unreadable. */
  readFile: (absPath: string) => Promise<string | null>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** Index over `wikiDir` — the update-mode oracle for "is this a real page". */
  getWikiIndex: () => Promise<WikiIndex | null>;
  /** Refresh the wiki-store TTL cache for this root (getWikiIndex refresh). */
  refreshIndex: () => Promise<void>;
  /** Best-effort huginn reindex for a collection; must never throw. */
  reindex: (collection: string) => Promise<void>;
  /**
   * Explicit huginn collections to reindex after the write, overriding the
   * default `reindexCollectionFor` mapping (life/** → wiki-life, else wiki, which
   * is hardcoded to jarvis's collections). Set for wiki-keyed (standalone-wiki)
   * applies — the consolidation gardener passes the wiki registry entry's
   * `collections` (e.g. `["mimir"]`). Absent ⇒ the legacy per-path mapping, so
   * bot-wiki applies are byte-identical. Empty array ⇒ no reindex.
   */
  reindexCollections?: string[];
  /**
   * Commit the just-written wiki files into their git repo (the page + log.md +
   * wired index/backlinks). Optional — absent in tests that don't exercise the
   * commit seam. Wired to `commitWikiChange` at the route; never throws.
   */
  commit?: (paths: string[], message: string) => Promise<unknown>;
  /**
   * Per-wiki cataloging policy — which page kinds get an index.md catalog line
   * (`buildIndexEntry`). Absent ⇒ the default `["concept"]` (today's behavior).
   * jarvis opts sources in via `wikiAutoCommit.catalogKinds` (`["concept",
   * "source"]`); entities are never cataloged regardless.
   */
  catalogKinds?: string[];
  /**
   * Is this instance forbidden from writing wiki page content? Injectable for
   * tests; defaults to the shared `isWikiReadonly` (`MUNINN_WIKI_READONLY`), so
   * the guard is fail-closed for every caller including ones added later.
   */
  isReadonly?: () => boolean;
  /**
   * Is THIS WIKI ROOT registered read-only (`WIKI_READONLY_ROOTS`)? The
   * per-wiki mechanism beside the instance flag; same fail-closed injection
   * rule. Reached via `POST /api/wiki/proposals/:id/approve`, which resolves its
   * target against the FULL registry, so the picker exclusion is not a guard.
   */
  isReadonlyRoot?: (root: string) => boolean;
}

/**
 * The commit message for a proposal apply: `[<writer>] <verb>: <page>`. Gardener
 * concept/entity applies are `[gardener] apply: …`; auto-drafted source pages are
 * `[source-drafter] draft: …`; consolidation-gardener synthesis pages are
 * `[consolidation] apply: …`.
 */
export function commitMessageFor(proposal: WikiProposal): string {
  if (proposal.kind === "synthesis") return `[consolidation] apply: ${proposal.targetPath}`;
  const writer = proposal.kind === "source" ? "source-drafter" : "gardener";
  const verb = proposal.kind === "source" ? "draft" : "apply";
  return `[${writer}] ${verb}: ${proposal.targetPath}`;
}

/** The `via <writer>` attribution in the apply-time log.md entry, keyed by kind:
 *  consolidation `synthesis` applies say `via consolidation-gardener`; every other
 *  kind keeps the historical `via wiki-gardener`. */
export function logWriterFor(proposal: WikiProposal): string {
  return proposal.kind === "synthesis" ? "consolidation-gardener" : "wiki-gardener";
}

/**
 * Commit the page + log.md + every wire-stage-modified file as ONE commit. The
 * page and log.md are NOT in the wire-stage set, so committing only the wire
 * result would leave the tree dirty. Deduped. No-op when no commit seam is wired.
 * The helper is non-throwing; the try/catch is belt-and-suspenders.
 */
async function commitApply(
  proposal: WikiProposal,
  deps: ApplyDeps,
  modified: Set<string>,
): Promise<void> {
  if (!deps.commit) return;
  const paths = [...new Set([proposal.targetPath, "log.md", ...modified])];
  try {
    await deps.commit(paths, commitMessageFor(proposal));
  } catch (err) {
    log.warn("Wiki-gardener apply: commit failed for {path}: {error}", {
      path: proposal.targetPath,
      error: errMsg(err),
    });
  }
}

/** The huginn collection a target path reindexes into: life/** → wiki-life, else wiki. */
export function reindexCollectionFor(targetPath: string): "wiki" | "wiki-life" {
  return targetPath.startsWith("life/") ? "wiki-life" : "wiki";
}

/** Title for the log.md entry — the draft's frontmatter title, falling back to topicKey. */
export function draftTitle(proposal: WikiProposal): string {
  const fm = parseFrontmatter(proposal.draft);
  const title = Array.isArray(fm.title) ? fm.title[0] : fm.title;
  return (title && title.trim()) || proposal.topicKey;
}

/**
 * Insert a new entry into a reverse-chron `log.md` — AFTER the `# Activity Log`
 * header, BEFORE the first `## [` entry (the wiki's newest-first convention; a
 * literal prepend above the H1 would be wrong). Creates the file with the header
 * when it doesn't exist yet.
 */
export function insertLogEntry(existing: string | null, entry: string): string {
  const header = "# Activity Log";
  const block = entry.replace(/\n+$/, "");

  if (!existing || !existing.trim()) {
    return `${header}\n\n${block}\n`;
  }

  let text = existing;
  if (!/^#\s+Activity Log/m.test(text)) {
    text = `${header}\n\n${text}`;
  }

  const lines = text.split("\n");
  const firstEntryIdx = lines.findIndex((l) => /^##\s+\[/.test(l));

  if (firstEntryIdx === -1) {
    const trimmed = text.replace(/\n+$/, "");
    return `${trimmed}\n\n${block}\n`;
  }

  const before = lines.slice(0, firstEntryIdx);
  if (before.length && before[before.length - 1]!.trim() !== "") before.push("");
  const after = lines.slice(firstEntryIdx);
  return [...before, block, "", ...after].join("\n");
}

/** Ensure the written page body ends in exactly one trailing newline. */
function withTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

/**
 * Apply one approved proposal: confinement → staleness → write → log.md → cache
 * refresh → fire-and-forget reindex. Returns the outcome; the caller flips the
 * DB status accordingly. Never throws for a recoverable condition — a stale
 * target or a confinement failure is a normal outcome, not an exception.
 *
 * Serialized on the SHARED wiki-write queue, keyed per wiki ROOT: a second apply
 * against the same root waits for the first to finish before its exists/hash
 * checks run — AND so does every `writeWikiPage` caller (the fact-check append +
 * integrate writers). That join is the point: `log.md` is wiki-GLOBAL, so this
 * path and those two are read-modify-writing one file. Until 2026-07-30 the
 * gardener kept a private per-wikiDir chain map, which serialized applies against
 * each other but not against the append/integrate family — approving a draft
 * while a fact-check write landed on the same wiki could lose a log entry.
 *
 * The commit tail runs AFTER the section releases, exactly as `writeWikiPage`
 * does — and for the same reason, which joining the shared chain made load-bearing
 * here too. `commitWikiChange` dispatches its push onto the per-git-toplevel commit
 * queue WITHOUT awaiting it, so a later commit queues behind an in-flight push —
 * bounded since the repo-sync PR at `GIT_NETWORK_TIMEOUT_MS` (60s), which caps the
 * stall but does not remove it. Committing inside the section would therefore park
 * every fact-check append/integrate on that wiki for up to that minute
 * (measured: a 3s push stall blocked a concurrent append for 3s).
 * That was harmless while the gardener held a PRIVATE chain; on the shared one the
 * lock's blast radius is all three writer families, so the hold must stay short.
 */
export async function applyWikiProposal(
  proposal: WikiProposal,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  // Readonly instance: refuse before the queue is even entered. A refusal, not
  // an error — the route answers 403 and leaves the row reviewable.
  if ((deps.isReadonly ?? isWikiReadonly)()) {
    log.warn("Wiki-gardener apply refused — instance is wiki-readonly: {path}", {
      path: proposal.targetPath,
    });
    return { outcome: "forbidden", reason: WIKI_READONLY_REASON };
  }

  // Per-WIKI read-only root: this instance owns writes, just not to THIS root.
  if ((deps.isReadonlyRoot ?? isReadonlyWikiRoot)(deps.wikiDir)) {
    log.warn("Wiki-gardener apply refused — wiki root is registered read-only: {path}", {
      path: proposal.targetPath,
      root: deps.wikiDir,
    });
    return { outcome: "forbidden", reason: wikiReadonlyRootReason(deps.wikiDir) };
  }

  // A holder, not a `let` — TS narrows a closure-assigned local to `null`.
  const tail: { commit?: () => Promise<void> } = {};
  const outcome = await runWikiWriteExclusive(deps.wikiDir, () =>
    applyInner(proposal, deps, (commit) => {
      tail.commit = commit;
    }),
  );
  if (tail.commit) await tail.commit();
  return outcome;
}

/** Hand the commit closure to `applyWikiProposal`, which runs it after the
 *  per-wiki write section releases. */
type DeferCommit = (commit: () => Promise<void>) => void;

async function applyInner(
  proposal: WikiProposal,
  deps: ApplyDeps,
  deferCommit: DeferCommit,
): Promise<ApplyOutcome> {
  const domain: "ai" | "life" = proposal.targetPath.startsWith("life/") ? "life" : "ai";

  // The fresh index backs both the update-target check (1a) and the apply-time
  // alias re-strip (1c) — create mode needs it too now.
  const index = await deps.getWikiIndex();

  // 1a. Update mode: the target must be a REAL indexed wiki page — look it up in
  //     the local store rather than trusting the row (passing the row's own
  //     targetPath as existingRelPath would make the confinement check a
  //     tautology).
  let existingRelPath: string | undefined;
  if (proposal.mode === "update") {
    const page = index?.pages.find((p) => p.relPath === proposal.targetPath);
    if (!page) {
      return {
        outcome: "error",
        reason: `update target "${proposal.targetPath}" is not an indexed wiki page`,
      };
    }
    existingRelPath = page.relPath;
  }

  // 1b. Path confinement (defense in depth — the shape-gate ran this at persist
  //     time, but a hand-edited row must not escape wikiDir on apply).
  const confined = isPathConfined({
    targetPath: proposal.targetPath,
    wikiDir: deps.wikiDir,
    domain,
    kind: proposal.kind,
    existingRelPath,
  });
  if (!confined) {
    return { outcome: "error", reason: `path confinement failed for "${proposal.targetPath}"` };
  }

  // 1c. Alias-hijack re-strip against the FRESH index (defense in depth — the
  //     runner stripped at persist time, but a canonical page created while the
  //     proposal awaited review must still win its aliases). The target path
  //     itself is always "self": on a create re-run after a crash-after-write,
  //     the target's own first write is indexed and must not strip the draft's
  //     aliases (a FOREIGN file at the target is caught by the stale check).
  const dealiased = stripOwnedAliases(proposal.draft, {
    index,
    selfRelPath: existingRelPath ?? proposal.targetPath,
  });
  if (dealiased.stripped.length > 0) {
    log.warn("Apply: stripped alias(es) owned by other pages from proposal {id}: {aliases}", {
      id: proposal.id,
      aliases: dealiased.stripped.join(", "),
    });
  }

  // 1d. Body-link containment re-run against the FRESH index (TOCTOU symmetry with
  //     the alias re-strip): a page linked in the body that was deleted between
  //     draft and approve must not ship as a dangling wikilink. Null index ⇒ skip
  //     (can't tell resolvable from phantom; don't de-link a whole page on an index
  //     outage). This mutates finalContent, which drives the re-run-safe early
  //     return below — an accepted, benign corner (a page deleted between draft and
  //     approve, a crash after the page write, then a re-approve makes finalContent
  //     no longer match disk, so the early return is skipped and create-mode falls
  //     to `stale`; the row re-drafts next weekly cycle). When the index is
  //     unchanged, containment is a no-op and idempotent recovery still holds.
  let containedDraft = dealiased.draft;
  if (index) {
    const contained = containDraftBodyLinks(dealiased.draft, {
      resolve: index.resolve,
      selfTitle: draftTitle(proposal),
    });
    containedDraft = contained.draft;
    if (contained.delinked.length > 0) {
      log.warn("Apply: de-linked unresolvable body link(s) from proposal {id}: {links}", {
        id: proposal.id,
        links: contained.delinked.join(", "),
      });
    }
  }

  const absTarget = path.join(deps.wikiDir, proposal.targetPath);
  const finalContent = withTrailingNewline(containedDraft);
  const current = await deps.readFile(absTarget);

  // 2a. Re-run safety: the target already IS the draft — a crash after the file
  //     write (before the terminal CAS) or a double-approve. Report applied
  //     without rewriting; the log.md entry from the first pass stands.
  if (current !== null && current === finalContent) {
    log.info("Wiki-gardener apply: target already matches draft for {path} — treating as applied", {
      path: proposal.targetPath,
    });
    // The crashed/double-approved pass may never have reached the wire stage or
    // the reindex — run the idempotent wire stage here too, refresh, and reindex
    // the union (including the target's own collection) before returning.
    const modified = await runWireStage(proposal, deps, index);
    try {
      await deps.refreshIndex();
    } catch (err) {
      log.warn("Wiki-gardener apply: cache refresh failed: {error}", { error: errMsg(err) });
    }
    reindexUnion(deps, proposal.targetPath, modified);
    // Commit is the last step, and runs OUTSIDE the write section (see
    // `applyWikiProposal`) — a re-run that changed nothing on disk stages an
    // empty diff and the helper skips the commit quietly.
    deferCommit(() => commitApply(proposal, deps, modified));
    return { outcome: "applied", writtenPath: proposal.targetPath };
  }

  // 2b. Staleness — the target must be exactly as it was at draft time.
  if (proposal.mode === "update") {
    if (current === null) {
      return { outcome: "stale", reason: "target file no longer exists" };
    }
    if (!proposal.baseHash || sha256(current) !== proposal.baseHash) {
      return { outcome: "stale", reason: "target file changed since drafting" };
    }
  } else if (current !== null) {
    return { outcome: "stale", reason: "target path already exists" };
  }

  // 2c. Stem collision, re-checked INSIDE the write queue. The approve route
  //     refuses this before its draft→approved CAS, but that guard sits OUTSIDE
  //     this queue and each gate card only disables its OWN buttons — so two
  //     colliding proposals approved together both pass it, and the second write
  //     lands the twin the first one's refusal was for. Measured. This is also
  //     what covers the one case the route guard deliberately skips: an `approved`
  //     crash-recovery re-run whose twin appeared inside the crash window.
  //
  //     `index` is the same object steps 1a/1c/1d use and is fetched in-queue; the
  //     route builds it with `refresh: true` precisely so this sees a page written
  //     by the apply that just released the queue. A null index (outage) degrades
  //     to no check, like every other index-dependent step here.
  //
  //     The outcome is the EXISTING `error` variant carrying the route's own
  //     refusal sentence — deliberately no new `ApplyOutcome`: the row is already
  //     `approved` by the time we get here, so the honest terminal state is the
  //     one the route already flips to and reports.
  if (proposal.mode === "create") {
    const stem = wikiPageStem(proposal.targetPath);
    const blocking = findStemTwin(index, stem, proposal.targetPath);
    if (blocking) {
      log.warn("Wiki-gardener apply refused for {path}: stem is already owned by {blocking}", {
        path: proposal.targetPath,
        blocking: blocking.relPath,
      });
      return { outcome: "error", reason: stemCollisionMessage(blocking, stem) };
    }
  }

  // 3. Write the draft.
  try {
    await deps.writeFile(absTarget, finalContent);
  } catch (err) {
    return { outcome: "error", reason: `write failed: ${errMsg(err)}` };
  }

  // 4. log.md entry (reverse-chron). A log-write hiccup must not undo the page
  //    write — the page is the source of truth — so it degrades to a warning.
  try {
    const logPath = path.join(deps.wikiDir, "log.md");
    const existingLog = await deps.readFile(logPath);
    const entry = `## [${todayOslo(deps.now())}] ${proposal.mode} | ${draftTitle(proposal)}\n- via ${logWriterFor(proposal)}, ${proposal.sourceDocs.length} sources`;
    await deps.writeFile(logPath, insertLogEntry(existingLog, entry));
  } catch (err) {
    log.warn("Wiki-gardener apply: log.md update failed for {path}: {error}", {
      path: proposal.targetPath,
      error: errMsg(err),
    });
  }

  // 4b. Wire the page into the wiki — index.md line + inbound See-also links on
  //     related pages — so it isn't shipped as an orphan. Best-effort per file;
  //     returns the paths it modified for the reindex union below.
  const modified = await runWireStage(proposal, deps, index);

  // 5. Refresh the read cache so /wiki and the next target-resolve see the write.
  try {
    await deps.refreshIndex();
  } catch (err) {
    log.warn("Wiki-gardener apply: cache refresh failed: {error}", { error: errMsg(err) });
  }

  // 6. Fire-and-forget huginn reindex over the union of the target's collection +
  //    every collection the wire stage touched — the approve response must not
  //    wait on a (potentially slow) best-effort POST.
  reindexUnion(deps, proposal.targetPath, modified);

  // 7. Commit the write into the wiki repo — last step, and the ONE step handed
  //    back to `applyWikiProposal` to await after the per-wiki write section
  //    releases (a stalled push must not park the other wiki writers; see there).
  //    Non-fatal — a commit failure never undoes the applied page.
  deferCommit(() => commitApply(proposal, deps, modified));

  return { outcome: "applied", writtenPath: proposal.targetPath };
}

/**
 * Wire the just-written page INTO the wiki so it isn't an orphan (the whole point
 * of this PR): (a) add its `## Concepts` index.md line (create mode only —
 * entities skip, sections that don't exist are never invented), and (b) add an
 * inbound `## See also` link on up to 3 of the proposal's `related_pages` that
 * still resolve in the fresh apply-time index.
 *
 * Best-effort PER FILE: a wiring failure warns and continues — the page write is
 * the source of truth and must never be undone by a wiring hiccup. Idempotent, so
 * safe to run on the re-run/early-return recovery path too. Returns the set of
 * wiki-relative paths it actually modified (for the reindex union). Index-line and
 * See-also edits deliberately bypass the base_hash CAS: they're additive,
 * idempotent, and re-read at apply time (accepted tiny race).
 */
async function runWireStage(
  proposal: WikiProposal,
  deps: ApplyDeps,
  index: WikiIndex | null,
): Promise<Set<string>> {
  const modified = new Set<string>();
  const title = draftTitle(proposal);
  const domain: "ai" | "life" = proposal.targetPath.startsWith("life/") ? "life" : "ai";

  // (a) index.md entry — create mode only.
  if (proposal.mode === "create") {
    try {
      const entry = buildIndexEntry(
        {
          title,
          kind: proposal.kind,
          domain,
          rationale: proposal.rationale,
          body: stripFrontmatter(proposal.draft),
        },
        deps.catalogKinds,
      );
      if (!entry) {
        log.info("Wiki-gardener wire: index entry skipped for {title} ({kind} — not cataloged for this wiki)", {
          title,
          kind: proposal.kind,
        });
      } else {
        const indexPath = path.join(deps.wikiDir, "index.md");
        const existing = (await deps.readFile(indexPath)) ?? "";
        const res = insertIndexLine(existing, entry);
        if (res.reason === "section-not-found") {
          log.warn(
            "Wiki-gardener wire: index section \"### {section}\" not found — skipping index entry for {title}",
            { section: entry.section, title },
          );
        } else if (res.changed) {
          await deps.writeFile(indexPath, res.content);
          modified.add("index.md");
          log.info("Wiki-gardener wire: added index entry for {title} under \"### {section}\"", {
            title,
            section: entry.section,
          });
        }
      }
    } catch (err) {
      log.warn("Wiki-gardener wire: index entry failed for {title}: {error}", {
        title,
        error: errMsg(err),
      });
    }
  }

  // (b) Inbound See-also links from related pages that still resolve. Selection
  //     (slice(0,3) → resolve → skip self-links) is the shared `selectWirablePages`
  //     helper so the review-gate preview can't promise a backlink apply skips.
  for (const { page } of selectWirablePages(proposal.relatedPages, index, proposal.targetPath)) {
    const relPath = page.relPath;
    // Pure-confinement semantics (existingRelPath supplied): rel === the page's own
    // path, and FORBIDDEN_BASENAMES (log.md/index.md/CLAUDE.md) is rejected first —
    // so this path can never touch wiki infrastructure files.
    if (
      !isPathConfined({
        targetPath: relPath,
        wikiDir: deps.wikiDir,
        domain: page.domain,
        kind: "concept",
        existingRelPath: relPath,
      })
    ) {
      continue;
    }
    try {
      const abs = path.join(deps.wikiDir, relPath);
      const content = await deps.readFile(abs);
      if (content === null) continue;
      const edited = buildSeeAlsoEdit(content, title);
      if (edited === null) continue; // already linked / nothing to do
      await deps.writeFile(abs, edited);
      modified.add(relPath);
      log.info("Wiki-gardener wire: added See-also [[{title}]] to {relPath}", { title, relPath });
    } catch (err) {
      log.warn("Wiki-gardener wire: See-also edit failed for {relPath}: {error}", {
        relPath,
        error: errMsg(err),
      });
    }
  }

  return modified;
}

/**
 * Fire-and-forget huginn reindex. For a bot wiki (no `reindexCollections`): the
 * UNION of the target's collection and every collection the wire stage touched
 * (life/** → wiki-life, else wiki), deduped. For a wiki-keyed apply: exactly the
 * injected `reindexCollections` (the wiki registry entry's collections — every
 * wire-touched page is in the SAME standalone wiki, so the per-path split doesn't
 * apply). Each POST is best-effort — a failure warns, never blocks the approve.
 */
function reindexUnion(deps: ApplyDeps, targetPath: string, modified: Set<string>): void {
  const collections: Set<string> = deps.reindexCollections
    ? new Set(deps.reindexCollections)
    : (() => {
        const c = new Set<string>([reindexCollectionFor(targetPath)]);
        for (const rel of modified) c.add(reindexCollectionFor(rel));
        return c;
      })();
  for (const collection of collections) {
    deps.reindex(collection).catch((err) => {
      log.warn("Wiki-gardener apply: reindex failed for {collection}: {error}", {
        collection,
        error: errMsg(err),
      });
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
