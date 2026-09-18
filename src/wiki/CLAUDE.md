# Wiki — Registry, Config Surface, Write Queue, Auto-Commit

## Registry (`registry.ts`)

Wikis come from two sources, matched case-insensitively, browsable at `/wiki?wiki=<name>` (legacy `?bot=<name>` accepted as alias):

- **Bot wikis** — per-bot `wikiDir` in `bots/<name>/config.json` (relative to the bot folder, same semantics as `.mcp.json` paths; resolved to absolute at discovery). Unset ⇒ the bot has no browsable wiki.
- **Standalone wikis** — `WIKI_EXTRA` env: comma-separated `name=path` pairs, with optional 3rd segment `=coll1+coll2` (Huginn collections backing the Ask tab — the standalone analogue of `wikiCollections`) and optional 4th segment `=botpin` (synthesis-bot pin — the standalone analogue of `wikiSynthesisBot`; bare bot name, charset excludes `+` so it's never confused with a collection list). `name=path==botpin` means no collections + pin. Paths may be absolute, `~`-prefixed (expanded to `$HOME`), or relative (resolved against the muninn repo root, same base as `WIKI_DIR`'s default); whitespace trimmed. Malformed pairs and names colliding with a bot-wiki name are warned and skipped.

Bare `/wiki` defaults to jarvis, or the `WIKI_DIR` env override (which shows a disabled "env override" picker state and claims no named wiki). Per-bot `wikiDir` and `?wiki=`/`?bot=` still take precedence over `WIKI_DIR`.

An optional **`.wiki-reader.json`** at the wiki root (`typeMap` folder→type + `typeLabels`) gives the wiki its own page-type ontology — e.g. mimir's `projects/`→subsystem, `plans/`→plan. Resolution: frontmatter `type:` → typeMap on first path segment → standard folder fallback → `note`. Read once per index build (5-min TTL); malformed ⇒ warn + ignore. No-config wikis keep the standard five types byte-identically.

An eighth key, **`activity`** (an object of seven optional numbers), tunes the page rail's **Activity** ranking for this wiki: `rows` (1–20, how many the section renders, and the only thing that cuts the list — measured 2026-09-13 over the full listings, mimir (528 pages), melosys-kode-wiki (396) and jarvis (1261) clear `ACTIVITY_MIN_SCORE` on about 120 / 46 / 202 rows, so the floor never binds at 20; they ask for 10, 6 and 6), `halfLifeNewDays`/`halfLifeChangedDays` (how fast a creation and a change fade) and the four 0–100 knobs `agePenalty`/`hubPenalty`/`planBoost`/`changedWeight`. Absent ⇒ `DEFAULT_ACTIVITY_WEIGHTS` (`views/components/wiki-activity-rank.ts`), the numbers the prototype was tuned to over the real mimir listing. Same validate-warn-**degrade** shape as its siblings, one level finer: a knob whose value is not a finite number of the right magnitude is dropped ALONE and the rest of the block stands, so a typo costs one weight rather than the section; an unknown key warns, since it is invisible in every other way; and `rows` CLAMPS rather than drops, because "as many as you can" is unambiguous. The resolved set is always COMPLETE on `WikiReaderConfig.activity` and rides `/api/wiki/pages` as `activity`, so the browser — where the ranking runs — never has to MERGE anything; it re-runs the same `parseActivityWeights` over the resolved block (one validator, and an older or degraded server cannot put a bad number into the ranking) and takes the defaults whole when the field is absent.

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
minute" failure those functions exist to absorb. ⚠️ A **change means the update signal's own KIND is `updated`** (`pageDateKind`),
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

**The reader's block** rides `GET /api/wiki/page` beside `meta`, and only when
`hasProvenance(meta)` — the ONE gate, shared with the store's other callers —
says the page carries any of the three LIST keys. `sessions_backfilled` alone
opens nothing: it is a marker about a list that is not there. The payload is
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
once after the awaits rather than raced per leg.

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
  re-reads `GET /api/wiki/page`.

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
```

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
