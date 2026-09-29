/**
 * The reader under `MUNINN_PROFILE=nais`, where only the `wiki-read` route
 * group is registered (`src/dashboard/route-groups.ts`).
 *
 * A dropped group takes its HTML surface with it: every control here would
 * reach a route with no handler (Hono 404), so the page HIDES them rather than
 * dimming them the way a read-only root does. The server stamps the class on
 * `<body>`; the selector is CSS, so it survives the re-renders that replace the
 * breadcrumb, the answer pane and the rail.
 */
import {
  WIKI_READONLY_BLOCKED_SELECTOR,
  WIKI_READONLY_EGRESS_SELECTOR,
} from "./wiki-readonly-client.ts";

/** The `<body>` class the server stamps when the tool surface is absent. */
export const WIKI_READ_SLICE_CLASS = "wiki-read-slice";

/**
 * Every control or panel that reaches a route outside the read slice.
 *
 * The two read-only lists cover the write and egress controls by the same
 * attributes their handlers key on. The rest are the surfaces a read-only ROOT
 * still shows, because on a normal instance their routes exist.
 */
export const WIKI_READ_SLICE_HIDDEN_SELECTOR = [
  WIKI_READONLY_BLOCKED_SELECTOR,
  WIKI_READONLY_EGRESS_SELECTOR,
  // The Ask tab, its collapsed-strip opener and its body: `/api/wiki/ask`.
  '[data-conntab="ask"]',
  '[data-pane-open="ask"]',
  "#askBody",
  // The issue board (`/wiki/issues`) and the gardener (`/wiki/gardener`).
  "#wikiBoardLink",
  ".wiki-gardener-icon",
  // Stamp on a provenance ghost row: `POST /api/wiki/provenance/stamp`.
  "[data-prov-stamp]",
  // The start view's What's new (digest) and Index (index-coverage, reindex)
  // cards, the rail's coverage footer and Similar: the client does not fetch
  // them under the read slice, and these stop an empty box from showing.
  "#wikiWhatsNew",
  "#wikiIndexCard",
  "#wikiCoverageFoot",
  "#wikiSimilar",
].join(",");

/** CSS for the hidden set. `!important` because several of these controls set
 *  `display` inline when a render shows them. */
export function wikiReadSliceStyles(): string {
  const scoped = WIKI_READ_SLICE_HIDDEN_SELECTOR.split(",")
    .map((sel) => `body.${WIKI_READ_SLICE_CLASS} ${sel.trim()}`)
    .join(",\n    ");
  return `
    ${scoped} { display: none !important; }`;
}

/** Is the full wiki tool surface registered? Reads `window.__WIKI_TOOLS__`,
 *  which the reader page injects; anything but an explicit `false` is the
 *  default instance, so a page that never set it keeps every panel. */
export function wikiToolsFlag(win: unknown = globalThis): boolean {
  return (win as { __WIKI_TOOLS__?: unknown })?.__WIKI_TOOLS__ !== false;
}

/** The overview tab to show: Atlas fetches `/api/wiki/atlas`, which the read
 *  slice does not register, so a stored or linked `view=atlas` lands on Hubs. */
export function readSliceStartTab<T extends string>(tab: T, tools: boolean): T | "hubs" {
  return !tools && tab === "atlas" ? "hubs" : tab;
}
