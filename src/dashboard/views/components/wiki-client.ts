import { makeBundledClientScript } from "./bundle-browser-iife.ts";

// Minified: served as its own content-hashed, immutable asset
// (`getWikiAssets` in `../wiki-page.ts`), not inlined into the page.
export const wikiClientScript = makeBundledClientScript("wiki-shell-client.ts", import.meta.dir, { minify: true });
