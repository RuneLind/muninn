/// <reference lib="dom" />
/**
 * Browser ENTRYPOINT for the `/summaries` Fact check section and rail badges —
 * the standalone bundle that page loads, since it composes template-string
 * scripts and cannot import (the `share-dialog-browser.ts` pattern).
 */

import {
  sumFactcheckBadgeHtml,
  sumFactcheckLoadBadges,
  sumFactcheckOnOpen,
  sumFactcheckStart,
  SUM_FACTCHECK_BTN_ID,
} from "./sum-factcheck-client.ts";

Object.assign(globalThis, { sumFactcheckBadgeHtml, sumFactcheckLoadBadges, sumFactcheckOnOpen, sumFactcheckStart });

document.getElementById(SUM_FACTCHECK_BTN_ID)?.addEventListener("click", () => sumFactcheckStart());
