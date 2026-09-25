# Wiki — Registry, Config Surface, Write Queue, Auto-Commit

## Registry (`registry.ts`)

Wikis come from two sources, matched case-insensitively, browsable at `/wiki?wiki=<name>` (legacy `?bot=<name>` accepted as alias):

- **Bot wikis** — per-bot `wikiDir` in `bots/<name>/config.json` (relative to the bot folder, same semantics as `.mcp.json` paths; resolved to absolute at discovery). Unset ⇒ the bot has no browsable wiki.
- **Standalone wikis** — `WIKI_EXTRA` env: comma-separated `name=path` pairs, with optional 3rd segment `=coll1+coll2` (Huginn collections backing the Ask tab — the standalone analogue of `wikiCollections`) and optional 4th segment `=botpin` (synthesis-bot pin — the standalone analogue of `wikiSynthesisBot`; bare bot name, charset excludes `+` so it's never confused with a collection list). `name=path==botpin` means no collections + pin. Paths may be absolute, `~`-prefixed (expanded to `$HOME`), or relative (resolved against the muninn repo root, same base as `WIKI_DIR`'s default); whitespace trimmed. Malformed pairs and names colliding with a bot-wiki name are warned and skipped.

Bare `/wiki` defaults to jarvis, or the `WIKI_DIR` env override (which shows a disabled "env override" picker state and claims no named wiki). Per-bot `wikiDir` and `?wiki=`/`?bot=` still take precedence over `WIKI_DIR`.

An optional **`.wiki-reader.json`** at the wiki root (`typeMap` folder→type + `typeLabels`) gives the wiki its own page-type ontology — e.g. mimir's `projects/`→subsystem, `plans/`→plan. Resolution: frontmatter `type:` → typeMap on first path segment → standard folder fallback → `note`. Read once per index build (5-min TTL); malformed ⇒ warn + ignore. No-config wikis keep the standard five types byte-identically.

An eighth key, **`activity`** (an object of eight optional numbers), tunes the page rail's **Activity** ranking for this wiki: `rows` (1–20, how many the section renders, and the only thing that cuts the list — measured 2026-09-13 over the full listings, mimir (528 pages), melosys-kode-wiki (396) and jarvis (1261) clear `ACTIVITY_MIN_SCORE` on about 120 / 46 / 202 rows, so the floor never binds at 20; they ask for 10, 6 and 6), `halfLifeNewDays`/`halfLifeChangedDays` (how fast a creation and a change fade), the four 0–100 knobs `agePenalty`/`hubPenalty`/`planBoost`/`changedWeight`, and **`workedGate`** (a whole number 0–100, default 60), a gate rather than a weight: when at least that percentage of the ranked `.md`/`.mdx` candidates (non-meta, clearing `ACTIVITY_MIN_SCORE` with substitution off) carry a `workedMs`, a covered page's change term decays on its worked-on date instead of its update stamp. Older or newer: an OLDER worked date demotes the page, reading the update past it as a bulk pass or a writer the ledger cannot see. The ledger is not complete — it records Edit/Write and the shell's write shapes (redirects, `tee`, `sed -i`, `mv`/`cp`, and since claude-usage #215 python-heredoc literal targets), the worked date is `max(w, b)`, and `b` reaches only pages that also have a write row — so this was measured before shipping: on 2026-09-23, 7 of mimir's 92 demotes were session edits the ledger missed (a `perl`/`bun -e`/loop-target or argv-target `python3 -` shell write, or a Codex session), none in the top 10 then — but a miss demotes a page at its freshest, when it matters most. A demotion also needs the update to predate the ledger's answer (`workedCoverage.asOfMs`, when muninn got the answer) by `WORKED_INGEST_SLACK_MS` (10 min), so a page edited since the memo refreshed keeps its update; no answer time, no demotion. The slack covers the laptop→mini push in its steady state (every minute), not a stalled push. The gate's `covered` count ignores the answer time. On an `added`-floor page the worked date must land over a day after the floor, and the gate counts such a page as covered only then. Below the gate the ranking is byte-identical to the pre-gate one. `workedGateFor` measures it once per payload over the whole listing (`setPagesData`), never over the rail's filtered rows, and reads `page.workedMs` directly — `workedSignal` falls back to the update signal and would count every page covered. Rows keep their `new`/`changed` kind; the `why` reads `worked on …` (or `worked just now`), plus `; update …: no session write on record, or a bulk pass` when a demotion set aside an update more than a day newer than the worked date and that moved the row. Absent ⇒ `DEFAULT_ACTIVITY_WEIGHTS` (`views/components/wiki-activity-rank.ts`), the numbers the prototype was tuned to over the real mimir listing. Same validate-warn-**degrade** shape as its siblings, one level finer: a knob whose value is not a finite number of the right magnitude is dropped ALONE and the rest of the block stands, so a typo costs one weight rather than the section; an unknown key warns, since it is invisible in every other way; and `rows` CLAMPS rather than drops, because "as many as you can" is unambiguous. The resolved set is always COMPLETE on `WikiReaderConfig.activity` and rides `/api/wiki/pages` as `activity`, so the browser — where the ranking runs — never has to MERGE anything; it re-runs the same `parseActivityWeights` over the resolved block (one validator, and an older or degraded server cannot put a bad number into the ranking) and takes the defaults whole when the field is absent.

A seventh key, **`project`** (an object, six optional sub-fields), is how a wiki says which PROJECT a page belongs to — the per-page `project` on `/api/wiki/pages` and the reader's Project facet. Resolved by the pure `resolveProject` (`store.ts`) in a fixed precedence, most-structural first, first rule that answers wins: **(1) `pathFolders`** (string[]) — under a declared first segment, the SECOND segment is the project, ≥3 segments only (a dated file sitting directly in the folder has a second segment too, and reading it as a project mints one facet value per file); **(2) `pageFolder`** (string) — the file stem of a direct child, the page-per-project folder; **(3) `filePrefixFolders`** (string[]) — the LONGEST *known* project that prefixes the file stem before a `-`, so an unknown prefix stays a filename rather than a new project; **(4) `frontmatter`** (string[]) — the first declared key carrying a value, a string or an array's first non-blank element, unguarded (an authored key IS the author saying so); **(5) `tagFallback`** (boolean) — the page's first tag, but ONLY when `aliases` names it or the known set holds the result; otherwise `undefined`, which is the honest answer for most of a wiki. **`aliases`** (short name → project) applies to rules 4 and 5 alone — the two whose input is authored free text, where a short form and the project name genuinely differ; rules 1–3 read directory names the filesystem already agrees on. **The KNOWN set is pageFolder stems ∪ every `pathFolders` project directory**, collected in a first pass over the scanned paths (before any page resolves: every rule reads the set — rules 3 and 5 as a GUARD that can reject, rules 1, 2 and 4 only to pick the spelling — so a page resolved mid-walk would answer differently depending on which read finished first); every lookup in it is **NFC+lowercase folded**, and **every rule ANSWERS with the known project's own spelling** — the first the sorted walk saw — where the set holds the name; when it does not, rules 1/2 answer the raw segment, rule 4 the alias's value, and rule 5 the alias's value only if the alias map names the tag, else `undefined` (rule 4 is unguarded by design; the two share one alias map, so a known value files under one bucket whichever rule carried it) — folding the test alone still splits the facet, one layer down: the page is admitted and then filed under the spelling it was written in. **Rules 3 and 5 are the two that need a known set** — a rule declaring `filePrefixFolders` or a `tagFallback` with no aliases while declaring neither `pageFolder` nor `pathFolders` can never match, and warns once naming the dead field. Same validate-warn-**degrade** shape as its siblings, per FIELD: a `project` that is not an object drops the whole rule; a wrong-typed sub-field warns and drops **only itself** (the six fields are independent rules, not one setting); list entries and alias keys/values are trimmed with blanks dropped (a blank alias value would ship a page a `project: ""` the facet cannot name), and an alias keyed `__proto__`/`constructor`/`prototype` is refused through that same warn — `map["__proto__"] = value` on a plain object hits the SETTER and creates no own key, so that entry would otherwise be dropped in silence; `constructor`/`prototype` DO assign as own keys and every read is `Object.hasOwn`-guarded, so they are refused as hygiene (an alias named after an object-model word is a typo, not a project), not as protection. Absent ⇒ every page `undefined` and the listing's `projects` map `{}`, byte-identical to a wiki that never declared one. Explainers resolve through the path rules and their `<meta name="keywords">` tags (which ARE that page's `tags`); they carry no frontmatter, so rule 4 never fires for them.

A third key, **`include`** (string[] of globs, relative to the root), scopes the SCAN itself: a page is kept when it matches ANY entry (union — an all-must-match rule has no useful spelling for "these two subtrees"). It exists for a root muninn does not own the layout of — `~/.claude/projects` holds 289 markdown files under per-project `memory/` dirs plus a *growing* pile of `<uuid>/session-memory/summary.md` and `tool-results/artifact-*.html` strays that would arrive as ten identically-named `summary` pages. Two mechanics matter: the config read was **moved AHEAD of the glob** (`buildWikiIndex`) — it depends on nothing but `root`, and after the glob it could not scope the glob — and the key follows the same validate-warn-**degrade** shape as `typeMap`/`typeLabels`, so a bad value ⇒ unscoped scan, never an offline wiki. That degrade is exactly why `include` may live in this file while the read-only guard may **not**: losing the config re-admits eleven cosmetic strays; losing a guard that lived here would silently make the root writable. Entries are normalized before use — trimmed, a leading `./` stripped (the scan matches wiki-relative paths carrying none, so `./x/**` matched nothing while looking correct), and BLANK entries dropped rather than invalidating the whole list, which is the loudest possible consequence for the quietest possible typo. Two warns: an `include` that matches ZERO files (an empty reader is indistinguishable from a missing directory), and — the one place the store needs to know a root is read-only — a `WIKI_READONLY_ROOTS` root whose EFFECTIVE glob list is empty. That second test is the effective list, not the presence of the file: `{}`, `[]`, a wrong-typed `"include": "x"` and a list of blanks all leave the scan just as unscoped, and measured, a `{}` config silently re-admitted all eleven strays with no warn at all.

A fourth key, **`titleFrom`** (string[] of frontmatter keys), names the keys tried IN ORDER as a page's title when the page carries no `title:` — the last stop before the filename stem. Absent/empty ⇒ today's behaviour byte-for-byte; same validate-warn-degrade shape as its three siblings. Dotted keys work (`"metadata.name"`), since they are just keys in the parsed map. `title:` still wins outright: this is a fallback, not an override.

It is **opt-in per wiki rather than a global `name:` fallback**, and the reason is measured. The `memory` wiki's files carry `name:` and no `title:` — 155 of its 289 pages have a `name:` that differs from the stem (a 156th carries `name: ""` and keeps its stem), so without it every one of them reads as `feedback_nav_create_pr` in the reader. But `name:`-without-`title:` also occurs on 7 pages spread across the five other registered roots (6 in melosys-kode-wiki, plus mimir's `archive/muninn/repo-health-arc.md`), two of them melosys-kode-wiki archive plans whose `name:` drops the date prefix the filename carries — and because `buildWikiIndex` registers `meta.title` into `byKey`, a global fallback would quietly change what a `[[wikilink]]` in someone else's wiki resolves to. Opt-in makes the blast radius on a wiki that does not ask for it exactly zero (measured: 0 title changes on the other five roots). On the wiki that DOES ask, the `byKey` registration is the point rather than a side effect — 58 previously-broken memory wikilinks written in the dashed `name:` spelling now resolve to their underscore-stemmed file, 0 newly broken.

Registration order bounds what a derived title can do, and the bound is worth stating exactly: **names register in their own pass first** and `register` is first-wins, so a derived title can never displace a page's own NAME. It does, however, register in the SAME `relPath`-ordered pass as authored titles and aliases — so it can shadow another page's authored title or alias exactly as one more authored title would. (That pass is relPath-ordered still: only the attachment pass's rule-1 CHILDREN are moved, to the END of it — see the Attachments section.) Landed as-is (identical to the pre-existing authored-title semantics; measured, none of the memory wiki's 155 changed titles collides with another page's title, alias or name).

A fifth key, **`defaultType`** (string), replaces the final `note` fallback in `typeFromFrontmatter` — and ONLY that fallback: an authored `type:`/`metadata.type:`, a `typeMap` folder hit and the four standard folder names all still win ahead of it. Absent/blank/wrong-typed ⇒ `note`, i.e. today's behaviour byte for byte; same validate-warn-degrade shape as its siblings. Two values are refused rather than accepted: **`explainer`** (warn + drop) is the one type that changes how a page is SERVED rather than labelled — the reader renders an explainer in a sandboxed iframe off `/api/wiki/html`, which streams the file's raw bytes as `text/html`, so a wiki declaring it would serve its whole untyped markdown corpus as HTML documents — and **`note`** warns as a no-op, since it IS the built-in fallback (`typeLabels: {note: …}` is the knob that was probably meant). A declared `defaultType` also joins `acceptDeclaredType`'s vocabulary, so a page AUTHORING that value is honoured: without it the authored key was rejected and, inside a `typeMap` folder, the folder's type silently won. It exists because `note` is one of the two types `atlas.ts` refuses a column (`EXCLUDED_TYPES`), so an untyped page is invisible on the Atlas tab and indistinguishable on the type facet. On the memory wiki that is **32** pages — the 30 per-project `MEMORY.md` hubs (no frontmatter at all) plus two strays (`melosys-api/memory/pr-3231-twfa-review.md`, no frontmatter; `muninn/memory/project_user_disappears_peer_clobber.md`, frontmatter with no type) — which now carry `memory-index` / "Memory index" and get a real Atlas column. `mergeWikiTypes` takes `defaultType` as a candidate alongside `typeLabels` keys and `typeMap` values, so a wiki declaring one without a label still gets an ordered-list entry (title-cased slug).

**It is excluded from the start view's hub sections** (`hubTypeList`, which takes it as a third argument fed by `/api/wiki/pages`' `defaultType` field). It names the pages nothing typed, so it is a leftovers bucket by construction rather than a curated section, and a "Top … by connections" hub over one is degenerate in exactly the way the explainer exclusion already covers — measured 2026-08-20, the memory wiki's 32 `memory-index` pages include **one** carrying a backlink (max 1), i.e. 31 zero-backlink cards. The two surfaces the key was added for, the type facet and the Atlas column, are untouched.

A sixth key, **`folderLabels`** (folder → display label), gives the first-path-segment folders readable names — used by the folder facet (option TEXT and its sort; the option VALUE stays the raw folder, so no filter path moves), by the breadcrumb, and as the disambiguator below. It exists for `~/.claude/projects`, whose folders are Claude Code's mangled project dirs (`-Users-rune-source-private-muninn`). Folders with no entry fall back to `deriveFolderLabels`' **common-prefix strip**: the folder name with the longest dash-token prefix EVERY folder shares removed, guarded by three conditions — ≥2 folders, ≥2 shared tokens, and every remainder non-empty (per FOLDER: one whose remainder would be blank — `p-q-`, whose last dash token is the empty string — keeps its own name while its siblings still strip). **The prefix is computed over ALL folders, labeled ones included, and applied only to the unlabeled ones**: computed over the unlabeled SUBSET it was dead in exactly the state the memory wiki is in — all 30 project dirs labeled by hand, then a new project appears ⇒ one unlabeled folder ⇒ the ≥2 guard returns nothing ⇒ the one folder the fallback exists for gets no label and its hub row reads `memory/MEMORY`. Two folders resolving to the SAME label are warned about (it is invisible from the config file). The widening pass below still separates the ROWS — its last step for a labeled first segment swaps the colliding LABEL out for the raw folder name, which is unique by construction (`x/p` and `y/p`, not two rows reading `same/p`; before that step every widening returned the same string and the loop stopped) — but the folder FACET still shows two identical options, which only the config file can fix. The guards are what keep it inert on wikis not shaped like that, and measured, that is all five other roots (mimir's `plans`/`projects`/`archive`, jarvis's `concepts`/`entities`/`sources` … share no dash token at all ⇒ `{}`). The effective map rides `/api/wiki/pages` as `folderLabels`, because the facet is built client-side from the pages themselves.

**Same-stem pages get a disambiguated `displayTitle`.** Two pages sharing a filename stem are NOT the cross-extension collision the precedence rule drops — they are two real pages, and on the memory wiki they are the 30 `MEMORY.md` hubs. `buildWikiIndex` stamps `displayTitle` on a page whose stem is shared AND whose `title` is that bare stem (an authored/`titleFrom` title already distinguishes it): `<prefix>/<stem>`, where the prefix is the wiki's folder label for the FIRST path segment when it has one (`muninn/MEMORY` — the intermediate `memory/` dir is what all 30 share and so disambiguates nothing), else the immediately-containing directory (`projects/yggdrasil/architecture.md` ⇒ `yggdrasil/architecture`). The stem is KEPT: a bare `yggdrasil` row would lose what the page is about.

**The prefix is then WIDENED until the title is unique.** Depth 1 is not collision-proof on its own — mimir holds `archive/huginn/wiki-collection-pattern.md` and `projects/huginn/wiki-collection-pattern.md`, both `huginn/…`, i.e. 30 identical rows traded for 2 — so `buildWikiIndex` re-groups the stamped titles and widens each colliding page a segment at a time, from the end the discriminator lives at (FORWARD from a folder label, `muninn` → `muninn/memory`; BACKWARD from the containing dir, `huginn` → `archive/huginn`). A pass that widens nothing stops the loop. Measured over the real roots after the pass: memory 32 stamped / **0 still colliding**, mimir 10 stamped / **0 still colliding**.

It is a **second field, never a rewrite of `title`**, and that is load-bearing three times over: `title` is registered into `byKey` (so it decides what a `[[wikilink]]` resolves to), it is what `renderWikiHtml`'s `stripTitle` compares the page's leading `# H1` against, and it is what the Similar query is built from. Measured on mimir, rewriting it would have stopped the H1 strip on all twelve colliding pages and rendered their headings twice. Everything that shows a page in a LIST (rows, hub cards, timeline, Connections rail, the Similar rail, the mini-graph's visible `<text>` label, the breadcrumb's current crumb, the article H1) goes through the one `displayTitleOf` spelling — and the SEARCH and SORT read it too (`filterPages` matches it, and the relPath but ONLY as a PATH query — the clause is gated on the query containing a `/` and anchored at segment boundaries, since as a plain substring `MEM` returned 290 of the memory wiki's 290 rows, every relPath containing `memory/`; `sortPages`' title sort and all three tiebreakers compare it, since sorting 30 identical `MEMORY` strings produces an order nothing on screen explains). The Atlas has its own one-line twin, `atlasLabel`, shared by the node card, the step panel and the cluster rail; `SimilarPage` carries the field so the rail can render it. The old-vs-new sweep over all six roots reports **0 title changes and 0 changed `byKey` resolutions**.

**The reader navigates and highlights by relPath.** `index.resolve(name)` is first-registration-wins on the lowercased stem, so a name-keyed reader opened the SAME page from all 30 `MEMORY` rows, and the name-keyed active test (`p.name === currentName`) drew all 30 of them active at once. Every row emitter now carries `data-relpath` beside its `data-page` — list rows, hub cards, the timeline, the mini-graph, the Connections + Similar rails, the Index card's missing-page links, and the server-rendered wikilinks in `render.ts` (which stamp the relPath the link RESOLVED to) — and both rules prefer it: `navTargetFrom` picks the click target, `isActivePage` compares the open page. Both are pure and unit-tested in `views/components/wiki-nav.ts`; the shell keeps only the DOM half. The name half stays as the fallback for links with no relPath (Ask citations) and for the window before a by-name navigation's response lands.

Three consequences worth keeping straight: (a) `loadPageByRelPath` needs its OWN explainer branch now that ordinary clicks route through it — asking `/api/wiki/page` for an explainer returns the raw `.html` as if it were markdown, and the lookup that feeds it is the case-insensitive `findPageByRelPath`, not a raw `===` (an Atlas node key is lowercased and a `?relPath=` can be typed by hand; a near-miss there does not degrade to "not found", it paints escaped HTML source into the article pane); (b) `fetchAndRenderPage` pushes the RESOLVED page's relPath (`?relPath=`), not the requested key, so reload/Back/share re-open the same page instead of re-resolving the stem — `?page=` is still read on the way in, for older links, and the server-rendered wikilink `href` is a `?wiki=…&relPath=…` URL now (the middle-click path used to lose BOTH facts: the wiki, so a link on mimir opened jarvis, and the page); (c) `/api/wiki/similar` and `/api/wiki/html` take an optional `relPath` (`/api/wiki/page`'s pattern) and the client passes it, memo and in-flight guard included — under the name key two same-stem pages shared one memo entry and the rail showed another page's cousins. Similar's self-exclusion is **relPath and only relPath**: the name half of that test threw away exactly the cousins worth showing (every `projects/*/architecture.md` sibling on mimir).

**Every page-scoped ACTION takes `relPath` too, and that half was a WRITE bug.** `index.resolve(name)` is first-registration-wins, so a name-keyed action resolved to whichever same-stem page registered first — measured on mimir, opening `projects/yggdrasil/architecture.md` and pressing fact-check → ➕ wrote the callout into `projects/claude-hivemind/architecture.md`. `/api/wiki/{explain,factcheck,factcheck/claim,share,factcheck/append,factcheck/integrate,factcheck/integrate/apply}` and `POST /api/wiki/ask/chat`'s article mode now resolve through the one shared `resolvePageRef` (relPath first, the stem NAME as the fallback — the client's copy of a path goes stale on a rename, and a 404 on a page plainly there is worse than a stem resolution), and the ONE `noPageMessage` spelling quotes whichever reference the caller actually sent on every 404 and every SSE preflight in the file. **A stale relPath falls back only onto an UNAMBIGUOUS stem:** if the name resolves to a page whose stem is shared, the fallback is guessing at exactly the question the relPath was sent to answer, and `explain`/`share`/`factcheck/claim` have no CAS to catch it — so that case 404s naming the path the caller sent. **Both integrate routes take either reference** (`!page && !relPath`, the append/share rule; `relPath` is declared on `IntegrateBody`/`ApplyBody` — `resolveIntegrateTarget` always read it, but the type did not, and the 400 demanded the stem beside it). The client sends both from `currentArticle` / `currentRelPath`, stamps the checked page's path on the fact-check TURN (`pageRelPath` — a persisted turn outlives the open article, so ➕/✎/↻ and the post-write reload must not read `currentArticle` at click time), and the four `allPages.find(p => p.name === currentName)` lookups behind the Explain pill, both fact-check buttons and the explainer-iframe bridge are `currentArticle` instead. Ask citations carry `pageRelPath` from the same `enrichCitationsWithPages` pass that matched them, so a cite marker and a Sources row open the page that was CITED — and `matchCitationToPage` returns the matched `WikiPageMeta` rather than its NAME, trying the doc id as a relPath (a huginn wiki-collection doc id IS the relPath) and as a full path BEFORE the bare stem. Re-resolving the name to recover a path was the same first-wins bug one layer up: a cite of `projects/yggdrasil/architecture.md` was stamped `pageRelPath = projects/claude-hivemind/architecture.md`.

**`/api/wiki/similar` carries the per-wiki egress prologue.** It reads the page off disk and ships its title + tags + first body paragraph to huginn's embedder — the same "this wiki's content leaves the machine" shape that puts `/api/wiki/reindex` on the list — and, fetched on every page open, it is the highest-VOLUME egress the reader has. The client skips the fetch entirely when the open wiki is read-only. `/api/wiki/html` is deliberately NOT guarded: it serves a local file to a local iframe and reaches nothing.

`~/.claude/projects/.wiki-reader.json` — the file that turns `titleFrom`, `defaultType` and `folderLabels` on for the memory wiki — is Claude Code's own state directory and sits outside every `SYNC_REPOS` entry, so it does not travel. A second machine registering the `memory` wiki must create its own copy.

### One nested frontmatter level (`parseFrontmatter`)

`parseFrontmatter` reads ONE level of nesting and emits it dotted — `metadata: ` + `  type: project` ⇒ `fm["metadata.type"]`. It exists for the `memory` wiki, whose generator files `type`/`node_type` under a `metadata:` block: 213 of its 289 pages keep their type there, out of reach of a key regex anchored at column 0.

**Reaching that key is not the same as changing a page's type, and the memory wiki is the proof.** The nesting was only half the cause: the memory vocabulary is `project`/`feedback`/`reference`/`user`, and none of those is in `VALID_TYPES`, so every page on that wiki stays `note` until its `.wiki-reader.json` declares them in `typeLabels` (campaign PR 3). The 44 memory pages that DO carry a top-level `type:` were `note` for that second reason alone.

`typeFromFrontmatter` falls back from the top-level `type:` to `metadata.type` **on VALIDITY, not presence**. A `fm.type ?? fm["metadata.type"]` treats a top-level key that resolves to nothing — `type: ""`, `type: bogus`, an inline-array `type: [a, b]` — as an answer and never looks at the nested one, so a page whose real type sat one key away rendered as `note`. Both keys now go through the same `acceptDeclaredType`; "authored usable top-level wins" is unchanged (including a value the wiki declares itself in typeMap/typeLabels), so this is a fallback and never a merge.

The rule, exactly, because every clause is load-bearing:

- **One level only.** A child of a child is depth ≥ 2 and is ignored, along with the depth-1 block-opener that would have parented it. Depth 1 is defined by the indent of the block's FIRST child, so a file picks its own indent width.
- **`parent.child`**, which can never collide with a top-level key: the key regex admits no `.`, so a literal `metadata.type:` at column 0 matches nothing and reaches no caller.
- **Scalar values only.** A nested inline array (`  tags: [a, b]`) is dropped — no consumer reads a nested key today, so the minimum additive emission is the one that cannot surprise one.
- **An indented `- ` makes the block a LIST, and the block ends there** — nothing more is emitted for it until the next column-0 key. Treating a list item as an unparsed line that leaves the block open leaked two measured shapes: a scalar SIBLING of the list arriving as a child (`sources:` + `  - a` + `  extra: leaked` ⇒ `sources.extra`), and a list OF MAPPINGS arriving as last-wins children of the parent (`  - name: X` / `    url: u` / `  - name: Z` / `    url: w` ⇒ `sources.url = w`) — the same shape under `metadata:` produces a `metadata.type` that CHANGES the rendered page type off a key the page does not carry. Forward-only: a child emitted before the marker stands.
- **A `#` comment is skipped at any indent.** A column-0 `#` is not a dedent out of the block; reading it as one made `metadata:` + `# c` + `  type: project` parse to `{}`.
- **Indentation is SPACES.** Indent is compared by character count, so a tab-led child would set `childIndent = 1` and drop every 2-space sibling after it as depth ≥ 2. A tab-led line is not a child at all.
- **The parent key's own emission is UNCHANGED.** A value-less `sources:` / `metadata:` line stays dropped exactly as before, and only its scalar children are ADDED. This is what keeps the change additive: `lint.ts`'s `checkMissingSources` reads `fm.sources` to decide whether a concept page cites anything, and `huginn-nav/wiki` carries 117 pages with a `sources:` block inside the fence. That block is a nested **MAPPING**, not the indented scalar list — an `umbrella:` inline array plus `confluence:`/`jira:`/`code:` keys whose values are lists of flow mappings — so what keeps it unread is the scalar-only, inline-array and list clauses together rather than any one of them. Making the parent truthy would silently retire a live finding on all 117 (measured before/after: `missing-sources` 64 on huginn-nav, 43 on melosys-kode-wiki, identical both sides).

Two emitted shapes are landed-as-is: (a) an indented prose CONTINUATION containing a `word:` under a value-less key (`description:` + `  Note: x` ⇒ `description.Note`) — 0 occurrences measured across the six roots; and (b) the derived-title registration described in the `titleFrom` section above.

The nine non-test callers all read named keys and none enumerate the map — `lint.ts` (×2), `gardener/{apply,draft,source-drafter,synthesis-drafter,runner}.ts`, `plans/source.ts`, `scripts/backfill-wiki-pubdates.ts` (×2 — `url`/`date` at `:146`, `type`/`url` at `:272`; it splices body lines and never reserializes the fence) and `store.ts` itself — so the nested keys are inert everywhere they are not asked for by name. `src/plans/frontmatter.ts` is shape-coupled rather than a caller: it re-implements the column-0 key shape for the `/plans` priority write, and the nested level does not change that shape. The adjacent CRLF bug (`(.*)$` matching no `\r`, so a CRLF page parses to `{}`) is **not** fixed here and stays documented at the call site in `buildWikiIndex`.

## Ask tab, Similar articles (`wikiCollections`)

`wikiCollections` (string[], per-bot config.json) names the Huginn search collections backing the wiki's **Ask** tab (research-style cited Q&A via `GET /api/wiki/ask`, reusing the `/research` pipeline). Citations whose doc resolves to a wiki page open in-reader. Unset/empty ⇒ Ask returns a clean "No search collection connected for this wiki" error.

Also backs the reader's **Similar articles** section (`GET /api/wiki/similar` — huginn `/api/search` with repeated `collection` params, top 5 hits resolved to wiki pages, self excluded; huginn unreachable ⇒ empty list, section hides).

## Ask → chat escalation (`ask-chat.ts`, `POST /api/wiki/ask/chat`, `GET /api/wiki/chat-target`)

