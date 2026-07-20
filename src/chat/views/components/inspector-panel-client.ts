import { makeBundledClientScript } from "../../../dashboard/views/components/bundle-browser-iife.ts";

export const inspectorPanelClientScript = makeBundledClientScript(
  "inspector-panel-browser.ts",
  import.meta.dir,
);
