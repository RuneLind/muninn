/// <reference lib="dom" />
/**
 * Browser ENTRYPOINT for the `/summaries` ▶ Find on YouTube section — the
 * standalone bundle the page loads (the `sum-links-browser.ts` pattern).
 */

import { sumDiscoverOnClose, sumDiscoverOnOpen, sumDiscoverStart, wireSumDiscover } from "./sum-discover-client.ts";

Object.assign(globalThis, { sumDiscoverOnClose, sumDiscoverOnOpen, sumDiscoverStart });

wireSumDiscover();
