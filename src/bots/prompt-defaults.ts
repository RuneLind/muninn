/**
 * The two prompt-variant constants, in a LEAF module of their own.
 *
 * Why they don't live in `bots/config.ts` with the loader that uses them: the
 * share preset layer (`src/share/presets.ts`) needs the same literals, and its
 * whole contract is "pure + IO-free". Importing them as VALUES from `config.ts`
 * pulled `node:fs` — and behind it the db and hivemind graph — into every module
 * that touched a preset, taking the import from ~2ms to ~20ms while the header
 * still claimed no filesystem. Same dependency argument that made the share body
 * prep fork its own component-tag strip instead of reusing `wiki/similar.ts`.
 *
 * `config.ts` re-exports both names, so existing importers are unaffected and the
 * loader and the picker still share ONE spelling of `"default"` — the loader
 * refuses `share.default.md`/`jiraAnalysis.default.md` precisely because these
 * entries own that id, and the two must never drift apart.
 *
 * Nothing may be added here that imports anything: the point is that this file
 * has no dependencies at all.
 */

/** Synthetic variant that maps back to a bare `<key>.md` prompt. Reserved as a
 *  variant id so a `<key>.default.md` file can't collide with it. */
export const DEFAULT_VARIANT_ID = "default";

/** Picker label for the synthetic default entry. */
export const DEFAULT_VARIANT_LABEL = "Standard";
