import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const gardenerClientScript = makeBundledClientScript(
  "wiki-gardener-browser.ts",
  import.meta.dir,
);
