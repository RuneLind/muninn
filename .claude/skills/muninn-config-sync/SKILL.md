---
name: muninn-config-sync
description: Sync muninn's gitignored bot folders (bots/<name>/) to and from their source-of-truth repos via bots.config.json. Use when adding a bot to the sync manifest, running config:sync / config:restore, debugging a skipped or failing bot repo, or resolving path conventions inside a synced .mcp.json.
---

# Muninn Config Sync

Bot folders (except `jarvis`) are gitignored. The manifest at `bots.config.json` (repo root) maps each bot to its source-of-truth repo — either a local path (e.g. `~/source/private/muninn-config`) or a git URL (e.g. `git@github.com:capraconsulting/huginn-capra.git`). Git-URL repos are sparse-cloned into `~/.muninn/bot-repos/<name>/`.

`.env` is **per-developer** — each dev maintains their own with the tokens for the bots they actually run. It is not synced by this tool.

```bash
bun run config:sync                # push local bots/<name>/ → each repo
bun run config:sync -- --pull      # fetch latest from git remotes first
bun run config:sync -- --commit    # commit + push in every touched repo
bun run config:restore             # reverse: pull each repo subpath → bots/<name>/
```

Entries in the manifest whose `repo` path doesn't exist (or whose git clone fails) are skipped with a warning, so a contributor only needs access to the repos for the bots they care about. `--restore` skips entries whose source-of-truth doesn't have a `CLAUDE.md` yet (i.e. has never been populated).

## Manifest entry shapes

```json
{
  "jarvis":  { "inline": true },
  "capra":   { "repo": "https://github.com/capraconsulting/huginn-capra.git", "subpath": "bot" },
  "melosys": { "repo": "~/source/private/muninn-config", "subpath": "bots/melosys" }
}
```

## Path conventions inside synced `.mcp.json`

Paths are resolved relative to `cwd: bots/<name>/`. To reference a sibling project (e.g. `~/source/private/huginn` when muninn is at `~/source/private/muninn`), use `../../../huginn`. Paths in `env` blocks are read literally — for HOME-relative paths use shell expansion in a `bash -c` command instead.
