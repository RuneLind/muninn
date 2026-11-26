/**
 * Every render sentinel's marker name: the `<NAME>` in a `\x00<NAME><n>\x01`
 * placeholder ({@link Placeholders} in `markdown-core.ts`) or in a caller's
 * `\x00<NAME><n>\x00`. Unrestored, the NUL backstop leaves `<NAME><n>` in the
 * page, which the F58 guard (`src/wiki/attribute-values.test.ts`) scans for.
 * `sentinel-names.test.ts` fails on a producer in `src/` whose name is missing
 * here, so a new sentinel kind joins this list.
 */

/** The markers formatters pass to `Placeholders.add`. */
export const PLACEHOLDER_MARKERS = ["INLINECMP", "INLINE", "LINKOPEN", "LINKCLOSE", "LINK", "SLINK", "STARRUN"] as const;
export type PlaceholderMarker = (typeof PLACEHOLDER_MARKERS)[number];

/** A caller's own `\x00<NAME><n>\x00` sentinels: fenced code (`CB`), the
 *  reader's wikilinks, key marks and diagram pictures, the Ask tab's citations
 *  and the case-dots view. */
export const PARKED_SENTINEL_NAMES = ["WIKIPAGELINK", "WIKIKEYOPEN", "WIKIKEYCLOSE", "ASKCITE", "CASEDOTS", "DGMPIC", "CB"] as const;

export const SENTINEL_NAMES: readonly string[] = [...PLACEHOLDER_MARKERS, ...PARKED_SENTINEL_NAMES];
