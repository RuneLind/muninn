---
type: plan
title: Wiki provenance — the frontmatter shape
updated: 2026-10-14
sessions: [claude-code:5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60, opencode:ses_7f3a9b2c1d]
sessions_backfilled: 2026-10-14
jira: [MELOSYS-8045]
prs: [navikt/melosys-api#1234, RuneLind/muninn#543]
---

# Wiki provenance — the frontmatter shape

THE SHAPE FIXTURE. This page is not a sample of a real wiki page; it is the
contract for the three provenance keys, checked in so that muninn's reader can
mirror the same file and both sides fail loudly when one of them drifts.

- `sessions` is a flow list of `provider:id`, in arrival order, never sorted.
- `sessions_backfilled` marks a list that came from history rather than from a
  live stamp. Only a pass that APPENDS an id removes it.
- `jira` and `prs` are written by muninn's Link Jira, through the same CLI.

Every key is one line. Block lists are refused rather than rewritten: muninn's
`parseFrontmatter` reads a value-less key as a nested block and yields no array
at all.
