import { makeBundledClientScript } from "./bundle-browser-iife.ts";

/** The `/jira` composer bundle — `jira-composer-browser.ts` wrapped as an IIFE
 *  and memoized, the `plan-board-client.ts` pattern.
 *
 *  NB the memoization: `bun --watch` never sees `jira-composer-browser.ts`
 *  (it is named as a STRING, not imported), so editing the browser half in a dev
 *  session neither restarts the process nor busts this cache. Restart `bun run
 *  dev` after a client change. */
export const jiraComposerClientScript = makeBundledClientScript(
  "jira-composer-browser.ts",
  import.meta.dir,
);
