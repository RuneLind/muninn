import { makeBundledClientScript } from "./bundle-browser-iife.ts";

/**
 * The standalone share-dialog bundle (publishes `openShareDialog` on
 * `globalThis`). For pages that cannot import — `/summaries` in PR C.
 *
 * The /wiki reader deliberately does NOT use this: `wiki-browser.ts` is itself a
 * bundle and imports the module directly, and loading both would give that page
 * two module states. See the entrypoint's header.
 */
export const shareDialogClientScript = makeBundledClientScript(
  "share-dialog-browser.ts",
  import.meta.dir,
);
