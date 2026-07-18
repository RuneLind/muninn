/// <reference lib="dom" />
/**
 * Browser entrypoint for the CodeTabs enhancer. Bundled by Bun.build()
 * (see code-tabs-client.ts) and injected as an IIFE into pages whose client JS
 * is a single inline `<script>` template literal (research-page.ts), where a
 * bare `import` can't reach the module.
 *
 * `enhanceCodeTabs` is attached to `globalThis` so the surrounding inline script
 * can call it by bare name — the same delivery pattern as wiki-mermaid-browser.ts.
 * The /wiki reader imports `enhanceCodeTabs` directly (its client is itself a
 * bundled module) and does NOT use this shim.
 */

import { enhanceCodeTabs } from "./code-tabs.ts";

Object.assign(globalThis, { enhanceCodeTabs });
