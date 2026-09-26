import { makeBundledClientScript } from "./bundle-browser-iife.ts";

/** The `/wiki/issues` board bundle — `wiki-board-browser.ts` wrapped as an
 *  IIFE and memoized, the `helpers-client.ts` pattern. */
export const boardClientScript = makeBundledClientScript("wiki-board-browser.ts", import.meta.dir);
