import { getLog } from "../../../logging.ts";
import { makeBundledClientScript } from "./bundle-browser-iife.ts";

// Minified: served as its own content-hashed, immutable asset
// (`getWikiAssets` in `../wiki-page.ts`), not inlined into the page.
export const wikiClientScript = makeBundledClientScript("wiki-shell-client.ts", import.meta.dir, { minify: true });

/** True when the server runs under `bun --watch` (`bun run dev`). */
export function underWatch(argv: readonly string[] = process.execArgv): boolean {
  return argv.includes("--watch") || argv.includes("--hot");
}

// Under `--watch` only, load the reader shell into the server's module graph,
// so the watcher restarts on an edit to any reader file (architecture review
// F23). Importing it runs nothing: `boot()` runs only in the browser entry. Not
// awaited and caught: a reader file that throws at import is logged, never
// stops the server, and the restart after its fix loads it again. Without
// `--watch` (`bun run start`, the pod) the server never loads the reader.
if (underWatch()) {
  import("./wiki-browser.ts").catch((err: unknown) => {
    getLog("dashboard", "wiki-client").warn("The /wiki reader failed to load on the server for --watch: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
