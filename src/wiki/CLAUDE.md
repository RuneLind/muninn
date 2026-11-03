# Wiki: rules, traps and an index

Detail lives in `src/wiki/reference/notes.md`, which Claude Code does not load automatically. Rules and traps that apply to one function stay there, in that function's section.

How to reach it (measured 2026-11-03):

- **Search it this way, never plain:** `rg -n -o '.{0,120}<term>.{0,120}' src/wiki/reference/notes.md`. With the Grep tool: `output_mode: content`, `-o`, the same pattern and that path. Lines are long: plain `rg` prints each whole line and plain Grep returns "Omitted long matching line". Do not use `grep -o` here: in a Claude Code shell it returns nothing for this pattern and exits 1, which reads as no note. Keep the window at 120 chars or less.
- **Before editing a file:** search its basename and the exported functions you are changing. **To look up a topic:** find its heading in the index and search a few plain words of it, never the whole heading: parens and brackets are regex metacharacters, and 63 of the 73 headings match nothing verbatim.
- **No hit:** zero hits on a basename means no note under that name, not no rule: 26 of the 118 non-test `src/wiki/**/*.ts` have none, among them the main write seam `page-write.ts`, while `writeWikiPage` hits 12 lines. Search the exported function names, then the index, then the neighbouring module's `notes.md`, or its `CLAUDE.md` where it has none; `rg -l <term> src -g '{CLAUDE,notes}.md'` finds which.
- **Read a hit:** `Read` from the hit's line with a limit of about 30 lines, not the whole section: sections run up to 70k chars. A line over about 5,000 chars goes to a scratch file first, then `Read` that file with offset and limit. Write the file's full path: from the repo root a bare `notes.md` prints a valid path to an empty file and exits 0.

  ```bash
  t=$(mktemp); sed -n '<N>p' src/wiki/reference/notes.md | fold -w 2000 > "$t"; echo "$t"
  ```

- **History:** `git log --follow -- src/wiki/reference/notes.md` reaches the old file's commits.

## Rules

Writing to a wiki:

- Anything writing to a wiki joins the per-wiki write queue (`runWikiWriteExclusive`, `queue.ts`, realpath-keyed on the root), with the queued section spanning read→CAS→write→`log.md`. `log.md` is wiki-global, so every read-modify-writer of it serializes on this one chain. The bucket mirror stays out: it is its root's only writer.
- The commit tail runs OUTSIDE the queue: push is bounded only by `GIT_NETWORK_TIMEOUT_MS` (60 s), and an unreachable origin would otherwise park every writer for that minute.
- Two locks, in this order: the in-process queue first, the file lock (`.wiki-write.lock`) inside it, released before the section returns. The file lock outside the queue is a deadlock shape, not a wait.
- Joining both queues, the commit queue (`runExclusiveQueued`) comes first and the per-wiki write queue second, with network I/O outside both, so a hung push can never park a page write.
- A file `writeWikiPage` cannot carry (its path confinement admits `.md`/`.mdx` only) repeats the guard and the per-wiki queue rather than routing around them: `plans/queue.yaml` the sha256 CAS too, `.work-map.json` the file lock.
- Every programmatic writer passes `refresh: true` to `getWikiIndex` after it lands.
- A burst of metadata writes uses no-log mode (`logKind: null`): one log line each would bury `log.md`, and each reindex would re-embed a page whose prose never moved.
- Name a new `PageWriteOutcome` variant in every route that maps it: those are `if` chains whose fall-through is success, so an unnamed variant reports a write that never happened.
- At a 409 the body's `locked` flag decides, never the status: `locked` is a retry, a stale page is a reload.
- muninn never writes the four provenance keys (`sessions:`, `sessions_backfilled:`, `jira:`, `prs:`). Their one line-upsert lives in claude-usage, and the Stamp route shells out to its CLI rather than growing a second writer: two writers of one frontmatter line lose each other's appends.
- Any other frontmatter write goes through muninn's one line-upsert, `setFrontmatterScalar` (`src/plans/frontmatter.ts`).
- A commit seam stages exactly the touched files, on the default branch only. Its failures warn and never block the write, and it never runs clean, checkout, restore or reset.
- Every wiki `git status` prefixes `STATUS_READONLY_ARGS` (`--no-optional-locks`) and lists with `--porcelain -z -uall`: a plain status takes `.git/index.lock` from an unlocked read path, and the sync loop's `git add` then exits 128.
- Only a stale-fix commit may carry a `[stale-check] ` subject (`STALE_CHECK_COMMIT_PREFIX`): the commit becomes invisible to `gitTouchedMs` and the changed-page rule, so a hand edit under it is hidden.
- A spawned Bun child passes `--no-env-file` and an allowlisted env: without the flag Bun reloads muninn's `.env` from its working directory, and every secret the allowlist left out comes back.
- Code enumerating a wiki's dirty files skips `.wiki-write.lock` and `.wiki-stamp.*.tmp` through `isWikiWriteArtifact`: the lock is taken on every registered root, and not every root's `.gitignore` names them.
- A lint check writes nothing: `lintWiki(index, deps)` stays pure and a `fix` is a payload. What turns it into rows, and what happens on Accept, is `src/gardener/CLAUDE.md`.
- The queue's full rationale is in `src/gardener/CLAUDE.md`, and the sync loop's locking and deferral contract in `src/sync/CLAUDE.md`, stated once.

