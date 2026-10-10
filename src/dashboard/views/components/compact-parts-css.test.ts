import { test, expect } from "bun:test";
import { componentBlockCss } from "../../../format/component-styles.ts";
import { renderWikiGardenerPage } from "../wiki-gardener-page.ts";
import { formatWebHtml } from "../../../web/web-format.ts";

// Fix round 1, item 4: every `renderWikiHtml` caller gets the reader markup,
// so a decision's date cell and a case's compact line must be hidden wherever
// the lens CSS is absent — the gardener preview and the digest — or the date
// shows twice.

const HIDE = (scope: string) => `${scope} :is(.dl-when, .cb-line) { display: none; }`;

test("the shared component CSS hides the compact parts by default", () => {
  expect(componentBlockCss(".wiki-article")).toContain(HIDE(".wiki-article"));
});

test("the gardener preview hides the compact parts its reader-path render carries", async () => {
  const preview = formatWebHtml("<DecisionLog>\n\n- **D1** — Regelen gjelder alle saker. Fag, 28.09 (runde 1).\n\n</DecisionLog>", {
    reader: true,
  });
  expect(preview).toContain('class="dl-when"');
  expect(await renderWikiGardenerPage()).toContain(HIDE(".gard-preview"));
});
