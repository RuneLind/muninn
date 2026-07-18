/// <reference lib="dom" />
/**
 * Browser entrypoint for the mermaid enhancer. Bundled by Bun.build()
 * (see wiki-mermaid-client.ts) and injected as an IIFE into pages whose client
 * JS is a single inline `<script>` template literal (research-page.ts), where a
 * bare `import` can't reach the module.
 *
 * `enhanceMermaid` is attached to `globalThis` so the surrounding inline script
 * can call it by bare name — the same delivery pattern as web-format-browser.ts.
 * The /wiki reader imports `enhanceMermaid` directly (its client is itself a
 * bundled module) and does NOT use this shim.
 */

import { enhanceMermaid } from "./wiki-mermaid.ts";

Object.assign(globalThis, { enhanceMermaid });
