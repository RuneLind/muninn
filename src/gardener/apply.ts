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
 *    a time (in-process single-flight), so two create proposals racing to the
 *    same targetPath resolve deterministically — one applies, the other sees the
 *    file and goes stale. (The DB unique index is on topic_key, not target_path.)
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
import { parseFrontmatter } from "../wiki/store.ts";
import { stripFrontmatter } from "../wiki/render.ts";
import { sha256, todayOslo } from "./util.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "apply");

export type ApplyOutcome =
  | { outcome: "applied"; writtenPath: string }
  | { outcome: "stale"; reason: string }
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
   * Commit the just-written wiki files into their git repo (the page + log.md +
   * wired index/backlinks). Optional — absent in tests that don't exercise the
   * commit seam. Wired to `commitWikiChange` at the route; never throws.
   */
  commit?: (paths: string[], message: string) => Promise<void>;
}

/**
 * The commit message for a proposal apply: `[<writer>] <verb>: <page>`. Gardener
 * concept/entity applies are `[gardener] apply: …`; auto-drafted source pages are
 * `[source-drafter] draft: …`.
 */
export function commitMessageFor(proposal: WikiProposal): string {
  const writer = proposal.kind === "source" ? "source-drafter" : "gardener";
  const verb = proposal.kind === "source" ? "draft" : "apply";
  return `[${writer}] ${verb}: ${proposal.targetPath}`;
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

/** Per-wiki-root apply chains — the in-process single-flight (see module doc). */
const applyChains = new Map<string, Promise<unknown>>();

/**
 * Apply one approved proposal: confinement → staleness → write → log.md → cache
 * refresh → fire-and-forget reindex. Returns the outcome; the caller flips the
 * DB status accordingly. Never throws for a recoverable condition — a stale
 * target or a confinement failure is a normal outcome, not an exception.
 *
 * Serialized per `wikiDir`: a second apply against the same root waits for the
 * first to finish before its exists/hash checks run.
 */
export function applyWikiProposal(proposal: WikiProposal, deps: ApplyDeps): Promise<ApplyOutcome> {
  const key = path.resolve(deps.wikiDir);
  const prev = applyChains.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => applyInner(proposal, deps),
    () => applyInner(proposal, deps),
  );
  applyChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function applyInner(proposal: WikiProposal, deps: ApplyDeps): Promise<ApplyOutcome> {
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
    // Commit is the last step — a re-run that changed nothing on disk stages an
    // empty diff and the helper skips the commit quietly.
    await commitApply(proposal, deps, modified);
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
    const entry = `## [${todayOslo(deps.now())}] ${proposal.mode} | ${draftTitle(proposal)}\n- via wiki-gardener, ${proposal.sourceDocs.length} sources`;
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

  // 7. Commit the write into the wiki repo (last step; must not delay or be
  //    skipped by the fire-and-forget reindex). Non-fatal — a commit failure
  //    never undoes the applied page.
  await commitApply(proposal, deps, modified);

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
      const entry = buildIndexEntry({
        title,
        kind: proposal.kind,
        domain,
        rationale: proposal.rationale,
        body: stripFrontmatter(proposal.draft),
      });
      if (!entry) {
        log.info("Wiki-gardener wire: index entry skipped for {title} (entity — file manually)", {
          title,
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
 * Fire-and-forget huginn reindex for the UNION of the target's collection and
 * every collection the wire stage touched (life/** → wiki-life, else wiki),
 * deduped. Each POST is best-effort — a failure warns, never blocks the approve.
 */
function reindexUnion(deps: ApplyDeps, targetPath: string, modified: Set<string>): void {
  const collections = new Set<"wiki" | "wiki-life">([reindexCollectionFor(targetPath)]);
  for (const rel of modified) collections.add(reindexCollectionFor(rel));
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
