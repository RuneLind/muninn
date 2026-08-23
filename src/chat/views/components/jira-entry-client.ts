import { makeBundledClientScript } from "../../../dashboard/views/components/bundle-browser-iife.ts";

export const jiraEntryClientScript = makeBundledClientScript(
  "jira-entry-browser.ts",
  import.meta.dir,
);
