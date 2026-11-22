import { makeBundledClientScript } from "./bundle-browser-iife.ts";
// A value import of the shell, so the server's module graph holds every reader
// file and `bun --watch` restarts on a client-only edit (architecture review
// F23). Importing it runs nothing: `boot()` runs only in the browser entry.
import { boot } from "./wiki-browser.ts";

// Minified: served as its own content-hashed, immutable asset
// (`getWikiAssets` in `../wiki-page.ts`), not inlined into the page.
export const wikiClientScript = makeBundledClientScript("wiki-shell-client.ts", import.meta.dir, { minify: true });
/** The browser entry's `boot`, referenced so the import above is kept: Bun drops an import nothing reads. */
export const wikiShellBoot: () => unknown = boot;