Read-only, two independent switches, neither implying the other:

- `MUNINN_WIKI_READONLY` is the instance (`isWikiReadonly()`), and forbids page content writes. `WIKI_READONLY_ROOTS` is one root (`isReadonlyWikiRoot(root)`), and forbids those plus every model call, web reach and chat seed on it. `SCHEDULER_ENABLED=false` is no substitute: every dashboard route stays registered.
- A content-write seam takes an injectable `isReadonly` defaulting to `isWikiReadonly()` and returns `forbidden` before it opens anything, so a call site added later is guarded by default.
- A refusal is 403 with `{error, readonly: true}`, never collapsed into the generic `error`: a refusal is not a failure.
- A mutation route refuses as its FIRST statement (`readonlyRefusal`) and `log.info`s the refusal with its route path.
- A `?wiki=`-steerable route that spends a model call on page content or ships it off the machine carries the per-wiki prologue (`egressRefusal`) immediately after the entry resolves and BEFORE bot resolution, the index read, the DB thread, the `/agents` run registration and the one-shot. It keys on the resolved ROOT, entry or no entry.
- Non-HTTP surfaces carry the same check, since a scheduled run spends exactly what a route would. A wiki-drafting watcher type joins `WIKI_DRAFTING_WATCHER_TYPES`, which both guards read.
- Neither switch gates git: `commitWikiChange` and the `wiki-committer` stay open, or the repo-sync loop stops on the read-only instance.
- Enforcement never reads `WikiRegistryEntry.readonly`: that flag is for the client half and the `/models` card, and a stale memo must not be able to open the guard.
- A write guard lives in the environment, never in `.wiki-reader.json`: that file degrades to `null`, which for a guard means writable. The file carries cosmetics, the environment carries safety.
- Compare roots through `sameWikiRoot`, never a re-spelling. Matching is root-exact, never a prefix: a wiki at a subdirectory of a listed root is NOT covered, so list each root you mean.
- A root muninn should only READ must ALSO be listed in `WIKI_READONLY_ROOTS`: registration alone makes it writable and model-reachable over HTTP.
- A refusal's copy never names a filesystem path: it lands verbatim in a 403 body on a reader-facing API.
- In the client, a write control joins `WIKI_READONLY_BLOCKED_SELECTOR` and an egress control `WIKI_READONLY_EGRESS_SELECTOR`, by the SAME attributes its delegated handler keys on. Folding egress ids into the shared list would dim Share and Fact check on a read-only instance, where the server serves both. A control activated from `mousedown` or the keyboard also joins `WIKI_READONLY_MOUSEDOWN_SELECTOR` or `WIKI_READONLY_KEYDOWN_SELECTOR`: a mousedown delegate fires BEFORE `click` and has already spent the call.
- State the refusal with the body class, not a per-render `disabled` sweep: the gardener strip and the answer pane replace their innerHTML on every poll or SSE event, so state written into a button is gone by the next paint.

