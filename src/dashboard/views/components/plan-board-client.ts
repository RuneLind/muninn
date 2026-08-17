import { makeBundledClientScript } from "./bundle-browser-iife.ts";

/** The `/plans` board bundle — `plan-board-browser.ts` wrapped as an IIFE and
 *  memoized, the `helpers-client.ts` pattern. */
export const planBoardClientScript = makeBundledClientScript(
  "plan-board-browser.ts",
  import.meta.dir,
);
