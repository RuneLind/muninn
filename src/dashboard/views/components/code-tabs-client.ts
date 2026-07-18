import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const codeTabsClientScript = makeBundledClientScript(
  "code-tabs-browser.ts",
  import.meta.dir,
);