Pages and routes:

- Every page-scoped action takes `relPath` and resolves through `resolvePageRef` (relPath first, the stem name as the fallback, and only onto an unambiguous stem): `index.resolve(name)` is first-registration-wins, and a name-keyed action wrote into another page with the same stem.
- One path spelling: every site that stores a page path or compares two goes through `normalizeRel`, and the server's work keys through `normalizeWorkedPath`. A key looked up against the listing uses its `relPath` spelling, never the lowercased `normalizeRelPath`, which zeroes the match on any path with a capital.
- Every row emitter carries `data-relpath` beside `data-page`, and relPaths are stored, never names: a name resolves to whichever same-stem page registered first.
- `displayTitle` is a second field, never a rewrite of `title`, which decides what a `[[wikilink]]` resolves to, the H1 strip and the Similar query. Whatever shows a page in a list goes through `displayTitleOf`.
- Rank and date a page through `pageAddedMs`/`pageTimeMs`, never raw `mtimeMs`/`gitCreatedMs`: a mechanical pass moves every mtime in the wiki.
- `work` moves ORDER and placement only, never series identity: `seriesDateSignal`, heads, `lint-series.ts` and Related's identity never read it.
- Every consumer that ranks or targets pages reads `culled`. The series census deliberately includes culled pages: a culled member can be the series head and name the fold.
- Fold keys are one flat namespace: a bare relPath is that page's attachment group, a card is `thread:<key>`, and each spelling means one thing.
- `link` and `mention` are demoted: a new count reads `relationsCount`, `DEMOTED_RELATIONS` or `facetJiraKeys`, never `meta.issues` directly, which still holds demoted keys.
- An unknown cost never renders as `$0`: an unpriced key shows as unknown, since `$0.00` says it was free.
- The browser never calls huginn or claude-usage (tailnet viewers, mixed content under `tailscale serve`): the server computes the field and ships it.
- A POST+SSE route returns every body check as a plain JSON 400 BEFORE `streamSSE`: after that commits a 200, the only way to report a bad request is an `app_error` nothing can tell from a model failure.
- On the pod's read slice, a background fetch from the index build gates on `wikiToolsRegistered`: the service it would dial is on another machine's loopback. An owner-derived listing field is never served there (`includeWaits`: a count would tell a reader which group the owner is in), and a personal one is hidden (`movesYou`: every colleague would read it as waiting on them).
- A field left on `toListing`'s rest spread goes to every caller unless stripped and opted in. A new reader control that calls a tool-half route joins `WIKI_READ_SLICE_HIDDEN_SELECTOR`: on the pod that route has no handler.
- Run the suite from the repo root on a host whose `.env` carries `MUNINN_WIKI_READONLY`: the bunfig preload that clears it resolves against the CWD and is ignored silently when it cannot. From a subdirectory, pass `bun test --preload ../test/preload.ts`.

## Traps

