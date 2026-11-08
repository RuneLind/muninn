# Dashboard Module

## Reading the notes

`src/dashboard/reference/notes.md` holds this folder's detail and is **not loaded automatically**. Rules and traps that apply to one function stay in its section there: ` [trap]` on an index line below sends you to that section before you edit that code.

- **Search it this way, never plain:** `rg -n -o '.{0,120}<term>.{0,120}' src/dashboard/reference/notes.md`. With the Grep tool: `output_mode: content`, `-o`, the same pattern and that path. Lines are long, 31 of them over 500 bytes (measured 2026-11-03, as is every count here): plain `rg` prints each whole line (one hit can cost tens of thousands of chars) and plain Grep returns "Omitted long matching line". Keep the window at 120 chars or less. Do not use `grep -o` here: in a Claude Code shell it returns nothing for this pattern and exits 1, which reads as no note.
- **Before editing a file:** search its basename, such as `wiki-routes.ts`, and the functions you are changing: `tools-routes.ts` never hits the leak warning that `disconnectServer` hits.
- **To look up a topic:** find its heading in the index and search a few plain words of it, never the whole heading: parens and brackets are regex metacharacters, and 5 of the 14 headings match nothing verbatim. 89% of the file sits under `Route Organization`, so most topics are bold lead-ins inside its table rows: search plain words for those too.
- **No hit:** zero hits on a basename means no note under that name, not no rule. Search the file's exported function names, then the index, then the neighbouring module's `notes.md`, or its `CLAUDE.md` where it has none; `rg -l <term> src -g '{CLAUDE,notes}.md'` (or the Grep equivalent) finds which. 20 of the 60 non-test `src/dashboard/routes/*.ts` files have no hit here, and 15 of those have their notes in another module's file, 7 of them in `src/wiki`'s.
- **To read a hit's line:** `Read` it whole only under about 5,000 chars: `sed -n '<N>p' src/dashboard/reference/notes.md | wc -c` tells you. 9 lines are longer (line 25 is 68k). `Read` refuses only line 25 and dumps the rest whole, so send a longer line to a scratch file first, from the repo root and with the file's full path. A bare `notes.md` prints a valid path to an empty file and exits 0:

```bash
t=$(mktemp); sed -n '<N>p' src/dashboard/reference/notes.md | fold -s -w 2000 > "$t"; echo "$t"
```

  Then `rg -n -o '.{0,120}<term>.{0,120}' <printed path>` finds the fold line to `Read` with offset and limit; a later Bash call has lost `$t`. Search one word or path: `fold -s` breaks only at spaces, so a phrase can split.
- **History:** `git log --follow -- src/dashboard/reference/notes.md` reaches the old file's commits.

## Rules

- A component exports only the parts it has (`*Styles`, `*Html`, `*Script`); a page imports and concatenates the ones that exist.
- A file the bundled client imports lands in the browser bundle with whatever it uses, and a green build does not prove it runs. Keep it free of npm packages (`postgres` fails the build), of Node builtins other than the bundled `node:path` (`node:fs` builds, then throws when called), of `Bun.*` and `process` (build, then throw when the line runs, at load if top-level; Bun inlines `process.env.NODE_ENV`, and a guarded `globalThis.Bun?.` read does not throw) and of `getLog()` in any reachable code (about 38k chars of logtape). A file on the server side is fine if it is import-safe: `wiki-chat-target.ts` imports `deriveAskThreadTitle` from the dependency-free `src/wiki/ask-chat.ts`. Other examples: `src/wiki/core/wiki-integrate.ts`, `src/jira/wire.ts`.
- A view does not import the routes factory: that would be a cycle, which is why the route groups have their own module, `route-groups.ts`.
- A POST+SSE route returns every body check as a plain JSON 400 before `streamSSE` commits a 200: after that, a validation failure can only be an `app_error` no client can tell from a model failure.
- The overview routes `/api/attention`, `/api/agents/overview`, `/api/indexing/overview`, `/api/models/overview` and `/api/sync/status` answer a degraded source through `errors[]`, not a 5xx. The catch is per source, so a throw outside it is still a 5xx: `assembleModelsOverview` itself, `getSyncRepos()`.
- A new plain-JSON wiki write route wraps its whole body, as `POST /api/wiki/remember` and `POST /api/wiki/factcheck/append` do, so an unexpected failure logs and returns 500 JSON. Nothing does that for it: there is no `app.onError`, and an unwrapped throw answers `500 text/plain`.
- In new code, run `isValidUuid` before a caller's id reaches a uuid-column `WHERE`, which would otherwise 500.
- A document deep link is `/search/document/<collection>/<encodeURIComponent(id)>`: the id segment is always encoded, because real ids carry `/`, spaces, `#` and non-ASCII, and naive interpolation truncates at `#`.
- Text on an `--accent`/`--accent-hover` fill is `var(--on-accent)` or `var(--on-accent-primary)`, never a literal `#fff`: Reading draws dark ink there.
- A badge that is a dark island in both bases takes an `--island-*` token, not a `--tint-*`: the tints are pale in light.
- A page sized against the header writes `calc(100vh - var(--header-h, <px>))`: the hidden state sets `--header-h` to 0.
- An SVG takes its theme colours from CSS classes, the house style (`fill: var(--x)` in a rule). No file here writes `var()` in a `fill=` or `stroke=` attribute.

