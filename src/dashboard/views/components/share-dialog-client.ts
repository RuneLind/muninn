import { makeBundledClientScript } from "./bundle-browser-iife.ts";

/**
 * The standalone share-dialog bundle (publishes `openShareDialog` on
 * `globalThis`). For pages that cannot import — `/summaries` in PR C.
 *
 * The /wiki reader deliberately does NOT use this: its bundle (entry
 * `wiki-shell-client.ts`) imports the module directly through `wiki-browser.ts`,
 * and loading both would give that page two module states.
 */
export const shareDialogClientScript = makeBundledClientScript(
  "share-dialog-browser.ts",
  import.meta.dir,
);