Three modes on the POST: **escalate** (Phase 1, #417 — carries the Ask `answer` + citations into a new thread via `buildAskChatSeed`), **direct** (`mode: "direct"`, #418 — skips Ask entirely; `buildDirectChatSeed` writes a research-instructing seed that claims web search only when the effective connector supports it, and omits the wiki-notes-first clause on collection-less wikis), and **article** (`mode: "article"`, chat-dialog PR C — see below). Direct mode also accepts **`askDeclined: true`** (boolean-validated; scoped to direct — the escalate seed quotes an answer the wiki DID produce): the question came from a turn the wiki's Ask DECLINED, so the seed replaces "search the wiki's own notes first" with the fact that its index has already been searched and had nothing solid. Without it the seed opens by ordering the one step known to have failed, and the answer's finding is the finding the reader already has. It beats `hasCollections` (a wiki that declined necessarily has collections) and leaves the web-search conditioning untouched. Optional `connectorId` (UUID-guarded; "" = bot default), `threadName`, `existingThreadId` ("Send there" — refuses to clobber a live pending seed with a 409 `alreadyQueued`; applies a picked connector only when the thread has none, else responds `connectorApplied: false`). Owner/pin/user resolution lives in `resolveAskChatTarget` (discriminated result, shared by POST + GET through the `askChatDeps` seam — tests run on `__setAskChatDepsForTest` fakes, never the live DB). `GET /api/wiki/chat-target?wiki=&bot=` feeds the reader's options popover (users, defaultUserId, capability-flagged connectors via `capabilitiesForConnectorType`, botDefault, folded preferred connector — plus, on the ok path, `bots` for the ⚙-section bot OVERRIDE on a resolved wiki, and `isJiraBot` — the resolved bot is the `JIRA_BOT` pin — which gates the article-mode "Draft Jira task" starter chip). ChatUrls from popover-origin requests carry `&src=wiki`, which the chat page's `stampConnectorOnThread` honors as **per-thread** stamp suppression so "(bot default)" keeps meaning the bot's config beyond the seeded turn; plain one-click escalates carry no flag (sidebar stamping applies, as in Phase 1).

**Decline hook (PR B):** an Ask/Explain turn the wiki DECLINED to answer renders a prominent "Ask in chat instead →" action (pure `declineChatBarHtml` in `views/components/wiki-chat-target.ts`) in place of the ordinary escalate bar, opening the same direct-mode popover. It is NOT a branch on the incoming SSE event: `done` fires once while the bar re-renders from turn state on every switch/rehydrate, so the reason is mapped onto `AskTurn.declined` / `StoredAskTurn.declined` (`"no_hits" | "low_confidence"`, persisted; `isValidTurn` validates the union **forward-tolerantly** — an unknown value drops the FIELD and keeps the turn, the `annotatable` treatment, since unlike `wrote` it gates no destructive write and a future third reason must not wipe a session on a downgrade). The mapping is the shared `askDeclineReason`, which checks **`lowConfidence` first** — `noHits` is unconditionally true on BOTH decline branches (`research/ask.ts`), so the natural `noHits ? … : …` order mislabels every low-confidence decline. (`/research`'s inline client injects that same function by source rather than hand-mirroring the order.) The decline hook catches the honest failures; the always-visible "New chat" button covers the confident whiffs.

Four things the hook does NOT share with the plain "New chat" opener:

- **The question is PINNED, not typed into the Ask box.** The first cut wrote `turn.question` into `#wikiAskInput`; that destroyed whatever draft the reader had, left the failed question armed in the box afterwards, and on the Connections tab wrote into a hidden textarea. `ChatOptState.pinnedQuestion` now carries it, the pure `chatOptQuestion(state, boxValue)` resolves the three sources (pinned → escalate's turn question → the live box), and the box is neither read nor written. The un-pinned "New chat" path keeps its live-box read/re-read (PR A's M9), and `shouldCloseChatOptions` keeps the panel open on an Ask-box click only there — under a pinned question the box is an ordinary outside click.
- **The pinned question is COMPOSED, not the turn's display one** (`composeDeclineQuestion`, pure): an Explain turn's `question` is the label `Explain: "<80-char slice>…"` (the real question is built server-side from `sel` and never comes back) and a follow-up's is a bare fragment — both unanswerable in a fresh thread. So an Explain turn escalates as `About the wiki page "<page>": explain this passage — "<selection>"` and a follow-up as `Context — the earlier question in this wiki session was "<origin>". Follow-up: <text>`. Two additive persisted fields feed it: `explainPage` (stamped in `activateExplain`) and `originQuestion` (stamped by `submitFollowup`, chains keeping the ROOT). Framing stays third-person for the same reason `buildDirectChatSeed`'s opening is.
- **The POST carries `askDeclined: true`** (see the route section above) so the seed stops ordering the search that just failed.
- **The turn rides along on `ChatOptState.turn`**, so a success mirrors `chatEsc = {status:"done", chatUrl}` onto the turn exactly as the one-click escalate path does — without it an Escape or a blocked popup lost the only link to the thread that was just created. `chatEscBarHtml` (moved into `wiki-chat-target.ts` with the bar's whole markup) therefore checks `chatEsc` **before** `declined`: a REALISED escalation outranks an offer to start one, and the earlier order silently shadowed the link while the second click walked 409 recovery for an unreachable thread. NB `chatEsc` is not declared on `StoredAskTurn`, but `serializeAskSession` JSON-stringifies live turns, so it does ride into localStorage (accepted, pre-existing — `isValidTurn` neither validates nor strips it).

**Article mode (chat-dialog PR C) — "💬 Discuss" on an open page.** `mode: "article"` + `page` (name) and/or `relPath`. `relPath` is TRIED first (collision-proof as on `GET /api/wiki/page`) and **falls back to an unambiguous name** when it resolves nothing — that is what a rename leaves an open tab holding, and without the fallback the button 404s on a page plainly there; it runs the shared `resolvePageRef`/`noPageMessage` now, so a same-stem sibling is a 404 rather than a seed quoting the wrong page's path. Like direct it needs no `answer`, and an empty `question` still 400s. **Article-mode body-shape checks (a missing page ref) run BEFORE bot resolution**, so a bot-less wiki answers "page is required in article mode" rather than "belongs to no bot". The route **re-resolves the page against the wiki index** (missing ref ⇒ 400, unresolvable ⇒ 404) rather than trusting a client-posted title/path — the client posts a REFERENCE, and everything the seed quotes is server-derived. `buildArticleChatSeed` frames it as a bracketed provenance line (`[Question asked while reading the "<wiki>" wiki article "<title>"]` — third-person for the same memory-extractor reason as the direct seed), carries the page's **wiki-relative path** so the bot pulls the real page instead of re-searching its title, appends the page's own summary as a parenthetical (frontmatter `description`, else the indexed `desc` first-prose-line; **absent ⇒ no parenthetical at all**, never an empty `()`; **truncated THEN trailing-period-stripped**, since a cut landing after a mid-sentence period reproduced the `(… pages.).` shape the strip exists to prevent), and takes the same `webSearch` / `hasCollections` conditioning as the direct seed. Bounded by the same `ASK_CHAT_SEED_MAX`, with per-part caps on title/path/description.

**`hasCollections` is config-PRESENCE, not capability**, so the searchable branch is phrased as an ATTEMPT with a stated fallback ("try to pull it up … if it isn't indexed, say so in ONE line and answer from what you can research; never open with an apology"). mimir declares a collection named `mimir` that does not exist in huginn, and a real model turn on the precondition phrasing opened with "I can't pull up this article…" — the retrieval failure became the answer. The collection-less branch is unchanged.

Three article-mode specifics worth keeping:
- **The thread is named after the PAGE, not the question** — and that derivation lives in the ROUTE (`deriveAskThreadTitleOrNull(page.title) ?? deriveAskThreadTitle(question)`), not only in the popover's preview (whose `chatOptNameSource` runs the same `…OrNull` test, not a `.trim()`, or a control-character title previews `wiki ask` while the server stores the question-derived name). That is what makes an article accumulate ONE discussion thread: every later question about the same page **409s by construction**, and `threadExists` + "Send there →" is the designed, successful resolution. Naming it after the question would mint a sibling thread per visit. A typed `threadName` still wins, and a title that flattens to nothing falls back to the question rather than to the generic `wiki ask`.
- **A name collision is NOT proof of identity — the description carries an article TAG.** `findThreadByName` is (user, bot, name)-scoped and an article thread's name is its page title: mimir + jarvis carry 13 colliding title groups over 30 pages (`architecture` ×3), two wikis owned by ONE bot collide with each other (`repos/huginn.md` in mimir vs `entities/Huginn.md` in jarvis), and an ordinary `/topic` chat thread can own the name outright. So the article thread's description is `Discussion of the wiki article "<flattened, truncated title>" (<wiki>:<relPath>)` (`buildArticleThreadDescription`; the tail is the machine tag, parsed back by `parseArticleThreadTag`/`articleThreadTagMatches` — anchored on the LAST `" (`, so quotes/parens/a planted fake tag in the title can't shadow it, wiki matched case-insensitively, relPath split on the FIRST colon). **No schema migration** — the column already existed and already held per-mode prose. Both name-keyed paths verify it: the 409 (`findThreadByName` now returns the description, so no second query) and the `existingThreadId` "Send there →" reuse (via `getThreadById`). A mismatch — different article, or no tag at all — returns a DISTINCT 409 `{nameTaken: true}` carrying NO `existingThreadId`, whose popover copy says the name is taken by an unrelated thread and whose only action is "Start new thread" (the existing `forceNew` unique-suffix walk, which mints the sibling with its own tag). Direct and escalate modes are untouched by the tag logic — their threads carry no tag, and checking one would turn every legitimate "Send there" into a refusal.
- **Thread description is per mode**: the article tag above / `Started from the <wiki> wiki` (direct) / `Continued from the <wiki> wiki Ask tab` (escalate). It sticks because the ROUTE 409s before re-inserting over a colliding name — **not** because of `createThread`'s COALESCE, which reads `COALESCE(EXCLUDED.description, threads.description)` and therefore lets a NEW non-null description WIN on conflict (only an absent/blank one preserves the stored value). The remaining overwrite path is a genuine race between two concurrent posts; documented, not locked. An article thread labelled "Continued from the Ask tab" would be a false claim about a conversation that never touched the Ask tab.

## Synthesis-bot routing (`resolveWikiSynthesisBot`)

Ask answers and the What's-new digest are synthesized by the wiki's **owning bot** (jarvis wiki → jarvis, nav wiki → melosys); standalone and opus-owned wikis fall back to the research bot. An explicit **`wikiSynthesisBot`** pin (set on the owning bot's config.json) beats both — and deliberately **bypasses the opus fast-gate** (e.g. capra pinning its own opus bot for capra's wiki is an informed choice). A pin naming no discovered bot is warned + ignored (routing falls through to owner/fallback), surfaced as a red note in the `/models` Wiki synthesis group, which shows every wiki's resolved bot with a `pinned`/`owner`/`fallback` origin chip.

## Fact-check claim retry (`GET /api/wiki/factcheck/claim`)

The read-only sibling of the two fact-check WRITE routes (`/factcheck/append`, `/factcheck/integrate`): it re-verifies ONE claim and writes nothing. An SSE route, same wire shape as `/api/wiki/factcheck` (heartbeat · `app_error` · terminal `end`) via the shared `streamFactcheckScaffold`, and the same preflight chain via the extracted pure `resolveFactcheckPreflight` (unknown wiki → unloadable index → unknown page → non-web connector; **no** collections check — fact-check is corpus-independent). Params: `page`, `wiki`/`bot`, `mode`, `sel`, `ctx`, `index`, `total`, `title`, `quote`.

**The client ↻** (claim-retry PR C — not the chat-dialog PR C above): a per-claim row injected under every retryable claim heading in the reader's answer pane, plus a "Retry N unverified claims" batch bar. The client half is `applyRetryAffordances` in `views/components/wiki-browser.ts`; all answer surgery is `views/components/wiki-claim-retry.ts`, whose fence-aware line walk (`scanClaimLines`, shared with `parseFactcheckClaims`) is what makes the splice's block extent identical to the parser's. Client contract in `src/dashboard/CLAUDE.md`'s `wiki-routes.ts` row; the four persisted turn fields it runs on (`claimOutcomeByIndex` · `fcMode`/`fcSel`/`fcCtx`) are declared on `StoredAskTurn`. Three route-side facts the client depends on, restated because they are what its behaviour is derived from: a FAILED retry emits `app_error` and no `claim_result` (so the row reports and stays live while the persisted answer is byte-untouched), the 409 carries `expiresAtMs` (rendered as "~Nm left", including for a row ↻ clicked mid-batch, which 409s by construction), and the retried block is guaranteed to carry the `### <emoji> Claim n/m` heading (`isClaimVerdictBlock`) — which is exactly the anchor the client's `spliceClaimBlock` replaces. The client re-checks that anchor anyway — but **renumbering is CORRECTED, not refused** (`renumberClaimBlockHeading`), so the two sides agree: `isClaimVerdictBlock` deliberately accepts a renumbered heading as a formatting wobble rather than throwing away a completed 180s verification, and the client rewriting the `n/m` to the claim it asked about (from the REPLACED block's own `m`, so the heading stays in step with its siblings) keeps both the retry AND the anchor integrity — a duplicate index retires the wrong ↻ and later makes the whole quote list fail validation. A block carrying NO claim heading at all is still refused, as is a `claim_result` whose wire `index` disagrees (the route echoes the requested index, so that is a transport problem, not a model wobble).

- **The claim text is CLIENT-SUPPLIED and re-extraction is not an option.** Extraction is a model call and non-deterministic, so "claim 2" on a re-extract need not be the claim that timed out — a re-extracting retry would verify a different statement and splice its verdict under the old index. Every echoed field is bounded instead: `title` TRUNCATED at `CLAIM_TITLE_MAX` (presentation only), `quote` DROPPED over `CLAIM_QUOTE_MAX` (the `claimsEventPayload` rule — a truncated quote can resolve to a different span than the model meant), `sel`/`ctx` on the article route's own `FACTCHECK_SELECTION_MAX`/`FACTCHECK_HEADING_MAX`, and `index`/`total` as integers with `1 ≤ index ≤ total ≤ CLAIM_INDEX_MAX`. That ceiling is deliberately NOT `FACTCHECK_MAX_CLAIMS`: the pair comes off a PERSISTED turn, so lowering the cap must not make old turns unretryable. Stated decision: this is loopback-only and no worse than the integrate POST, which accepts a whole client-posted answer — the bounds are for accident and payload size, not trust.
- **Bounding is not the same job as SHAPE-neutralizing, and both run.** The bounds above are for accident and payload size; the prompt's DELIMITER CONTRACT is a separate question, because `buildClaimVerifyPrompt` writes `title` as one `CLAIM (n/m): …` line and fences `quote` between `"""` markers. So `shapeClaimTitle` collapses every whitespace run in `title` (raw newlines otherwise both break that single-line field and render the `/agents` run card multi-line) and `neutralizePromptFence` collapses any run of 3+ `"` in BOTH fields to one — the `neutralizeFactcheckSentinels` treatment, keeping readable content while destroying the marker, and idempotent for the same reason. Flattening runs before the length cap (so the cap counts real content) and the cap itself is the surrogate-safe `truncateUnits` (now exported from `ask-chat.ts`), as is the `/agents` run-name clip: a bare `slice` through an astral character stores a U+FFFD.
- **The excerpt is BEST-EFFORT.** The persisted `sel` reconstructs the SELECTION, not the surrounding excerpt: the route re-reads the page as it is NOW and re-runs `locateExcerpt`, so a page edited since the original check can have moved or lost the passage and the locator degrades. Acceptable because the prompt frames that block as "reference only" — the claim being verified comes from the turn.
- **A failed retry emits `app_error` and NO `claim_result`** (timeout, empty result, **a reply that missed the claim-heading contract**, connector error, preflight). The persisted answer, its outcome map and the rendered pane stay byte-untouched and the ↻ affordance stays live. A fresh synthetic ❓ would splice one hole over another and rewrite the reason text of a claim nobody re-verified. Timeout prose comes from `retryTimeoutReason`, NOT the fan-out's `claimTimeoutReason` — that helper falls back to the 110s per-claim constant, and a retry ran against the 180s `FACTCHECK_RETRY_TIMEOUT_MS`.
- **The retried block must OPEN with a `### <emoji> Claim n/m — <title>` heading** (`isClaimVerdictBlock` in `factcheck-sse.ts`, which runs the contract's ONE implementation — `parseFactcheckClaims` — over the block's first non-blank line rather than re-spelling the regex). A retried block is SPLICED over a well-formed one, so a reply that merely drifted off format would destroy the anchor `parseFactcheckClaims` / `correctableClaims` / the integrate route's edit anchors all read — turning a previously intact claim into an unanchored one. A mismatch therefore takes the app_error path ("the model's reply did not come back as a verdict block"). It deliberately does NOT require `n`/`m` to match the requested pair: a renumbered-but-otherwise-good block is a formatting wobble, not a different claim, and rejecting it would fail a usable retry.
- **The block is run through `linkifySourcesLines` before emission.** On a normal run `Sources:` lines are linkified once at assembly (`assembleFactcheckAnswer`); a raw retried block spliced into the answer would keep bare URLs, and `web-format.ts` has NO bare-URL autolinker. The helper is server-side (the client cannot fix it) and idempotent (per-block application is safe).
- **Its own trace root + its own `/agents` run** — `factcheck-retry` root, span `claude:claim-retry-<n>` **1-BASED** to match the `Claim n/m` heading contract the client retries against (the in-run fan-out's `claude:claim-<i>` labels are 0-based on purpose: that index names a worker slot, this one names the claim a reader clicked), tool children attached on BOTH paths (the shared `rebuildToolSpansAfterFailure` on the throw path). `tracedOneShot` deliberately owns neither the root nor the run — a one-shot with no registered run is invisible on `/agents`. **The root is finished in the runner's `finally`, keyed on `status`, so every terminal path closes it exactly once** — it used to be finished in the catch plus an `ok`-only branch, which left the two mid-`try` returns (empty result, non-verdict block) closing NEITHER, and an unfinished root renders as perpetually running on `/traces` forever since nothing revisits it.
- **Per-page single-flight, 409 `{state: "running", expiresAtMs}`.** Extends the atlas draft-synthesis precedent (`synthesisInFlight`, a bare `Set` answering `{state, topicKey}`) with a `Map<key, {startedAt, expiresAt}>`: the deadline rides the 409 so the client's "try again in…" copy needs no second route, and an EXPIRED holder counts as free (evaluated lazily on the next hit — no sweeper, no timer to leak; release is identity-checked so a late release can't free a newer holder). Taken only on the happy path, so a preflight failure can't wedge a page, and the route wraps the stream construction so a SYNCHRONOUS throw before `streamFactcheckRetrySSE` returns (leaving `onSettled` unwired) releases instead of wedging the page for the full expiry. Bounding the inputs is not bounding the RATE: one GET buys a tool-enabled 180s one-shot.
- **The slot's expiry is `acquire + FACTCHECK_RETRY_TIMEOUT_MS + CLAIM_RETRY_SLOT_SLACK_MS` (30s), and the slack is load-bearing.** The one-shot's own 180s budget starts AFTER the acquire (the route still has a page read and an excerpt locate to do) and the run's teardown — failure-path span rebuild, final SSE writes, the scaffold's `finally` — runs after that budget expires. Sized to exactly the budget, the slot frees itself while the holder is still tearing down and a second GET on that boundary starts a CONCURRENT 180s tool-enabled run. The slack only ever delays the LAZY heal of a slot whose `finally` never ran; the ordinary path releases explicitly.
- **Three blocks are SHARED with `factcheck-sse.ts`, not copied** — `makeClaimToolForwarder` (the tool-progress forwarder: the accumulate-BEFORE-the-gone-guard rule and the `{state, name, label, detail, url?, claimIndex}` payload the client's Consulting chips read), `rebuildToolSpansAfterFailure` (classify → `spanStartedAt` offset origin → fail-soft `attachToolSpans`; each caller keeps its own log line via `onError`) and `makeSafeWrite`. All three carry either a live client contract or a trace invariant, which is exactly what two copies would drift on.

## ⧉ Copy path (breadcrumb)

The open page's path ON DISK — `wikiPagePath(root, relPath)`, absolute wherever the server named a root (`servedRoot` in `wiki-routes.ts`, injected as `window.__WIKI_ROOT__`, read by `readActiveWikiRoot`) and the relPath alone otherwise. Every registered wiki has a root, so this is not a mimir-only affordance; the /plans drawer's button is the same two functions (`views/components/copy-path.ts` — the clipboard write and the join both live there, one fallback path rather than two that drift).

Five things about it are deliberate and easy to undo by accident:
- **The path rides on the button** (`data-copy-path`), not re-derived at click time from module state a navigation may already have moved — so the tooltip and the clipboard cannot name different pages.
- **It is in NEITHER read-only selector list.** Copying a path spends no model call, writes nothing and reaches no network, so it stays live on a `WIKI_READONLY_ROOTS` wiki — which is the kind whose paths get pasted into briefs most. Adding `COPY_PATH_BTN_ID` to `WIKI_READONLY_EGRESS_SELECTOR` dims a control that has nothing to refuse.
- **The breadcrumb's leaf is the page's TITLE, not its filename**, which is exactly why a copy button is needed rather than selecting the trail: on mimir the two share nothing.
- ⚠️ **It is ICON-ONLY, the row WRAPS, and the rule is ENFORCED by the spec, not recorded in a comment.** `.wiki-bc-trail` is the row's only shrinkable item, so every action added to that row comes out of the trail's width: a LABELLED button (~104px) rendered it at 27px at 1280 and 0px at 800 with the document scrolling 48px sideways; the glyph costs ~38px (a 30px button plus the row's 8px gap) and `flex: 1 1 160px` + `flex-wrap` catches the rest. **Two earlier rounds wrote measurements into this comment and the CSS's, and a third wrote a full sweep; each was refuted by the next review** — the sweep claiming "260 wraps at every width" about a build where it wraps at 8 of 14. So the invariant is what is stated (the trail stays legible; the row never overflows its pane; it wraps ONLY where a single line would leave the trail cramped — the counterfactual below, not a bare "does one line fit", which the shipped basis deliberately does not satisfy at 960/980 where wrapping buys the trail 214/234px instead of 129/149px) and `e2e/wiki-copy-path.spec.ts` **sweeps 760–1920px in both selection states** to enforce it — both states because ✨ Explain and ✓ Fact check are hidden until text is selected, so every hand sweep measured a row two items shorter than a reader mid-selection sees. With a selection live the row may legitimately wrap where it otherwise does not, so the no-wrap check is scoped to the no-selection case. The no-wrap half is a **counterfactual, not a width list** — the spec forces `nowrap`, reads what the trail would have got, and only then asks whether wrapping bought anything, which is what makes it portable: where a flex row breaks depends on platform font metrics, and CI proved it by failing on Linux at two widths that stay on one line on macOS. Measured against that rule, each mutation shown to apply: basis 0 fails 7 cases, 100 fails 1, 180 fails 3, 200 fails 4, 260 fails 5, removing `flex-wrap` fails 7 — while 120/140/160 all pass, so it brackets the basis from both sides without dictating one value. The detector itself is pinned in both directions (hardwiring it to `false`, and the top-edge form it replaced, each fail one case). Re-tune by changing the basis and running the spec.
- **A blank path is a REFUSAL, not a copy.** `writeText("")` resolves, so copying nothing would report success while emptying the reader's clipboard — `wikiPagePath` answers `""` for a blank relPath and the click reports "Copy failed". The accessible name carries that verdict too: an `aria-label` overrides a button's text, so a static one silences the only feedback a clipboard write has, hardest on the `execCommand` path that is PRIMARY on the plain-HTTP tailnet deployment.

**It is also a new disclosure**, small but real: `GET /wiki` now ships the host's absolute directory layout for the selected wiki (`window.__WIKI_ROOT__`) to whoever can load the page — `origin/main` shipped no absolute path there, and `/api/wiki/*` still ships none. Bounded by `/wiki` being admin-zone under `src/auth/zones.ts` (default-deny) and dropped entirely under `MUNINN_PROFILE=nais`; `/plans` already ships its wiki root the same way. On the documented `MUNINN_AUTH=off` shape there is no middleware at all, so on a tailnet-served instance it discloses the username and home layout — including for `WIKI_READONLY_ROOTS` entries such as `~/.claude/projects`. Wiki content cannot read it: explainer pages render in an iframe with no `allow-same-origin`.

Acceptance: `e2e/wiki-copy-path.spec.ts` (two temp wikis in ONE process, the second registered read-only).

## The page rail's recall aids (Activity · Pinned · Jira-key jump)

**Activity** leads the rail: pages recently CREATED, then pages meaningfully
CHANGED, in one list ranked by one score (`views/components/wiki-activity-rank.ts`,
pure and DOM-free; `renderList` calls it once per render over the FILTERED pages,
so a facet narrows it exactly as it narrows Pinned). Five factors,
all read off the listing muninn already ships: creation recency and change
recency (exponential decay, `halfLifeNewDays` / the shorter `halfLifeChangedDays`,
which is one of the two terms separating a creation from a change of equal age, `changedWeight` being the other), a **page-age**
discount and a **backlink** discount on a change — together the reason a touch to
`log.md`-shaped traffic or to an old hub never leads — and a **type** boost for
plans (in-flight and proposed most) and, at a third of a plan's share, blogs. The two signals are the sweep-aware
`pageAddedMs`/`pageTimeMs`, never raw `mtimeMs`/`gitCreatedMs`: a mechanical pass
moves every mtime in the wiki, and ranking on that is the "148 plans edited this
minute" failure those functions exist to absorb. ⚠️ **The mtime rule has ONE
exception, and it is where that failure came back**: a DIRTY page's mtime is
trusted, because git has not recorded that edit yet — so a mechanical frontmatter
write (a series join across twelve pages, a burst of `/plans` flips) made every
page it touched read as edited minutes ago. `buildWikiGitDates` now COMPARES a
TRACKED, MODIFIED page against its `HEAD` blob and drops it from `dirty` on either
of two verdicts, so it dates from git history like a clean page: `metadata-only`
(the body after the fence is byte-identical and, with every column-0
`METADATA_ONLY_FRONTMATTER_KEYS` line stripped from both sides — the four
provenance keys plus `series`/`series_label`/`priority`/`plan_status`/`status_date` —
the two frontmatter remainders are identical IN ORDER, so a hand edit that only
reordered `title:` and `tags:` is an edit)
and `identical` (equal texts, which `git status` still reports as modified after a
`chmod`). Everything else is an `edit` and keeps its mtime — and `edit` is the
DEFAULT, so there is no unnamed page to guess about: a body difference, a page
with no frontmatter, a differing key outside the set, an indented or unparsed
frontmatter line, a missing `HEAD` blob, an unreadable, non-UTF-8 or
NUL-carrying file. The HEAD side is ONE `git cat-file --batch` fed
repo-relative paths on STDIN — a path with a space, a quote or a non-ASCII byte
needs no quoting there (a path containing a NEWLINE is the one shape stdin cannot
carry; it is left out of the batch and stays dirty), and no `diff.*` user config
can change the spelling an answer comes back under, which is the whole class of
bug the `git diff HEAD` text parse this replaced was built on. Untracked and deleted paths pass through
UNTOUCHED (an untracked page has no `HEAD` blob, and dropping it would also count
it into `store.ts`'s unexplained-miss warn); the comparison is against `HEAD`
rather than the index because both wiki writers stage before they commit; and a
changed line counts only INSIDE the frontmatter block `parseFrontmatter` reads,
since mimir documents these very keys at column 0 inside body code fences. The
classification carries its OWN budget (`GIT_DATES_CLASSIFY_TIMEOUT_MS`) whose
loser is the UNCLASSIFIED dirty set, never the empty one. The same verdict
covers COMMITTED history: a page's newest non-sweep commit is compared with its
parent blob, and a `metadata-only` or `identical` one (a pure rename) steps back
to the commit before it, up to `METADATA_TOUCH_MAX_STEPS` (8). The sweep
threshold cannot catch these, because a mechanical writer commits per call — the
2026-09-21 lint accepts were 38 commits of 2–12 pages and dated 93 of mimir's 139
series members to that morning. Rules and degrades: the metadata-only section of
`src/wiki/git-dates.ts`. ⚠️ A **change means the update signal's own KIND is `updated`** (`pageDateKind`),
never a gap between two dates: `updatedSignal` falls back to the git CREATION
date for a page whose every commit was a sweep, and read as a date it makes
such a page "changed <the day it was created>", outranking the creation it is
made of (534 jarvis pages have the shape; all are old enough to sit under the
floor today, so it bites when the floor is recent — a re-clone, an import). A
page with NO creation signal at all (no git history, no birthtime, no
frontmatter `created:`; mtime is its only date) is eligible as a change with its
age factor at 1 — an unknown age is not evidence of an old page — and its `why`
says `created ?`. Bookkeeping pages are excluded
(`isMetaPage`), and so is anything below `ACTIVITY_MIN_SCORE` — which is what lets
the section be EMPTY on a wiki where nothing has happened, instead of filling six
rows with `+` glyphs reading "created on" a day two years back. The weights live in
`DEFAULT_ACTIVITY_WEIGHTS` and a wiki overrides them in its `.wiki-reader.json`
`activity` block (above); each row carries a `+`/`~` glyph, the age of the signal
that placed it, and its full derivation in the row's `title=`.

**Every rail row shows a COMPACT age**, not a calendar date — `now` / `Nh` / `Nd`
up to `RAIL_AGE_MAX_DAYS` (99), then the day (`formatRailAge`, the one spelling
Activity rows, Pinned and the listing all use; the backlinks sort
still counts links). The full date stays one hover away on the `.wiki-list-meta`
element's own `title=` — on the element, because a child's `title=` wins the
hover over the width it covers — and the ARTICLE header is untouched, still
showing `created X · updated Y` in full. Three surfaces name that day — the cell,
the meta `title=` and an Activity row's `why` sentence — and one rule keeps them
agreeing: past the relative window the cell and the `why` take the winning
signal's own label (`pageDateSignal`, ONE derivation per row) **only when it is a
bare `YYYY-MM-DD`**, else the local day of the stamp. A bare day is the one label
with no instant behind it (`Date.parse` reads it as UTC midnight, so re-deriving
it renders the 14th for an authored `created: 2026-01-15` west of UTC), while a
time-bearing label has one — and `store.ts` passes any STRING `created:` through,
so the label is whatever `Date.parse` accepted, at whatever width. That is a guard
on unvalidated input rather than a repair: measured 2026-09-13, every frontmatter
date on all three registered wikis is already a bare day. The hover
`title=` is the exception by design: it shows the label verbatim whatever its
shape, since it is where the full date belongs.

⚠️ **Activity CLAIMS its pages before Pinned does**, so a page that is
both new and pinned renders once, at the top, under Activity. Claim ORDER is the
only thing deciding that — see `buildRail`.

⚠️ **`Recently opened` is GONE** (2026-09-13). It was a folded third section
holding the last six pages the reader opened, and it carried a rule set of its
own — the page being READ was skipped there (its `.active` row must not be inside
a closed `<details>`), the fold's open state was carried across re-renders, a
`clear` affordance was gated on every facet being inert, and every navigation
bumped a token so a response that lost a race could not write itself to the head
of a persistent list. All of it is deleted, along with the `recent` section, the
`fold`/`clear` header fields, `resolve`'s `skip` predicate, `buildRail`'s `active`
input, `railFacetsInert`, `pushRecent` and `navToken`. The rail is Activity, then
Pinned, then the listing: Activity answers "what happened here" from the wiki's
own dates, and a ★ answers "keep this" deliberately — an automatic list between
them said neither, folded away where nobody read it. A ★ is how a reader keeps a
page now. The dead `muninn.wiki.recents.v1:*` keys are dropped by a boot-time
`purgeRecentsKeys()` (below).
Acceptance: `e2e/wiki-rail-activity.spec.ts`, whose fixture wiki is a real git
repo with backdated commits — the dates are git's, so a fixture written a
millisecond ago proves nothing. The inverse holds for every OTHER fixture wiki:
written all at once, every page is brand new and Activity claims six arbitrary
rows, which is why `e2e/settled-wiki.ts` exists.

Client-only, per browser, per wiki. The rule is one pure function —
`buildRail` in `views/components/wiki-recents.ts` returns the whole ordered list
of headers and rows and `renderList` only paints it — with the localStorage half
in `wiki-recents-store.ts`, the same pure/DOM split as the rail's drag handle
(`wiki-rail-width.ts` + `wiki-rail-resize.ts`).

The pin key is suffixed with the wiki's canonical name (`""` for the default
wiki), so a browser reading two wikis keeps two lists:
`muninn.wiki.pins.v1:<wiki>`. Its dead sibling `muninn.wiki.recents.v1:<wiki>` is
REMOVED once per rail boot by `purgeRecentsKeys()` (`wiki-recents-store.ts`) —
idempotent, so it needs no "have I run this?" flag, which would itself be a key
nothing ever removes; backwards over `localStorage.key(i)`, since `removeItem`
re-indexes the store and a forward walk skips the key that slides into the index
just removed; and matching `RECENTS_KEY_PREFIX` and nothing looser, because
`muninn.wiki.` would take the pins key and `muninn.wiki.last.v1` with it.
`RECENTS_KEY_PREFIX` survives in `wiki-recents.ts` for the purge (its one production reader) and the e2e fixture that seeds a dead key. The modules keep the `wiki-recents` name: a rename touches every import for no behaviour change. The purge is pinned by `e2e/wiki-rail-pins.spec.ts`, not by the activity spec.
The rail's third key is
`muninn.wiki.railWidth.v1` (PR #501), which is NOT per wiki — a width is a
property of the reader's screen, not of the wiki. Same rule for the fourth,
`muninn.wiki.panes.v1` (`wiki-panes.ts` rules + `wiki-pane-toggle.ts` DOM):
`collapsed` when the reader folded the Connections/Ask pane to its 40px icon
strip (`]`, or the collapse button in its tab row). Focus mode (`F` / ⤢,
both side panes gone, `Esc` back) is deliberately NOT stored — a reload with no rail and no pane
is a "where did everything go" moment — but it survives in-page wikilink
navigation, since that is the reading it was entered for. Both are cleared FOR THE SITTING by
`revealRightPane()` when a stream is about to show something IN the pane (Ask,
Explain, Fact check) — the stored preference is not touched — and `]` is inert
while the pane is not on screen (focus mode, the Atlas tab, the ≤1100px media
rule: the check is the pane's computed display), so a keypress with no visible
effect can never persist one. Acceptance:
`e2e/wiki-pane-toggles.spec.ts`, bounding boxes only.

Two more keys, owned by `views/components/wiki-home.ts` (pure rules) + `wiki-home-store.ts`
(the storage half; the shell and the site nav apply them): `muninn.wiki.last.v1` — the wiki last opened BY
URL, global — which the nav's "Wiki" link rewrites its href from and a bare
`/wiki` `location.replace`s to when the stored wiki is still in the picker (the
`WIKI_DIR` override, rendered as `""`, is never redirected away from); and
`muninn.wiki.startTab.v1:<wiki>` — the Hubs / Timeline / Atlas tab, also carried
as `?view=timeline|atlas` on the overview URL (Hubs = absent), so Back from an
article and a reload land on the tab the reader left. The breadcrumb's wiki crumb
is the link back to the overview; a tab click `replaceState`s, never pushes.

**`?project=` is the reader's one FACET in the URL** (#509). It is read into
`filters.project` at boot and on popstate, and on every LATER listing adopt only
re-validated against the payload's `projects` map — never re-read from the address
bar, because an article URL is pushed by `articleUrl` and a stashed refresh applied
at the top of the next click would otherwise wipe the filter (measured, the first
cut). Unknown/blank value ⇒ whole wiki and the param deleted; a known value is
carried by every pushed article URL, `currentStartUrl()` and the crumb `href`
(rewritten in place by `refreshCrumbHref`, not by re-rendering the breadcrumb, which
closes the chat/share dialogs). ⚠️ The reader has THREE URL writers —
`writeProjectParam`, the tab click's `replaceState(currentStartUrl())` and
`goToStart` — and only the first keeps `location.hash`; a property fixed on one is
not a property of the reader. Back/Forward that moves the project repaints with
`autoOpen=false`, so a deliberately collapsed Filters stack stays collapsed.

⚠️ **relPath identity has ONE boundary: entries are normalized on the way into
storage** (`parseRelPathList` on read, `togglePin` on write), so
every comparison downstream is exact by construction. Leaving it to each
comparison was the bug five times over — and fixing only the two READ halves
(`buildRail` and the DOM painter) left it alive with a worse label: the star read
"Unpin this page", the click appended a SECOND entry for one page, and that page
then rendered twice under a `#wikiCount` that said otherwise. The count cannot
see it — it counts distinct pages, so it read 12/12 with 13 rows on screen; only
the row count can. `buildRail` also dedupes by PAGE rather than by stored string,
so its "every page appears exactly once" invariant does not depend on an upstream
that a key written by an older build can violate.

relPaths are stored, never names: a wiki with same-stem pages resolves a name to
whichever page registered first, and they are resolved back through
`findPageByRelPath`.

Six things are deliberate and easy to undo by accident:
- **Sections MOVE a row, they never copy it — every page is on screen exactly
  once.** Leaving the listing complete and letting a pinned page render twice
  was wrong in five measured ways at once: `.wiki-list-item[data-relpath=…]`
  stopped naming one element (a strict-mode violation for four existing e2e
  specs), the open page got two `.active` highlights, `#wikiCount` disagreed
  with the rows on screen, `e2e/wiki-refresh` went red counting rows, and the
  rail grew a row on every article view.
- **A facet NARROWS Pinned, only a query hides it** (`railSectionsVisible`,
  PR #504). The pins resolve from the filtered pages, so under `type=plan` the
  section is exactly the plans the reader pinned. The first cut hid it on any
  facet — the reader lost their pins the moment they picked a type, for a
  contradiction (a row from outside the filter) that could never render.
- **Meta pages (`index`/`log`/`CLAUDE`, any folder, by stem) sink to the bottom
  of BOTH recency sorts** (`isMetaPage` in `wiki-filter.ts`), and `buildRail`
  renders the sunk run under a `Bookkeeping` header (`metaTail`, set by
  `renderList` for the two recency modes only). "Recently added" sank them from
  the start; "Recently updated" — the default sort — did not, so on mimir and
  jarvis alike two of the top three rows were bookkeeping (measured
  2026-09-02). The header
  is not decoration: without it the date column of a descending list jumps
  back to today at the tail and reads as a broken sort. It is a recency-LIST
  affordance only: under a query the rows are exactly as today, and a rail that
  is meta pages ALONE has no tail to explain and renders plain — lifted rows
  count as "above", so a meta-only remainder under Pinned keeps the header
  (fix round 2 shipped it under "Other pages"; the split's reachable cells are a
  table in the test). The sink is by
  stem, so a hand-edited CLAUDE.md goes with them — accepted, the header says
  where.
- **`#wikiCount` counts DISTINCT rendered rows**, not query matches. Under a key
  jump that can exceed what the query itself matched, because the jump reads the
  facets without the query.
- ⚠️ **A bare four-digit run in 1900–2099 is a YEAR, never an issue number.**
  mimir files pages as `archive/<yyyy-mm-dd>-<topic>.mdx`, so a date is how a
  reader finds one there — and as a bare key `2026` resolved to **121 of 485
  pages**, pushing the query's single real match below eight unrelated ones.
  Requiring a `<prefix>-<number>` token instead was tried for one round and
  reverted: it narrowed recall (`Sak 7588 løst` stopped being a reference), no
  test pinned it, and it does not close the case anyway — `retro-2026` and
  `q1-2026` are ordinary tag shapes that satisfy it exactly. A PREFIXED
  `MELOSYS-2026` still
  resolves — naming the project is the only way anyone could tell the two apart.
  Every candidate the query yields is tried in order and the first that RESOLVES
  wins, which is what makes a permissive parse free.
- ⚠️ **The ★ is `tabindex="-1"`, and hidden-until-hover only inside
  `@media (hover: hover)`.** As an ordinary tab stop it put one per page ahead of
  the rail resizer (485 on mimir, 953 on jarvis) in a list whose rows a keyboard
  cannot open anyway. `pointer-events: none` on an invisible button was INERT for
  the case it was written for — Chromium applies `:hover` on touchstart, so the
  star became clickable before the click dispatched and a tap in that slot still
  pinned instead of opening the page (measured with a real tap: pinned 1, article
  0). Nothing invisible may be hit-testable, and on a device that cannot hover
  the only way to satisfy that is to SHOW the star, so the reveal is scoped to
  `@media (hover: hover) and (not (any-pointer: coarse))` — `hover: hover` alone
  left the HYBRID cell open, since a touchscreen laptop with a mouse reports it
  and a finger tap in an invisible star's slot pins again. Of that media state
  space's four cells, two are pinned by tests, the hybrid one is **not
  constructible in Chromium's emulation** (touch emulation forces `hover: none`
  regardless of `Emulation.setEmulatedMedia`, and `setTouchEmulationEnabled`
  forces `hover:false` and `any-pointer:coarse` together) and is correct by
  construction only, and the fourth is benign. Two caveats: that unbuildability
  is a CHROMIUM fact and `playwright.config.ts` runs only Chromium, so a WebKit
  or Firefox project could pin it; and `not (…)` is MQ4 boolean syntax, so a
  browser that cannot parse it (Safari < 16.4, older Firefox) drops the whole
  block and shows the star on every row — which is the benign direction. It also shares
  one flex slot with the date (`.wiki-list-end`) so it costs the row its own
  width and not the row's 8px gap as well — as a sibling of the title the pair
  measured 21px off `.wiki-list-title` on every row. That slot is also the one
  that WRAPS when a row's floors no longer fit it (see the row-layout rules under
  Attachments); it is last in source order for exactly that reason.

⚠️ **The ★ toggle does NOT re-render the list.** It repaints that one button
(`paintPinState`) and the sections rebuild at the reader's next render. This is a
class fix, arrived at after three rounds on one state space — (render cause ×
scroll position × whether the list reorders) — each of which produced a different
defect: a numeric scroll restore moved the row at the cursor ~96px, so a second
click pinned a DIFFERENT page; the anchored restore that replaced it threw the
reader down the list on a sort change and hid the new `Pinned` header when
pinning at the top; and two more cells of it shipped unpinned. Painting one
button deletes the space instead of choosing a fourth point in it, and the
painter reads the WHOLE pin list back rather than the clicked row — `togglePin`
displaces the oldest pin at `PINS_MAX`, so a toggle at the cap flips two pages
and "repaint what was clicked" left the other one lit and doing the opposite of
its own label. `renderList` is back to the plain `scrollTop` restore it always
had.

⚠️ **Residual**: "nothing moves" is true of the CLICK, not of every later render.
The render that first paints the new section can be the background listing
refresh rather than one the reader caused, and the section then appears on a
repaint nothing on screen explains — measured at ~50px on top of the ~46px that
refresh already shifts content by, which is pre-existing and unrelated to pins.

Acceptance: `views/components/wiki-recents.test.ts` (the state space, enumerated),
`views/components/wiki-recents-store.test.ts` (the purge, against a fake storage —
what it removes AND what it must not) and `e2e/wiki-rail-pins.spec.ts` (two temp
wikis in ONE process, so a globally-keyed store cannot pass).

## Attachments — the rail's groups (`pairAttachments`, `store.ts`)

A wiki page is not always one file. A plan carries its prototypes, an `.mdx`
carries the diagram it embeds, a superseded plan sits beside its successor — and
the rail listed every one of them as a peer row, or (for a same-stem `.html`)
did not list it at all. The store now PAIRS them and the rail FOLDS them.

**Four rules, all scoped to ONE FOLDER, first match wins**, recorded on the child
as `pairedBy` so the rail can say why on hover:

| rule | shape | `pairedBy` |
|---|---|---|
| 1 | `x.html` beside `x.md`/`x.mdx` | `stem` |
| 2 | `x-prototype.html` / `x-prototype-N.html` beside a page at `x` | `suffix` |
| 3 | the markdown page carries `<Embed src="./child.html">` | `link` |
| 4 | the child's frontmatter names `superseded_by: [[successor]]` | `superseded` |

A META-stemmed `.html` beside its own meta markdown page (`index.html` +
`index.md`) is dropped one layer ABOVE the pairing pass and never reaches it, so
rule 3 cannot pair it however many pages embed it — unchanged from before
attachments existed, and `/api/wiki/html` still serves the dropped file by path,
so the embed on the page renders.

The child keeps its own row identity — its own `relPath`, page route, pin,
Activity glyph and backlinks. `parent`/`pairedBy` ride `/api/wiki/pages` (they
are ordinary `WikiPageMeta` fields, one short string each). The store's matching
`children` array does NOT: `toListing` strips it, because `buildRail` rebuilds
every group from the `parent` links of the pages the FACETS left on screen, so a
server-side child list is payload no consumer may believe.

⚠️ **Rule 1 changes the same-stem DROP, and only in one direction.** A same-stem
`.html` in the SAME folder is no longer dropped: it stays in `pages` as a child,
and `index.shadowed` no longer lists it. Measured on the live wikis, that is
`shadowed` 6 → 1 on one and 7 → 0 on the other. Everything else about the
precedence rule is unchanged — a same-stem `.html` in ANOTHER folder is still a
collision and still dropped with its `shadowed` entry (the 1 that remains), and
`.md` still shadows a same-folder `.mdx`, which is an authoring mistake rather
than an attachment.

**The un-drop reads the POST-drop set, and that is load-bearing.** The exception
applies only when the same-folder markdown twin itself SURVIVES: with
`a/x.mdx` + `a/x.html` + `b/x.md`, the `.mdx` is dropped by the cross-folder
winner, so the `.html` is dropped with it and keeps its `shadowed` entry
(`shadowedBy: b/x.md`). Judged pre-drop it survived as a top-level orphan —
absent from `shadowed`, counted as a stem collision, and growing a folder prefix
onto `b/x.md`.

**The markdown page keeps the name, through ONE mechanism: a rule-1 child
registers no stem key at all.** Registration order is unchanged (relPath, first
wins) — after the drop, no two SURVIVING pages of different extensions can share
a stem by any other route, so an extension-rank sort over that pass could decide
nothing the skip has not, while it DID re-order the title/alias pass and flip
resolutions between two pages that merely share an authored title. The title pass
therefore stays in relPath order, with rule-1 children registering **last**: an
attachment's `<title>` is a key that did not exist before the un-drop, so it
never takes one from a page already reachable by it, and still names the diagram
where nothing else claims it. Measured over both live wikis, old vs new: **0
changed key resolutions and 0 changed `displayTitle`s**; the only difference is
the new titles the un-dropped pages add. Three more places read the pairing:
`stemCounts` and the display-title stamping loop both skip a rule-1 child (or its
parent grows a folder prefix), and `stemIsUnique` (`wiki-routes.ts`) skips it too
(or `resolvePageRef`'s stale-relPath fallback 404s explain, share and fact-check
on every page that has an attachment).

**Rule 3 reads embeds, not links.** `extractEmbedTargets` reads the BODY
(`stripFrontmatter`) with fenced and inline code masked (a plan page QUOTING an
`<Embed>`, in prose or in a frontmatter block scalar, adopts nothing), matches
only the two line-owning spellings `tryParseComponent` accepts (`<Embed … />` and
`<Embed …></Embed>` — a bare `>` never closes, a tag or a `>` on the next line is
not a tag, and trailing prose makes it not a block), runs each tag's attributes
through the parser's own `ATTR_RE` and then `parseEmbedAttrs` and
`resolveEmbedRelPath` — the same accept and resolve rules the reader renders
with, so a `src` the renderer refuses pairs nothing — and feeds the pairing pass
ONLY: `index.outgoing`, the backlinks, the Atlas graph and the lint checks are
untouched, because an embedded diagram is part of the page while a cited one is a
peer. An html embedded by two or more pages belongs to neither.

**Rule 4 is same-folder too, and the folder is RESOLVED, not discarded.**
`superseded_by: [[archive/old-plan]]` names a page in `archive/`; re-scoping that
bare stem to the child's own folder pairs it under whatever same-stem page lives
there. A target naming another folder — or nothing — pairs nothing.

**A META page (`index`/`log`/`CLAUDE`) is never a parent, under any rule.** They
are per-folder plumbing, and one lookup enforces it for all four rules at once.
Under rule 1 that means a same-stem `index.html` keeps its pre-attachment DROP
(there is no page for it to fold under); under rule 2 a `log-prototype.html` is an
ordinary top-level row.

**The pass is one level deep, both directions closed.** An html child can never
collect children (every rule needs a markdown parent), and a rule-4 pair is
DROPPED when it would nest — when the child carries attachments of its own, or
when the successor is itself superseded. The rail renders one level; a
grandchild would be hidden inside a fold nothing opens. The rule-4 candidates are
collected before any of them is applied, so the outcome does not depend on the
walk order.

### In the rail

`buildRail` emits a child under its parent (open) or not at all (closed), and the
one-row invariant is unchanged — sections MOVE a row, never copy it:

- **Activity ranks PAGES, not groups.** A child it ranks is emitted in Activity
  as itself (with its `pairedBy` and its parent's title in the hover) and leaves
  the parent's chip count; a parent it ranks takes its open group with it, so a
  group is never split across two sections. A pinned child is lifted the same
  way — the ★ is the reader's own choice. **Both lifts are computed BEFORE the
  first row is emitted**: the chip stands for the rows the group is hiding, so it
  has to be counted against every child's FINAL placement, and a child ranked
  BELOW its own parent was still unclaimed when the parent's chip was counted. A
  lifted row keeps the hover sentence and loses the INDENT — drawn under whatever
  happens to be above it, an indent claims a parentage the rail invented.
- **A child whose parent is itself a child renders as an ordinary row.** One
  level deep is the store's invariant, not a promise about the payload the rail
  is handed, and a two-level chain (or a cycle) put both pages inside groups
  neither of which was emitted — two rows silently gone.
- **A closed group emits no child rows**, so `rail.shown` — and with it
  `#wikiCount` — goes DOWN, and the chip says by how much (`3 attached`,
  `1 superseded`, joined with ` · ` when mixed). **The chip has TWO forms and
  renders both**, one hidden by CSS: the full label above, and a COMPACT
  `3 · 1` that the row falls back to when the space left beside the title cannot
  hold the words. The words are moved, not dropped — `title=` and `aria-label`
  carry the full label in either form. See the row-layout rules below.
- **A query flattens everything.** Groups are for browsing; a hit inside a closed
  group is a result the reader asked for and cannot see.
- **The open page's group is forced open**, whatever the store holds — and its
  chip says so rather than toggling: `isOpen` is `forced || stored`, so a click
  could only write a stored key nothing on screen reflects. The row (and the
  `Bookkeeping` header) carries `forcedOpen`, and the painter renders a disabled
  control, which is also what stops the click reaching the store at all.
- **A child whose PARENT the facets filtered away is an ordinary row** — folding
  it under a page that is not on screen would delete it from the rail.

### The row's layout rules (`wiki-page.ts`, constants in `wiki-rail-width.ts`)

A rail row is six things — type dot · title · group chip · status pill · ⚑ ·
★+date — and only the title is elastic. At the 260px rail (`RAIL_WIDTH_MIN`, i.e.
any window under 1100px) the title gets what the 226px content box leaves after
the row's other parts and one 8px gap per part after the first. Measured on
mimir 2026-09-18 (the reviewer re-derived every term): dot 7; status pill
44–76.3 (`superseded` is the widest); ⚑ 6.3; ★+date 25.7 as an age or 74 as a
full date; an Activity row adds a 10px glyph and its gap; a chip row adds the
compact chip (29.4–74.5) and its gap. So a chipless pill + ⚑ + age row keeps
72–99px of title (the floor exactly on the `superseded` + age row: 226 − 32 −
7 − 76.3 − 6.3 − 32.5 = 71.9), an Activity row 80, and a full-date row ~50 —
under the floor, which is the shape that wraps at 260 (17 of 18 wrapped
chipless rows; the 18th is the widest pill beside an age). #557's comment said
"143.4px plus 40px of gaps, 42.6px left" and #559's first two drafts each
replaced it with another single sum; the terms above are what re-derives.
Two rounds of distributing that proportionally (the chip shrinkable, then the
title on a 40% basis) each produced a 10px title and a count clipped to `10 · 1`.
A share of too little is still too little, so each element has a rule instead:

- the **title** has an absolute floor, `RAIL_TITLE_MIN` (72px ≈ 9 characters),
  and flexes from a 0 basis — from its CONTENT width it out-weighs the chip in
  the shrink distribution, which is how 6 of mimir's 8 real group rows rendered
  `1 atta…` beside a comfortable title;
- the **chip** never clips its digits: below a measured breakpoint it swaps its
  words for its counts (a container query on the row's REMAINING space), and one
  breakpoint per label-WIDTH class — a short one-kind label (the default:
  `N attached`, `N shipped`, `N pages` at up to two digits), a long one-kind
  label (`is-long`: the word `superseded` at any count, or any one-kind word at
  three digits) and a two-kind label (`is-wide`) — since `99 attached`,
  `99 superseded` and `99 attached · 99 superseded` are 85.5, 100.3 and 170.6px
  of chip and a single threshold sized for the long form strips the words off
  every short chip, while one sized for `1 attached` (what #557 shipped) paints
  `10 supersede…` at the 260px rail. The painter also sets a DIGIT class from the
  compact label (`counts-narrow` for one count of up to three digits,
  `counts-wide` for a four-digit, three-digit-pair or three-plus-count one),
  which picks the `.wiki-list-mid` floor — 46, 62 or
  76px of compact chip beside the title's 72 — so a `3 attached` row with a pill
  and a ⚑ keeps one line at the 300px rail and a `120 · 100` chip wraps its row
  instead of overflowing onto the pill (`foldChipLabelClass`,
  `foldChipCountsClass` in `wiki-recents.ts`; budgets in `wiki-rail-width.ts`);
- the **pill and the ⚑** keep their intrinsic width — they are already the
  shortest form of themselves;
- and when the floors still do not fit, the **row wraps** to a second line
  (`flex-wrap`, with the ★+date slot last in source order and `margin-left:auto`
  so it stays flush right on the line it lands on). Nothing is hidden and
  `#wikiList` never scrolls sideways — the two failure modes the proportional
  rounds were choosing between.

`.wiki-list-mid` is the wrapper that makes this expressible: title + chip in one
box whose width IS "what is left on this row", which a query on the ROW could not
ask (every row is the rail's width; only some carry a pill and a ⚑).

**Fold state is per wiki**, in `muninn.wiki.folds.v1:<wiki>` beside the pins key,
same storage discipline (try/catch everywhere, normalized at the boundary, capped
on read and write). The key space is ONE flat namespace — a parent's normalized
relPath, or a `section:` sentinel — so PR 2's family keys join it with no change
to the store, the toggle or the parse. **Default is CLOSED**, which is why the
stored list is the OPEN keys: a reader who has never touched the rail carries no
key at all. **Bookkeeping starts collapsed** under the same store
(`section:meta`); its header stays and carries its count.

Acceptance: `store.test.ts` (the four rules, the nesting guards, the drop that
stays), `wiki-recents.test.ts` (the sections, with a child in every one of them
at once), `wiki-routes.test.ts` (the listing, `?name=`, `resolvePageRef`) and
`e2e/wiki-rail-attachments.spec.ts` (the chip, the fold, the count, the reload,
the flatten, and the contrast in both themes).

### Families and months (`wiki-groups.ts`)

The rail's SECOND grouping layer, behind one checkbox in the rail head —
`group families`, **off by default** and remembered per wiki. It is client-only:
a pure function over the listing's `relPath`s, the pairing the store already
made, and the wiki's own project names. On:

- **stem families** fold to one row with a status ROLL-UP (`9 shipped ·
  1 superseded`), and
- **the archive folds by month** instead, whenever the folder facet is `archive`
  and the sort is a date sort.

**The family rule, in full.** A family is the SHORTEST dash-separated stem prefix
of **two or more segments** that **three or more and at most twelve** pages in
the **same folder** share (folder = the whole directory part of `relPath`, not
the facet's first segment), excluding a prefix equal to a **project name**, with
**no nesting in either direction**: once `alpha-beta` qualifies,
`alpha-beta-north` is not a second family, and no family forms under a prefix
that is itself a family CANDIDATE (two or more segments, not a project name) and
exceeded the cap. So a 3-member `alpha-wiki-ask` does not fold under a 16-member
`alpha-wiki`, while a 10-member `alpha-tools-live` still forms under the over-cap
PROJECT name `alpha-tools`, which is never a candidate at all.

Six things about WHICH ROWS COUNT, each of them load-bearing:

- **The cap and the over-cap ban are judged on the prefix's TOTAL member count**
  — parents plus rule-4 children — so a slate does not start folding because part
  of it was superseded; **only the three-member formation threshold is judged on
  PARENT rows**, or a page plus its predecessor would read as a slate.
- **Families are FORMED over parent rows only**: `.md`/`.mdx` pages that are
  nobody's child. An `.html` page never counts at all, and meta pages are out —
  they sink to `Bookkeeping`.
- **A rule-4 child belongs to the family its SUCCESSOR belongs to**, never the one
  its own name points at. It then counts toward that family's cap and roll-up and
  renders inside its body, under that successor, one indent further in. A retired
  page whose successor sits in another folder — or in another family — is a piece
  of THAT work: counting it here would put one page in two slates while it renders
  in neither's body, and it would let a name push a prefix over the cap it is no
  member of. (A child of any OTHER pairing rule counts nowhere: it is an
  attachment of its parent.)
- **A bare DATE is never a family candidate** — `2026-07` and `2026-07-15` alike.
  A month is what the month grouping owns, and measured on the live wiki the
  family rule minting one did three wrong things at once: the same label formed
  TWICE (two subfolders of one month, indistinguishable on screen), a 13-page
  month went over the cap and BANNED a genuine 3-page slate nested under it, and
  the row said "these pages were written in July", which is what a date sort
  already says on every row. Being a non-candidate is also what stops it banning
  anything, exactly as a project name does not.
- **The `<YYYY-MM-DD>-<n>-fix-rounds-<prs>` filename shape is never a member and
  never a family.** Those pages audit a PR rather than carrying a piece of the
  work. (That exemption stays: it is about the SHAPE, not the date.)
- **Prefixes AND folders are matched lower-cased**, like every other relPath
  comparison in the rail, so `alpha-Foo-*` and `alpha-foo-*` are one family and
  the label is the lower-case spelling; `Notes/` and `notes/` are one folder.

**Labels are disambiguated across the whole render.** A prefix is unique only
within its folder, and the whole-wiki view draws every folder at once — two
`beta-flow-*` rows with identical label, `title=` and `aria-label` are two
controls nobody can tell apart. So when a prefix is used by more than one family
in the SAME render, each label carries its folder (`notes/beta-flow-*`); a unique
prefix is unchanged. A wiki-root family in such a pair reads `/beta-flow-*`, the
spelling the folder facet already uses for the root. The KEYS never move.

A month is the looser grouping of the two, deliberately: the exclusions above are
the FAMILY rule's. A month takes any dated rail row that is not a child and not a
meta page — an `.html` explainer and a fix-round report included — because "this
page is filed under August" is true of them whatever their shape.

**Months** key on `YYYY-MM` from the filename's date prefix, falling back to the
date the rail is sorting on when the name carries none. The filename first
because that is the date the page is ABOUT, while its `updated` stamp moves on
every typo fix and a grouping that reshuffles on an edit is not one a reader can
navigate by. The month (`01`–`12`) and the day (`01`–`31`) are VALIDATED, because
an impossible one is not a date and files the page under a bucket nothing else
can join; and the prefix ends at a dash OR at the end of the stem, so
`archive/2026-09-02.mdx` buckets by its filename too. A page with neither signal
joins no month and stays an ordinary row.
**Months come back newest-first and the rows are re-ordered to match**
(`orderPagesForGroups`): the rail's ordinary rule puts a group where its first
remaining member sorts, which on a real archive ordered the months
08 · 05 · 07 · 09 · 06 — an old page edited last week pulls its whole month to
the top. Families keep the ordinary rule: a slate interleaves with single pages
by age, which is the reader's own sort speaking.

**The keys, all three in the one folds store** (`muninn.wiki.folds.v1:<wiki>`,
the flat namespace the attachment section describes): `family:<folder>/<prefix>`,
`month:<YYYY-MM>`, and `toggle:families` for the toggle itself — a sentinel
beside `section:meta`. The plan wrote `family:<prefix>`; the FOLDER is in the key
because two folders hold a family of the same prefix on a real wiki, and a bare
key would make one reader's click open both.

A family key in the wiki ROOT has no folder segment: `familyFoldKey("", p)` is
`family:<prefix>`. Nothing else in the namespace can collide with it — a page key
is a relPath and every sentinel carries its own prefix — so the root is left
unnamed rather than given a spelling of its own.

**Two defaults, and each key spelling means ONE thing.** Every family and every
month starts CLOSED except one: the **newest month among the groups that actually
render**, chosen after the Activity/Pinned lift (`defaultOpenGroupKey`). So a
stored `month:<YYYY-MM>` always means OPEN and a stored
`closed:month:<YYYY-MM>` always means CLOSED, and the `closed:` spelling is only
ever WRITTEN for the group that defaults open — that row's `data-fold-key` IS the
`closed:` form, so the one generic toggle handler flips the right key with no
branch of its own. A key of the spelling that does not match a group's current
default is ignored, never reinterpreted; where a group has collected both (it
moved in and out of the default role), the one the reader wrote LAST wins, which
is the head of the list since `toggleFold` prepends.

Two things this replaced, both measured: the default-open month was chosen BEFORE
the lift, so on a real archive under "Recently added" — where every page of the
newest month is also the freshest thing on the wiki — Activity lifted all of it
and NO month was open; and the one key spelling meant CLOSED for the default
group and OPEN for everything else, so the day a new month landed (or a facet
filtered the newest away) a reader's deliberate close silently became an open.

**The `toggle:` sentinel is exempt from `FOLDS_MAX`** and hoisted to the front of
the stored list. It is a MODE, not one of the fold exceptions the cap bounds:
capped with them it was evicted after ~200 fold opens and the feature turned
itself off, indistinguishable from never having been enabled. Hoisting is what
makes the exemption hold on the way back IN, since the READ caps at the same
number.

**In the rail** (`buildRail`), the one-row invariant is unchanged and a group row
is **not a page**: it has no `relPath`, opens nothing and is not counted by
`#wikiCount`, so a closed family lowers that count by exactly its members.
A member the Activity ranking or the reader's pin lifted leaves the group for
that render and leaves the roll-up with it; a member that is itself a PARENT
keeps its own attachment group inside the family body, one indent further in
(`.wiki-list-item.member.child`); and a query flattens groups exactly as it
flattens attachments.

**The open page's group is forced open** — through its attachment parent when the
reader is on a CHILD — and renders the same disabled control an attachment chip
does, but **only while that page is still one of the members this render DRAWS**.
Lifted into Activity or Pinned it is already on screen one section up, so the
family is not hiding it and renders on the reader's own stored state with a live
chip instead.

The roll-up is a CENSUS of the slate, not a count of hidden rows: it is
`plan_status` counts in the facet's order (unknown words, the neutral `unmarked`
included, after the known statuses in their own alphabetical order), superseded
children included wherever the rail happens to draw them — a child rendered under
its own successor inside the body still counts. **Only the LIFT takes one out**:
Activity or a pin took the member, the child, or the child's successor — so the
census reads the lift and never "what has been painted so far", which is a fact
about the sort rather than about the slate. That is the rule the code states; the
sort-dependent roll-up it was found beside — one unchanged slate measuring
`3 shipped` with a successor above the family and `3 shipped · 1 superseded`
below it — was a child counted in the wrong family, and **SUCCESSOR membership is
what closed it**: a retired page whose successor is not a member never reaches
this census at all. The attachment chip is the one that counts rows. A month's
chip counts pages instead — every page in it says the same thing about itself.

The group row reuses the parent row's furniture — the same caret, the same chip
with both label forms and the same `.wiki-list-mid` container the width rules
measure. It takes ONE number of its own, `RAIL_GROUP_CHIP_SWITCH`: status words
are shorter than "attached", so a two-count roll-up priced at the ATTACHMENT
chip's worst case went `display:none` at a mid of 253.6px — exactly the 300px
shipped rail, which left `9 shipped · 1 superseded` hover-only on every rail
anybody has. A one-kind roll-up keeps `RAIL_CHIP_SWITCH_SHORT`, which its 61–80px
was already sized for — except a one-status `N superseded` slate, which carries
the page chip's `is-long` class and breakpoint (inert there: a group row's mid
is ≥ 213px). The page-row
constants were re-budgeted by the layout follow-up (above), not by this change.

**The sort row's third control wraps, and it is the TOGGLE.** `group families`
is last in source order and flex wraps from the end, and `#wikiCount` carries
`margin-left: auto`, so the select and the count keep the line they shared before
this row grew a third control. The count's box is on the select's line at every
width. **The width at which the toggle joins them is a fact about the COUNT,
not a constant**: it moves with the rendered glyph width of `#wikiCount`'s text
(a narrow `1` buys two pixels), and with nothing else on that row — the folder
select lives in the `#wikiFilters` details block, not here. Measured at a 1400px
viewport, walking the rail one pixel at a time — a listing reading `149 / 545`
wraps through 321 and shares one line from 322; `440 / 545` from 324; the e2e
fixture wiki reading `17 / 18` (grouping off) from 305 and `8 / 18` (grouping on)
from 301. Any single number quoted here without its count text is one of those.

Acceptance: `wiki-groups.test.ts` (the rule's state space, on synthetic names —
a private wiki's file names are a disclosure in a public repo),
`wiki-recents.test.ts` (the arrangement: the lift, the forced-open family, the
one-row invariant with both layers at once) and
`e2e/wiki-rail-families.spec.ts` (the toggle, the roll-up, the count, the
reload, the flatten, the month defaults and the contrast in both themes).

### Series (`series:` / `series_label:`, `groupSeries`)

The rail's THIRD grouping layer, and the only AUTHORED one. Families and months
fold what a filename says; the work a reader returns to is spread over stems and
folders — a plan, its successor plan and the blog explaining them are three
unrelated rows — and "the latest plan in this piece of work" has no row at all.

**Two frontmatter keys.** `series: <key>` on every member, one short authored
slug; `series_label: <text>` on the HEAD page only, so renaming a series is one
edit and never breaks the key its members share. Read in `store.ts`'s index pass
beside `superseded_by` and with the same tolerance (a scalar, or the first entry
of a flow list; trimmed; anything else ignored). **The store keeps the raw
string; the GROUPING folds it** — trimmed and compared without case
(`seriesFoldKey`), because the folds store lower-cases every key it compares:
`Wiki-Provenance` and `wiki-provenance` minted two groups whose `data-fold-key`
was one string, the second registration overwrote the first, one series' pages
vanished from the rail and the other's rendered twice. Reporting the two
spellings stays the wiki linter's job — it reads the INDEX, not the rail, so
nothing is hidden by folding them here. Both ride `toListing`'s
rest spread on all three callers and are deliberately NOT in the provenance
opt-in: the rail groups by them on the hot listing, exactly as it facets by
`project`.

**Membership is ONE function**, `seriesMembersOf(all, key)` in
`wiki-groups.ts`: a page carrying the key is a member when it is a parent row,
or a `superseded` child whose SUCCESSOR is a member. A child of any other
pairing rule is an attachment (a prototype, an exported twin) and counts
nowhere however its frontmatter reads. `groupSeries` and the reader header both
call it, which is the only reason `N pages` and `N of M shown` can be trusted to
be about the same set — the header re-deriving it with its own filter is what
let an attachment child rename the strip and a case variant drop out of the
count.

**The head, and the newest plan.** The HEAD is the member carrying
`series_label:`; absent, the newest PLAN; absent that too, the newest member.
The label is read off it — its `series_label:` where it wrote one, else its own
spelling of the key — so a series nobody has labelled renders under the bare key
the HEAD wrote. **Two members carrying `series_label:` is not an error here: the
newer one wins, silently**, because the head is picked newest-first; the lint
reports the duplicate. The **newest plan** is the member carrying a NON-TERMINAL
`plan_status` (`SERIES_TERMINAL_STATUSES` = `superseded`, `abandoned` — a
retired plan's `status_date` is usually NEWER than its successor's, since
retiring a page is the last edit it gets, so without this the `▸` and *continue
at* named a dead page), newest by `seriesDateMs`. A blog or an archive page is a
member of the work but never "the latest", because *continue at* has to name a
page a reader can continue IN. The test is `plan_status`, not the `plans/`
folder: a plan filed elsewhere counts, a blog in `plans/` does not.

**`seriesDateMs` compares DAYS, not instants.** `status_date` else the git touch
date else mtime, each floored to its LOCAL day (`localDay`, the spelling every
rendered date in the reader uses) — measured on mimir, comparing a calendar day
against a git instant let any page touched later the same day outrank the plan
that had just affirmed its status. A tie on the day is broken by the RUNG (an
authored `status_date` beats a git touch) and then by relPath, so the order is
the same on every render. **The day is the PROCESS's local day**: `localDay`
reads the timezone this code runs in, so a git touch near UTC midnight floors to
one day in Oslo and another in a UTC pod, and the two hosts can order the same
pair differently. The rendered date cell always names the day the order used.

**Six rail rules**, extending the family list above:

1. **Always on.** Series are computed whether or not `group families` is
   checked: that toggle guards the two NAME heuristics, and a key is not a
   guess. A query still flattens everything, series included.
2. **Precedence for where a page renders: Activity-ranked > Pinned > Series >
   months/families**, and a series itself is placed by Activity (below). A
   series member Activity ranked renders in its series' Activity row; one it did
   not rank, and is pinned, renders under `Pinned`. Activity sits
   ABOVE months and families, not below: it lifts a family member out before
   the groups form, which is what a family's roll-up dropping a lifted member
   means. A pinned member Activity did not rank stays in `Pinned` — the ★ is
   the reader's explicit choice — and the fold shows a dim, non-clickable **ghost row**
   (`pinned above`, rendered AFTER the member rows: it is a footnote about a
   page already on screen, and interleaving it by date would cost the member
   rows their own order) so the roll-up's count and the rows on screen cannot
   disagree. **Activity does NOT lift a series member out; a ranked member
   moves the WHOLE series into Activity**, at the slot of its best-ranked
   member (a member's attachment child ranks for that member). A closed series
   there shows its ranked members under its row, up to `SERIES_PEEK_MAX` (3) in
   rank order, then a `+N more` row that opens the same fold. The difference
   from a family is deliberate: lifting a series' newest page alone renders the
   fold without the row it is about, and keeping the series in its own block
   below Activity hid the newest work under week-old rows (measured on
   melosys-kode-wiki: a 15h member sat below an 8d Activity top, and two
   diagrams embedded in a series member were lifted out alone). The `Series`
   block keeps only the series Activity did not rank. A pinned member that
   Activity ranked ITSELF renders in the series' Activity row, not under
   `Pinned` — Activity claims before Pinned, as it does for any page. A pinned
   member ranked only through its attachment child stays under `Pinned`, and
   the series still takes the child's slot. A member row in an Activity series
   carries the best signal that ranked it — its own, or its child's when the
   child ranked first — in its date cell. A series claims its members BEFORE
   `groupFamilies`/`groupMonths` are computed — `renderList` subtracts them
   (`withoutSeriesMembers`) — so two knock-on effects are accepted and pinned by
   unit tests: a family that drops below `FAMILY_MIN` **dissolves** into plain
   rows, and a prefix that was over `FAMILY_MAX` **may form**.
3. **Formed over the FILTERED set**, like families — but the LABEL, the member
   `total` and the newest plan come from the WHOLE listing, because each is a
   fact about the series rather than about the facet. Under a facet the row says
   `N of M shown` on its OWN LINE under the label: beside it, inside the label's
   `overflow: hidden; nowrap` box, it painted 15px of its 65 at the 300px
   default rail — clipped to nothing while a `toHaveText` assertion still
   passed. The series row's own roll-up is also a line under the name (#581),
   so the census is the line after it, and neither costs `.wiki-list-mid` any
   width.

   The members inside the fold are always NEWEST-FIRST by `seriesDateMs`,
   whatever the reader's sort — unlike a family or a month, which open in the
   sort's own order. The fold is a timeline of one piece of work and "where do I
   go now" is its first row.
4. **The open page's series is forced open**, with a disabled fold button that
   says so on hover (#557's F2 decision) — unless the open page is itself lifted into `Pinned`,
   or a closed series in Activity already shows it (or the member it is
   attached to, whose own chip then opens) as a peek row, where it is
   already on screen and forcing the fold would hide the reader's
   stored state behind a dead control. Fold state is stored like a family's, and
   a series NEVER defaults open, so it never uses the `closed:` spelling.
5. **`shown` / `#wikiCount` count a member once**, in the series (in Activity
   or its own block) — or under `Pinned` when it was lifted there. A ghost row is not a row and is not
   counted. The `N of M shown` census counts every rule-4 child of the filtered
   set, wherever it renders (inside the body, under a lifted successor, or as
   its own row when the reader pinned the child): the census says which of the
   series' members this render ACCOUNTS FOR, not which are painted — a closed
   fold paints none of them and still says `4 of 4`. Dropping the lifted-parent
   case read `1 of 2 shown` with nothing hidden and lost the roll-up's
   `1 superseded`. A FAMILY's census is deliberately the other way round: there
   the lift really does take the page out of the slate for that render.
6. **`latest` is not a seventh row element.** The newest plan's row carries a
   `▸` glyph INSIDE `.wiki-list-title` with the words on hover; the row's six
   elements are each budgeted in `wiki-rail-width.ts` and a seventh takes the
   title under its floor. Re-measured at 260 and 300 px against #559's baseline:
   no new wrapped row. The glyph is `--accent-light`, the token the series group
   row already carries: `--status-warning` measured 3.19:1 in the light theme,
   under AA for an 11px mark that is the whole claim.
7. **The series is one block** (#581). A 2px accent rail runs from the series
   row through every `.wiki-series-cont` row after it — members and their
   attachment children, ghosts, `+N more` — and caps on the last one
   (`:not(:has(+ .wiki-series-cont))`, since the rows are flat siblings). It is
   an absolute `::after`, not a border, so it costs no row width; under
   forced colours every segment, hovered or not, paints `CanvasText`. A series row carries NO chip: the
   name wraps to two lines and the roll-up is a line under it, one nowrap unit
   per count, so it wraps between counts and never clips one. The chip's fixed
   `RAIL_GROUP_CHIP_SWITCH` breakpoint ignores label length, and a five-status
   roll-up kept its full form at any rail over ~282px while the name fell to
   its 72px floor. Families and months keep the chip.

**No minimum and no cap.** A one-member series is a series with one page in it
so far, and a twenty-member one is twenty pages of one piece of work — neither
is the accidental folder-shaped fold `FAMILY_MIN`/`FAMILY_MAX` exist to refuse.

**The roll-up counts the folder where a member declares no `plan_status`** —
`blogs/` as `blog`, `archive/` as `archive`, everything else as `unmarked` — so
the roll-up line reads `1 in-flight · 1 shipped · 1 blog` rather than reporting a blog
and an archive report as the same nothing. Series-only: a family lives in one
folder, where the word would be the same on every member.

**The reader header.** A member's article head carries one line —
`Series · <label> · N pages · continue at: <the newest plan that is not this
page>` — plus a timeline of the members, oldest → newest, with the open page and
the shipped ones marked. Built from the listing the rail already holds, so it
costs no request, and through `seriesMembersOf` and `seriesDateSignal`, so it
can never report a different set or a different day from the fold: the timeline
is the fold's own order REVERSED, and each step prints the day it was ordered
by, mtime rung included. *continue at* never names the open page (a reader
usually arrives there from the `▸` row), is omitted when there is no other plan,
and clips its label at `SERIES_CONTINUE_MAX` (64 code points) with the whole
title on `title=` — a mimir plan title runs past 100 characters and took the
strip's whole second line. Beside it sits **`edit series`**, the affordance PR A
omitted rather than rendering inert — the editor below is what it opens.

**The editor** (`POST /api/wiki/series`, `wiki-series-routes.ts`; the popover's
pure half in `views/components/wiki-series-menu.ts`). One `⋯` opener on a rail
row and on a `Related work` row, one `edit series` in the reader header, and one
popover node shared by the three — so "only one open at a time" is a property of
the DOM rather than a rule to enforce. It offers four verbs: JOIN a series (or
type a new key), RENAME the label, MOVE the head, and REMOVE the page.

  - **The route is the FIFTH call site of `writeWikiPage`**, and the third of
    the three that write metadata in NO-LOG mode (the two `/plans` flips are the
    others; the fact-check append and the integrate apply both log and commit):
    no `log.md` line, no reindex, no commit. It DOES refresh the wiki index
    inside the write, because the rail reads that index behind a 5-minute TTL,
    and it reads the index with `refresh: true` BEFORE deciding too — the key's
    spelling and the one-label check are decisions made off that index, and the
    cached one is up to five minutes old. The frontmatter half is
    `setFrontmatterScalar` (`src/plans/frontmatter.ts`), so there is still
    exactly one line-upsert implementation; the label is written with its
    `after: "series"` anchor so the pair stays together through a head move.
  - **Who commits it.** mimir: the repo-sync loop. A BOT wiki: the daily
    `wiki-committer` sweeper, up to ~24 h later, under a `[sweep]` subject that
    bypasses that bot's own `wikiAutoCommit` policy. A standalone `WIKI_EXTRA`
    wiki outside `SYNC_REPOS`: **nobody** — the edit sits in the working tree,
    and the write logs one `warn` saying so (`src/wiki/series-committer.ts`).
  - **ONE page per call**, `{wiki?, relPath, baseHash, series: string|null,
    seriesLabel?: string|null}`. The status ladder, in full: **415** a
    `content-type` that is not `application/json` and **403** a cross-site POST
    (both `decideStampRequest`, before the body is read) · **403** read-only,
    instance or root · **400** a bad body, a non-markdown page, or one of the
    reserved basenames `index`/`log`/`CLAUDE` (`canEditSeriesPage`, the same
    predicate that decides which rows render an opener — without it the writer's
    own confinement answered **500**) · **404** an unknown wiki, an unknown page,
    or a target that vanished between the index read and the write · **503** a
    wiki directory that is not there · **422** a fence this must not edit, a
    list-valued key (block or flow), or a label carrying both quote characters,
    which the reader's unquote rule cannot carry · **409** a stale `baseHash`, a
    held write lock, or a label on a series another member already names
    (`twoHeaded`) · **200** `{relPath, hash, written, series, seriesLabel}`,
    parsed back out of the bytes the transform ended with — the FILE, never the
    TTL-cached index, which reported the pre-write pair on a noop and on an
    omitted field.
  - **The CAS base is `GET /api/wiki/page`'s new `hash`** (sha256 of the raw
    file, beside `meta` rather than inside the listing shape), and it is captured
    when the POPOVER OPENS — one per page the menu's verbs can write, held for as
    long as it is on screen. Read per write instead, the compare-and-swap covers
    the network round trip and not the seconds a human spends deciding: measured,
    an edit made while the menu stood open was silently overwritten. The page the
    reader has OPEN needs no request at all (its page payload carried the hash,
    and every write answers the hash it left behind, so the editor's own writes
    keep it current); a 409 stops the menu writing, names the page and refetches
    the listing, and the reader reopens with fresh bases.
  - **A head move is TWO calls**, each CAS'd, and the ORDER is the contract: the
    old head's label is cleared FIRST. A failure between them leaves a series
    with no labelled member, which the fold and the reader header render under
    its bare key — visible, and one rename from repaired — where the other order
    leaves two labelled members, which the rail resolves silently and only lint
    8.3(b) reports. Measured against a copy of mimir's `plans/`: the label-less
    state produces no `series-inconsistent` finding at all, so "visible" is the
    whole of its safety net.
  - **A new key is normalized to an existing member's spelling**
    (`normalizeSeriesKey`), since the fold is case-insensitive: joining `alpha`
    from a menu listing `Alpha` must write `Alpha` or the fold is unchanged
    while 8.3(a) gains a variant nobody chose. The same rule HEALS a variant on
    any write that touches a member's own `series:` line.
  - **A label belongs to a SERIES, not to a page.** Clearing the key clears the
    label with it — a `series_label:` on a page in no series names nothing and is
    read by nothing (the rail takes the label off a MEMBER, and the lint's census
    skips a page with no key) — and so does MOVING the page, when the request names no
    label of its own. The menu's join and new-key verbs send `{relPath, series}`
    and nothing else, so without that rule a page that was the HEAD of the series
    it is leaving carried that name into the one it joins: two labelled members
    there, the series it left silently un-named, and a 200 calling it success.
    The 200 reports the drop (`clearedLabel: {series, label}`, absent otherwise)
    and the popover stays OPEN to say which series has no label now, since the
    rail and the header fall back to its bare key and no lint check reports it. An explicit
    `seriesLabel: null` is the caller's own decision and reports nothing.
  - **The one-label check runs inside the TRANSFORM**, against the label that
    will be on disk when it returns rather than the one the request carried —
    they differ on exactly the write above. It fires only where THIS write puts
    the label on that series (the label line changes, or the fold does): a write
    touching neither cannot have created the fork, and refusing it would fail a
    noop over a wiki somebody else hand-edited two-headed.
  - **`order` is not a key and is not editable.** A series' order is DERIVED
    (`seriesDateSignal`), so there is nothing to write; re-ordering a series
    means changing a page's `status_date`, which is the `/plans` board's job.
  - **Read-only renders NOTHING**, on both mechanisms — not a dimmed control
    (#557's F2 rule), with the two selectors in `WIKI_READONLY_BLOCKED_SELECTOR`
    as the backstop and the route refusing 403 regardless. Neither does a row no
    series can claim: an `.html` attachment or a reserved basename renders no
    opener, by the same `canEditSeriesPage` the route 400s on.
  - **The `⋯` is revealed by its OWN row's hover and costs the row no width.**
    Both are measured failures of the first cut: one reveal rule keyed on
    `.wiki-list-item:hover` left a `Related work` row's opener permanently
    `pointer-events: none` (the click NAVIGATED), a later unconditional
    `opacity: 1` painted the rail's on every row, and the always-in-flow button
    took `.wiki-list-end` to 90 px and wrapped a plan row's title under
    `RAIL_TITLE_MIN` at the 300 px rail on CI's fonts. On a fine pointer it is
    absolutely positioned over the date it replaces on hover (the `▸` rule — the
    row's six items are budgeted one by one in `wiki-rail-width.ts`); on a coarse
    one it is visible and in flow, since a hover-revealed control is one a finger
    cannot reach.
  - **The header-less POST is the stamp route's known class**, inherited with
    `decideStampRequest`: a request with neither `origin` nor `sec-fetch-site` is
    allowed, so under `MUNINN_AUTH=off` anything that can reach the port can
    write this line. Stated, not fixed here — the answer is the auth switch.

Acceptance: `wiki-groups.test.ts` (formation, membership, the case fold, the
head and newest-plan rules incl. the terminal statuses, the day granularity and
its tie-break, the filtered/whole split, the two family knock-on effects, the
roll-up word, the `continue at:` clip), `store.test.ts` (the parse),
`wiki-recents.test.ts` (the block's position, the ghost row and its place after
the member rows, the census, the lifts, the forced-open rule and its pinned
exception) and `e2e/wiki-rail-series.spec.ts` (the chain end to end: the fold,
one row for two spellings of the key, the dissolution against an untouched
control family, the `▸` inside the title, the ghost, `N of M shown` — asserted
VISIBLE at 300 and 260px, since `toHaveText` passes on a clipped element — the
reader header agreeing with the fold, and the contrast of the label, the chip,
the census, the timeline date and the `▸` in both themes). The EDITOR's own acceptance is
`wiki-series-routes.test.ts` (every status code, the case-fold normalization,
the html and reserved-basename refusals, the one-label 409, the noop's honest
echo, the two write-time races via the `readFile` seam, the held lock, and both
read-only refusals through the test setters), `wiki-series-menu.test.ts` (the
menu model, the cap and its "N more" note, `canEditSeriesPage`, the head-move
plan, the escaping), `series-committer.test.ts` (which wikis have a committer)
and `e2e/wiki-series-editor.spec.ts` (acceptance 11: joining from a rail row
writes one line and moves the row inside the fold with `#wikiCount` unchanged,
the label rename touches only the head's bytes, the head move touches two files,
the removal drops the header in place, both read-only shapes — instance and
per-root — render no opener and 403 the POST, plus the fix-round half: an
out-of-band edit while the menu is open is refused rather than overwritten (both
writes of a head move), a `Related work` opener opens instead of navigating, the
rail's is invisible until its own row is hovered and takes the row no width, no
opener on a page no series can claim, a scroll inside the popover does not
dismiss it, focus returns to the opener, and the popover's contrast in both
themes).

### Worked-on recency (`worked-ledger.ts`, `workedMs`)

The rail's THIRD date axis, and the only one that comes from outside this
machine: **the day an agent session last WROTE the page**, read out of
claude-usage's `session_files` ledger. It exists because the other two collapse
under a mechanical edit — twelve pages joined into one `series:` all read `3h`
old on mtime, and a git touch date is flattened by ordinary small commits the
sweep threshold cannot tune away (measured 2026-09-21: four of twelve pages
sharing 09-15, three sharing 09-21, all from authored 1–3-file commits).

**One request, server-side.** `GET <CLAUDE_USAGE_URL>/api/files?root=<abs>&summary=1`
answers one row per page with a qualifying write — `{p, w, b?, s}`, `p`
wiki-relative and `w` epoch ms — with any session that wrote `bulk` (10) or more
pages under that root discounted WHOLE, upstream, where the corpus is in hand.
The worked date is **`max(w, b)`**: `b` is the page's newest bash touch (`sed -i`,
`cat >`, and since claude-usage #215 a python-heredoc `open(…, "w")` target),
under the same fan-out discount. Upstream sends `b` only on pages that also have
a qualifying write, so bash-only pages stay uncovered. A malformed `b` is
skipped, never rejecting the row. Measured on the mini 2026-09-23: 89 of mimir's
354 pages have `b` newer than `w`, 34 by more than 3 days. The BROWSER never
reaches claude-usage (tailnet viewers, mixed content under `tailscale serve`),
which is why the field is computed here and shipped on the listing.

**A page with no worked date is the ordinary case, not an error.** Absent means
one of four things and none of them is a failure: the ledger holds no write for
the page, every write it holds was discounted as a bulk pass, the memo has not
warmed yet, or this instance is pointed at no claude-usage. The plan measured
post-discount coverage at mimir 64%, melosys-kode-wiki 37%, jarvis 6% and capra
0% on the MINI's ledger; this PR did not reproduce those figures (the laptop's
ledger reaches back only to 2026-08-31, where mimir matched 12 of 12 returned
rows), so treat them as the plan's measurement rather than as properties of
every host. What follows from the shape rather than from the numbers: every
consumer falls back PER PAGE rather than treating absence as "old", and
`workedMs ?? pageTimeMs` is the whole key — on all four surfaces, since the fix
round below collapsed them onto one chain.

**The module's own contract is its docblocks**, not this page: `worked-ledger.ts`
owns the raw-row rejection, the root-spelling retry, the two TTLs in phase and
the six named degrades, and `store.ts` owns the post-pass and the match-rate
guard. What belongs here is the CROSS-MODULE map:

| Where | What it owns |
|---|---|
| `worked-ledger.ts` | the one fetch, the per-root memo, the root spelling, the degrades |
| `store.ts` | the index post-pass, `workedMs` on `WikiPageMeta`, `workedCoverage` |
| `wiki-filter.ts` | `workedSignal` — the ONE key — plus the sort mode and the row chip |
| `wiki-groups.ts` | `workedDateSignal`/`byWorkedDateDesc` (that key day-floored, falling back to `seriesDateSignal`), the fold, the Series section order |
| `wiki-browser.ts` / `views/wiki-page.ts` | the row's hover, the reader strip, the hidden `<option>` |

Four rules from those modules are worth restating because a caller can get them
wrong from outside:

- **A failure never blanks a good memo**, and neither does a SUCCESSFUL empty
  answer: a 200 carrying zero rows for a root the memo holds pages for is kept
  and warned about once, because nothing else about it would be visible — the
  axis simply goes blank and the sort option hides. It is HELD, not held
  forever: the empty answer still advances `fetchedAt` (or the TTL gate never
  holds and the root is re-asked on every index build — the back-off, defeated
  through the empty path), and once empties have persisted for
  `WORKED_EMPTY_RELEASE_MS` (1 h) since the last non-empty answer it is believed
  and the memo is cleared, under a warn of its own. A wiki that legitimately
  went N → 0 — every session under it later discounted, the root renamed
  upstream — would otherwise show dates for writes nobody claims for the life of
  the process.
- **The root is `path.resolve`d before the ask** (upstream refuses a non-canonical
  root with a 400, which the zero-row realpath retry cannot recover), and the
  spelling that ANSWERED is asked first on every later refresh.
- **A degraded upstream is backed off** on the caller's own TTL, so a service
  that is down or un-upgraded is re-tested once per TTL rather than on every
  index rebuild. Nothing on the HTTP surface waives it, `?refresh=1` included:
  the server cannot tell an operator's typed refresh from the browser's own
  focus refetch (every tab focus, 30 s throttle, per tab) or the series editor's
  post-write refetch, so a hatch keyed on it re-asked a dead service from a hot
  path — measured through three fix rounds before the hatch was removed. The
  release is time alone (one index TTL); a process restart is the deliberate
  "ask again now", since boot kicks with no age gate.
- **The boot kick is gated on the serving profile**: under `MUNINN_PROFILE=nais`
  the `wiki` route group is dropped, so there is no reader to warm the axis for
  and nothing is fetched.

**Path matching, and the guard that can actually fire.** Rows key on the
NORMALIZED wiki-relative path (`normalizeWorkedPath` — the index's own
`normalizeRelPath` plus a leading-slash strip, so one normalizer decides both
sides), deliberately looser than the git walk's raw-relPath keying: that walk and
the index read one filesystem through one tool, while this map comes from a
second process reading a case-insensitive filesystem through whatever spelling an
agent typed. The guard is a RATE (50%) over the rows RETURNED — an absolute count
carries no signal, since a healthy refresh leaves rows for pages since renamed or
deleted, while a root whose ledger spelling differs matches ~0%. It is gated on a
non-empty answer like its `GIT_DATE_MISS_WARN_RATE` sibling, and THROTTLED per
root: the condition is durable and the caller is not (five index builds produced
five identical warns). ⚠️ `returned` counts every `.md`/`.mdx` upstream knows
about under the root and cannot see the reader's `include` globs, so a wiki that
scopes its scan can sit under the floor legitimately.

**`worked` moves ORDER, never IDENTITY — the Decision this axis turns on.**
`seriesDateSignal` and its chain (`bySeriesDateDesc`, `newestSeriesPlan`,
`seriesHead`, `SERIES_DATE_RANK`) are UNTOUCHED, because they decide which page a
series IS about: `lint-series.ts` picks the head a `series_label:` fix writes on
with them, and `related.ts` orders the Related-work panel with them. A field that
is absent on a cold memo would make two lint runs over one corpus propose two
different heads, and one Accept would then write different bytes. A SEPARATE
comparator — `workedDateSignal`/`byWorkedDateDesc` — carries the display order
instead. `seriesHead`/`newestSeriesPlan` are safe under the reorder by
construction: both re-sort what they are handed with `bySeriesDateDesc`, whose
last tiebreak is the relPath and so is a TOTAL order. Pinned in BOTH directions
by `worked-order-invariant.test.ts` — identical lint findings, identical
`computeRelated` rows and an identical HEAD with `workedMs` present and absent,
AND a fold that really does reorder, so neither half can pass vacuously.

**ONE WORKED key, four surfaces — the fix round's own rule.** The worked rung of
`workedDateSignal` is `wiki-filter.ts`'s `workedSignal`, day-floored, so the rail
row in worked mode, the Series SECTION's order, the fold's members (via
`describeSeries`) and the reader strip all read one key with one future guard.
They did not, and the three consequences were measured on live mimir: a
`workedMs` of 2027 fell back in the rail while sorting first and printing
`2027-06-01` in the fold and the strip; a series whose frontmatter and file dates
disagree was PLACED by one chain and PRINTED by the other; and an expanded fold
read `09-21, 09-17, 09-17, 09-20, 09-15`, because its members sorted on a date
their own chips did not show.

⚠️ **The chain is worked-then-`seriesDateSignal`, and the second rung is fix
round 2's correction.** Fix round 1 fell an uncovered member back to the rail's
UPDATE chain, which on a COLD instance — no ledger, the mini, the first build
after boot, and 537 of mimir's 549 pages even when warm — lands on
`gitTouchedMs`, a date ordinary 1–3-file commits flatten: measured on a mimir
clone, 23 of 30 series folds reordered against `origin/main` and 25 of 30
collapsed to a single tie-day, i.e. to alphabetical, with the reader strip then
reading reverse-alphabetical. The WORKED rung still comes through the one
guarded `workedSignal`, so the fold and the row chip agree about a covered page;
a stamp the guard rejects falls through to each surface's OWN lower rungs — the
chip's update chain, the fold's series chain — and may be dated differently by
the two, the same class as an uncovered member; below it the fold keeps
`seriesDateSignal`'s own rungs (`asserted` > `git` > `mtime`), so two uncovered
members sharing a day order authored-date-first rather than by relPath.

The cost, stated so nobody files it: in Worked-on mode an UNCOVERED member is
ordered by the series chain while its own row chip still shows the update date,
so a fold can read non-monotonic across covered and uncovered members. The
authored chronology wins over a flat git date. And **the
fold's order is worked-first in EVERY sort mode** whenever the memo is warm, so
one wiki open on a warm instance and on a cold one can sequence the same fold two
ways under "Recently updated"; the alternative is a fold whose order depends on a
sort the fold does not display. What may legitimately disagree, also by design:
the fold's FIRST ROW need not be its head, its `▸` or the lint's proposed head.
The `⋯` series menu's option list stays on the IDENTITY chain — it is a write
surface.

**The Series SECTION's own order is a deliberate divergence.** The rail's rule is
that a group sits where the reader's sort put its first member; measured on mimir
2026-09-22, that left its 30 series carrying only 14 distinct newest-member days,
15 of them sharing one — half the section ordered by nothing but a title. So
`orderSeriesGroups` orders the section by each group's newest member's key FOR
THE MODE ON SCREEN in the three recency modes (ties falling back to the label) —
in `worked` mode that key is the FOLD's own comparator, so no group is placed by
a date its fold does not print, while `updated`/`created` keep the mode's own row
key and the section then follows the row chips while the fold stays worked-first,
so the two can differ for any member, covered or not —
alphabetically by label in `title` mode, and keeps FIRST APPEARANCE in
`backlinks` — where that already means "the group holding the most-connected page
first", and link counts do not tie the way a corpus of same-day dates does. The
members INSIDE a fold are unaffected: they are newest-first whatever the sort.

**The client's five quiet sites**, three of which failed silently on a two-value
test: `WikiSortMode` gains `worked` and `sortPages`' mode switch is EXHAUSTIVE
(its bare `else` sorted any unknown mode by `pageTimeMs`, so a forgotten branch
looked like it worked; the `never` makes that a compile error, and the RUNTIME
default — a stored sort value from an older build — falls back to the update
order rather than to the walk's directory order); `pageDateSignal`/`groupMonths`
take the third `which` value, resolved by the shared `recencyKindFor` rather than
by a hand-written map at each call site; `wiki-groups.ts`' `dateSort` gate and
`wiki-browser.ts`' `metaTail` both read the shared `isRecencySort` — a TYPE
PREDICATE — rather than testing two values (the first turned the archive's month
folding off, the second sank the bookkeeping rows with no `Bookkeeping` header to
explain the tail); and `views/wiki-page.ts` owns the
`<option value="worked" hidden>`. **The option is HIDDEN, not disabled, on a wiki
whose `workedCoverage.matched` is 0** — on a corpus written entirely by bulk
passes the mode is "Recently updated" under a second name (the corpus that shape
was measured on is named once, on `WikiIndex.workedCoverage`). An ABSENT
`workedCoverage` (a cold memo, a degraded ledger, an older server) leaves the
option as it is: "nothing is known yet" is not a verdict.

**"Worked on" is the DEFAULT sort wherever the option is shown**, and a sort the
reader picks is stored per wiki (`muninn.wiki.sort.v1:<wiki>`) and wins over the
default. The rules are the pure `resolveSortMode`: a listing with no coverage
answer (a cold memo after a restart) keeps what the select holds, so the rail
switches to `worked` on the first listing that reports coverage unless the
reader already picked a sort in that tab; a stored `worked` on a wiki the ledger
matched nothing for falls back to `updated`.

**The chip MARKS where a worked-on date came from** (`workedSourceOf`, shared
with the header): cyan + semibold (`--worked-ink`) when a session wrote the page,
an amber dot after it (`--changed-ink`) when the update signal is more than
`CHANGED_SINCE_MIN_MS` (24h) newer — a hand edit, a heredoc script, a lint or
sync commit the ledger cannot see — and a dotted underline on a FALLBACK date
(no ledger row, so the chip shows the update date). The 24h bound is measured:
11 of mimir's 60 covered pages with a later update day sit within a day, the
late-evening-edit-committed-next-morning shape. Colour is never the only cue.
In Activity, a `changed` row on a wiki whose worked gate is open gets the
fallback mark when the ledger has no row for its page. The other sort modes
answer one question each and mark nothing. Both tokens are their own because
the light values of `--status-cyan`/`--status-warning` measure under AA at
10.5px (3.68:1, 3.19:1 on white).

**In worked mode the row's hover names the signal** (`2026-07-02 (worked)` /
`2024-03-01 (updated — no session write recorded)`, `(added — …)` when the
fallback is a sweep-only page's creation date, plus a `changed <day>, no session
write recorded` line on a changed-since row — all from the pure `workedChip`), because the axis is sparse by
construction and a bare day would claim a worked date an uncovered page never
got. The suffix goes on the `title=` ONLY: `formatRailAge` reads the label as a
BARE day and would fall back to the stamp's local day for a decorated one,
shifting a frontmatter date west of UTC.

**The article header gets a `worked` slot** when the last listing reported
coverage (`pageHeaderDates(p, now, { ledger: true })`): `created X · worked Y`,
plus `updated Z` in amber only when a change landed after that session, and on a
page no session wrote the old created/updated slots with the update date
dotted-underlined and a `no session` note. On a wiki the ledger covers nothing
on, the header is unchanged — "no session" would be true of every page there
and say nothing.

**`workedMs` rides `toListing` onto the single-page route's rows too** — the
meta, the outgoing/backlink listings and the `related` rows — unread, at ~15
bytes each, exactly as `gitTouchedMs` does. Stated rather than stripped: the
three `toListing` callers share one rest spread, and an opt-in for a field this
small is more machinery than the payload it saves.

Acceptance: `worked-ledger.test.ts` (the parse — including the raw row form and
the clip flag — the memo's empty-answer and retry-throw rules, the root
normalization and the remembered spelling, the back-off, the non-object throw,
and the rate guard at its boundary and its throttle),
`worked-order-invariant.test.ts` (the pair above),
`views/components/wiki-filter.test.ts` + `wiki-groups.test.ts` (the sort, the
chip signal, `groupMonths`' third value, the one-chain property, the comparator,
the strip order and the section order) and `e2e/wiki-worked-recency.spec.ts` (a
twelve-page fixture spreading 09-21 → 07-02 with a swept page on its fallback,
the chip, the Series section, a rendered reader strip, the hidden option, and all
three ledger degrades in ONE boot — asserted against the spawned server's own
stderr, since "nothing warned and the axis is just empty" is the failure the
`pages`-key strictness exists to prevent).

### Lint check 8 — the series checks, and the only lint that proposes a fix

The rail can only fold what somebody NAMED, and nothing told a reader which
pages a `series:` was missing from. Check 8 (`src/wiki/lint-series.ts`, run by
`lintWiki` like the seven hygiene checks) reads the index the rail reads and
reports three things — and its findings, alone among the ten checks, carry a
machine-readable `fix` the gardener turns into review-gate rows.

| check | what it reports |
|---|---|
| `same-work-no-link` (8.1) | two pages that are plainly one piece of work with no wikilink either way |
| `series-unnamed` (8.2) | a cluster of linked pages that declares no `series:` at all |
| `series-inconsistent` (8.3) | a series whose declaration is half-written |

**The four cuts are REUSED, never re-declared** — `isBookkeeping` (exported from
`related.ts` for this), `RELATED_HUB_BACKLINKS` (25), `RELATED_DIGEST_PRS` (15)
and `RELATED_SHARED_PRS_MIN` (2), with the measurements in
`related-constants.ts`. Hubs and bookkeeping pages are cut from BOTH ends of
every pair, exactly as `computeRelated` cuts the open page: each says "this page
is not a piece of work", which is as true of one end as of the other. Explainers
are out — no frontmatter to write and no link graph to join.

**8.1** pairs two non-hub, non-bookkeeping pages with no `[[link]]` either way on
one of three signals, in this precedence: ≥2 shared `prRefs` (neither page a
digest), a shared `sessions:` id, or a `superseded_by` chain — read off the
store's own `pairedBy: "superseded"` pairing, so nothing re-parses frontmatter.
One finding per pair, filed against the **newer** page by `bySeriesDateDesc`,
which is also the page its fix writes on. Candidate pairs come from inverted
indexes over the two list fields plus the superseded pairing, so the cost is the
number of pages carrying a signal rather than the square of the wiki.

**8.2 and 8.3(c) run over NARRATIVE pages only** (`isNarrativePage`, exported):
a page carrying `plan_status`, or `status_date`, or a narrative `type:`
(blog/plan/archive/report/handover/postmortem), or sitting in a top-level
`plans`/`blogs`/`archive`. 8.1 keeps the wider candidate set — a missing link
between two pages that landed the same two PRs is worth reporting wherever they
live — but a SERIES is the stronger claim that these pages are episodes of one
effort with a head you can continue at. Measured on a mimir clone before the
predicate existed: the largest cluster ran to 68 pages, glued by
`projects/muninn/tracing.md` (21 backlinks, under the 25-backlink hub cut), and
8 of another's 12 rows were permanent reference pages — one Accept would have
put `series:` on the wiki's `overview.md`. It is a clarification of the plan's
own scan scope: the dry run scanned `plans/`, `blogs/` and `archive/` only.

**8.2 and 8.3(c) are ONE clustering, and that is load-bearing.** The edge is
*mutual wikilinks, OR one wikilink plus ≥1 shared PR ref (neither a digest), OR a
superseded chain* — stronger than 8.1's signal because a cluster is transitive
and a weak edge merges half the wiki (mimir's raw link graph has a 189-of-379
component). Per component of ≥2 pages:

- **no member names a series** ⇒ an 8.2 finding: coin `series: <the head's page
  stem>` on every member and `series_label: <the head's title, clipped to
  `SERIES_CONTINUE_MAX`>` on the head, where the head is `newestSeriesPlan` (the
  rail's own rule: a blog records the work, it never names it), falling back to
  the newest member;
- **exactly one member names one** ⇒ an 8.3 finding: the unnamed members join
  that key;
- **two or more keys** ⇒ nothing. Merging two named series is an editorial
  decision, not a lint fix.

Splitting those into two passes over two vertex sets was tried and is wrong: one
page could be proposed by both checks with two different keys, i.e. two
`wiki_proposals` rows on one `target_path` whose group applies stale each other.

A component over **`SERIES_CLUSTER_MAX` (12)** pages is proposed as its 12
newest, with the rest named in `detail` (`N more cut: …`) — a cut rather than a
refusal, because the cluster is real and 40 frontmatter edits behind one Accept
is not a review.

**An 8.2 component is PROPOSED only when ≥2 members carry a non-terminal
`plan_status`** (`SERIES_CLUSTER_MIN_PLANS`, the dry run's own `≥2 plans` gate).
Under it the component is still a FINDING — the count is the signal — but
carries no `fix`, so nothing is seeded and no Accept can name a series nobody is
working on. **Measured on mimir 2026-09-20** (547 pages): 44 `series-unnamed`
findings, of which **31 carry a fix** over **139 pages** and 13 are report-only.
The campaign's dry run counted 21 usable clusters, and that number is **not the
one to compare against**: it FILTERED components over `SERIES_CLUSTER_MAX` out
of its count, where the shipped rule keeps them and takes a 12-newest CUT — so
the two are counting different things, and an earlier version of this paragraph
claiming the shipped clustering "reproduces the dry run's 20-odd usable
clusters" was false in both directions. Re-derive with
`bun -e` over `buildWikiIndex` + `lintWiki`, counting `f.fix` and the distinct
`fix.edits[].relPath`.

**A coined key never collides with a series that already exists**
(`coinSeriesKey`, compared under `seriesCensusKey`): a stem is exactly the kind
of name somebody has already typed, and coining it twice merges two unrelated
pieces of work into one rail fold the moment the second fix applies. On a
collision the key takes a `-2`, `-3` suffix, and keys coined earlier in the same
pass are taken too. **No `series_label:` row is proposed when the head carries
no `title:`** — the store falls a title back to the page STEM, which is what the
key is, so the label would restate it.

**8.3's other two sub-rules read the AUTHORED key alone**, over the RAIL's own
census of each series (`seriesMembersByFoldKey`, exported from `wiki-groups.ts`
for this): hubs and bookkeeping pages are IN — the cuts answer "is this page a
piece of work", which is the PAIRING question, while a key somebody typed is a
declaration — and the two kinds of page the rail does not count are OUT, an
attachment child and a retired page whose successor left the series. Those
render under another page, so their key is not this series' to normalise and
their `series_label:` is not this series' label; censusing with a plain
`filter(key ===)` let the lint propose removing the very label the fold reads.
(a) one series spelled more than one way normalises to the head's spelling; (b)
more than one member carrying `series_label:` keeps the one the RAIL reads —
`seriesHead`, the newest LABELLED member — and removes the rest. 8.3(c) joins
under that same head's spelling, never the spelling of whichever member the
cluster happened to touch: joining the met spelling adds a fresh variant of a
key rule (a) is normalising away in the same pass.
**One normalisation, stated once:** two keys are one series when
`seriesCensusKey` (trim + lower-case) agrees. ⚠️ That is NOT `seriesFoldKey`,
which prefixes `series:` for the folds STORE's flat namespace — a caller that
looked a series up with the prefixed form got `undefined` and silently fell
back.

⚠️ **Accepting an 8.1 fix can mint an 8.2 finding, and that is the rule
escalating rather than a treadmill.** The See-also line makes the pair linked,
and a link plus a shared PR ref IS the cluster edge — so a pair that was "one
piece of work with no link" becomes "a linked pair that declares no series". It
is pinned by `e2e/wiki-lint-proposals.spec.ts` so the behaviour is a decision
rather than a surprise.

The lint still WRITES NOTHING: `lintWiki(index, deps)` stays pure and the `fix`
is a payload. What turns it into rows — and what happens on Accept — is
`src/gardener/CLAUDE.md`.

Acceptance: `lint-series.test.ts` (each rule, each cut sized from the constants
AND driven at the boundary — a page at exactly 25 backlinks is not a hub and one
at exactly 15 refs is not a digest — the 12-cap with its cut line, the
two-named-series refusal, the superseded and same-session pairs, the newer-page
rule, link suppression in BOTH directions, the shared-title stem fallback, the
narrative predicate, the plans gate, the `-2` collision suffix, the label skip,
the head's spelling and the rail census), `src/gardener/lint-proposals.test.ts`
(the row builder, the claim, the order, the self-heal) and
`e2e/wiki-lint-proposals.spec.ts` (the chain end to end, including the file
bytes an Accept writes, the simultaneous overlap, the sequential self-heal and
the stopped path).

## Related work (`related.ts`, `prRefs`, the Connections panel's top block)

The Connections panel's first section: the pages one hop from the open page,
newest first, each with the one line saying why it is there. It leads the panel
because it ANSWERS a question — "what else is this piece of work?" — while
`Linked from` and `Links to` under it are the raw lists it is derived from.

```
related = cites ∪ cited-by ∪ shares ≥2 PR refs, minus hubs, never transitive
```

Deterministic: no model, no embedding, and it changes only when a page's text
changes. `Similar` in the same panel is the semantic answer; this one is the
answer a reader can reproduce.

**Never transitive**, and that is a measurement rather than a preference. The
largest connected component of mimir's raw link graph is 189 of 379 narrative
pages (`scripts/lint-series-dryrun.ts` in mimir, 2026-09-20), so "reachable"
groups half the wiki and says nothing. **Two shared PR refs, not one**: one
shared number pairs every page that mentions a busy week.

### `prRefs` — a derived index field

`WikiPageMeta.prRefs` is every PR a page names: the authored `prs:` list merged
with what the BODY names, normalized to `owner/repo#n` (the spelling
`PR_COORDINATE` in `provenance.ts` parses) and deduped case-insensitively.
`pagePrRefs` computes it in `buildWikiIndex`'s existing read pass, where the body
is already in hand — a derived field like `links`, so "no bodies in the index"
still holds. Absent, never `[]`, on a page naming none.

It is derived rather than authored because `prs:` is stamped on **0** of mimir's
379 narrative pages while the bodies name PRs constantly. Measured over the
whole wiki (547 pages, 2026-09-20): **156** carry at least one ref.

Three body shapes, in the order the one alternation regex tries them:

| Shape | Owner |
|---|---|
| `https://github.com/<owner>/<repo>/pull/N` | as written, any owner |
| `<owner>/<repo>#N` | as written — in PROSE, `PR_REF_OWNER` only |
| `<repo>#N` / `<repo> #N`, `PR_REF_REPOS` only | `PR_REF_OWNER` (`RuneLind`) |

Every clause of that is a shape the corpus contains:

- ⚠️ **Shape 2's owner is gated, and the two callers gate it differently.**
  `<a>/<b>#N` is also an anchor link, a wikilink fragment and a version string,
  so a BODY scan keeps it only for `PR_REF_OWNER`, matched without case. Without
  that gate `[x](plans/foo#3)`, `[[plans/index#3]]` and `v1.2/3.4#5` each minted
  a ref that pairs pages, and mimir's `log.md` carries a live `Jira-Cloud/PR#165`.
  One AUTHORED `prs:` entry keeps any owner (`normalizePrRef`, anchored end to
  end) — the documented frontmatter shape is
  `prs: [navikt/melosys-api#1234, RuneLind/muninn#543]` and `PR_COORDINATE` in
  `provenance.ts`, the single-value sibling, accepts any owner too. An authored
  entry is a declaration; a prose span is a guess. Measured cost of the gate on
  mimir: **822 → 819** refs over the same 156 pages — one false
  `Jira-Cloud/PR#165` and two prose spellings of `navikt/melosys-muninn#1`, both
  on pages the digest cut already excluded; the third occurrence of that PR is a
  pull URL and still pairs.
- **A bare `#N` is not a PR reference.** In this corpus it is a heading anchor or
  a count, so the third shape needs a known repo name in front of it.
  `PR_REF_REPOS` is `muninn`, `huginn`, `mimir`, `yggdrasil`, `claude-usage`,
  `claude-skills` and `claude-hivemind`. A name the list is missing costs a
  pairing, never a wrong one — the first two shapes stay open to every repo.
- **One optional space before the `#`, and no more.** The dry run allowed up to
  12 arbitrary characters there, which reads a repo named in one clause and a
  `#12` in the next as one reference.
- **The lookbehind keeps a longer path out.** In `src/wiki/store.ts` the `wiki`
  and `store.ts` segments are both preceded by `/`, so neither starts a match,
  and `x-muninn#5` is not `muninn#5`. `@` is in that class for the same reason:
  `rune@muninn#5` is a handle, not a PR.
- **An unparseable `prs:` entry is DROPPED.** `normalizePrRef` answers
  `undefined` and `pagePrRefs` leaves it out. The `jira` precedent (keep the
  typo, it pairs with nothing) does not transfer — two pages both parked on
  `TBD` carry two identical unparseable entries, which is exactly the
  `RELATED_SHARED_PRS_MIN` threshold. The provenance strip renders the page's own
  `meta.prs` verbatim; this is the DERIVED field.
- ⚠️ **Frontmatter is not body, and fenced and inline code is masked** —
  `stripFrontmatter` plus `markdownCodeRegions`, the two rules
  `extractEmbedTargets` already applies. Measured: both acceptance pages quote
  `prs: [navikt/melosys-api#1234, RuneLind/muninn#543]` inside a ```yaml fence
  documenting this very feature, and without the mask every page explaining
  provenance pairs with PR 543.

**The listing does not grow.** `toListing` strips `prRefs` on ALL THREE callers
and opts it in for NONE — not even `includeProvenance`. It is the input to
`computeRelated`, which runs server-side and hands each row the refs it matched
on inside that row's own `why`; the raw list is a dozen refs per page that no
LIST renders. Measured on a 547-page mimir clone, `GET /api/wiki/pages`:
**385,013 bytes before and after**, every row byte-identical.

### The rule (`computeRelated`, pure)

`computeRelated(index, relPath)` takes the built `WikiIndex` and answers the
DECISION — which pages, and why — never a listing row. `/api/wiki/page` maps each
decision onto `toListing`, so a related row is the shape the panel's other rows
are plus `why`, and this module stays testable without a Hono app.

Three cuts, each one a way the block fills with pages nobody meant — and **all
three are SYMMETRIC**: each says "this page is not a piece of work", which is as
true of the page you have open as of a candidate, so a bookkeeping or hub page
gets no block at all. Measured on the 547-page clone with the first two applied
to candidates only, opening `index.md` answered **340** rows (+220 KB on one
response), `plans/index.md` 246, `log.md` 189, and `flows/how-we-build.mdx` — cut
as a candidate at 27 backlinks — 36. Symmetric, the largest block on that corpus
is **33** rows (`overview.md`), which is the link graph's own bound: there is no
`RELATED_MAX` cap, because a cap drops rows from a page that really does have
that many neighbours.

- **Hubs**: a candidate with more than `RELATED_HUB_BACKLINKS` (25) backlinks is
  dropped, from EVERY source. A page cited by the whole wiki is not related work
  because this page cites it too. Measured on mimir, exactly two pages exceed it:
  `flows/how-we-build.mdx` (27) and `projects/muninn/dashboard.md` (26).
- **Digests**: a page naming more than `RELATED_DIGEST_PRS` (15) refs is cut from
  the PR-sharing source — it names half the month by construction. It still
  appears through a real link, with the link as its reason. The cut is applied to
  BOTH ends of a pair: the inference is as false when the digest is the page you
  have open. Measured on mimir, 5 pages exceed it (`log.md` at 208,
  `plans/index.md` 83, the plans-index archive report 32, `index.md` 27, the
  review-9 blog 19), against 18 pages in the 6–15 band — the constant sits in a
  real gap.
- ⚠️ **Bookkeeping**: `index`, `log` and `CLAUDE`, by stem, in any folder
  (`isMetaStem`, the rail's own predicate). The hub cut does not reach them, and
  that is measured rather than assumed: on mimir `index.md` has **3** backlinks,
  `log.md` 4 and `plans/index.md` 6, because a catalog page LINKS OUT rather than
  being linked to. Without this cut they led the block on both acceptance pages.
  The campaign's dry run cut them by NAME; this is the same cut spelled as a
  predicate the reader already has. The stem comes from `pageStemOf`, the rail's
  own spelling, which strips ANY extension — `wikiPageStem` strips only
  `.md`/`.mdx`, so `plans/index.html` sat under `Bookkeeping` in the rail and
  arrived here as ordinary related work. ⚠️ `isMetaStem` is case-sensitive on
  `CLAUDE` alone, inherited from the rail.

**The open page's own ATTACHMENTS are excluded too** — a candidate whose `parent`
is the open page. The rail already shows them as that page's attachment chip, so
a row here is the same file twice on one screen (measured: opening
`plans/muninn-wiki-rail-grouping.mdx` listed its own
`-prototype.html`). Scoped to THIS page's children: an `.html` explainer
belonging to some other page is an ordinary candidate.

**Order is newest first, through `bySeriesDateDesc`** — `status_date`, else the
durable git touch date, else mtime, at DAY granularity with the rung as the
tie-break. The same function the rail's Series fold orders its members by, so two
surfaces that both claim to show the newest page of one piece of work cannot
disagree. `seriesDateSignal` takes a structural `PageDateFields` for that reason:
the server's `WikiPageMeta` satisfies it as well as the client's `WikiListing`.

**The why line joins its reasons with ` · `** in a fixed source order —
`cites this page`, `cited by this page`, then
`shares <ref>, <ref>`. The shares reason names the first two shared refs in the
OPEN page's own `prRefs` order, in the full `RuneLind/<repo>#N` spelling: the
reader pastes that into a PR search, and a display form the ledger does not use
is one more spelling to reconcile.

Series membership changes nothing here. A series member is an ordinary
candidate — the block is about links, and the rail already groups the series.

### Rendering

`relatedSectionHtml` (`views/components/wiki-related-view.ts` — pure string
building, in its own module because `wiki-browser.ts` touches `document` at
import time and `bun test` cannot load it) paints the block at the top of
`renderConnections`. Rows are the panel's own `.wiki-conn-item`, so the delegated
`[data-page]` handler opens them and there is no second click path; the why line
is a second line inside `.wiki-conn-text`, with each reason in an `<em>` and the
separators outside them.

**An empty block is omitted**, not rendered as a "nothing related" row: the two
sections under it already say `None` for the mechanism they name, and a third
saying it about a derived rule reads as a failure. `related` is `[]` on a page
with no neighbours and absent on an older server; both land as no block.

**The why line WRAPS.** `white-space: nowrap` + `text-overflow: ellipsis`
measured 353 px of line in a 248 px box at the default rail — 30% hidden, and the
hidden half is the `shares RuneLind/muninn#549, …` numbers the reason exists to
show, while a `toHaveText` assertion passed the whole time. The e2e measures the
element's own box AND intersects it with every clipping ancestor (the technique
`wiki-rail-series.spec.ts`'s census case uses), and counts the line boxes off an
explicit `line-height` so the row stays two lines.

**Contrast**: the why line is `--text-soft`, judged in all FOUR states a reader
meets — over `--bg-panel` at rest and over the row's own `:hover` fill, in both
themes. `--text-dim` is 3.24:1 dark / 3.74:1 light and `--text-muted` measures
**4.42:1** over the LIGHT hover fill, both under the 4.5:1 floor for a line
carrying the PR numbers the pairing rests on. A hovered row is not a transient
state: it is where the pointer is whenever a row is being read.

**There is no `⋯ add to series` control.** The series editor is a later PR, and a
visible control that cannot act is the dead control #557's F2 decision rejected.
`series` and `series_label` are untouched by this feature.

Acceptance: `store.test.ts` (the three shapes, the fence mask, the frontmatter
merge, the bare-`#N` and unknown-repo refusals, the prose owner gate and its five
false shapes, the anchored normaliser and the dropped `prs:` entry),
`related.test.ts` (each source, the multi-reason why, the three cuts with the hub
threshold driven at 25 and 26, the same two cuts applied to the OPEN page, the
`.html` stem case, the attachment exclusion and its non-child control, the
never-transitive case, the shares reason's order and count, the case fold and the
self guard), `wiki-related-view.test.ts` (the empty-block guard — the shape a
spec cannot reach, since an omitted block has no element to assert on),
`wiki-provenance.test.ts` (the strip on `/api/wiki/pages`, `related[]` on
`/api/wiki/page`) and `e2e/wiki-related-work.spec.ts` (the chain end to end, both
cuts against a real index, the listing's absent key, the why line's full
visibility, and the contrast at rest AND hovered in both themes). The spec sizes
its fixture from `src/wiki/related-constants.ts` rather than re-typing the
numbers, so the FIXTURE TRACKS the constant and the boundary case holds at any
value — which is also why the import catches no drift by itself (measured:
25 → 10 and 25 → 30 both leave the spec green). The spec PINS each value
instead, one `toBe` per constant: a threshold is a measurement, and moving it
means re-measuring on the live wiki and moving the pin in the same edit.

## Share (`POST /api/wiki/share`, `GET /api/wiki/share/presets`)

Turns one wiki page into a pasteable post — the reader's **📤 Share** breadcrumb action, beside 💬 Discuss. One fenced one-shot on the wiki's synthesis bot (`resolveWikiSynthesisBot`, same routing as Ask), streamed as markdown, and on completion three server-rendered strings. Prompt/preset/body-prep layers live in `src/share/` (see the Share row in the repo `CLAUDE.md`); the SSE runner is `dashboard/routes/share-sse.ts`, the dialog `dashboard/views/components/share-dialog.ts` (+ its pure half `wiki-share-dialog.ts`).

- **`page` is the page NAME, resolved with `index.resolve(page)`** — the Explain / fact-check / Similar contract, NOT a relPath (which carries directories and an extension, and which the reader's client never holds for the open page) and NOT `/api/wiki/page`'s name-or-relPath contract.
- **POST, and the ordering is a requirement.** This is the FIRST POST+SSE route in the family (the other `streamFactcheckScaffold` callers are GETs). Every body check — missing `page`/`preset`, an unknown `lang`, both text caps, an **unknown preset id** — returns a plain JSON 400 BEFORE `streamShareSSE` is called; after `streamSSE` commits a 200 the only way to report a bad request is an `app_error` nothing can tell from a model failure. It is POST rather than GET because the reader can EDIT the prompt before generating.
- **Over-cap is a 400, never a truncation** (`SHARE_PROMPT_OVERRIDE_MAX` 8k, `SHARE_EXTRA_MAX` 2k). A silently shortened prompt changes what the model was asked without telling anyone, and the reader reads the result as an answer to the instruction they wrote.
- **An unknown preset id is refused, not defaulted.** `findSharePreset` returns undefined for a present-but-unknown id (an ABSENT id still means "the default"), so the route 400s instead of generating with the neutral prompt and reporting it as the picked preset's output. The id is resolved against the RESOLVED BOT, whose `prompts/share*.md` files override the shipped set — which is why that check runs after bot resolution and why a bot-less wiki takes the `app_error` path instead.
- **The prompt is instruction → language rider → extra → fenced source, in that order.** The rider goes AFTER the reader's edit on purpose: an edit rewrites the SHAPE of the post, not the language toggle, and rider-first let "…in English" inside an edited prompt silently beat a toggle left on Norsk. Every interpolated field is fence-neutralized (`neutralizeShareFence`, the `neutralizePromptFence` treatment).
- **The web tools are fenced off** — `SHARE_EXCLUDED_TOOLS` (WebSearch/WebFetch) unioned onto `FENCED_EXCLUDED_TOOLS`. The product is a summary of a source the sender chose; a model that fetches the web mid-summary puts claims that are not in that page into a post going out under the sender's name. It also removes the latency tail from a call whose whole input is already in the prompt. Preflight therefore needs **no** web-tools connector and **no** collections (`resolveSharePreflight` is just unknown wiki → unloadable index → unknown page); a page that reduces to no prose is refused before the slot is taken.
- **Streaming needed a passthrough.** `FencedOneShotOptions` gained an additive `onProgress` (the underlying `tracedOneShot` always had one, it simply was not forwarded) — the two pre-existing fenced callers omit it and are unaffected.
- **Per-page single-flight, 409 `{state: "running", expiresAtMs}`** — the claim-retry registry pattern verbatim, including the lazily-evaluated expiry (`SHARE_TIMEOUT_MS` + `SHARE_SLOT_SLACK_MS`, so the slot outlives the run's teardown), the identity-checked release, the happy-path-only acquire and the release-on-synchronous-throw handover. Bounding the inputs is not bounding the rate: one POST buys a whole-page summarization, and a double-click, a reload mid-stream or a second tab each buy another.
- **The `done` payload is exactly `{markdown, slack, mailHtml}`** and the tabs are **Slack | email | markdown**. Telegram is OUT of v1 (product decision 2026-08-11): no tab, no fourth string, and deliberately not a disabled placeholder either — the send action arrives in a later PR. Rendering is server-side (`formatSlackMrkdwn` / `formatEmailHtml`, the same renderers delivery uses) so there is no second client implementation to drift.
- **The client consumes it with `fetch` + a ReadableStream, never EventSource** — the claim-retry rationale, and here it is the 409's `expiresAtMs` that would be unreadable, plus an auto-reconnect straight into the single-flight slot the first connection holds. Framing is the shared `makeSseFrameParser`.
- **`GET /api/wiki/share/presets?wiki=`** serves the merged preset list WITH its content (the dialog shows and edits the prompt) plus the language list. Read-only, model-free, 404 on an unknown wiki; a bot-less wiki still gets the shipped set with `bot: null`.
- **One dialog module, one copy per page.** `share-dialog.ts` owns the state and the document listeners; `share-dialog-browser.ts` publishes `openShareDialog` on `globalThis` for pages that cannot import (the `/summaries` mount). The /wiki reader IMPORTS it from inside `wiki-browser.ts`'s bundle and never loads the standalone script — doing both would put two module states and two listener sets on one page.

## Provenance (`provenance.ts`, `provenance-service.ts`, `session-ledger.ts`, `lockfile.ts`)

Which agent sessions wrote a page, which Jira issue it serves, which PRs its work
landed as — four frontmatter keys, one flow list per line:

```yaml
sessions: [claude-code:5a2ee3f0-…, opencode:ses_7f3a9b2c1d]
sessions_backfilled: 2026-10-14
jira: [MELOSYS-8045]
prs: [navikt/melosys-api#1234, RuneLind/muninn#543]
```

**muninn NEVER writes them.** There is exactly ONE line-upsert implementation and
it lives in claude-usage (`src/wiki-stamp.ts`, driven by `scripts/wiki-stamp.ts`);
the Claude Code `PostToolUse` hook and the opencode plugin call it, and muninn's
**Stamp** route is its third caller — it SHELLS OUT to the same CLI
(`WIKI_STAMP_BIN`, see the Stamp section below) rather than growing a second
writer. Two writers of one frontmatter line lose each other's appends — which is
what the lockfile below exists for.

**The shape is checked in TWICE, byte for byte** —
`src/wiki/__fixtures__/wiki-stamp-shape.md` here,
`test/fixtures/wiki-stamp/shape.md` in claude-usage. **Each side pins its OWN
copy** — `provenance.test.ts`'s first describe block reads this file and asserts
the keys it READS, claude-usage's suite asserts the keys it WRITES — and neither
assertion can see the other file, so the two are compared by hand. One
opportunistic test here diffs them when a claude-usage checkout happens to sit at
`../claude-usage`, and SKIPS otherwise by design: CI clones one repo, and a
machine without the sibling must not go red over a file it does not have.

**What the store does with them** (`buildWikiIndex`, beside `project`): `sessions`
and `prs` verbatim and in FILE order (arrival order, never sorted), `jira`
normalized to trimmed UPPERCASE so a page's spelling and a query's cannot
disagree, `sessions_backfilled` as a trimmed string. All four are **absent, not
`[]`**, on a page carrying none — which is every page of every wiki until the
stamper has run on it, and an empty array per page is listing payload asserting
nothing. Jira keys are deliberately NOT shape-filtered: a value that is not a key
shape is a typo worth seeing in the facet, not one worth hiding.

**What reaches which payload** is a deliberate split, and `toListing` is where it
is made: `jira` is a listing FACET (the `project` twin) and rides the hot
`/api/wiki/pages` payload, with `jiraCounts(index.pages)` beside `projects:` —
`{}` on a wiki nothing has stamped, which is how the client knows to render no
facet at all. `sessions`/`prs`/`sessions_backfilled` are stripped by default and
opted in by the SINGLE-PAGE caller alone, through `includeProvenance` (the
`includeDesc` mechanism, whose comment names all three callers of that one
function).

**The reader's block** is `GET /api/wiki/page/provenance` (deferred — see
below); `GET /api/wiki/page` only answers `provenancePending: true`, and only
when `hasProvenance(meta)` — the ONE gate, shared with the store's other
callers — says the page carries any of the three LIST keys, or (on a wiki with a
tracker) at least one issue whose relations COUNT (`relationsCount`; a
link-only or mention-only key opens nothing). `sessions_backfilled` alone
opens nothing: it is a marker about a list that is not there. The reader's
placeholder reads its sibling `provenanceStripCertain` (the same minus `prs:`,
which may resolve to no strip), and the explainer path fetches the block too. The payload is
`{sessions, jira, prs, merges, totalCost, costedSessions, backfilled?, ledger,
mergesLedger}`.

Sessions are enriched SERVER-side in BATCHES of `SESSION_IDS_PER_CALL` (200)
against `GET <CLAUDE_USAGE_URL>/api/sessions-by-id?ids=…`, through the shared
`utils/claude-usage-fetch.ts` (the one fetch helper all three claude-usage
proxies use — the `/models` ledger card, the `/plans` board, this). Its
warn-once registry is keyed PER CALLER (`what`): the three churn at very
different rates, and one capped set cleared wholesale let this caller — once per
page open, with the failing endpoint in its key — evict the `/models` card's
single key and make it re-warn an outage in its tenth hour. One call for
every page anyone has actually stamped, but **not one by contract**: the batch
size is the cap, and a page naming 250 sessions makes two.

**SIX legs, ONE deadline, TWO dependent hops at worst.** Beside the session facts and
the huginn Jira lookup, a page open asks `GET <CLAUDE_USAGE_URL>/api/merges?sessions=…`
for the PRs those sessions merged (`fetchMergesForSessions`, the same batching,
the same id-shape gate, the same `SESSION_IDS_QUERY_MAX_BYTES` budget — the
16 KiB header block is a property of the SERVICE, not of one route). Every leg
shares one `PROVENANCE_BUDGET_MS` (10 s) `AbortSignal`, so a page open costs one
budget rather than the sum of its legs.

**The page open does not wait on that budget at all.** `GET /api/wiki/page`
answers `provenancePending: true` (absent, never `false`, on a page carrying
none of the keys — the client's one gate stays "is the key here") and joins
nothing; the reader renders a placeholder strip with a spinner under the title
and fetches **`GET /api/wiki/page/provenance`** (same `wiki`/`relPath`/`name`
resolution, `{ provenance }` or `{}` for an unstamped page, 404 for no page)
once the article is on screen. Measured before the split: a plan page naming
four sessions and three PRs opened seconds after its markdown was ready,
because the join's slowest leg gated the whole payload. The placeholder is a
`.wiki-prov-strip` like the real one, so the one writer, `placeProvStrip`,
replaces either; a fetch that fails outright becomes one
"provenance not loaded · retry" line — the retry matters because the Stamp
button lives inside the real strip — never a spinner that runs forever, and an
answer landing after the reader navigated away is dropped. Loads can also
OVERLAP for one page — leave and return before the first answer lands — and
there the rule is **the newest load wins**, and **there is ONE writer**:
every load, the Stamp redraw and the retry write through `placeProvStrip`,
which replaces whatever strip is on the page or inserts one when none is. An
older load's answer is dropped whatever it carries, and a Stamp redraw retires
the loads in flight, since its block is a re-resolve after the write. What a
load may write is decided before the writer runs: a block replaces anything, an
empty or failed answer replaces only a placeholder — a real strip stays, so a
Stamp refetch that re-reads a page which resolved to no keys does not remove
the strip the reader just stamped from. Two
writers with DOM rules of their own is how the page showed two strips twice
(#560's fix rounds 1 and 4 caused it, 2 and 5 removed it). The placeholder is rendered only when the
page names a session or a Jira key: a `prs:`-only page may resolve to no strip
at all, so it fetches with no spinner; a strip that comes back is inserted
after the meta row, and an empty or failed answer stays silent. The stamp route still
returns the block inline — it has just written the keys and owes the caller
the strip.

That signal is created in **`pageProvenance`** and passed down. It used to be
created inside `resolveProvenance` and never returned, which leaves a leg added
beside it either unbounded or armed with a second timer — and awaiting that
function before starting the new leg would make the page open sequential. The
conditional creation is unchanged: a page with nothing to ask still arms no
timer.

The other four legs are PR 3's, and they all live in `pageProvenance` for the
merges leg's reason:

| Leg | Route | Input | Degrade |
|---|---|---|---|
| 3 | `/api/session-handoff?id=` ×N | each stamped id, in parallel | no handoff lines, no handoff ghosts; footer `handoffs not read` |
| | | | ⚠️ a **404** is upstream's documented "no such session" and counts as an ANSWER with no handoff — `reachable` stays true and nothing warns. It used to read as a failed call, so a page whose ids the ledger does not hold (the `missing` chip state) rendered `handoffs not read` against a healthy service and minted one warn per id. |
| 4 | `/api/merges?prs=` | the page's own `prs:` entries | no PR ghosts; footer `PR links not read: …` |
| 5 | `/api/sessions-by-id` | the ghost ids legs 3+4 found | ghost rows id-only: no cost, no title, neutral glyph, no Stamp |
| 6 | `/api/merges?sessions=` | the same ghost ids | ghost rows without their merge rows |

Legs 1–4 start together; 5 and 6 hang off the **leg-3 and leg-4 promises
only**, never off a `Promise.all` that also holds leg 1. Leg 1 is the huginn Jira
corpus and gives up only at the SHARED deadline, so awaiting all four put it on
the hop's critical path: on a page with a `jira:` key and a slow corpus the ghost
legs started on an already-aborted signal and reported `reachable: false` against
a claude-usage nobody asked. Measured at a 300 ms corpus, the hop fired at
302 ms; at a 25 ms budget both ghost legs came back unreachable. **Leg 3 has no
batch form** — `/api/session-handoff` takes one id — so it is N calls and is
capped at `HANDOFF_READS_MAX` (10): a page past the cap reads NO handoff at all
and the footer says so, rather than showing the first ten and being short for a
reason nothing states. Ten measured 0.14–0.56 s wall for the whole parallel set.
Leg 4's list is capped at `PR_READS_MAX` (10) client-side and filtered to the
coordinate shape first — a malformed coordinate is a 400 for the WHOLE request
upstream, so one typo in `prs:` must not take the leg down. `links`
(`{handoffs, prs, ghostFacts, ghostMerges, handoffsCapped, prsCapped, timedOut}`)
is what the footer reads; `timedOut` is the shared signal's own `aborted`, read
once when legs 1–4 and the ghost hop have settled rather than raced per leg — not
after the issue leg, which carries its deadline on each row's `ledger`, so a
page whose own legs finished (or never ran) is not blamed for it.

**A GHOST is a session the ledger links to the page that `sessions:` does not
name**, and the two sources are not interchangeable. Through a HANDOFF: a stamped
session's `ranBy` names it, which says only that it pasted the prompt — so the row
says `ran this session's handoff — may not have touched this page` and its Stamp
is a two-step confirm. Through a PR: `/api/merges?prs=` names the session that
merged a PR the page itself lists — real evidence, so a one-click Stamp.
Discovery is ONE hop (a ghost's own handoff is not read), ghosts ride their own
`ghosts` array and are **never in the cost sentence's denominator**, and their
`provider` goes through the ONE `claude → claude-code` mapping in
`enrichSessions` so a bare stamped ref, a ghost glyph and a Stamp ref all agree.
A provider the mapping's range does not hold renders the row with no Stamp and
says which provider it was — but only when the ledger actually NAMED one. A chip
the ledger never answered for (`unresolved`/`missing`/`invalid`) already carries
its own reason from `bareChipCopy`, and `noStampReason` returns `null` there
rather than adding "the ledger named no provider for this session" beside it: two
sentences on one row, one saying the lookup never answered and the other
reporting what the answer contained. `bareChipReason` is the predicate both use,
so they cannot disagree about which state the chip is in.

**The three sources of merge rows are deduped with `?sessions=` ahead of
`?prs=`.** `dedupeMerges` is first-wins on
`(sessionId, prNumber, mergedAt, repo)`; the caller's order is the stamped
sessions' rows, then the GHOSTS' rows (also a `?sessions=` read), then the
`?prs=` ones. The two forms can disagree about one merge — `?prs=` prefers the
confirmed `merge-cmd` row where `?sessions=` may answer the `squash-composed` one
— and with the `?prs=` rows in the middle, STAMPING a ghost moved its merge from
third place to first and flipped the rendered gate verdict (`✓ review floor` →
`no gate line` on a fixture where the forms differ). `repo` is in the key because
without it two BARE merges (`prNumber` null, `mergedAt` null) from different
repositories collapse into one.

**The merges leg lives in `pageProvenance`, NOT in `resolveProvenance`.** The two
reverse lookups share that function over up to `PROVENANCE_REFS_MAX` (1000)
refs, and a fan-out there would multiply the claude-usage calls one GET buys on a
route that renders no merge row. A test pins it, and it is the one test in that
file which is vacuous until someone moves the call — which is exactly why it is
there.

`mergesLedger` is `{asked, reachable, partial, truncated, limit?, errors?}` and
is deliberately NOT folded into `ledger`: the two legs hit the same service and fail independently, and the
reader must be able to tell "this page has no merges" from "the merges call did
not answer". A shared `reachable` would make the second unsayable, and would push
the cost sentence — which is about the FACTS leg — into a state the money it
reports never came from. A merge row with no `sessionId` is dropped (it is the
join back onto a chip); `mergeOk` is read as false only when EXPLICITLY false, so
an older ledger that does not send the field cannot turn every merge on the page
into `merge unconfirmed`.

`partial` is the THIRD state, the same one the facts leg has carried since #549:
some batches answered and some did not, so the rows on screen are real and there
are more of them. It matters exactly when there is more than one batch — measured
on 250 ids (batches of 200 + 50, the second throwing), which rendered one merge
under a silent footer. `reachable` alone cannot say it, and a half-answer read as
a whole one is the failure this whole block exists to prevent.

`fetchMerges` is a REQUIRED member of `SessionLedgerDeps` rather than an optional
one: an absent leg would be indistinguishable from a leg that answered nothing,
so a wiring mistake would render as "these sessions merged nothing" on every
page. Every construction site states what its merges leg does, and the compiler
is what enforces it.
The `provider:` prefix is muninn's, so the ids go BARE; a bare ref takes the
LEDGER's provider for its glyph, a prefixed one keeps the page's own spelling.
The browser never reaches port 8787 (tailnet viewers, mixed content under
`tailscale serve`), so the drill-down is the session id as copyable text plus an
optional `CLAUDE_USAGE_PUBLIC_URL` link.

**A bare chip has FOUR possible reasons and they are not interchangeable.** The
chip carries three booleans, at most one of them true (`bareChipReason` owns the
precedence), and every chip carries the SAME key set with an explicit `null`
where a fact is unknown:

| flag | meaning |
|---|---|
| `missing` | the ledger ANSWERED and does not hold this id — reaped, or another host's |
| `unresolved` | nobody asked: the batch carrying it failed, or this host is not pointed at a claude-usage |
| `invalid` | the value cannot BE a session id (over 128 chars, or outside `[A-Za-z0-9._-]`) and was refused before batching |

That third one is a bound, not fussiness: one malformed frontmatter entry sent
whole puts the request over claude-usage's 16 KiB header block, and the 431 that
comes back has no body naming the offender — so it takes every legitimate id in
its batch with it.

**`ledger` has three states, not two.** `asked` is the explicit third, and it
means a request was SENT: a `jira`-only page, a host with no
`CLAUDE_USAGE_URL`, and a page whose every session id was refused before
batching (all of them damaged) were never asked, and reporting
`reachable: false` about a call that did not happen reads as "the ledger is
down". That last case is why `asked` rides the ledger client's own result
(`SessionLedgerResult.asked`) rather than being derived from "a lookup
returned something" at the caller — `fetchSessionsById` returns a result for an
all-invalid page too, and reading THAT as "asked" put "claude-usage
unreachable" on a page whose only problem was one mangled frontmatter line.

`partial` is the fourth fact — some batch answered and some did not, so
`totalCost` is over a SUBSET — because `reachable: true` alone presents a
200-of-250 answer as complete. An UNCONFIGURED host never fetches at all
(`ledger: {asked:false, reachable:false, partial:false, configured:false}`, no
`baseUrl`): the `/models` card's "left unset and unreachable, hide it" rule, one
layer down, so an instance nobody pointed at a claude-usage does not pay a
connection refusal on every stamped page open. That answer is the FROZEN
`LEDGER_NOT_ASKED`, handed out by reference to every such page open, so it must
not be mutable.

**"Configured" has exactly ONE source: `sessionLedger.urlConfigured` on the
`ProvenanceContext`.** It decides both whether the ledger is fetched and what
the payload reports. A second context field beside it was two spellings of one
fact, wired from one expression at the route and free to disagree anywhere
else — including in a test, where the disagreement is invisible.

**Cost is labelled honestly.** `totalCost` is the sum over the sessions the ledger
PRICED and is never a per-page share — a session that wrote four pages cost what
it cost, and dividing it four ways would invent a number — with `costedSessions`
as the denominator that total is over. It is **rounded to cents at the seam**,
not at the renderer: the ledger's per-session costs carry full float precision
and summing them produces the `5.350000000000001` shape on a wire payload more
than one client renders. A session the ledger does not hold is a
`missing: true` chip contributing nothing, and is not a $0 session either;
`ledger.reachable` is what tells "this session is gone" from "I could not ask",
because the chip cannot.

**Two reverse lookups**, `GET /api/wiki/provenance` (`routes/wiki-provenance.ts`,
registered INSIDE the `wiki` route group so `MUNINN_PROFILE=nais` drops it with
the rest of the filesystem-bound surface):

| Query | Answer |
|---|---|
| `?jira=<KEY>` | every page in EVERY registered wiki serving that issue |
| `?session=<provider:id or bare id>` | every page that session wrote |

They are the one `/api/wiki/*` family that iterates the whole REGISTRY rather
than resolving one wiki — an issue is served by a page in the kode-wiki and
discussed in a mimir plan, and "which pages serve MELOSYS-8045" has no useful
per-wiki answer — so each row names its own `wiki`. The key is normalized before
matching (`melosys-8045` is what a shared URL carries) and a non-key shape is a
400; both params at once is a 400 rather than a silent preference; a key nothing
serves is an empty list, not a 404. A degraded ledger never 5xxes either route.

Four rules the route's SHAPE depends on:

- **The Jira key shape is `^[A-Z][A-Z0-9]*-[0-9]+$`** — byte for byte what
  claude-usage's `/api/jira-sessions` validates with. The `*` is load-bearing:
  upstream accepts a one-character project prefix, and requiring two made `X-1` a
  400 on the muninn side of a key the stamper had happily written. `jiraCounts`
  filters the LISTING facet to that shape for the same reason — the store keeps a
  typo (worth seeing on the page's own row), but a facet chip whose only
  behaviour is to 400 when clicked is not worth rendering.
- **`?session=` is validated too**, against claude-usage's own `session_id`
  shape, so a value that cannot be an id is refused before walking every wiki to
  match nothing.
- **Both 400 bodies echo the NORMALIZED key, clipped to 64 chars** — a 400 that
  reflects arbitrary caller bytes is a payload nobody asked this route to carry.
- **Both halves of the answer are CAPPED** — `PROVENANCE_PAGES_MAX` (500) page
  rows and `PROVENANCE_REFS_MAX` (1000) distinct session refs, with a top-level
  `truncated: true` saying the answer is a prefix. The second cap is the one that
  matters: at 200 ids per call it bounds the claude-usage fan-out ONE GET buys.
  That amplification is also why the route is on `SIDE_EFFECTING_GETS`
  (`src/auth/origin.ts`) — not a model call and not a write, but a cross-site GET
  that drives this host's outbound calls.

**`?session=` prices the session ASKED ABOUT**, not every session sharing a page
with it (`costOver`): summing those answers "what did these pages cost" under a
heading that says "what did this session cost". The page rows keep their own full
`sessions` lists. And the queried spelling is UPGRADED — `dedupeSessionRefs`
keeps the query's position at the head but prefers a matched page's prefixed
spelling, so a reader who pasted the bare id still gets the provider glyph on the
one chip the answer is about.

**Neither route carries the per-wiki egress prologue, deliberately.** The whole
request is a list of session ids and Jira keys going to a LOCAL ledger and a
local knowledge API — no page content leaves the machine and no model call is
spent — so a read-only INSTANCE (`MUNINN_WIKI_READONLY=1`, the mini serving
mimir) and a read-only ROOT both answer them in full. Provenance is a READ; only
the lock below touches a write seam. The amplification the route DOES have is
handled by the caps + `SIDE_EFFECTING_GETS` above, which is a cross-site-origin
question rather than an egress one.

**huginn's Jira corpus lookup NEGATIVELY caches a failure** for
`JIRA_KEY_INDEX_FAIL_TTL_MS` (60 s, `src/jira/verify-keys.ts`). The fetch carries
a 15 s timeout and nothing remembered that it had just expired, so a down huginn
cost every caller 15 s — and on this path that is once per stamped page open.
Short deliberately: the answer it suppresses is a degrade rather than a result.

### Tracker inference (`src/wiki/trackers/`, `.wiki-reader.json` `trackers`)

Pages name their issues in titles, file names, tags and links far more often
than in a stamped `jira:` line, so a wiki whose `.wiki-reader.json` declares a
`trackers` block gets `issues` inferred per page at index time
(`buildWikiIndex`, where the body is already in hand). Code outside the one
adapter file says tracker / issue / issue ref (`{tracker, key, relations}`);
`jira.ts` is the only adapter, registered in `index.ts`.

- **The block** is parsed with the rule every other block here follows: a bad
  field warns and drops alone, and in a list a bad ELEMENT drops alone — a
  `projects` entry must be a 2–16-character key prefix (the shape the mention
  scanner can find), a `hosts` entry a bare hostname with an optional port. An
  entry is dropped WHOLE only for an unknown `id`, a duplicate, or no usable
  `projects` — `projects` bounds every inferred key, so without it the entry
  could only guess. No usable entry ⇒ no tracker. Each warning names its
  config key (`trackers[0].hosts[1]`) as its own log property, the `activity`
  block's convention.
- **Relations**, strongest first: `stamped` (the adapter's `frontmatterKey`
  line: an entry that is itself exactly key-shaped is kept whatever its case,
  any other entry is prose and goes through `extractJiraKeys` — uppercase only,
  denylisted; NOT project-bounded), `declared` (the configured
  `frontmatterKeys`, project-bounded), `created` ("created here": a `link` after
  a `createdMarkers` word in the same clause), `title` (the authored `title:`
  line only, never the stem fallback; UPPERCASE keys only, so a bot name like
  `demo-2` is not a key; shorthands `A-145/174` and `A-158 + 169`; an `.html`
  page's `<title>`), `stem` (case-insensitive; the two-key form
  `demo-7588-7969-notes` yields both), `tag`, `link` (`browse/KEY` on a
  configured host), `mention` (a bare uppercase key in the body). Every
  relation is kept per key.
- **What is not a key**, in every inferred rule: ASCII word edges on both sides
  (`xdemo-1`, `demo-12x`, `FOO_X-7`), a number with a leading zero
  (`DEMO-0145`), a run followed by `-` and a digit (`demo-2026-09-25`,
  `DEMO-1-2` — `extractJiraKeys` shares that rule, so the Jira composer's key
  check changed with it), and any key that is not ASCII key-shaped and in a
  configured project after normalization (a Kelvin sign `K` never becomes a
  `KODE` key: the key-scanning regexes carry no `u` — the created-marker
  regex does, which folds only the marker word — and the membership check is
  a second layer in the scan path; `stampedKeys` requires an exact entry to be ASCII key-shaped BEFORE
  it upper-cases it, since `toUpperCase` maps `ſ` to S and `ı` to I). A chained
  number — a title shorthand or the stem's second key — must have the base
  number's digit count, no leading zero and end cleanly, and a title shorthand
  must also sit within 1000 of the base (`DEMO-145/2026 rapport`,
  `DEMO-8045/2026`, `DEMO-8045 + 2025-kjøringen` each yield the base key
  alone, while `DEMO-7588/7969 Nullable sats` yields both). Accepted residual:
  a same-width count within 1000 still chains (`DEMO-145 + 300 saker` mints
  `DEMO-300`). At most five expansions per base key. The `link` rule carries
  the same right edge (`browse/DEMO-12-3` and `browse/DEMO-77abc` are no link).
- **Masks.** Every body rule reads the body with fenced code, inline code and
  HTML comments blanked, same length; `mention` additionally blanks URLs,
  markdown link destinations and wikilink targets.
- **A clause** ends at a newline, `·`, `;`, a period followed by whitespace or
  the line's end, and — on a table row only — a `|` outside `[...]`/`[[...]]`,
  where only a `[` with a matching `]` later on the line opens a bracket.
  Never a character count. Boundaries are computed once per line that holds a
  link, and not at all on a wiki with no `createdMarkers`.
- **Bookkeeping pages** (`isMetaStem`) are never inferred from, and an `.html`
  page reads only its bounded `<head>` prefix (title, keywords).
- ⚠️ **`link` and `mention` are the DEMOTED tier** (`DEMOTED_RELATIONS`,
  `relationsCount` in `types.ts`). A key whose only relations are those two
  stays in the page's full `issues` — the single-page meta, for PR 3's "also
  linked" line — but is not a pill, not a facet key and not in a key's page
  count. `link` joined `mention` after measurement: on melosys-kode-wiki it was
  right on ~42 % of its 118 refs and ~23 % of the 88 where it stood alone
  (epics, "Relatert" lines, history tables). `created` still refines a link and
  counts; a key that is `link` plus anything stronger counts through that.
  `tag` sits above `link` in `RELATION_STRENGTH` for that reason, so
  `relations[0]` is always a counting relation on a counting key.
- **Payloads.** `WikiPageMeta.issues` is absent, never `[]`. The hot listing
  ships a COMPACT copy (`compactIssues`: only counting refs, `mention` relation
  dropped); the single-page `meta` carries the whole list. `/api/wiki/pages`
  also carries `trackers: [{id, label}]` on a wiki with a tracker (absent
  otherwise). Measured 2026-09-25 on melosys-kode-wiki (417 pages, 92 with a
  counting key, 45 facet keys): `/api/wiki/pages` 181,740 → 191,768 bytes.
- **The facet.** `facetJiraKeys` (`wiki-filter.ts`) is the ONE definition the
  four consumers share — `jiraCounts`, `filterPages`, `jiraChipCounts` and the
  listing field: a page carrying `issues` answers its counting Jira refs, a
  page without answers its stamped `jira` list. ⚠️ So a wiki with NO tracker
  is byte-identical to before — pinned by `trackers/store-issues.test.ts` and
  by the spec's second wiki. The reader's `?jira=` FILTER reads that facet
  (inferred keys included); the reverse lookup `GET /api/wiki/provenance?jira=`
  stays stamped-only, while the provenance strip draws the payload's `issues`
  (see Connections and Link). On a tracker wiki the chip row is
  labelled with the adapter's name and shows the top `JIRA_CHIPS_MAX` (8) plus
  the active key and a `+N` expander (`jiraChipRow`); on a wiki with none it is
  uncapped and unlabelled, as before.
- ⚠️ **An active Jira filter opens every fold** (`buildRail`'s `expandAll`):
  series, families, months, attachment groups and Bookkeeping render open with
  a disabled control saying why, so a chip's count is the rows on screen and
  `#wikiCount`. A tag filter makes no such promise and still counts pages a
  closed fold hides.
- **Rail pills** sit in a column of their own inside `.wiki-list-title`,
  which becomes a wrapping flex pair (`has-issues`: the clamped
  `.wiki-list-title-text` and `.wiki-issue-pills`) — never inside the clamp,
  where a wrapped pill run was clipped on 80 of 96 keyed rows. Still one row
  element (the `▸` rule). The column sits BESIDE the text while the text keeps
  `RAIL_TITLE_MIN`, and wraps UNDER it (flush right) otherwise, so a pill row
  takes no reserve in the row's floors or chip breakpoints and breaks lines
  exactly where the same row without pills does: a reserve on the chip floors
  (fix round 1's 96px) wrapped whole rows at 260–290px. The column is at most
  `RAIL_ISSUE_PILLS_COL` (92px) and shrinks to its widest pill; a key may wrap
  after its project's `-` (`<wbr>`), so a pill only overhangs its cell for a
  project name of 11+ characters at the title's floor (the one residual).
  Up to two pills, strongest first, then `+N` whose hidden keys are in its
  accessible name; dashed unless `stamped`. A pill is part of the row, which
  is one click target, so it keeps the row's `pointer`. On a hovered or active
  row the pill ink is `--text-secondary` (`--text-muted` measured 4.42:1 and
  under 4.5 there in the light theme). Measured on melosys-kode-wiki at every
  rail width 260–560px (10px steps), both themes: 0 rows that wrap where main's
  do not, 0 clipped pills, 0 pill overlaps; mimir's rail is byte-for-byte the
  same geometry as main. The cost is the title text: clamped rows 206 / 152 /
  135 / 103 / 42 / 2 at 260 / 286 / 300 / 340 / 420 / 560px against main's 203
  / 145 / 115 / 66 / 17 / 0, and 53 / 19 / 19 / 21 / 28 of the 78 pill rows are
  taller than on main at 260 / 300 / 340 / 420 / 560px.

Acceptance: `trackers/jira.test.ts` (each rule, the anchor line's 2/70/138
shape, Jira markup, the project bound, the not-a-key shapes and masks),
`trackers/index.test.ts` (the block's validation), `trackers/store-issues.test.ts`
(the index build through the route's own `toListing`, the demotion, the
count-equals-rows property, the no-tracker pin) and
`e2e/wiki-tracker-links.spec.ts` (pill geometry at three rail widths in both
themes, a fold-chip row's line structure and chip form against the same row
without pills at 260–560px, a long key wrapping inside its cell, contrast at
rest / hovered / active, a listing that drops the tracker, and chip = rows =
`#wikiCount` through a closed series and an `.html` twin).

### Connections and Link (`trackers/rows.ts`, `trackers/jira-lookup.ts`, `views/components/wiki-issue-rows.ts`)

On a wiki with a tracker, the Connections panel opens with the page's issues,
above the mini-graph (which draws up to four counting Jira keys as diamonds,
and counts the rest in its footer as `+N issues not drawn`).

- **One row shape, two paths** (`IssueRow`, `trackers/types.ts`). `GET
  /api/wiki/page` carries the index-local half inline as `issueRows` (key, url,
  this page's relations, `pageCount`, `planPages`) plus `issueStampable`, so
  the section renders with the page. The deferred `GET
  /api/wiki/page/provenance` carries the WHOLE row in `issues[]` — title, raw
  `status`, `category`, epic, `updated`, `known`, `ledger` — and the reader
  adopts it under the strip's own sequence guard (`adoptIssueRows`). Both are
  absent, never `[]`, on a page with none, and on every page of a wiki with no
  tracker — mimir's payloads are unchanged.
- **The key map.** `buildWikiIndex` builds `index.issueKeys` (`tracker:key` →
  every page related to it, with its relations and whether it is a plan).
  `pageProvenance(meta, ctx, wikiDir, index)` reads it and the index's resolved
  tracker config; both callers (the page route and the Stamp route) pass it.
- **Plan coverage.** A page is a plan when its RESOLVED type is `plan` (a
  `type: plan` the wiki's ontology accepts, or its `typeMap`), it sits in a
  top-level `plans/`, or its title matches `planTitle` and not
  `planTitleExclude`. A key is covered when a plan relates to it through
  `COVERAGE_RELATIONS` (`stamped`, `declared`, `created`, `title`, `stem`),
  over every relation that page has to the key. `tag` and `link` never cover.
- **Status.** `loadIssueFields` reads huginn's `jira-issues` listing with
  `include_issue_fields=true` ONLY (its own 10-minute cache and 60 s negative
  cache; past the TTL a failed refetch keeps serving the last good listing for
  up to `ISSUE_FIELDS_MAX_STALE_MS` (1 h) after it was read, and past that
  answers null like a host with none; the first failure warns, repeats log
  info, a success re-arms the warn). The key is `jiraKeyFromDocId`'s (`src/jira/retrieval.ts`), so the
  strip, Connections and the Jira composer agree on which keys huginn holds
  (measured 2026-09-25: all 2,386 live ids yield the same key both ways). A
  stamp with an out-of-range component (`2026-13-01`, `+9999`) is unparseable,
  never rolled over. Twin documents: the newest
  PARSED `updated` wins (offsets `+0100`/`+02:00`, a stray `\:` unescaped), an
  unparseable one loses and is not served, a tie goes to the smaller id — a
  string max picks the wrong twin across an offset change. The status goes
  through the wiki's merged `statusMap`; unmapped is `unknown`, logged once per
  wiki and value. A lookup that degrades leaves the rows with no `category`, so no
  status pill and no Draft plan.
- **Cost.** `/api/jira?key=` on the claude-usage host, through the optional
  `SessionLedgerDeps.fetchIssueLedger` and the adapter's `ledgerPath`: at most
  `ISSUE_LEDGER_MAX` (8) counting keys a page, `ISSUE_LEDGER_CONCURRENCY` (4)
  at a time, strongest first, on the page's one `PROVENANCE_BUDGET_MS`
  deadline (raced as well as signalled). claude-usage records mentions only for
  its `JIRA_KEY_PREFIXES`, so a key outside the tracker's `ledgerProjects`
  (default: the adapter's mirror of that list; a wiki may name its own, and an
  empty or unusable one warns and keeps the default — never "nothing is
  tracked") renders "not tracked" and is never asked. The lookup and the ledger
  start together, so a slow huginn cannot spend the deadline claude-usage was
  never asked in. The key's project and the answer's shape are the adapter's
  (`projectOf`, `parseLedger`). Every other unpriced row says why (`cap`,
  `deadline`, `unreachable`, `not-configured`, `demoted`).
- **Layout.** Counting keys are rows (dashed unless stamped; the strongest
  relation shown, all of them on hover). Link-only keys go on an "also linked"
  line, each with a Link that promotes it; mention-only keys on a "mentioned"
  line with no Link. **Draft plan** shows on an uncovered counting key in
  `todo`/`active` and opens the Discuss dialog in article mode with a leading
  "Draft a plan for KEY" chip and an empty question box.
- **The strip.** When the payload carries `issues`, the strip's chip row draws
  every counting Jira key from them (`stripChipViews`, strongest first,
  inferred ones dashed, ✓ from the lookup's `known`), then every stamped value
  that is not key-shaped as the same inert chip a wiki without a tracker draws.
  `jira` stays in the payload for that, the shape fixture and the reverse
  lookup, which stay stamped-only.
- **Link** is the Stamp route's second body form — see the Stamp section.
  Offered only when `stampable` and the page is markdown (the inline
  `issueStampable` is false on any other page); **Link all** writes the
  `declared`/`created`/`title`/`stem` keys (`LINK_ALL_RELATIONS`, the coverage
  relations minus `stamped`, so it never changes a verdict), one POST at a
  time. While any Link on a page is in flight every Link control there is
  disabled; the lock is keyed by wiki and relPath and survives a navigation
  away and back. After a Link the rows, the strip, the mini-graph and the rail
  row's pills and the Jira facet's chip row redraw from the route's
  re-resolved block. A redraw that replaces the focused control moves focus to
  the same kind of control for the same key (its anchor, its plan link, its
  Draft plan, its Link), else to the section itself; focus is moved ONTO a Link
  or Link all only from that same control, or from the section while it holds
  focus for the Link the reader just activated — never from a read control, so
  Enter on a key anchor cannot become a write.

Acceptance: `trackers/jira-lookup.test.ts`, `provenance-issues.test.ts` (the
gate, coverage, the deferred rows, the ledger cap and deadline, the page route,
the no-tracker pin), `views/components/wiki-issue-rows.test.ts`,
`wiki-stamp.test.ts` (the tracker form) and `e2e/wiki-tracker-connections.spec.ts`.

### The client (`views/components/wiki-provenance-view.ts`)

**One surface: a collapsed line under the title that opens into the chain.**
Below `.wiki-meta-row`, a `.wiki-prov-strip` carries the Jira row, then a
`.wiki-prov-line` — the cost sentence plus one mark per event — and the
`.wiki-prov-chain` it discloses. The rail's `Sessions` section is GONE: it
repeated the strip in a 340 px column, and its two controls (⧉ and ↗) moved into
the chain rows. Both halves render only from the single-page payload's
`provenance` key — absent on an unstamped page, which is the one gate, and
cleared at the START of every navigation rather than when the next response
lands, so a slow load cannot leave the previous page's chain standing over the
new article. **`prs` renders nothing at all**: the frontmatter PR row ships with
campaign 2, and a half-built control is worse than none.

Every string and every fragment of markup lives in **one pure module** — no DOM,
no import from `wiki-browser.ts` — because that entrypoint touches `document` at
import time and `bun test` cannot load it, so anything shaped there is provable
only through Playwright. `costLine` has **nine outcomes**, enumerated in a table
test, and the pair that must never collapse is *asked and unreachable*
("claude-usage unreachable, cost unknown") against *never asked and unconfigured*
("no claude-usage on this host") — plus the third the server's `asked` flag exists
for, a page whose every id is damaged ("N session refs — none could be looked
up"), and the fourth degrade the "over M of N" line used to swallow: a reachable
ledger that priced NOTHING says "the ledger holds none of them" rather than
`cost $0.00 in total over 0 of 1`, which is "we don't know" spelled as "it was
free". The ninth is PR 3's: a page with NO stamped session but a ghost the ledger links
says `the ledger links N sessions through #553 — $X`, which is what makes a
`prs:`-only page render a strip at all (`provStripHtml`'s early return is keyed on
the LINE, which is what let that state be added here rather than as a second
condition there). It rides `with_` like the other eight, so `backfilled` is not
dropped from the one state where it explains the most — why the page names no
session of its own. A page that HAS stamped sessions says it as a separate hint
after the marks instead (`ghostHint`), because the cost sentence is about the
sessions the page stamped.

**Both ghost sentences share `ghostLinkTail`, which COUNTS its sources and states
its denominator.** An earlier cut read `links 3 sessions through #553 — $15.00`
for a page whose three ghosts came through two PRs and a handoff, two of them
priced: it named the FIRST ghost's link as if it were the only one, and the money
read as the total for all three. Now: one PR is named (`through #553`), several
are counted (`through 2 PRs`), handoffs are appended rather than dropped
(`through #553 and a handoff`) since a handoff is the weaker evidence and the
sentence must not hide which kind it rests on, and a session id is never named
(the reader has no way to place one). The money carries ` over M of N` whenever
`M < N`, and no amount at all when nothing is priced — a ghost with no cost is not
a $0 session. Rounding happens once, in `money`'s own `toFixed(2)`. `backfilled` appends `· inferred from history YYYY-MM-DD`
to whichever line was built, degraded ones included: it qualifies the LIST, not the
money. The bare
reasons come from the server's own `bareChipReason`, imported rather than
re-derived, and each of the three gets its own sentence — `missing` is a session
that is gone, `unresolved` one nobody asked about. **`unresolved` splits on
`ledger.configured`** (`bareChipCopy`), for the reason `costLine`'s fourth and
fifth rows split: on a host with no `CLAUDE_USAGE_URL` the default sentence
blames a service that does not exist, under a strip already saying so. A bare
row carries the id and its reason and NO `CLAUDE_USAGE_PUBLIC_URL` drill-down:
for `missing`/`invalid` that link is a dead end by construction — the SERVER
builds the url for every chip and the client decides per row.

**The line is a real `<button aria-expanded>`**, not a `<summary>` and not a
clickable `<div>`: the keyboard reader gets it for free and the state is readable
by anything that asks. It ships collapsed, with no per-viewer memory; the chain
is `hidden` on the ELEMENT rather than behind a class, so a stylesheet that
failed to load leaves the chain closed rather than every row of every page
expanded. ⚠️ **A `display` declaration on a class beats the user agent's own
`[hidden]` rule** — measured: the first cut rendered the chain fully expanded
while the attribute said `hidden`, green through every unit test and caught by
the e2e — so `.wiki-prov-chain[hidden] { display: none; }` rides beside the
`display: flex`, and any later `display` on that element needs it too.

**The chain is `chainEvents`: sessions and merges on ONE spine, ascending.** A
session is dated by `first ?? last` (either end can be the only one the ledger
holds — both are optional in its answer and both default to `null`) and a
merge by `mergedAt`; a DATELESS event sorts LAST, in the page's own `sessions:`
order. That rule is stated rather than inherited from a sort because every bare
chip has `first: null` — `enrichSessions` fills the whole key set with nulls when
the ledger holds no facts — so the shape fixture's `missing` session and a
damaged ref's `invalid` chip would otherwise land wherever the comparator left
them. Ties keep input order (sessions before merges) through an explicit index,
not by relying on the sort being stable, and a stamp that does not parse is
treated as dateless rather than placed at epoch zero.

Stamps render `MM-DD HH:MM` **in the VIEWER's zone**, assembled from
`formatToParts` (a locale decides the order of its own date parts; this row's
layout is not the locale's business) with `hourCycle: "h23"` stated, since `h24`
renders midnight as `24` and `h12` as `12`. The row's `title` carries the
ledger's own ISO stamps, so the local-time label is never the only spelling of
the instant — and every test and spec that asserts an hour pins a zone
explicitly, or the assertion is a fact about the machine that ran it.

**A merge row is rendered from the merge's `url`, never from `repo`.** That
column is a CHECKOUT PATH on this corpus, and turning one into an `owner/repo` is
the guess claude-usage's own `planPrUrl` refuses to make; `url` is null for any
repo its `repoUrls` map does not name, and such a row renders `#n merged …` with
the checkout's BASENAME as a hover and no link at all. Only a `https://github.com/<owner>/<repo>/pull/<n>`
url is linked — an arbitrary href out of a ledger row is not this control. The PR
title is omitted (`subject` is null on every merge measured; it comes from the
confirm side). A **`mergeOk: false` row is QUALIFIED with `merge unconfirmed`,
never dropped**: false has three causes and the common two are ordinary — a UI
merge whose squash message was composed here, and a `gh pr merge` whose result
was never paired — so dropping them would hide the NAV flow's merges entirely
(measured 20 of 179 rows false, 2026-09-16).

**Each of PR 3's legs fails on its own too**, and `linksNotes` adds one footer
line per leg that has something to report: `handoffs not read`, `PR links not read:
claude-usage did not answer`, `handoff lines not shown: this page names more than
10 sessions`, `PR links read for the first 10 entries only`, and `some ledger reads
timed out` when the shared deadline fired mid-fan-out. Legs 5 and 6 report nothing
there: their degrade is already on screen as an id-only ghost row, and a footer
line about it would describe a row the reader can see.

**The merges leg fails on its own, and says so in one footer line.** `mergesNote`
answers most-severe first: `merges not shown: claude-usage did not answer` for a
leg that was asked and got nothing, `merges may be incomplete: claude-usage
answered for some sessions only` for a PARTIAL one, `merges list cut at <limit>
by claude-usage` for upstream's own `truncated`, and NOTHING for a leg that was
never asked — a host with no claude-usage has no merges call to have failed. The
cost sentence is about the FACTS leg and does not move for any of it.

The cut note names UPSTREAM's cap, off the payload's own `limit`, and says "list
cut" rather than "not shown": the rows it stands under ARE rendered. ⚠️ That
state is **unreachable today** and kept deliberately — `fetchMergesForSessions`
batches at exactly `SESSION_IDS_PER_CALL` (200), which is upstream's own
`SESSION_IDS_MAX`, and `truncated` over there is `ids.length > SESSION_IDS_MAX`
per CALL, so no call this side makes can trip it. It is upstream's cap that
decides, and it can move in a release muninn does not ship.

**A session row also carries `· <model>` after the host and `· $Y delegated`
after the cost** where the ledger sent them. The model renders SHORT — one rule,
`modelLabel`: drop a trailing `-YYYYMMDD` release stamp and keep the family — with
the raw id on the row's `title`, because which build answered is a fact worth
reading exactly. `delegatedCost` is a SLICE of the total, never an addition, so it
renders only beside a cost.

**A merge row carries the pipeline ledger's own gate verdict**, `gateVerdict`,
five outcomes in this order: nothing at all for a `gate: null` row (a bare
`gh pr merge`, where upstream deliberately left the data out), `gate not matched`
for `{matched: false}` (the join found no ledger row, which is not "ungated"),
`✓ review floor + split check` for a gated one (the kinds it carried, in the
ledger's own `ASSOCIABLE_GATE_KINDS` order, with an unknown kind named raw rather
than dropped), `no gate data before <date>` for a `preStandardization` row, and
`no gate line` otherwise. `preStandardization` sits BELOW gated and ABOVE
`no gate line` because it qualifies an ABSENCE — a 2026-06 merge has no gate data
to be missing, and calling it `no gate line` reads as a verdict about the merge.
The date is the merges envelope's own `rulesStandardizedDate`, carried rather than
restated.

**A handoff is a quiet row between two sessions**, sorted on the instant the later
session typed the prompt — which is what puts it between them — with both ids on
the hover. A GHOST row is amber on the spine the way a bare row is grey, says what
its evidence is, and carries the Stamp (see above) when `stampable`.

**The marks on the collapsed line are capped at `MARKS_MAX` (24), with one `+N`
tail mark carrying the rest on a hover.** Over the cap, the slots are reserved
PER KIND before they are filled: every kind present gets `floor(24 / kinds)`, and
what a kind does not need of its share passes on in render order (sessions, then
GHOSTS — a dashed ring — then merges). That reservation is why a page of 250 sessions and one merge still shows
the merge — sliced off one sessions-then-merges run it showed `session=24,
merge=0`, deleting the merges leg's whole contribution to the line. MEASURED on
a 60-session page in a 1100 px window: the marks are one inline-flex run beside
the sentence, and
uncapped they ended 44 px past the article column and took the caret with them.
The cap is the LEGIBILITY bound; the containment bound is CSS — `flex-wrap` on
the line, `flex-shrink: 0` + `max-width: 100%` on the marks, `min-width: 0` +
`overflow-wrap` on the cost — and neither alone is enough. The chain below still
lists every event.

The rail's empty state is still decided on the PAGE rows alone (`railListHtml`,
now one argument): the rows that motivated the rule have moved into the chain,
but "No pages match." is about the FILTER and nothing above it may stand in for
that answer. **The explainer path renders nothing** — a standalone `.html`
carries no frontmatter to stamp.

**The strip holds no client state at all.** It is re-rendered from each page's
own payload inside `articleHeadHtml`, which runs on every navigation as part of
replacing `#articleWrap`, so a page that carries no `provenance` key renders no
strip and the previous page's chain goes with the markup it lived in. The client
kept a `currentProvenance` module variable while the rail had a Sessions section
to repaint from it; with that section gone nothing read it, and a cleared-on-
navigation variable nobody reads is a stale-state trap waiting for its first
reader.

`wiki-browser.ts` wires four delegated controls on the document, all delegated
because `#articleWrap`'s innerHTML is replaced on every page load: the Jira key
(`[data-prov-jira]`), the ⧉ copy button (`[data-sess-copy]`, which keeps its
contract from the rail rows), the Stamp (`[data-prov-stamp]`) and the disclosure
(`[data-prov-toggle]`). The copy button and the Stamp are checked BEFORE the
disclosure, since both sit inside the chain the line opens. The two-step confirm
for a handoff ghost lives on the BUTTON rather than in a module flag, for
`toggleProvChain`'s reason: the strip is re-rendered from scratch on every page
load, so a flag would outlive the element it described. `data-prov-stamp-confirm`
is the SERVER's static fact ("this ghost needs confirming") and
`data-prov-stamp-armed` is the press that answered it — three failures came from
having only the first:

- **A double-click delivered both presses.** `dblclick` fires two `click` events
  milliseconds apart, so the confirm was armed and consumed inside one gesture
  and the write happened with the confirmation never on screen. Arming now
  DISABLES the button for `STAMP_ARM_MS` (500 ms), which drops the second click
  of a double-click and not a deliberate second press.
- **A failure disarmed it permanently.** The first press REMOVED the attribute,
  so after a 409 the next single click wrote with no confirmation at all. Every
  non-success path now runs `resetStampButton` — label back to `Stamp`, armed
  flag cleared, button live — so a retry asks again.
- **A 200 with no `provenance` disabled it forever.** The re-resolve can
  legitimately answer nothing; the button now re-enables and `refetchProvStrip`
  re-reads `GET /api/wiki/page/provenance`.

A 200 WITH a block redraws the strip in place from the route's own re-resolved
payload, with the chain left OPEN since the reader was reading it. A refusal goes
into its own `.wiki-chain-stamp-msg` span (`[data-prov-stamp-msg]`, rendered empty
and `hidden` by the view so the class is one spelling), written with
`textContent` — never into the button's LABEL, which is what made a failed Stamp
rename the control to a sentence. `toggleProvChain` reads and writes the DOM only — `aria-expanded` on the
button, `hidden` on the element `aria-controls` names — rather than a module
flag, which would outlive the element it described and report the wrong state on
the next page. Each ⧉ copies the bare id through the shared
`copyText`/`flashCopyResult` pair: the browser cannot reach claude-usage, so
copyable text IS the drill-down, and on the tailnet-over-plain-HTTP deployment
`navigator.clipboard` is absent and the `execCommand` fallback is the only path.

**Contrast**, measured on a body probe in both themes at these sizes:
`--text-faint` is 2.50:1 dark / 2.62:1 light and `--text-dim` 3.24 / 3.74, both
under the 4.5:1 floor. Every line a reader has to READ — the sentence, the dates,
the host, a bare row's reason, the title, the id, the copy control, the footer —
sits at `--text-muted` (5.26 dark / 4.94 light). Only the marks and the provider
glyph sit lower, and each carries a `title`: they are marks, not text.

**The Jira facet** is the `project` facet's twin, mirror for mirror — `?jira=` URL
state, a chip row inside the Filters disclosure, `resolveJiraParam` /
`jiraFilterAfterListing` / `searchWithJira` / `urlWithJira` beside their project
counterparts in `wiki-filter.ts`, and the same rule that a key this wiki does not
know is cleared AND dropped from the URL. Three differences: a page has ONE
project and SEVERAL Jira keys, so `filterPages` matches list membership; the
whole-wiki gate reads the LISTING PAYLOAD's `jira` map rather than the pages,
because that map is shape-filtered server-side while the store deliberately keeps
a typo on the page's own row — counting off the pages would render a chip whose
only behaviour, once clicked, is a 400 from the reverse-lookup route; and
`resolveJiraParam` UPPER-CASES before its membership test (`resolveProjectParam`
matches exactly), because the store normalizes every key and a shared link
routinely carries `?jira=melosys-8045`.

A Jira key has **two behaviours in the reader, and they are different controls**:
the rail search box JUMPS to the pages serving a key typed into it
(`e2e/wiki-rail-pins.spec.ts`), while the chip row and the strip's key FILTER the
listing through `?jira=`. The strip's key sets that facet — and renders as a
control at all only for a key the facet map holds, with `applyJiraFilter`
refusing anything `resolveJiraParam` would drop, so no entry point can set a
filter a reload would silently lose. Smoked end to end in `e2e/wiki-provenance.spec.ts`,
whose `node:http` stub plays claude-usage: it prices ONE of the shape fixture's
two sessions (which drives the `missing` row and the "over M of N" line in a real
browser), answers three merges covering the linked / unlinked / unconfirmed
shapes, and refuses `/api/merges` for one page's session so the footer degrade is
driven through a real page open. The spec pins `timezoneId`, since every rendered
stamp it asserts is otherwise a fact about the machine.

### Stamp (`POST /api/wiki/provenance/stamp`, `routes/wiki-stamp.ts`, `stamp-roots.ts`)

The ONE write the provenance feature makes, and muninn still writes no
frontmatter line: the route spawns claude-usage's CLI exactly as the hook does,
plus `--report`:

```
<WIKI_STAMP_BUN|bun> <WIKI_STAMP_BIN> --session <ref> --file <abs> --report
<WIKI_STAMP_BUN|bun> <WIKI_STAMP_BIN> <stampFlag> <KEY> --file <abs> --report
```

The second line is the **`{ tracker, key }` body form** — Connections' Link.
Exactly one of `ref` and `tracker`+`key` (both ⇒ 400). The adapter is resolved
(unknown ⇒ 400 `unknown-tracker`; a `null` `tracker` or `key` counts as
absent), the key read by its `parseKey` — ASCII key-shaped BEFORE any case
fold, a 2–16 character project and a number of at most eight digits with no
leading zero (⇒ 400 `bad-key`) — a wiki whose `.wiki-reader.json` names no such
tracker is refused 409 `no-tracker`, and a key in none of that tracker's
`projects` 409 `out-of-project`, all before any spawn. Every other check
below applies unchanged. The form refreshes the index on `unchanged` as well as
`written`, since an "already stamped" from the reader usually means a hand edit
the cache has not seen. The CLI's skip reasons reach the row as named states
(`not-inline-list`, `duplicate-key`, `skip-list`; any other one by name — a
non-markdown page never reaches the CLI, since confinement refuses it first).

through the shared bounded spawn helper (`src/utils/run-proc.ts`, hoisted out of
`src/video/media.ts` so a wiki route does not import the capture-vertical graph;
both its streams are capped at `RUN_PROC_MAX_OUTPUT_BYTES` (8 MB, the
claude-usage read cap) because the drain buffers the whole stream in this
process).

**The child env is an ALLOWLIST** — `PATH`, `HOME`, `TMPDIR` and
`WIKI_STAMP_ROOTS`, built by `stampChildEnv`. `WIKI_STAMP_BIN` names a `.ts` file
chosen by an environment variable, so the child is as trusted as whoever set that
variable and no more; `{ ...process.env, … }` handed it everything muninn holds
— how much is measured ONCE, in `stampChildEnv`'s docstring, which is the only
place that count lives (it is a fact about one machine at one moment, and two
independent counts of it disagreed). The three
inherited names are what the CLI needs to RUN — `PATH` so the interpreter is
findable (a bare `{ WIKI_STAMP_ROOTS }` drops it and lands every Stamp in the 502
bucket with an empty stderr), `HOME` for its skip record, `TMPDIR` for
`writeAtomic`'s sibling temp file. A test asserts `PATH` and `WIKI_STAMP_ROOTS`
present and `DATABASE_URL` absent.

Checks, in order, each BEFORE any spawn:

0. **The request itself**, `decideStampRequest` — see "Route-local CSRF" below.
1. `ref` against a copy of the CLI's `SESSION_REF_RE`
   (`/^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,128}$/`) ⇒ **400** `bad-ref`. SHAPE only;
   the CLI stays the authority on meaning. It removes a wasted spawn, a NUL in
   `ref` (which `Bun.spawn` throws SYNCHRONOUSLY for, and which used to be
   reported as `stamp-timeout`) and a newline splitting this route's own success
   log line.
2. `wiki` present but not a string ⇒ **400**. `typeof` alone read it as `""`,
   which means "the default wiki" — a write to a page the caller never named.
3. `isPathConfined(relPath, { domain: "ai", kind: "concept", existingRelPath: relPath })`
   against the resolved root — the exact form `writeWikiPage` uses; without
   `existingRelPath` the helper refuses every page outside `expectedDir`, the
   acceptance page included. Outside ⇒ **400**.
4. **Realpath containment** ⇒ **400** `outside-root`. `isPathConfined` is
   LEXICAL, so a symlink inside the wiki that points outside it passes it:
   measured, `<root>/link.md -> /tmp/x.md` reached the CLI. Both sides are
   resolved the way the CLI's own `realOf` resolves them (the directory always,
   the file itself when it is a link), and the RESOLVED path is what is handed
   down — so muninn's gate and the CLI's classification ask about the same bytes,
   and nothing downstream re-derives a path from `relPath`. A page whose
   DIRECTORY is not on disk is **not** an escape: `realPageOf` resolves the
   deepest ancestor that exists and re-appends the spelled tail, so a typo'd
   folder reaches the CLI and comes back as **409 `missing-file`** — "no such
   page", which is what it is. (muninn resolves one step FURTHER than the CLI's
   `realOf`, which gives up at the first unresolvable directory; resolving more
   is the safe direction, and it is what keeps a wiki under a symlinked
   `/var/folders/…` root from being refused as outside its own root.) One
   branch this resolves LESS strictly than round 1 did: a DANGLING symlinked
   directory inside the wiki (`<root>/d -> /outside/nodir`) has no real path to
   resolve, so the spelled tail is re-appended under the root and the request
   reaches the CLI, which refuses it itself — `outside-roots` if the target ever
   exists, `missing-file` otherwise (`scripts/wiki-stamp.ts` `classifyPath`).
   muninn's gate is not the last check on that branch; the CLI's is.
5. `isWikiReadonly()` / `isReadonlyWikiRoot(root)` ⇒ **403**. AFTER the
   confinement, unlike `writeWikiPage`: deliberate, so a traversal never reaches
   the read-only test with an unresolved root.
6. `WIKI_STAMP_BIN` or `WIKI_STAMP_ROOTS` unset ⇒ **501** naming the variable.
   Below the 403, because an instance that must not write is unwritable however
   it is configured.
7. `isStampRoot(root, config.roots)` ⇒ **409** `not-a-stamp-root`. The equality
   rule below, enforced SERVER-SIDE. `stampable` on the payload is the same
   predicate, but it only hides a button: without this check a wiki registered at
   `<stamproot>/sub` answered `200 written` while the same instance's payload said
   `stampable: false` — two writers, two lock files, the lost append. A 409 rather
   than a 403 because the request is well-formed and permitted and the
   instance's CONFIGURATION is what refuses it.

**The `wiki` name resolves the way the READ routes resolve it.**
`resolveWikiRequest` returns no registry entry for the `WIKI_DIR` env-override
shape (`{envOverride: true, entry: undefined, unknownWiki: false}`), so a guard
keyed on the entry answered "no wiki configured for that name" on an instance
where no name was sent. The root is `entry?.root ?? resolveWikiRoot(undefined)`,
which is what `getWikiIndex` resolves through — and `wiki-routes.ts` passes the
same `resolveWikiRoot(entry?.root)` into `pageProvenance`, so `stampable` is
computed against the root that is actually served rather than `undefined`.

#### Route-local CSRF (`decideStampRequest`)

The route is **admin-zone by default-deny** (no `zones.ts` entry) and covered by
the global side-effect check in `auth/origin.ts` — **in an authenticating mode**.
With `MUNINN_AUTH=off` it is covered by nothing: `src/index.ts` mounts the auth,
origin and zone middlewares only when `isAuthenticatingMode(auth.mode)`, and
`off` is the one instance shape that can actually write. Measured against a live
`off` server: a page on another origin appended a ref with
`fetch(url, {mode: "no-cors", headers: {"content-type": "text/plain"}})`, which
needs no preflight. So the route carries its own pure check, independent of the
mode, with three rules:

| rule | refusal |
|---|---|
| `content-type` is not `application/json` (parameters allowed) | **415** `unsupported-content-type` |
| `Sec-Fetch-Site: cross-site` or `same-site` | **403** `cross-origin` |
| an `Origin` that is not the request's own `Host` authority | **403** `cross-origin` |

Rule 1 is the one that closes it: a cross-origin `fetch` cannot set that header
without a CORS preflight, muninn answers no CORS headers, and the three types a
no-cors request or a `<form>` MAY set are exactly the three this refuses — the
same 415 `jira-routes.ts` mitigated its own measured cross-origin `text/plain`
POST with. ⚠️ Rule 3 compares `Origin` to `Host`, which `auth/origin.ts`
explicitly REFUSES to do for the global middleware (a DNS-rebound name the
attacker owns satisfies it). That argument holds here too: rule 3 is not the
defence, rules 1 and 2 are. It is kept because it refuses the plain cross-origin
POST one step earlier with a readable reason, and under `off` there is no
`MUNINN_ALLOWED_ORIGINS` to check against at all. **The other muninn write routes
share this exposure under `off`** — a class follow-up, out of this route's scope.

**Behind `tailscale serve`, rule 3 passes as written — MEASURED** (2026-09-17,
the author's laptop): the proxy passes `Host:` through UNCHANGED as the tailnet
name (`rune-macbook-pro-m4-max.tail7b311e.ts.net`), adds `X-Forwarded-Host` with
the same value and `X-Forwarded-Proto: https`, and a browser on that page sends
`Origin: https://<that host>`. So `Origin` and `Host` name one authority under
two schemes, which is exactly what `originMatchesHost` compares host+port for.
Nothing reads `X-Forwarded-*`: a forwarding header is client-settable on a direct
request, so trusting one would hand the comparison to the caller. No code change
came of the measurement; the proxied shape is a unit case.

**A refusal warns ONCE per reason, then logs `info`.** These refusals are
precisely what a cross-origin page produces, and nothing rate-limits it. The
change is to the CONSOLE only: the JSONL file sink writes `info` as well, so it
still receives one line per refused POST (measured 2026-09-17: 120 POSTs, 114
lines). A request-rate cap for refused writes is a follow-up shared with every
muninn write route reachable under `MUNINN_AUTH=off`; `ws-upgrade.ts` and
`introspect.ts` return without logging, a different discipline.

The CLI **always exits 0 and prints nothing without `--report`** (its banner
invariant), but only once it runs — so the route parses the LAST stdout line as
JSON and treats the exit code as information only when there is no report line:

| CLI result | Route |
|---|---|
| `written` | 200 + the RE-RESOLVED `provenance` block, so the client redraws with no second fetch |
| `unchanged` (`already-stamped`) | 200, same body — the append is idempotent |
| `skipped` | 409 `{reason}`, the CLI's own reason verbatim (`outside-roots`, `lock-timeout`, …) |
| no parseable report line | 502 `{exitCode, stderr: <first line>}` |
| the CLI printed more than `RUN_PROC_MAX_OUTPUT_BYTES` (8 MB) BEFORE its report line | 502, as "no parseable report line" — a stated limitation, see below |
| a report naming a different `path` than the one asked for | 502 `{reason: "path-mismatch"}` |
| muninn's own spawn timeout (`ProcTimeoutError`) | 409 `{reason: "stamp-timeout"}` |
| any OTHER throw out of the spawn | 502 `{error, exitCode: null}` |

The last two rows used to be one. `Bun.spawn` throws SYNCHRONOUSLY for an argv it
cannot build or a binary it cannot execute — a NUL in `ref` failed in ~10 ms —
and reporting that as "the CLI did not return" sends an operator looking for a
wedged child that never existed. `runProc` rejects with a typed `ProcTimeoutError`
so the two are told apart by type rather than by matching a message string.
**The 8 MB cap can eat the answer, and that is the accepted trade.** `runProc`
CANCELS a stream at the cap rather than draining it, so a CLI that printed 8 MB
before its report line loses the report and the Stamp answers 502 — a write that
may well have happened, reported as a failure. The cap is not negotiable (the
drain buffers in the dashboard's event loop and a fast writer reaches gigabytes
inside the 15 s budget), and the CLI's own banner invariant is that `--report`
prints ONE line and nothing else, so 8 MB of preamble is already a bug in the
child. The retry is safe: the append is idempotent and answers `unchanged`.

The `path-mismatch` row reads back the report's own `path`: the CLI was given one
file and nothing else, so a different one means the two sides do not agree about
which page was just written, which is the one thing a success must never hide. An
ABSENT `path` is tolerated (an older CLI printed none).

**After a `written` report the wiki index is REFRESHED before the re-resolve**
(`getWikiIndex({ root, refresh: true })`, the step `defaultPageWriteIo` runs for
muninn's own writes): `pageProvenance` reads `sessions:` off the TTL-cached index,
so without it the cache answers the pre-stamp frontmatter and the row stays amber
— the inert-fix shape, green in every test that does not open the page.

**No `baseHash` crosses the wire**: the append is idempotent
and the CLI holds the same per-root lock muninn's writers take across its whole
read-modify-write. A Stamp retires `sessions_backfilled` (the CLI does it), so the
`· inferred from history` tail leaves the cost line on the re-resolve.

**`stampable`** is a boolean on the payload beside `ledger`, and false hides every
Stamp button:

```
WIKI_STAMP_BIN && WIKI_STAMP_ROOTS && wikiDir EQUALS one of the parsed roots
  && !isWikiReadonly() && !isReadonlyWikiRoot(wikiDir)
```

**EQUALITY, not containment** (`stamp-roots.ts`): the CLI locks the longest
matching STAMP root and muninn locks the WIKI root, so a wiki registered at a
strict subdirectory of a stamp root gets two different lock files and no mutual
exclusion — the lost-append the single-writer rule exists to prevent, and what
makes "nothing for a hash to protect" true. `…/mimir-old` is not `…/mimir` and
`…/mimir/plans` is not `…/mimir`; both are false, and both would be true under
the prefix tests this replaces. muninn re-implements the roots parse rather than
importing it (`:`-separated like `PATH`, relative entries dropped, `/` refused,
normalized, deduped — `claude-usage/src/wiki-stamp.ts`'s `parseRoots` semantics).
The mini — a stamping host with both variables set AND `MUNINN_WIKI_READONLY=1` —
is the case that makes the read-only half necessary.

### The cross-process lockfile (`lockfile.ts`)

`runWikiWriteExclusive` serializes muninn's own writers against each other. It
cannot serialize muninn against ANOTHER PROCESS, and there is one: `wiki-stamp`,
spawned from a `PostToolUse` hook, appends a session id to a page's `sessions:`
line while the model is mid-turn on that same file. So both sides take
`<root>/.wiki-write.lock` with `openSync(path, "wx")` (`O_CREAT|O_EXCL`).

**The lock is taken on EVERY registered wiki root a writer touches**, not on two
named ones — so every root has to tolerate the file. mimir's `.gitignore` names
both it and `.wiki-stamp.*.tmp`; the jarvis wiki's own repo (`huginn-jarvis`,
which is a repo of its own — the outer `huginn` checkout's directory rule is a
different repo answering a different question) ignores NEITHER, and muninn does
not edit that repo. So `isWikiWriteArtifact` (`lockfile.ts`) skips both by
BASENAME at the three places that enumerate a wiki's dirty files —
`listWikiSubtreeDirty` (the daily `wiki-committer` sweeper, which would otherwise
commit a LIVE lockfile and delete it again on the next sweep, forever),
`listDirtyEntries` (the repo-sync loop, which holds the lock across its own
`git status`, so the file is dirty by construction on every tick) and
`wikiDirtyStat` (the Index card's badge, which would report a wiki as having
uncommitted changes for the two seconds a write holds it).

| | wiki-stamp | muninn |
|---|---|---|
| wait | 250 ms | `WIKI_LOCK_WAIT_MS` (2 s) |
| stale takeover | 10 s | `WIKI_LOCK_STALE_MS` (10 s, the same) |
| on timeout | skip the stamp, record it | `locked` outcome, nothing written |

muninn waits eight times longer because it is the LONG holder — its section spans
read → CAS → write → log.md, while the stamp is a read-modify-write of four
lines — and because a hook is synchronous on a tool call while a human clicking ➕
can wait. The stale window is the same on both sides: shorter here and muninn
seizes a lock the stamper still holds; longer and muninn waits behind an
interrupted stamp longer than the stamper would wait for itself.

**On acquire muninn writes ONE JSON line into the file** — `{pid, host, op, at}`.
For an operator it answers "who is holding this, and since when" from a file that
was otherwise zero bytes. For the code it is a FENCE: `release()` unlinks only
while the file still carries OUR line, so a lockfile a third process took over as
stale — and is now holding for its own write — is never deleted by our late
release; acquire verifies the same way, re-reading after the write, because a
stale takeover elsewhere can unlink and recreate the file between our `O_EXCL`
create and our write. ⚠️ **The fence is ONE-SIDED today**: `wiki-stamp` writes an
empty lockfile and unlinks unconditionally, so it can still drop a lock muninn
holds once muninn's has aged past the stale window. Follow-up in claude-usage
(write an owner line, verify before unlinking); until then this half stops muninn
from being the one that does it. ⚠️ **The Stamp route makes that one-sidedness
READER-TRIGGERABLE**: until PR 3 the CLI only ran from a `PostToolUse` hook on
this machine's own tool calls, and it now also runs whenever a reader presses
Stamp. The exposure is unchanged in KIND (the same CLI, the same unconditional
unlink) and landed as-is; what changed is who can time it. The window needs
muninn's own lock to have aged past `WIKI_LOCK_STALE_MS` (10 s) first, which a
wiki write does not do in normal operation.

Three rules are load-bearing:

- **Two locks, in this order.** The in-process QUEUE first (it is what the chain
  is keyed on), the FILE lock inside it, released before the section returns — so
  the commit tail, which enqueues on a different chain, never runs holding it.
  Taking the file lock outside the queue would make every queued writer wait on
  it in turn while the one ahead held the chain: a deadlock shape, not a wait.
- **A non-numeric `waitMs` is REFUSED, not defaulted.** The wait becomes a
  deadline (`now() + waitMs`) and every `now() >= until` test against NaN is
  false, so a held lock would be polled without end while the caller holds
  whatever it holds. `takeWikiWriteLock` throws a `TypeError` on anything that is
  not a finite, non-negative number. Not hypothetical: this function's second
  argument changed from a positional `waitMs` to an options object and one call
  site kept passing the object positionally.
- **Only a HELD lock refuses a write.** EEXIST means someone has it: wait, poll,
  take over once stale. Any OTHER errno — ENOENT on a root that does not exist,
  EACCES on a 0555 checkout, EROFS on a read-only mount — means waiting cannot
  help, so muninn proceeds with a warn. The lock is an advisory interlock with a
  best-effort stamper (which records `lock-unavailable` and skips on the same
  errnos); a root muninn genuinely cannot write to fails at the WRITE, which is
  where that failure belongs.
- **`locked` is its own `PageWriteOutcome` variant**, not `error`: nothing failed
  and nothing was written, so every route maps it to **409 `{error, locked:
  true}`** beside `stale` — the fact-check append, the integrate apply and both
  `/plans` writes. Those routes map outcomes with `if` chains whose fall-through
  is success, so a new variant that is not named there reports a write that never
  happened.

**The `locked` 409 is a RETRY, not a reload — and the clients say so.** Two
conditions answer 409 at these routes and their recoveries are opposite, so the
body's `locked` flag decides, never the status: the `/plans` board renders a
retry sentence with `reload: false` (`classifyWriteFailure`), and the reader's ➕
and ✎ bars show `WIKI_LOCKED_COPY` instead of the stale copy (`isLockedResponse`,
one reader of the flag shared by both). Branching on the status alone told a
reader whose only problem was a two-second lock contention that their page had
changed on disk, and disabled the control until they reloaded something that was
never stale.

**The repo-sync loop takes it too** (`src/sync/run.ts`, `withWikiFileLock`), per
affected root, INSIDE that root's in-process queue and held over the local
section only — status → add/commit → rebase, all local git, so it holds no
network I/O. `git rebase` is the one operation in that file that rewrites a
working tree wholesale, and a stamper that read a page before the rebase and
renamed its replacement over it afterwards reverts whatever the rebase pulled in;
the NEXT tick commits and pushes that revert as if a human had made it. A held
lock is a hard `deferred` carrying `sectionSkipped`, which withholds the sweeper
evidence stamp — an ordinary `deferred` means "the commit path ran and the loop
chose to wait", and this one means nothing ran at all.

`applyWikiProposal` and `writePlanQueue` route through `runWikiWriteExclusive`
but NOT through `writeWikiPage`, so they take the in-process queue and **not** the
file lock. Stated rather than fixed, with the justification corrected:

- `writePlanQueue` is genuinely SAFE — it writes `plans/queue.yaml`, which is not
  a page and carries no frontmatter, so the stamper will never touch it.
- `applyWikiProposal` is NOT. Its update mode rewrites an EXISTING page, which is
  exactly what the stamper appends to; the earlier claim that "the stamper only
  ever appends frontmatter to a page that already exists" describes the race
  rather than excluding it. The decision to leave it unlocked still stands,
  because its outcome union has no `locked` variant and mapping a 2 s contention
  onto `error` flips the proposal row to a TERMINAL state — a worse failure than
  the narrow race. **The residual is a lost apply or a lost stamp** on a page
  being applied and stamped in the same instant. Adding the lock means adding the
  variant and its route mapping first.

**A read-only INSTANCE does not hold this lock at all** — on the mini
(`MUNINN_WIKI_READONLY=1`) `writeWikiPage` refuses at its `forbidden` guard,
which runs BEFORE the lock is taken, so nothing is created and nothing is waited
on there. The sync loop and the sweeper still run on that host and still take it;
they are git operations, which neither read-only mechanism gates.

⚠️ **`WIKI_STAMP_ROOTS` (claude-usage) and muninn's registered roots must name the
SAME directories.** The lock is per ROOT, so two processes configured with
different roots lock at different paths and share nothing. In particular a wiki
registered at a strict SUBDIRECTORY of a stamp root gets no mutual exclusion:
the stamper locks the parent, muninn locks the child, and both writes proceed.

## Write queue (`queue.ts`)

Per-wiki write queue, realpath-keyed on the wiki ROOT. `log.md` is wiki-GLOBAL, so every read-modify-writer of it (gardener apply, fact-check append/integrate, `writeWikiPage`) must serialize on this one chain. `writePlanQueue` joins it too — it writes no `log.md`, but it shares mimir's working tree with the page writers and the sync loop's staging.

**No-log mode (`logKind: null`, `PageWriteNoLogOptions`).** The write, the CAS, the queue and the wiki-store cache refresh all still happen; the `log.md` entry and the huginn reindex fan-out do not, and the commit tail stages the page alone. It exists for metadata writes — the `/plans` board's priority flips — where a triage sitting is a burst of 60 clicks: one curated log line each would bury the 4,100-line log those entries are FOR, and 60 reindex calls would re-embed a page whose prose never moved. A separate interface rather than three optional fields, so the ordinary path still cannot compile without its title and line. The CAS's `staleReason` is a caller option for the same reason: the default is the fact-check wording this helper was extracted from, and it is the whole explanation a reader gets for a refused click. Rules for joining: the queued section must span read→CAS→write→log.md, and the commit tail must run OUTSIDE the queue (push is dispatched un-awaited and bounded only by `GIT_NETWORK_TIMEOUT_MS` (60s) — an unreachable origin would otherwise park every writer for that minute). Full rationale: `src/gardener/CLAUDE.md`.

## Readonly — two independent mechanisms (`readonly.ts`)

There are **two** read-only switches, and they answer different questions. Neither implies the other; both, either or neither can be on.

| | `MUNINN_WIKI_READONLY` | `WIKI_READONLY_ROOTS` |
|---|---|---|
| Scope | the whole INSTANCE | one wiki ROOT (comma-separated list) |
| Question | "does this machine own wiki writes?" | "may muninn do anything but read THIS root?" |
| Forbids | page content writes | page content writes **+ every model call / web reach / chat seed** on that wiki |
| Predicate | `isWikiReadonly()` | `isReadonlyWikiRoot(root)` |
| Refusal copy | `WIKI_READONLY_REASON` | `wikiReadonlyRootReason(root)` / `wikiNoEgressReason(wiki)` — **neither names a filesystem path**: both land verbatim in a 403 body, and interpolating the root published an absolute home-directory path on a reader-facing API (the `wikis[].root` rule). `wikiNoEgressReason("")` drops the quoted name for the `WIKI_DIR` env-override shape. |

### The instance switch (`MUNINN_WIKI_READONLY`)

`MUNINN_WIKI_READONLY=1` marks an instance as NOT the wiki write owner. Muninn runs on two machines against the same wiki working trees, and `SCHEDULER_ENABLED=false` closes only the scheduler — `createDashboardRoutes` registers every route unconditionally, so the whole HTTP write surface stays live on the non-owner.

**It forbids page CONTENT writes, not git.** Enforced at exactly three seams, each taking an injectable `isReadonly` that defaults to `isWikiReadonly()` (so a call site added later is guarded by default, and a test drives one seam without touching the process env):

- `writeWikiPage` → new `forbidden` outcome variant, returned BEFORE the read (nothing is opened, no `log.md` is created). `appendBlockToPage` propagates it.
- `applyWikiProposal` → same variant, returned before the write queue is entered.
- `writePlanQueue` (`src/plans/write.ts`) → same variant, before the file is opened. It is the third content seam because `writeWikiPage` cannot carry `plans/queue.yaml` (path confinement admits `.md`/`.mdx` only, correctly), so it repeats the guard, the per-wiki queue and the sha256 CAS rather than routing around them.

All three map to **403** with the SAME body everywhere — `{error, readonly: true}` — deliberately not collapsed into the generic `error` (⇒ 500), since a refusal is not a failure.

The mutation routes additionally refuse as their FIRST statement (`readonlyRefusal`, one per route file), so the answer costs no DB round-trip, no model call and no status CAS — and each refusal is `log.info`d with its route path, because a route guard answers *before* the seams (which warn on their own), so a refused POST otherwise left no trace at all:

- **Applies + drafting:** `proposals/:id/approve` (before the draft→approved CAS, so the row stays reviewable for the write owner), `gardener/backlog-run`, `gardener/source-draft-{run,backlog,doc}`, `atlas/draft-synthesis`, and `factcheck/integrate` (the PROPOSE half — it writes nothing, but its only consumer is the guarded `/apply`, so its ~90s one-shot could only ever buy a preview nothing can commit). Guarded even though they persist proposals rather than pages: a readonly instance must not build a gate backlog it can never apply.
- **Backlog state verbs:** `gardener/backlog-{reset,cancel,recover,dismiss}` and the prune verbs `gardener/backlog-docs-{dismiss,undismiss,dismiss-reset}` + `gardener/backlog-doc-delete` (the last four share one guarded prologue, `resolvePruneTarget`). They write no wiki page, but they mutate the watcher snapshots the write owner's in-flight drain reads back — and delete reaches huginn. **`backlog-doc-delete` also deletes the `source` proposals drafted FROM the doc** (`deleteSourceProposalsForDoc`, inside the same mutex — pinned by a test whose seam asserts a second `runExclusive` is refused — and only after huginn's DELETE succeeded): a review-gate card whose source is gone is not reviewable, and approving it would write a page from a deleted document. `applied` rows are KEPT and named in the response (`proposals.kept`) — their wiki page still exists. It also clears the WHOLE summaries stats cache, not one bot's key: that cache is keyed on the stats route's `?bot=` fallback (`"jarvis"`), which is not in general the deleting bot. The `/summaries` doc panel's 🗑 Delete posts to this same route with an explicit `?wiki=` the PAGE resolved (`src/summaries/delete-target.ts`: the default bot wiki, else the first; no button at all on a read-only instance/root or with no bot wiki), so there is ONE delete path, not two — and the one gate the page cannot pre-check, a seeded `wiki-gardener` watcher, surfaces as the route's 404 in the page notice.
- **`POST /api/watchers/:id/trigger`** (`data-routes.ts`), for the wiki-DRAFTING watcher types only (`wiki-gardener`, `consolidation-gardener` — `WIKI_DRAFTING_WATCHER_TYPES`). Non-wiki watchers (email/x/anthropic), the report-only `wiki-linter` and the git-only `wiki-committer` stay triggerable.
- **The SCHEDULED run of those same two types** — `runChecker` (`src/watchers/runner.ts`) returns `[]` with one `log.info` before dispatching either gardener. Guarding only the route was a hole, not a design: a readonly instance left with `SCHEDULER_ENABLED=true` kept minting weekly proposals (and spending model calls) that only the write owner can apply. Both call sites read the SAME `WIKI_DRAFTING_WATCHER_TYPES`, which lives in `src/watchers/wiki-drafting.ts` for exactly that reason. The run still advances `last_run_at` (the skip is not an error), and `wiki-linter`/`wiki-committer` stay unguarded on this path too.
- **`triggerSourceDraftFromCapture`** (`src/gardener/source-drafter-run.ts`) — not a route but the widest entry point: fire-and-forget from six capture summarizers, all reachable over the tokenless HTTP surface. The check lives in the trigger function, NOT at the six call sites, so a seventh caller is guarded by default. Its `isReadonly`/`run` seams are injectable for the same reason the write seams' are.

**Not guarded, on purpose:** `commitWikiChange` (the repo-sync loop on the readonly instance commits and pushes through it), the `wiki-committer` watcher (it commits stray dirty files, writes no page content), `proposals/:id/reject` (a DB status flip that mutates no wiki), `/api/wiki/remember` (a DB memory — but it IS on the per-wiki egress list below, since it spends a Haiku distill + an embedding) and `/api/wiki/reindex` (huginn indexing — but it IS on the per-wiki egress list below, since it ships page bodies off the machine). Offline scripts writing via a bare `Bun.write` are out of scope — this guards the HTTP surface.

### The per-wiki switch (`WIKI_READONLY_ROOTS`)

`WIKI_READONLY_ROOTS` is a comma-separated list of wiki **ROOTS** a write-owning instance may only READ. It exists for `~/.claude/projects` — Claude Code's own auto-memory, browsable as the `memory` wiki — whose files are loaded into a session's context at start, so an HTTP write there edits the developer's own instructions.

**Three design decisions carry it.**

1. **Keyed on the resolved ROOT, not the registry name.** Every enforcement point already holds the root at its refusal (`writeWikiPage`'s `wikiDir`, `applyWikiProposal`'s `deps.wikiDir`, `writePlanQueue`'s `opts.wikiDir`, an egress route's `entry.root`), so the predicate is a string comparison against a value in hand — no registry lookup, and therefore no `registry-memo.ts` → `bots/config.ts` → `db/` import pull into the store and the page writer. A NAME key would need a name→root translation whose typo path fails **open**; the root key's typo path names a root nothing writes, i.e. fails closed for itself. Paths resolve through the shared `resolveConfiguredPath`, and matching additionally tries the realpath form so a symlinked (or, on a case-insensitive filesystem, differently-cased) spelling of the same directory still matches. Matching is **root-EXACT, never a prefix**: a wiki registered at a subdirectory of a listed root is NOT covered, so list each root you mean. The single realpath-aware comparison is `sameWikiRoot`, shared by the guard and by `unmatchedReadonlyWikiRoots` (the `registry-memo.ts` drift report + the `/models` card) — the pure registry builder used to re-spell it normalize-only, which warned "matches no registered wiki root" for every symlinked root while the entry it named carried `readonly: true`.
2. **In the environment, not in `.wiki-reader.json`.** `readWikiReaderConfig` degrades a missing/unreadable/malformed file to `null`; for an ontology that is right, for a write guard it means "degrade to writable", silently and invisibly to any test run against a well-formed config. The file carries cosmetics (`include`), the environment carries safety.
3. **Enforcement never reads `WikiRegistryEntry.readonly`.** That flag exists for the client half and the `/models` card only; a stale memo or a registry built without the roots must not be able to open the guard.

**Registration buys THREE surfaces, not two,** which is why this switch forbids more than writes: file writes (the three seams), local reads (bounded by `DASHBOARD_HOST=127.0.0.1`) — and a set of `?wiki=`-steerable routes that spend a **model call** on page content, two of which reach the **live web** through the fact-check prompt's WebFetch/search instructions. Loopback does not bound that. Nor does bot-lessness: `resolveWikiSynthesisBot` falls through to `resolveResearchBot` for any entry with no pin and `source !== "bot"` (`bots/config.ts`), so every one of these routes resolves a bot and runs.

So each of them carries a **per-wiki prologue** (`egressRefusal` in `wiki-routes.ts`) placed immediately after the entry resolves and BEFORE bot resolution / the index read / the DB thread / the `/agents` run registration / the one-shot — and it keys on the **resolved ROOT, entry or no entry**: `resolveWikiRequest` returns `entry: undefined` for the `WIKI_DIR` env-override shape while the routes go on serving `resolveWikiRoot(undefined)`, so an entry-keyed refusal failed OPEN on exactly the root an operator pointed the var at — the mirror image of `readonlyRefusal`, which is a route's FIRST statement precisely because it needs no wiki:

| Route | What it would spend |
|---|---|
| `GET /api/wiki/factcheck` | claim extraction + per-claim verification — **live web** |
| `GET /api/wiki/factcheck/claim` | one re-verification — **live web** |
| `POST /api/wiki/share` | one fenced one-shot turning the page into a pasteable post |
| `POST /api/wiki/ask/chat` | a DB thread + conversation shell seeded with page content (**all three modes**) |
| `POST /api/wiki/factcheck/integrate` | the ~90 s editor one-shot over the whole page |
| `GET /api/wiki/digest` | a `log.md` summarization one-shot — gated by nothing else, so it fires on the reader's first start-view load |
| `GET /api/wiki/ask` / `GET /api/wiki/explain` | retrieval + cited synthesis (collection-gated today; a `WIKI_EXTRA` 3rd segment lights them up) |
| `POST /api/wiki/remember` | a Haiku distill + an embedding (it writes a Postgres row, not a file — hence egress list, not write list) |
| `POST /api/wiki/atlas/draft-synthesis` | the drafting one-shot + a proposal the seam guard then refuses forever |
| `POST /api/wiki/reindex` | every page BODY shipped to huginn's embedder — the one non-model way this wiki's content leaves the machine (collection-gated today, which is one `WIKI_EXTRA` third segment away from being untrue) |

**The prologue's entry-less fallback is scoped to the requests it actually serves.** `resolveWikiRequest` answers `entry: undefined` for two unrelated shapes — the `WIKI_DIR` env override (no `?wiki=`/`?bot=` given), which the routes really do serve from `resolveWikiRoot(undefined)` and which therefore must be guarded, and an UNKNOWN name, which they serve not at all. `readonlyCandidateRoot(entry, unknownWiki)` separates them (`null` ⇒ no root ⇒ no refusal): keying on `entry === undefined` alone made a typo inherit the env root's policy, so with `WIKI_DIR` naming a read-only root `?wiki=typo` answered 403 "this wiki is read-only" about a wiki nobody asked for, and `/wiki?wiki=typo` rendered the banner + disabled Ask box to match. An unknown name keeps the preflight error each route already has. The same helper feeds the `/wiki` render flag, so page and routes cannot disagree.

`/api/wiki/digest` is the one refusal that does not use the shared `error` key: the What's-new card reads `data.error` as "generation FAILED — keep the old digest, offer a retry", and a policy refusal is not a failure, so it answers 403 with `{digest: null, readonly: true, reason}` and the card simply hides.

The **14 `readonlyRefusal` route guards are deliberately untouched** — inverting their ordering at every site to make them per-wiki is a much larger change than the surface warrants. What covers the gardener/backlog family instead, and both halves were corrected after review:

- **`resolveBacklogBot` refuses a read-only root explicitly**, with the family's ONE shape — 403 + `readonly: true`, rendered by the shared `backlogRefusal(c, …)` rather than spelled at each of its ten call sites (a 400 reads as "your request was malformed", which is the one thing the caller cannot fix). Its `source !== "bot"` check covers a standalone read-only wiki; it does NOT cover a BOT whose own `wikiDir` is listed, and every drafting POST in that file (backlog-run, source-draft-{run,backlog,doc}, backlog-doc-delete) funnels through that one prologue.
- **`proposals/:id/approve` refuses BEFORE the draft→approved CAS.** The root-keyed `applyWikiProposal` guard is reached only AFTER it, so — measured — approve returned 403 with the row left in `approved`, where the gate offers no verb at all (reject 409s "not reviewable"): stuck forever on a refusal that changed nothing. The cheap half of the apply-target lookup (wiki name → registry root, else bot → `wikiDir`) is hoisted above the CAS for it; the failing half stays below, since it flips the row to `error`. The read and the CAS are `BacklogRouteDeps` seams precisely so a test can drive the gap between them.
- **`isGardenerWiki` excludes read-only wikis cosmetically** — a picker filter and nothing more (its three consumers are all read-side).

**Non-HTTP surfaces carry the same check**, since a scheduled run spends exactly what a route would: `checkWikiGardener` and `checkConsolidationGardener` skip a read-only root with one `log.info` (stated explicitly rather than left to the collection check, which stops a read-only root today only by coincidence of configuration and would report a POLICY decision as a source-health ERROR), `triggerSourceDraftFromCapture` skips at the same seam its instance-flag guard uses, and `POST /api/watchers/:id/trigger` answers 403 rather than queueing a forced run that can only no-op — via `wikiDraftingTarget` (`src/watchers/wiki-drafting.ts`), which gates on the SHARED `WIKI_DRAFTING_WATCHER_TYPES` set the instance guard reads and returns `unhandled` (warn + 403, fail-closed) for a member it has no root resolver for, rather than the hardcoded pair of type names that silently answered "allow" for anything else. `wiki-linter` (report-only, no model call, no write) and `wiki-committer` (git, which both mechanisms deliberately leave open) are NOT guarded.

Diagnostics: a `WIKI_READONLY_ROOTS` entry matching no registered wiki root is warned about loudly in `registry-memo.ts` (someone edited one var and not the other) — NOT in the pure builder, which had to re-spell the root comparison and got it wrong for symlinks; the warn and the `/models` card share `unmatchedReadonlyWikiRoots`. The `/models` **Machine** card renders matched and unmatched roots as SEPARATE rows beside `MUNINN_WIKI_READONLY`, with each registered wiki tagged `read-only` — one count over both read as protection for an entry that guards nothing. The unmatched row renders in the LOUD `warn` style, not the muted `none` one that means "absent value".

### Client half

The pages inject `window.__WIKI_READONLY__` (instance) and `window.__WIKI_READONLY_WIKI__` (the OPEN wiki's per-wiki flag, from the resolved entry) and `wiki-readonly-client.ts` stamps `body.wiki-readonly` (+ `body.wiki-readonly-wiki`) + installs the capture-phase blockers `wikiReadonlyGuardPlan(instance, perWiki)` returns — one per `{type, selector}` pair.

**`click` alone was not enough for a read-only WIKI — and is exactly enough for a read-only INSTANCE, which is why the plan is computed from the flags rather than fixed.** Three egress buttons are activated from a **`mousedown`** delegate (`WIKI_READONLY_MOUSEDOWN_SELECTOR` = `#wikiExplainBtn`, `#wikiFactcheckBtn`, `#wikiFactcheckArticleBtn` — mousedown so `preventDefault` keeps the text selection alive), which fires BEFORE `click` and had already spent the call by the time the click listener ran; and two more are reachable from the **keyboard** with no pointer event at all (`WIKI_READONLY_KEYDOWN_SELECTOR` — Enter in `#wikiAskInput` and in `#wikiFollowupInput`). The keydown listener cancels only ACTIVATING keys (`wikiReadonlyKeyActivates` — Enter/Space): cancelling Tab would trap focus, and cancelling character keys buys nothing, since the activation is what spends the model call.

**Neither of those two listeners is installed for the INSTANCE flag, and that is load-bearing.** Every cancel ends in `stopImmediatePropagation()`, so an installed listener is an event taken away from the page's own delegates on the same node — and `wiki-browser.ts` owns a bubble-phase `mousedown` delegate on `document` whose fall-through dismisses the Explain button. Installing the mousedown cancel unconditionally meant a mousedown on ANY write control (➕, ✎, a gardener verb) killed that delegate and left the Explain button on screen for the rest of the session. The instance plan is therefore byte-identical to what shipped before `WIKI_READONLY_ROOTS` existed: the click cancel alone, over the write controls, which are click-activated. The per-wiki mousedown cancel is scoped to the three mousedown-ACTIVATED ids for the same reason — a write control's mousedown is nobody's business, its click is already refused. Driven through a fake DOM in `views/components/wiki-readonly-client.test.ts` (capture → bubble, asserting on the SECOND listener), because a selector assertion cannot see a listener that should not exist.

**Beyond cancelling the event, three things state the refusal before the click:** the two question inputs render `disabled` with a shared read-only placeholder (`WIKI_READONLY_DISABLED_INPUTS` — set server-side on `#wikiAskInput` and at RENDER time in `askFollowupHtml`, because that bar is repainted on every turn switch and a boot-time DOM sweep would be undone by the next paint; they are in the SELECTOR too, which is the half that survives those repaints); a one-line banner under the breadcrumb, rendered unconditionally and shown by CSS keyed on `body.wiki-readonly-wiki` so the banner and the dimmed controls cannot disagree; and the Ask rail's copy is replaced (`WIKI_READONLY_ASK_HINT`) while the "Answered by <bot> … research-bot fallback" line is dropped entirely — it describes a call this wiki can never make. **And the four dialog openers are gated on the FLAG, not only on the cancelled click** (`openChatOptions`, `openArticleShare`, plus `submitChatOptions` and the share dialog's `generate`, the two statements that actually spend), so a path that never dispatches a click cannot walk into a dialog whose only outcome is a 403.

**Two selector lists, not one.** `WIKI_READONLY_BLOCKED_SELECTOR` is the write controls (unchanged); `WIKI_READONLY_EGRESS_SELECTOR` adds 📤 Share, both 🔎/✓ Fact check buttons, ✨ Explain, 💬 Discuss, Ask/New chat/follow-up/Remember, the chat-escalate bar, the claim-retry ↻ and the two Enter-submitting inputs. A read-only WIKI installs the union; a read-only INSTANCE installs only the first — folding the egress ids into the shared list would dim Share and Fact check on the mini, where the server serves both happily. The sentence differs for the same reason: `WIKI_READONLY_WIKI_MESSAGE` must not claim `MUNINN_WIKI_READONLY=1` on a host that writes every other wiki. `wikiBlockedSelectorFor`/`wikiBlockedMessageFor` are pure and unit-tested; neither flag ⇒ empty selector ⇒ no listener installed at all. Deliberately not a per-render `disabled` sweep — the gardener strip and the answer pane replace their innerHTML on every poll/SSE event, so any state written into a button is gone by the next paint; a body class is a selector and survives. The blocked list uses the SAME attributes the real delegated handlers key on, so the two cannot drift.

`isBlockedByReadonly` capability-tests `target.closest` before calling it, and **fails SOFT** — it never throws. `e.target` is only *usually* an Element (a click dispatched at `document`, a synthetic event, a text node), and a capture-phase listener that THROWS never reaches its `preventDefault`, so a TypeError there let clicks through on *every* blocked control on the page. Returning `false` for a non-Element loses nothing blockable: a non-Element cannot match a selector, so it was never a mutation control.

**`WIKI_READONLY_BLOCKED_SELECTOR`'s deliberate absences,** each for its own reason: `[data-action="reject"]` (a DB status flip that mutates no wiki — the server leaves it unguarded too); the inspector's `data-inspect-bucket` filters and its `close`/`more` controls (reads and pagination — only its `bulk-dismiss` verb writes); and `[data-backlog-action="cancel"]`, which is the confirm PANEL's close button (not the drain's `cancel-run`) — blocking it would strand the panel open with no way to dismiss it. Everything else behind a guarded route is listed, including `confirm` (the panel opener: every action inside it is refused, so it is a dead end here).

Which instance is which is readable on `/models` (the **Machine** card: hostname, `SCHEDULER_ENABLED`, `MUNINN_WIKI_READONLY`, the resolved `WIKI_READONLY_ROOTS`, bots, registered wikis — each tagged `read-only` where it applies — and whether this instance owns writes) — the profile is env-only, so it is shown rather than implied. The write-owner row's copy is conditional for the same reason: "this instance writes wiki pages" stops being true the moment `WIKI_READONLY_ROOTS` names one, so it becomes "…except the read-only roots below". It is also stated once at boot (`src/index.ts`) when the flag is ON.

Three accuracy rules the card follows, each closing a way it could lie: the readonly row reads `isWikiReadonly()` — the SAME function the seams enforce with, never the env one level below it; a registry that THREW renders as **unknown**, not `none` (`machine.wikisKnown`, detail in `errors[]`), since "no wikis" makes a readonly instance look harmless; and `machine.bots` carries `{name, polling}` rather than bare names, because `discoverAllBots` lists every folder while the process only starts the token-carrying ones — typically none of them on the mini. The payload publishes no wiki `root` (absolute on-disk paths on a reader-facing API, rendered nowhere).

**Test hermeticity:** the mini's `.env` carries the flag, and Bun auto-loads `.env` for `bun test` too — 45 pre-existing wiki/gardener write tests failed there because the seams read it through their default. `bunfig.toml`'s `[test] preload` runs `src/test/preload.ts`, which clears `MUNINN_WIKI_READONLY` for tests only. The flag's own tests never relied on the env (they drive `__setWikiReadonlyForTest`), so nothing is lost. **Run the suite from the repo root on a flag-bearing host:** that preload path is resolved against the CWD (not against `bunfig.toml`) and an unresolvable bunfig preload is ignored silently, so `cd src/wiki && bun test ./page-write.test.ts` reintroduces the exact 9 failures the preload exists to prevent — from a subdirectory, pass it yourself (`bun test --preload ../test/preload.ts …`).

## Repo sync loop (`src/sync/`, `SYNC_REPOS`, `POST /api/sync/run`)

Two machines (laptop + Mac mini) edit the same repos — mimir, huginn-jarvis (a wiki
nested in a bigger repo), the skills repo, muninn itself — and converge ONLY through
GitHub. The loop is one endpoint driven by two triggers: a 15-minute launchd `curl`
and the `/models` **Repo sync** card's Sync now / Sync all buttons.

**The loop's own contract — locking, deferral semantics, the quiet period, the
non-obvious git rules — lives in `src/sync/CLAUDE.md`, stated once.** Config surface
+ mode semantics: the `SYNC_REPOS` row in the repo `CLAUDE.md`. Route contract: the
`sync-routes.ts` row in `src/dashboard/CLAUDE.md`. What matters from the WIKI side:

- **It joins this directory's two queues, in a pinned order** — the commit queue
  (`runExclusiveQueued`, now exported from `commit.ts`) FIRST, the per-wiki write
  queue (`runWikiWriteExclusive`) SECOND — for a short, entirely local section
  (status → path-scoped add/commit → rebase). Network I/O is outside both, so a hung
  push can park the sync but never a page write. The deadlock invariant that makes
  that order safe is the one stated in `queue.ts` + `src/gardener/CLAUDE.md`: every
  current writer keeps its commit tail OUTSIDE its write section. A `plain`-mode
  entry over a repo CONTAINING a registered wiki takes that wiki's write lock too —
  its rebase rewrites the wiki's working tree.
- **Git timeouts are network-verb only**, at `GIT_NETWORK_TIMEOUT_MS` (60s), and a
  timed call runs in its own process group so the kill reaches the transport. Local
  verbs stay untimed deliberately — a killed `add`/`commit` leaves `.git/index.lock`
  behind, which the sync's own pre-flight escalates to a human.
- **Every `git status` in `commit.ts` runs `--no-optional-locks`** — a plain status
  opportunistically rewrites `.git/index` (measured), i.e. takes `index.lock`, from
  unlocked read paths that race the loop's own locked `git add`.
- **It commits wiki pages behind a 5-minute quiet period**, with the deletion-hold
  and rename-pair rules, over `listDirtyEntries`/`parsePorcelainZWithStatus`
  (`--porcelain -z -uall`, both flags load-bearing for the same reasons the sweeper
  documents). The denylist is UNTRACKED-only: a tracked denied path stays dirty and
  would refuse the rebase every tick.
- **Post-sync it refreshes the reader cache** (`getWikiIndex({root, refresh: true})`)
  for a wiki whose HEAD moved — including a head that moved during the push retry's
  second rebase — else the 5-minute TTL keeps a pulled page invisible. Then a
  CONDITIONAL, silent huginn reindex through the SHARED `buildReindexResponse` +
  `postCollectionUpdate` (`src/wiki/reindex.ts`), so huginn's CAS 409 reads as
  `already-running` rather than a failure.
- **Sweeper subsumption:** `checkWikiCommitter` stands down for a repo a `wiki`-mode
  entry covers only on EVIDENCE — a tick that got THROUGH its LOCAL (commit) section
  without failing in it within ~26h (`syncSubsumesSweeper`) — plus the one `blocked`
  case, which subsumes regardless of freshness because this sweeper has no
  unmerged-paths pre-flight and would commit the half-finished merge. Every other
  state falls through once the evidence is stale. Configuration alone used to stand it
  down forever; so did a tick that errored at the fetch having committed nothing; and
  so did one that reached `git commit` and failed there (a broken signing key, a
  refusing hook) — all three the 2026-07-23 page-loss shape with a new cause. The rule
  exactly as implemented: an `error`, `transient` or `blocked` outcome from BEFORE or
  INSIDE the local section stamps no evidence — but one from AFTER it (a failed push,
  the no-upstream `blocked`) DOES stamp, because the local commit path genuinely
  worked and the sweeper could add nothing the loop did not already commit (except a
  failure INSIDE the push retry's second local section, which stamps nothing). Two
  residuals, accepted: (a) a loop whose PUSH has failed for days keeps subsuming and
  the daily warn stays silent (the `/models` Repo sync card is red with a FRESH "last
  commit pass" — the diagnosis is the push, not the commit); (b) a repeating hard
  `deferred` with nothing in-subtree dirty stamps evidence without ever invoking `git
  commit`, so a broken signing key is undetected in that state until in-subtree dirt
  appears. The warn is separate from the stand-down: no
  commit pass in ~26h always warns, subsumed or not. Marked `ok`, not `skipped`.
- **`log.md merge=union`:** mimir declares it and a fixture test asserts both
  machines' entries survive a rebase. A wiki that does NOT declare it gets a standing
  card warning (`git check-attr merge -- <wiki>/log.md`, memoized per repo) — the
  conflict it prevents is one whose correct resolution is always "keep both".

## Auto-commit (`commit.ts`, `wikiAutoCommit`)

Per-bot `wikiAutoCommit` config: `{ push?: boolean, catalogKinds?: string[] }`. After a gardener apply / source-drafter write / fact-check "Add to article" append / fact-check "Integrate into article" apply, muninn stages exactly the touched files and commits them (message `[gardener] apply: <page>` / `[source-drafter] draft: <page>` / `[fact-check] annotate: <page>` / `[fact-check] integrate: <page>`), on the wiki repo's **default branch only** (a feature-branch checkout is left for the sweeper), then pushes to the current branch's upstream.

- **`push`** defaults ON for any repo with a remote+upstream (never creates one); `{ "push": false }` commits locally without pushing.
- **`catalogKinds`** — which page kinds get a `- [[Title]] — …` index.md catalog line when applied (default `["concept"]`; jarvis sets `["concept", "source"]` so source pages are cataloged under `## Sources`). **Entities are never cataloged** regardless of this list (their index is split People/Organizations/Products, not derivable).

All commit failures are non-fatal (warn, never block the write). Never runs clean/checkout/restore/reset. Catalog code: `catalogPage`/`buildIndexEntry` in `src/gardener/wire.ts`. The `wiki-committer` daily watcher backstops the per-write commit seam by sweeping uncommitted wiki-subtree changes on the default branch.


<!-- moved out of the root CLAUDE.md by /doctor on 2026-09-08 -->

## `WIKI_DIR` — the full entry from the root `CLAUDE.md` env table

Explicit override for the bare `/wiki` root. Per-bot `wikiDir` and `?wiki=`/`?bot=` still take precedence.

## `MUNINN_WIKI_READONLY` — the full entry from the root `CLAUDE.md` env table

Set to `1` on a SECOND muninn instance (e.g. the Mac mini) to forbid programmatic wiki **page content** writes: the three content seams (`writeWikiPage`, `applyWikiProposal`, `writePlanQueue`) return `forbidden` and the gardener/fact-check/atlas mutation routes 403. An INSTANCE switch — the per-wiki sibling is `WIKI_READONLY_ROOTS` below, and the two are independent. Deliberately does NOT gate git — `commitWikiChange` still commits/pushes, so the repo-sync loop keeps working. `SCHEDULER_ENABLED=false` is not a substitute: it gates the runner only, and every dashboard route stays registered. Surfaced on `/models` (Machine card). Details: `src/wiki/CLAUDE.md`.

## `WIKI_EXTRA` — the full entry from the root `CLAUDE.md` env table

Comma-separated `name=path[=coll1+coll2][=botpin]` pairs registering **standalone** wikis (owned by no bot) in the `/wiki` picker — e.g. `notes=/abs/path,team-wiki=../team-wiki=team-wiki`. A root muninn should only READ (e.g. `memory=~/.claude/projects`) must ALSO be listed in `WIKI_READONLY_ROOTS`: registration alone makes it writable and model-reachable over HTTP. A wiki root muninn does not own the layout of can scope its own scan with an `include` glob list in `.wiki-reader.json`. Full segment semantics: `src/wiki/CLAUDE.md`.

## `WIKI_READONLY_ROOTS` — the full entry from the root `CLAUDE.md` env table

Comma-separated wiki **ROOTS** (same `~`/relative/absolute dialect as `WIKI_EXTRA`, resolved through the same `resolveConfiguredPath`) that this instance may only READ — however many other wikis it owns. Keyed on the resolved root, not the registry name, because every enforcement point already holds the root: the three content seams refuse before opening anything, and a **per-wiki prologue** on every `?wiki=`-steerable EGRESS route (`/api/wiki/{digest,ask,explain,factcheck,factcheck/claim,share,remember,ask/chat,factcheck/integrate,atlas/draft-synthesis}`) 403s before any model call, DB thread seed or `/agents` run registration. Registration buys three surfaces, not two — file writes, local reads, and routes that spend a model call on page content, two of which reach the **live web** via the fact-check prompt's WebFetch/search instructions; `DASHBOARD_HOST=127.0.0.1` bounds only the second. An entry matching no registered wiki fails **closed for itself** (it names a root nothing writes) and is warned about loudly. Unknown roots are writable, so the mechanism is inert until used. **Matching is root-EXACT, not prefix** (normalized + realpath-aware, so a symlinked or differently-cased spelling of the same directory matches, but a wiki registered at a SUBDIRECTORY of a listed root is NOT covered — list each root you mean). Two read paths deliberately stay outside it: `POST /api/wiki/reindex` is guarded but collection-gated (a root with no `wikiCollections` never reaches huginn anyway), and `src/wiki/ingest-backlog.ts`'s `collectWikiRefs` sweep walks **every** `.md` under the root without honouring `.wiki-reader.json`'s `include` — harmless today because it is reached only through bot-wiki gardener routes, which a read-only root now refuses. Surfaced on `/models` (Machine card) and injected into the reader as `__WIKI_READONLY_WIKI__`, which dims + blocks the write AND egress affordances. Set on this laptop for `~/.claude/projects` — Claude Code's own auto-memory, loaded into a session's context at start, so an HTTP write there edits the developer's instructions. Details: `src/wiki/CLAUDE.md`.
