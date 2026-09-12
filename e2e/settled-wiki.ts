/**
 * Make a temp fixture wiki look SETTLED, so the rail's Activity section is empty
 * on it.
 *
 * A fixture wiki is written milliseconds before the spec reads it, which makes
 * every page brand new: `pageAddedMs` falls back to the file's birthtime and
 * `pageTimeMs` to its mtime, both "now", so `rankActivity` scores the whole wiki
 * at the top and the Activity section claims six arbitrary rows. That is correct
 * for a wiki whose pages really were just written and wrong for a fixture
 * standing in for a corpus somebody has had for a year — and it would otherwise
 * lift the very rows a spec about Pinned, Recently opened or a facet is asserting
 * about.
 *
 * Two things are needed together, because the two signals have different
 * fallbacks:
 *
 *  - a frontmatter `created:` far in the past — `pageAddedMs` takes the OLDEST
 *    of frontmatter/git/birthtime, so this wins over the birthtime nothing can
 *    set portably (macOS moves it with mtime, Linux does not);
 *  - a backdated **mtime** — `pageTimeMs` takes the NEWEST of frontmatter, the
 *    git touch date and (on a wiki git knows nothing about, which every temp
 *    fixture is) mtime, so an untouched mtime keeps the page "changed today".
 *
 * A spec that wants a page to BE news leaves it out of both.
 */

import { readdir, utimes } from "node:fs/promises";
import path from "node:path";

/** The `created:` value fixture pages carry. Far enough back that the score is
 *  orders of magnitude under `ACTIVITY_MIN_SCORE` whenever this file is run. */
export const SETTLED_CREATED = "2024-01-02";

/** The frontmatter line to put in a fixture page, alongside its `title:`. */
export const SETTLED_CREATED_LINE = `created: ${SETTLED_CREATED}`;

const SETTLED_MS = Date.parse(`${SETTLED_CREATED}T12:00:00Z`);

/** Backdate the mtime of every page under `root`, recursively. Call it once,
 *  after the fixture's files are written. */
export async function settleWikiMtimes(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(md|mdx|html)$/i.test(entry.name)) continue;
    const abs = path.join(entry.parentPath ?? root, entry.name);
    await utimes(abs, new Date(SETTLED_MS), new Date(SETTLED_MS));
  }
}
