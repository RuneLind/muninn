/**
 * Append (or replace) a sentinel-wrapped block on an EXISTING wiki markdown page —
 * the write path behind the fact-check reader's "➕ Add to article" action.
 *
 * Deliberately NOT the gardener `applyWikiProposal` path: that runs
 * `containDraftBodyLinks` + alias-strip over the WHOLE page and could rewrite
 * existing content. This helper splices one block — {@link spliceSentinelBlock} is
 * that splice — and touches the rest of the body ONLY through the caller's
 * optional {@link AppendBlockOptions.prepareBody} pass, which the ➕ fact-check
 * route uses to supersede stale `<Fact>` marks (no hook ⇒ the body reaches the
 * splice untouched). Everything around it (confinement → CAS → write → log.md →
 * refresh → reindex → commit, the whole sequence serialized on the per-wiki write
 * queue) is the SHARED `writeWikiPage` in `page-write.ts`, which the fact-check
 * integrate path uses with its own strings.
 *
 * The splice itself: replace an existing
 * `<!-- factcheck:start -->…<!-- factcheck:end -->` in place, else insert before a
 * trailing `## Sources` section if present, otherwise append at end.
 *
 * Filesystem/index/reindex seams are injected so the splice + staleness logic
 * unit-tests with in-memory fakes.
 */

import { FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "./factcheck-context.ts";
import { writeWikiPage, type PageWriteOptions } from "./page-write.ts";
import type { CommitWikiResult } from "./commit.ts";

export type AppendOutcome =
  | { outcome: "written"; writtenPath: string; commit?: CommitWikiResult }
  | { outcome: "stale"; reason: string }
  /** Propagated from `writeWikiPage` on a wiki-readonly instance — a refusal the
   *  caller maps to 403, deliberately NOT collapsed into `error` (⇒ 500). */
  | { outcome: "forbidden"; reason: string }
  | { outcome: "error"; reason: string };

export interface AppendBlockOptions
  extends Omit<
    PageWriteOptions,
    "transform" | "logKind" | "logLine" | "commitMessage"
  > {
  /** The full sentinel-wrapped block to splice in (see `buildFactcheckBlock`). */
  block: string;
  /**
   * Optional caller-owned pass over the FRESHLY-READ body, run inside the write
   * section immediately before the splice. Absent ⇒ the body reaches
   * `spliceSentinelBlock` untouched and the log line + commit subject are the
   * bare ones below, i.e. every existing caller is byte-identical.
   *
   * It exists for ONE caller: the ➕ route, which must run the fact-check strip
   * here and nowhere else — the strip is a fact-check policy, not a property of
   * splicing a sentinel block, so it stays in the route (which also needs to
   * COUNT what it removed, off the same bytes, to report the supersede note).
   * Doing it before the call is not an option: the body is read inside the
   * section, after the CAS.
   */
  prepareBody?: (current: string) => PreparedBody;
}

/** What a {@link AppendBlockOptions.prepareBody} pass hands back. */
export interface PreparedBody {
  /** The body the splice runs against. */
  body: string;
  /**
   * Short clause naming what the pass CHANGED, e.g. `2 prior marks superseded`.
   * Appended to both the `log.md` line and the commit subject, because a pass
   * that rewrote prose the caller never asked about must not hide behind a line
   * that says only "fact-check block added" — the log and the history are where
   * a reader finds out a page lost its marks. Absent ⇒ both strings are the bare
   * ones, so a pass that changed nothing reads exactly like no pass at all.
   */
  note?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ensure exactly one trailing newline. Exported so the fact-check INTEGRATE
 *  write normalizes identically on BOTH its branches — otherwise ticking the
 *  "also refresh the callout" checkbox would change trailing bytes an untouched
 *  edits-only apply left alone. */
export function withTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

/**
 * Splice a sentinel-wrapped `block` into `content`:
 *   - if a `<!-- factcheck:start -->…<!-- factcheck:end -->` block already exists,
 *     REPLACE it in place (a function replacer, so `$`-sequences in the block are
 *     literal);
 *   - else insert before a trailing `## Sources` heading if present;
 *   - else append at end of file.
 * Pure — no trailing-newline normalization (the caller does that).
 */
export function spliceSentinelBlock(content: string, block: string): string {
  const re = new RegExp(
    escapeRegExp(FACTCHECK_SENTINEL_START) + "[\\s\\S]*?" + escapeRegExp(FACTCHECK_SENTINEL_END),
  );
  if (re.test(content)) {
    return content.replace(re, () => block);
  }
  const lines = content.split("\n");
  const sourcesIdx = lines.findIndex((l) => /^##\s+Sources\b/i.test(l));
  if (sourcesIdx !== -1) {
    const before = lines.slice(0, sourcesIdx).join("\n").replace(/\n+$/, "");
    const after = lines.slice(sourcesIdx).join("\n");
    return `${before}\n\n${block}\n\n${after}`;
  }
  const trimmed = content.replace(/\n+$/, "");
  return `${trimmed}\n\n${block}`;
}

/**
 * Append/replace one sentinel-wrapped block on an existing wiki markdown page.
 * Returns the outcome; the caller maps it to an HTTP status (written→200,
 * stale→409, error→400/500). Never throws for a recoverable condition.
 */
export async function appendBlockToPage(opts: AppendBlockOptions): Promise<AppendOutcome> {
  const { block, commit, prepareBody, ...rest } = opts;
  // Set by `transform` and read by the two thunks below — `writeWikiPage`
  // resolves both AFTER the transform has run, which is the only point at which
  // what the prepare pass found is known (the body is read inside the section).
  let prepareNote: string | undefined;
  const withNote = (base: string, wrap: (n: string) => string): string =>
    prepareNote ? base + wrap(prepareNote) : base;
  const result = await writeWikiPage({
    ...rest,
    // Committer and subject travel together (`PageWriteCommitOptions`): this
    // path owns the subject, the caller owns whether there is a committer.
    ...(commit
      ? {
          commit,
          commitMessage: () =>
            withNote(`[fact-check] annotate: ${opts.relPath}`, (n) => ` (${n})`),
        }
      : { commit: undefined, commitMessage: undefined }),
    transform: (current) => {
      const prepared = prepareBody?.(current);
      prepareNote = prepared?.note;
      return withTrailingNewline(spliceSentinelBlock(prepared ? prepared.body : current, block));
    },
    logKind: "factcheck",
    logLine: () => withNote("fact-check block added via the wiki reader", (n) => `; ${n}`),
  });
  // The append transform always returns content, so `noop` is unreachable here —
  // map it defensively rather than widening this path's outcome vocabulary.
  if (result.outcome === "noop") {
    return { outcome: "error", reason: "nothing to write" };
  }
  return result;
}
