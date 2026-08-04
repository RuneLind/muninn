# Wiki — Registry, Config Surface, Write Queue, Auto-Commit

## Registry (`registry.ts`)

Wikis come from two sources, matched case-insensitively, browsable at `/wiki?wiki=<name>` (legacy `?bot=<name>` accepted as alias):

- **Bot wikis** — per-bot `wikiDir` in `bots/<name>/config.json` (relative to the bot folder, same semantics as `.mcp.json` paths; resolved to absolute at discovery). Unset ⇒ the bot has no browsable wiki.
- **Standalone wikis** — `WIKI_EXTRA` env: comma-separated `name=path` pairs, with optional 3rd segment `=coll1+coll2` (Huginn collections backing the Ask tab — the standalone analogue of `wikiCollections`) and optional 4th segment `=botpin` (synthesis-bot pin — the standalone analogue of `wikiSynthesisBot`; bare bot name, charset excludes `+` so it's never confused with a collection list). `name=path==botpin` means no collections + pin. Paths may be absolute, `~`-prefixed (expanded to `$HOME`), or relative (resolved against the muninn repo root, same base as `WIKI_DIR`'s default); whitespace trimmed. Malformed pairs and names colliding with a bot-wiki name are warned and skipped.

Bare `/wiki` defaults to jarvis, or the `WIKI_DIR` env override (which shows a disabled "env override" picker state and claims no named wiki). Per-bot `wikiDir` and `?wiki=`/`?bot=` still take precedence over `WIKI_DIR`.

An optional **`.wiki-reader.json`** at the wiki root (`typeMap` folder→type + `typeLabels`) gives the wiki its own page-type ontology — e.g. mimir's `projects/`→subsystem, `plans/`→plan. Resolution: frontmatter `type:` → typeMap on first path segment → standard folder fallback → `note`. Read once per index build (5-min TTL); malformed ⇒ warn + ignore. No-config wikis keep the standard five types byte-identically.

## Ask tab, Similar articles (`wikiCollections`)

`wikiCollections` (string[], per-bot config.json) names the Huginn search collections backing the wiki's **Ask** tab (research-style cited Q&A via `GET /api/wiki/ask`, reusing the `/research` pipeline). Citations whose doc resolves to a wiki page open in-reader. Unset/empty ⇒ Ask returns a clean "No search collection connected for this wiki" error.

Also backs the reader's **Similar articles** section (`GET /api/wiki/similar` — huginn `/api/search` with repeated `collection` params, top 5 hits resolved to wiki pages, self excluded; huginn unreachable ⇒ empty list, section hides).

## Ask → chat escalation (`ask-chat.ts`, `POST /api/wiki/ask/chat`, `GET /api/wiki/chat-target`)

Two modes on the POST: **escalate** (Phase 1, #417 — carries the Ask `answer` + citations into a new thread via `buildAskChatSeed`) and **direct** (`mode: "direct"`, #418 — skips Ask entirely; `buildDirectChatSeed` writes a research-instructing seed that claims web search only when the effective connector supports it, and omits the wiki-notes-first clause on collection-less wikis). Optional `connectorId` (UUID-guarded; "" = bot default), `threadName`, `existingThreadId` ("Send there" — refuses to clobber a live pending seed with a 409 `alreadyQueued`; applies a picked connector only when the thread has none, else responds `connectorApplied: false`). Owner/pin/user resolution lives in `resolveAskChatTarget` (discriminated result, shared by POST + GET through the `askChatDeps` seam — tests run on `__setAskChatDepsForTest` fakes, never the live DB). `GET /api/wiki/chat-target?wiki=&bot=` feeds the reader's options popover (users, defaultUserId, capability-flagged connectors via `capabilitiesForConnectorType`, botDefault, folded preferred connector). ChatUrls from popover-origin requests carry `&src=wiki`, which the chat page's `stampConnectorOnThread` honors as **per-thread** stamp suppression so "(bot default)" keeps meaning the bot's config beyond the seeded turn; plain one-click escalates carry no flag (sidebar stamping applies, as in Phase 1).

**Decline hook (PR B, client-only):** an Ask/Explain turn the wiki DECLINED to answer renders a prominent "Ask in chat instead →" action (pure `declineChatBarHtml` in `views/components/wiki-chat-target.ts`) in place of the ordinary escalate bar, opening the same direct-mode popover with the turn's question written back into the Ask box first (direct mode reads the live box, and `askQuestion` clears it on submit). It is NOT a branch on the incoming SSE event: `done` fires once while the bar re-renders from turn state on every switch/rehydrate, so the reason is mapped onto `AskTurn.declined` / `StoredAskTurn.declined` (`"no_hits" | "low_confidence"`, persisted + union-validated in `isValidTurn`). The mapping is the shared `askDeclineReason`, which checks **`lowConfidence` first** — `noHits` is unconditionally true on BOTH decline branches (`research/ask.ts`), so the natural `noHits ? … : …` order mislabels every low-confidence decline. The decline hook catches the honest failures; the always-visible "New chat" button covers the confident whiffs.

## Synthesis-bot routing (`resolveWikiSynthesisBot`)

Ask answers and the What's-new digest are synthesized by the wiki's **owning bot** (jarvis wiki → jarvis, nav wiki → melosys); standalone and opus-owned wikis fall back to the research bot. An explicit **`wikiSynthesisBot`** pin (set on the owning bot's config.json) beats both — and deliberately **bypasses the opus fast-gate** (e.g. capra pinning its own opus bot for capra's wiki is an informed choice). A pin naming no discovered bot is warned + ignored (routing falls through to owner/fallback), surfaced as a red note in the `/models` Wiki synthesis group, which shows every wiki's resolved bot with a `pinned`/`owner`/`fallback` origin chip.

## Write queue (`queue.ts`)

Per-wiki write queue, realpath-keyed on the wiki ROOT. `log.md` is wiki-GLOBAL, so every read-modify-writer of it (gardener apply, fact-check append/integrate, `writeWikiPage`) must serialize on this one chain. Rules for joining: the queued section must span read→CAS→write→log.md, and the commit tail must run OUTSIDE the queue (push is dispatched un-awaited with no timeout — an unreachable origin would otherwise park every writer). Full rationale: `src/gardener/CLAUDE.md`.

## Auto-commit (`commit.ts`, `wikiAutoCommit`)

Per-bot `wikiAutoCommit` config: `{ push?: boolean, catalogKinds?: string[] }`. After a gardener apply / source-drafter write / fact-check "Add to article" append / fact-check "Integrate into article" apply, muninn stages exactly the touched files and commits them (message `[gardener] apply: <page>` / `[source-drafter] draft: <page>` / `[fact-check] annotate: <page>` / `[fact-check] integrate: <page>`), on the wiki repo's **default branch only** (a feature-branch checkout is left for the sweeper), then pushes to the current branch's upstream.

- **`push`** defaults ON for any repo with a remote+upstream (never creates one); `{ "push": false }` commits locally without pushing.
- **`catalogKinds`** — which page kinds get a `- [[Title]] — …` index.md catalog line when applied (default `["concept"]`; jarvis sets `["concept", "source"]` so source pages are cataloged under `## Sources`). **Entities are never cataloged** regardless of this list (their index is split People/Organizations/Products, not derivable).

All commit failures are non-fatal (warn, never block the write). Never runs clean/checkout/restore/reset. Catalog code: `catalogPage`/`buildIndexEntry` in `src/gardener/wire.ts`. The `wiki-committer` daily watcher backstops the per-write commit seam by sweeping uncommitted wiki-subtree changes on the default branch.