## Traps

- ⚠️ **Hand-written SSE framing:** `stream.writeSSE({event, data})` frames an event itself. Only a hand-written write has to end each event in a double newline (`data: JSON\n\n`); a missing one breaks the stream.
- ⚠️ **A non-200 ends an `EventSource` for good:** it goes to `readyState` 2 and never retries.
- ⚠️ **An undefined CSS token fails silently:** `.wiki-chatopt` once used `var(--bg-elevated, var(--bg-secondary))`, neither defined on `/wiki` then, so the declaration was invalid and the dialog rendered fully transparent. Today on `/wiki`, `--bg-secondary` is still never defined, and `--bg-elevated` is missing under the explicit Light and Dark themes only (`palettes.ts` sets it for the System theme and every palette). Check a token in every theme.
- ⚠️ `views/components/wiki-browser.ts` runs nothing at import: load-time code goes in `boot()`, in its source order (listener order is load-bearing, pinned in `wiki-shell-boot.test.ts`). Its controllers (`wiki-rail-controller.ts`, `wiki-stale-controller.ts`, `wiki-effort-controller.ts`, `wiki-menus-controller.ts`, `wiki-ask-controller.ts`, `wiki-article-controller.ts`, `wiki-series-controller.ts`) never import it: shell state and functions reach them through a port (a `*Deps`, the Ask tab's `AskTurnPort`, the article tools' `ArticlePort` or the series editor's `SeriesPort`). A `let` written by exactly one module stays in it and other modules read it through a port getter (shell-owned) or an exported getter (controller-owned); a `let` written by two or more modules lives in `wiki-shell-state.ts`; `const` objects mutated in place (`filters`, `pagesRefresh`) may cross by reference. A module writes a `let` when it assigns it, directly or through an exported setter (`setCurrentName`); a controller command that assigns its own `let` for a caller (`toggleRailFold`, `resetStaleRailPainted`, `staleFollowShownPage`) is the owner writing. A controller imports another directly when that adds no cycle (the ⋯ menus import the rail's accessors); otherwise the shell relays it through the importer's port, as `RailDeps` relays the effort, stale and ⋯ menus controllers' exports, since each of those imports `renderList` from the rail.

## Index

` [trap]` marks a section that records a failure or hazard; an unmarked section can still hold a rule, so search before you edit.

- File Overview [trap]
- Route Organization [trap]
- View System
- Component Pattern
- Shared Infrastructure [trap]
- Pages
- Real-Time Updates
- SSE Endpoints (sse-routes.ts)
- Agent Status (`src/observability/agent-status.ts`) [trap]
- Activity Log (`src/observability/activity-log.ts`)
- MCP Debug Client (`src/ai/mcp-tool-caller.ts`)
- Common Pitfalls [trap]
- The `Jira composer` entry from the root `CLAUDE.md` module table [trap]
- Corrective Retrieval (Path D, in huginn) — from the root `CLAUDE.md`
