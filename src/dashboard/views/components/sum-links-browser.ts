/// <reference lib="dom" />
/**
 * Browser ENTRYPOINT for the `/summaries` 🔎 Find links section — the
 * standalone bundle the page loads (the `sum-factcheck-browser.ts` pattern).
 */

import { sumLinksOnClose, sumLinksOnOpen, sumLinksStart, wireSumLinks } from "./sum-links-client.ts";

Object.assign(globalThis, { sumLinksOnClose, sumLinksOnOpen, sumLinksStart });

wireSumLinks();
