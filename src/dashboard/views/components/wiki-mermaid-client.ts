import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const wikiMermaidClientScript = makeBundledClientScript(
  "wiki-mermaid-browser.ts",
  import.meta.dir,
);
