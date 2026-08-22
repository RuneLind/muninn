/// <reference lib="dom" />
/**
 * Browser ENTRYPOINT for `/jira`. Bundled by `Bun.build` (see
 * `jira-composer-client.ts`) and injected as an IIFE into the page.
 *
 * The page ships an empty three-column shell and this mounts into it — unlike
 * `/plans`, there is no embedded payload to read: everything the composer shows
 * is either typed by the reader or fetched from a route (`/api/jira/templates`,
 * `GET /api/jira/draft/:id`), and the page renders no numbers of its own that a
 * no-JavaScript reader could check.
 */

import { mountJiraComposer } from "./jira-composer.ts";

function start(): void {
  if (!document.getElementById("jcRoot")) return;
  mountJiraComposer();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
