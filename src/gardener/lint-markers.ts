/**
 * The two facts a `lint` proposal row carries beyond the page it edits, and the
 * readers of them — `wiki_proposals.lint_meta` (migration 078).
 *
 *  - **`seededBy`** — the weekly `wiki-linter` watcher, or the gate's own
 *    `Propose fixes` button. The apply's `log.md` entry names it, because an
 *    unattended proposal and one a reviewer asked for are different events in a
 *    wiki's history.
 *  - **`findingRelPath`** — the page the LINT filed the finding against, which
 *    is not in general the row's own `target_path`: an 8.2 cluster is filed
 *    against its HEAD and edits every member. The gate's card reads it to
 *    decide which member's title to show, and the group apply to headline its
 *    log entry.
 *
 * Both readers DEGRADE rather than assume: a row written before the column
 * existed carries `null`, and so does one written by a build that only set half
 * of it. That is why the readers below take the whole value rather than
 * destructuring it at each call site.
 *
 * Its own module because `apply.ts` reads it and `lint-proposals.ts` writes it,
 * and `apply.ts` importing the seeder from the proposal builder would pull the
 * whole lint graph (`lint-series.ts` → `wiki-groups.ts`) into the apply path.
 */

/** Who seeded a lint row. */
export type LintSeeder = "wiki-linter" | "lint-proposals";

/** The `lint_meta` object, as stored. Every field optional on READ — the column
 *  is JSONB and older rows carry `null`. */
export interface LintMeta {
  seededBy?: string;
  findingRelPath?: string;
}

/** The value written onto a fresh lint row. */
export function lintMeta(seededBy: LintSeeder, findingRelPath: string): LintMeta {
  return { seededBy, findingRelPath };
}

/** Which seeder proposed this row. Defaults to the weekly watcher, which is
 *  what every row written before the column existed came from. */
export function lintSeederOf(meta: LintMeta | null | undefined): LintSeeder {
  return meta?.seededBy === "lint-proposals" ? "lint-proposals" : "wiki-linter";
}

/** The page the finding was filed against, or `null` on a row that carries no
 *  marker — in which case the caller falls back to a row of its own choosing. */
export function lintFindingPathOf(meta: LintMeta | null | undefined): string | null {
  const raw = meta?.findingRelPath;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
