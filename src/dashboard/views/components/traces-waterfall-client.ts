import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const tracesWaterfallClientScript = makeBundledClientScript(
  "traces-waterfall-browser.ts",
  import.meta.dir,
);