- ⚠️ The fence on `.wiki-write.lock` is one-sided: `wiki-stamp` writes an empty lockfile and unlinks unconditionally, so it can drop a lock muninn holds once that lock has aged past `WIKI_LOCK_STALE_MS` (10 s). The Stamp route makes that reader-triggerable.
- ⚠️ `WIKI_STAMP_ROOTS` (claude-usage) and muninn's registered roots must name the SAME directories. The lock is per root: for a wiki at a strict subdirectory of a stamp root, the stamper locks the parent, muninn locks the child, and both writes proceed.
- ⚠️ A DIRTY page's mtime is trusted, so a mechanical frontmatter write can make every page it touches read as edited minutes ago. `buildWikiGitDates` drops a tracked, modified page from `dirty` only when its `HEAD` blob compares `metadata-only` (only `METADATA_ONLY_FRONTMATTER_KEYS` lines differ) or `identical`: a differing key outside that set is an `edit`.
- ⚠️ The reader has THREE URL writers (`writeProjectParam`, the tab click's `replaceState(currentStartUrl())`, `goToStart`), and only the first keeps `location.hash`: a property fixed on one is not a property of the reader.
- ⚠️ `isMetaStem` is case-sensitive on `CLAUDE` alone. Feed it `pageStemOf`, which strips ANY extension: `wikiPageStem` strips only `.md`/`.mdx`, so `plans/index.html` passes as an ordinary page.
- ⚠️ A `display` declaration on a class beats the user agent's own `[hidden]` rule, green through every unit test and caught by the e2e: `.wiki-prov-chain[hidden] { display: none; }` rides beside its `display: flex`.
- `modalOpen()` reads every visible `[role="dialog"]` as a modal, so a non-modal panel with that role kills the reader's single-key shortcuts page-wide.
- `isPathConfined` is LEXICAL, so a symlink inside the wiki that points outside it passes: the Stamp route adds realpath containment for that reason.
- The older `fencedLineMask` and `frontmatterEndLine` (`wiki-integrate.ts`: a `~~~` fence counts, an unclosed opener runs to the end, an indented `---` ends the frontmatter) disagree with the reader's rule (`readerFencedLines`: backticks only, an unclosed opener stays prose; `frontmatterBodyLine`). The line-walking lint checks listed under Lint check 14 read the older one; checks 14 and 20 read the reader's.

## Index

` [trap]` marks a recorded failure, and an unmarked section can still hold a rule, so search before you edit.

- Registry (`registry.ts`) [trap]
- One nested frontmatter level (`parseFrontmatter`) [trap]
- Ask tab, Similar articles (`wikiCollections`)
- Ask → chat escalation (`ask-chat.ts`, `POST /api/wiki/ask/chat`, `GET /api/wiki/chat-target`) [trap]
- Synthesis-bot routing (`resolveWikiSynthesisBot`)
- Fact-check claim retry (`GET /api/wiki/factcheck/claim`) [trap]
- Waiting on you (`next-moves.ts`, `WikiPageMeta.movesYou`) [trap]
- Line-ref chips (`code-refs.ts`)
- Query files (`page-files.ts`) [trap]
- ⧉ Copy path (breadcrumb) [trap]
- ⇪ Felles — publish to melosys-felles (`felles-publish.ts`, `POST /api/wiki/felles-publish`, `GET /api/wiki/felles-status`) [trap]
- Sync: «Felles: N changed» (`felles-status.ts`) [trap]
- The page rail's recall aids (Activity · Pinned · Jira-key jump) [trap]
- Attachments — the rail's groups (`pairAttachments`, `store.ts`) [trap]
- In the rail [trap]
- The row's layout rules (`wiki-page.ts`, constants in `wiki-rail-width.ts`)
- Culled pages (`signal: none`, `WikiPageMeta.culled`)
- Families and months (`wiki-groups.ts`) [trap]
- Series (`series:` / `series_label:`, `groupSeries`) [trap]
- Worked-on recency (`worked-ledger.ts`, `workedMs`) [trap]
- Work sessions (`work-sessions.ts`, `work-focus.ts`, `work`) [trap]
- Lint check 8 — the series checks, and the only lint that proposes a fix [trap]
- Lint check 9 — report-page drift (`lint-drift.ts`)
- Lint check 11 — the top of a report page (`lint-report-top.ts`)
- Lint check 12 — role keys (`role-key`, in `lint.ts`)
- Lint check 13 — CaseBoard labels (`case-board-labels`, in `lint.ts`)
- Lint check 14 — state outside its home (`lint-state.ts`) [trap]
- Lint check 15 — component values and attributes (`lint-components.ts`) [trap]
- Lint check 16 — the decision chain (`lint-decision-chain.ts`)
- Lint check 17 — `<Chart>` tables (`lint-chart.ts`)
- Lint check 18 — `<RuleTree>` (`lint-rule-tree.ts`)
- Lint check 19 — `<Glossary>` (`lint-glossary.ts`)
- Lint check 20 — text drawings (`lint-text-diagram.ts`)
- Lint check 21 — `<Diagram>` pictures (`lint-diagram.ts`)
- Lint check 22 — `<Steps>` focus ids (`lint-steps.ts`)
- Lint check 23 — `<SystemMap>` (`lint-system-map.ts`)
- Lint check 24 — status lines (`stale.ts`)
- Lint check 25 — declared efforts (`effort-unknown`, in `lint.ts`)
- Lint check 26 — genre and its picture (`lint-genre.ts`)
- Decision chain route and dry run
- Stale check — free half (`stale.ts`, `GET /api/wiki/stale`, `scripts/wiki-stale.ts`)
- Stale check — model half (`stale-confirm.ts`, `wiki_stale_verdicts`, the STALE tab) [trap]
- Stale check — the counts everywhere (PR 2b: `wiki-stale-summary.ts`, `wiki-stale-marks.ts`)
- Stale check — the fix paths (PR 3: `stale-fix.ts`, `stale-fix-verdicts.ts`, Apply, Send to Gardener) [trap]
- Work map (`src/wiki/work-map/`, `.work-map.json`, `WORK_MAP_WIKIS`) [trap]
- Related work (`related.ts`, `prRefs`, the Connections panel's top block)
- `prRefs` — a derived index field [trap]
- The rule (`computeRelated`, pure) [trap]
- Rendering [trap]
- The neighbour rule and find (`strength.ts`, `session-refs.ts`, the `/` palette) [trap]
- Share (`POST /api/wiki/share`, `GET /api/wiki/share/presets`) [trap]
- Walk me through (`POST /api/wiki/walkthrough`) [trap]
- Provenance (`provenance.ts`, `provenance-service.ts`, `session-ledger.ts`, `lockfile.ts`) [trap]
- Tracker inference (`src/wiki/trackers/`, `.wiki-reader.json` `trackers`) [trap]
- Connections and Link (`trackers/rows.ts`, `trackers/jira-lookup.ts`, `views/components/wiki-issue-rows.ts`) [trap]
- Graph mode (`graph.ts`, `GET /api/wiki/graph`, `views/components/wiki-graph-view.ts`) [trap]
- Issue board (`/wiki/issues`, `graph-board.ts`, `views/components/wiki-board-view.ts`) [trap]
- The client (`views/components/wiki-provenance-view.ts`) [trap]
- Stamp (`POST /api/wiki/provenance/stamp`, `routes/wiki-stamp.ts`, `stamp-roots.ts`) [trap]
- The cross-process lockfile (`lockfile.ts`) [trap]
- Index single-flight (`getWikiIndex`, `store.ts`)
- Write queue (`queue.ts`)
- Readonly — two independent mechanisms (`readonly.ts`)
- The instance switch (`MUNINN_WIKI_READONLY`) [trap]
- The per-wiki switch (`WIKI_READONLY_ROOTS`) [trap]
- Client half [trap]
- Bucket mirror (`bucket-mirror.ts`, `WIKI_BUCKET_MIRRORS`) [trap]
- Repo sync loop (`src/sync/`, `SYNC_REPOS`, `POST /api/sync/run`) [trap]
- Auto-commit (`commit.ts`, `wikiAutoCommit`)
- `WIKI_DIR` — the full entry from the root `CLAUDE.md` env table
- `MUNINN_WIKI_READONLY` — the full entry from the root `CLAUDE.md` env table
- `WIKI_EXTRA` — the full entry from the root `CLAUDE.md` env table
- `WIKI_READONLY_ROOTS` — the full entry from the root `CLAUDE.md` env table [trap]
