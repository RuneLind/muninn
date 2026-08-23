import { makeBundledClientScript } from "../../../dashboard/views/components/bundle-browser-iife.ts";

export const jiraCardClientScript = makeBundledClientScript(
  "jira-card-browser.ts",
  import.meta.dir,
);
