/**
 * The reader under `MUNINN_PROFILE=nais`, where only the `wiki-read` route
 * group is registered (`src/dashboard/route-groups.ts`).
 *
 * A dropped group takes its HTML surface with it: every control that would
 * reach a route with no handler (Hono 404) is HIDDEN rather than dimmed the way
 * a read-only root does. The one signal is the `<body>` class
 * {@link WIKI_READ_SLICE_CLASS}, stamped by the server. Three layers read it —
 * this is the index of all three:
 *
 *  1. **CSS** — {@link WIKI_READ_SLICE_HIDDEN_SELECTOR}, scoped to the class by
 *     {@link wikiReadSliceStyles}. CSS survives the re-renders that replace the
 *     breadcrumb, the answer pane and the rail.
 *  2. **Client guards** — {@link wikiToolsFlag} reads the same class; the
 *     reader (`wiki-browser.ts`) uses it to skip the fetches whose panels are
 *     hidden (index coverage, the start cards, Similar), to leave the Atlas tab
 *     out and to keep the rail on Connections ({@link readSliceStartTab}).
 *  3. **Server omissions** — `renderWikiPage({ tools: false })`
 *     (`views/wiki-page.ts`) renders no agent-presence chip, withholds the host
 *     path from `window.__WIKI_ROOT__`, and the `/wiki` route resolves no ask
 *     bot and no gardener badge (`registerWikiReadRoutes`).
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

/** Is the full wiki tool surface registered? False exactly when `<body>`
 *  carries {@link WIKI_READ_SLICE_CLASS} — the one signal the CSS reads too.
 *  No document (a unit test, the server) is the default instance. */
export function wikiToolsFlag(doc: unknown = (globalThis as { document?: unknown }).document): boolean {
  const body = (doc as { body?: { classList?: { contains(c: string): boolean } } } | undefined)?.body;
  return !body?.classList?.contains(WIKI_READ_SLICE_CLASS);
}

/** The overview tab to show: Atlas fetches `/api/wiki/atlas`, which the read
 *  slice does not register, so a stored or linked `view=atlas` lands on Hubs. */
export function readSliceStartTab<T extends string>(tab: T, tools: boolean): T | "hubs" {
  return !tools && tab === "atlas" ? "hubs" : tab;
}
