# Dashboard Module

## Reading the notes

`src/dashboard/reference/notes.md` holds this folder's detail and is **not loaded automatically**. Rules and traps that apply to one function stay in its section there: ` [trap]` on an index line below sends you to that section before you edit that code.

- **Before editing a file:** Grep `notes.md` for the file's basename (such as `wiki-routes.ts`) with the `-o` pattern under "Long lines".
- **To look up a topic:** find its heading in the index and Grep for a few plain words of it, never the whole heading: parens and brackets are regex metacharacters, and 5 of the 14 headings match nothing verbatim (measured 2026-11-03). 89% of the file sits under `Route Organization`, so most topics are bold lead-ins inside its table rows: Grep plain words for those too. Then `Read` with offset and limit.
- **No hit:** zero hits on a basename means no note under that name, not no rule. 20 of the 60 non-test `src/dashboard/routes/*.ts` files have no hit in `notes.md`, and 15 of those have their notes in another module's file, 7 of them in `src/wiki`'s. So go to the index, then to the neighbouring module's `notes.md`, or its `CLAUDE.md` where it has no `notes.md`. Grep the path `src` with glob `{CLAUDE,notes}.md` and `output_mode: files_with_matches` to find which one.
- **Long lines:** 31 lines are over 500 bytes, and Claude Code's Grep tool runs ripgrep with `--max-columns 500`, so a plain search matching one returns "Omitted long matching line". Grep with `output_mode: content`, `-o` and a pattern such as `.{0,120}<term>.{0,120}` returns the text around each match. Keep the `-o` window at 120 chars or less: ripgrep counts its 500-column limit in bytes.
- **A line too long for `Read`** (line 25 is 68k chars) goes to a scratch file first, from the repo root and with the file's full path. A bare `notes.md` prints a valid path to an empty file and exits 0. Then `Read` that file with offset and limit:

```bash
t=$(mktemp); sed -n '<N>p' src/dashboard/reference/notes.md | fold -w 2000 > "$t"; echo "$t"
```

- **History:** `git log --follow -- src/dashboard/reference/notes.md` reaches the old file's commits.

## Rules

- A component exports only the parts it has (`*Styles`, `*Html`, `*Script`); a page imports and concatenates the ones that exist.
- The bundled client must not import a server module, which would drag that module's imports into the browser bundle. What both sides share lives in an import-safe file, such as `views/components/wiki-integrate.ts` or the dependency-free `src/jira/wire.ts`.
- A view does not import the routes factory: that would be a cycle, which is why the route groups have their own module, `route-groups.ts`.
- A POST+SSE route returns every body check as a plain JSON 400 before `streamSSE` commits a 200: after that, a validation failure can only be an `app_error` no client can tell from a model failure.
- An overview or status route (attention, agents, indexing, models, sync) never 5xxes: degraded sources land in `errors[]`.
- A POST landing on an in-flight run answers 409 `{state:"running"}` with a human-readable `error`, the family's single-flight convention: the card's toast reads that field.
- A plain-JSON wiki write route wraps its whole body, so an unexpected failure logs and returns 500 JSON, never an unhandled throw.
- Run `isValidUuid` before a uuid-column `WHERE` can 500.
- A document deep link is `/search/document/<collection>/<encodeURIComponent(id)>`: the id segment is always encoded, because real ids carry `/`, spaces, `#` and non-ASCII, and naive interpolation truncates at `#`.
- Text on an `--accent`/`--accent-hover` fill is `var(--on-accent)` or `var(--on-accent-primary)`, never a literal `#fff`: Reading draws dark ink there.
- A badge that is a dark island in both bases takes an `--island-*` token, not a `--tint-*`: the tints are pale in light.
- A page sized against the header writes `calc(100vh - var(--header-h, <px>))`: the hidden state sets `--header-h` to 0.

## Traps

- ⚠️ **SSE format:** events must be `data: JSON\n\n`; a missing double newline breaks the stream.
- ⚠️ **MCP connection cleanup:** always call `disconnectServer()` or `disconnectAll()`; leaked stdio processes stay alive.
- ⚠️ **A non-200 ends an `EventSource` for good:** it goes to `readyState` 2 and never retries.
- ⚠️ **An undefined CSS token fails silently:** `.wiki-chatopt` used `var(--bg-elevated, var(--bg-secondary))`, neither token is defined on `/wiki` (`--bg-elevated` lives only in `chat/views/components/chat-styles.ts`), so the declaration was invalid and the dialog rendered fully transparent.
- ⚠️ **SVG `fill=`/`stroke=` attributes never resolve `var()`:** make an SVG theme-aware through CSS classes.

## Index

- File Overview [trap]
- Route Organization [trap]
- View System
- Component Pattern
- Shared Infrastructure [trap]
- Pages [trap]
- Real-Time Updates
- SSE Endpoints (sse-routes.ts) [trap]
- Agent Status (`src/observability/agent-status.ts`)
- Activity Log (`src/observability/activity-log.ts`)
- MCP Debug Client (`src/ai/mcp-tool-caller.ts`)
- Common Pitfalls [trap]
- The `Jira composer` entry from the root `CLAUDE.md` module table [trap]
- Corrective Retrieval (Path D, in huginn) — from the root `CLAUDE.md`
