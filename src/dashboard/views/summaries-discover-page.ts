import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escHtml } from "./components/escape.ts";
import { escJsonScript } from "../../utils/escape-html.ts";
import { discoverPageClientScript, discoverPageStyles } from "./components/discover-page.ts";
import type { DiscoverShelf } from "../../db/youtube-discover.ts";

/**
 * `/summaries/discover` — the Discover page (plan muninn-youtube-discovery,
 * PR 2, layout D5 "shelves by seed"). The server sends the shell and the stored
 * shelves as JSON; `discover-page-client.ts` renders the shelves, the sort and
 * length filters, the details drawer and the actions, so a sort or a dismiss
 * never round-trips for HTML. The seed bar (PR 3, `discover-seed-bar-client.ts`)
 * starts new runs from a category, the last 7 days or a hand-picked set.
 */

export interface DiscoverPageData {
  shelves: DiscoverShelf[];
  /** Older shelves the page's read left out (`listDiscoverShelfPage`). */
  hidden: number;
  error?: string;
}

export async function renderSummariesDiscoverPage(data: DiscoverPageData): Promise<string> {
  const client = await discoverPageClientScript();
  const error = data.error ? `<div class="dsc-error" role="alert">${escHtml(data.error)}</div>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>Muninn - Discover</title>
  <style>
    ${SHARED_STYLES}
    ${discoverPageStyles()}
  </style>
</head>
<body>
  ${renderNav("summaries")}
  <div class="dsc-page">
    <div class="dsc-head">
      <h2>Discover</h2>
      <span class="dsc-sub">New videos found from what you captured</span>
      <span class="dsc-spacer"></span>
      <span class="dsc-sub" id="dscCount"></span>
      <a class="dsc-back" href="/summaries">← Summaries</a>
    </div>
    <div class="dsc-controls">
      <label class="dsc-ctl"><span class="dsc-ctl-label">Sort</span>
        <select id="dscSort">
          <option value="score">Best match</option>
          <option value="new">Newest upload</option>
          <option value="long">Longest</option>
          <option value="short">Shortest</option>
        </select>
      </label>
      <label class="dsc-ctl"><span class="dsc-ctl-label">Length</span>
        <select id="dscLen">
          <option value="0">Any length</option>
          <option value="600">Over 10 min</option>
          <option value="1800">Over 30 min</option>
        </select>
      </label>
    </div>
    <section class="dsc-seeds" id="dscSeeds" aria-labelledby="dscSeedsLbl">
      <div class="dsc-seed-modes">
        <span class="dsc-ctl-label" id="dscSeedsLbl">Search from</span>
        <button type="button" class="dsc-chip" data-seedmode="category" aria-expanded="false" aria-controls="dscSeedPanel">+ A category…</button>
        <button type="button" class="dsc-chip" data-seedmode="week" aria-expanded="false" aria-controls="dscSeedPanel">+ Last 7 days</button>
        <button type="button" class="dsc-chip" data-seedmode="pick" aria-expanded="false" aria-controls="dscSeedPanel">+ Pick summaries…</button>
      </div>
      <div class="dsc-seed-panel" id="dscSeedPanel" hidden></div>
      <div class="dsc-progress" id="dscProgress" role="status" aria-live="polite" tabindex="-1"></div>
    </section>
    ${error}
    <main id="dscMain" class="dsc-main"></main>
  </div>
  <div class="dsc-drawer-bg" id="dscDrawerBg" hidden></div>
  <aside class="dsc-drawer" id="dscDrawer" role="dialog" aria-modal="true" aria-labelledby="dscDrawerTitle" hidden></aside>
  <div class="dsc-toast" id="dscToast" role="status" aria-live="polite"></div>
  <div class="dsc-sr" id="dscAnnounce" role="status" aria-live="polite"></div>
  <script type="application/json" id="dscData">${escJsonScript({ shelves: data.shelves, hidden: data.hidden })}</script>
  <script>${client}</script>
</body>
</html>`;
}
