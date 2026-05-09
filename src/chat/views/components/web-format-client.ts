import { makeBundledClientScript } from "../../../dashboard/views/components/bundle-browser-iife.ts";

export const webFormatClientScript = makeBundledClientScript(
  "web-format-browser.ts",
  import.meta.dir,
);
