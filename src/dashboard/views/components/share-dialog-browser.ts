/// <reference lib="dom" />
/**
 * Browser ENTRYPOINT for the share dialog — the standalone bundle a page without
 * its own bundler can load.
 *
 * The publication happens HERE, in the entrypoint (the `web-format-browser.ts`
 * pattern), and `makeBundledClientScript` only wraps this file into an IIFE. That
 * keeps the DOM module itself importable: the /wiki reader's own bundle imports
 * `openShareDialog` directly and never loads this script, while `/summaries` —
 * which composes template-string scripts in one page scope and has no import — will
 * load this and call the global.
 *
 * **A page uses exactly ONE of those two routes.** Doing both would put two copies
 * of the module in one page: two `state` objects, two document listener sets, and
 * a dialog whose halves disagree about which one is open.
 */

import { openShareDialog, closeShareDialog } from "./share-dialog.ts";

Object.assign(globalThis, { openShareDialog, closeShareDialog });
