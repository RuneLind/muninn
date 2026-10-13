# Share

<!-- moved out of the root CLAUDE.md by /doctor on 2026-10-13 -->

Path: `src/share/`

Turning one source document into a pasteable post. `presets.ts` (shipped preset set + per-bot `prompts/share*.md` merge; `findSharePreset` returns **undefined** on an unknown id so the route can 400 rather than generate with the wrong instruction), `body-prep.ts` (on-disk → prose, one preparer per kind, `SHARE_BODY_MAX` 24k), `prompt.ts` (instruction → **language rider** → extra → fenced source; `SHARE_EXCLUDED_TOOLS` = the WebSearch/WebFetch half of the fence) and `wire.ts` (langs, the two text caps, `SLACK_PASTE_MAX`, the `done` payload type — dependency-free, so the browser dialog can import it). Consumed by `POST /api/wiki/share` (`routes/share-sse.ts` + the dialog in `views/components/share-dialog.ts`); see the share section of `src/wiki/CLAUDE.md`.
