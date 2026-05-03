# Huginn trace-pointer follow-ups

Review notes from huginn-peer after PR #81 squash-merged as `b2fcdbe` on `main`. Three small follow-ups worth bundling into a single PR.

> **Status (2026-05-03):** items **A** (host allow-list) and **C** (regex tightened to `/api/trace/<16hex>`) shipped in PR #82 (`be54b52`). Item **B** (5xx test) also landed in #82. This doc is now historical — kept for the rationale.

Companion repo: huginn `main` `88b9212` ships the `/api/trace/<id>` endpoint + in-memory TTL store; this doc is muninn-side only.

## Context

Phase-2 trace-id pointer channel landed end-to-end and pilot is green on jarvis. The pieces under review here:

- `src/ai/huginn-trace-pointer.ts` — `parseHuginnTracePointer`, `peelHuginnTraceChannel`, `fetchHuginnTrace`
- `src/core/message-processor.ts:165–185` — parallel pointer-fetch step before tool spans open
- `src/ai/huginn-trace-pointer.test.ts` — 13 tests covering parse + fetch happy/sad paths

Findings below are all incremental hardening — none block the rollout, none break backward-compat, none are user-visible. Bundle as one PR.

---

## A. URL fetch should be host-restricted (security-flavored)

**File:** `src/ai/huginn-trace-pointer.ts:136–154`, plus the regex at `:37–38`.

`fetchHuginnTrace` accepts whatever URL Huginn put in the pointer line and fetches it. The pointer line lives at the end of the tool result, after search hits.

**Threat:** if a search hit body ends with the literal wire format (someone documents the wire format and the doc gets indexed, or — worst case — a user with edit access to a Confluence/Notion page plants `\n\nhuginn-trace-url: https://evil.example/...\n`), the regex matches at end-of-string. Muninn issues an outbound HTTPS request to that host. The response is parsed as JSON and stored on the tool span as `attributes.searchTrace`.

**Risk profile:** low.
- No code execution: response is `await resp.json()`, stored as data, never run.
- No DOM reflection unless the waterfall span-detail viewer renders attribute values as raw HTML (it doesn't today, but worth confirming).
- Bounded by `Promise.allSettled` + `AbortSignal.timeout(2000)`, so DoS surface is small.

**Why fix anyway:** the design intent is "Muninn fetches *Huginn's* trace store." Trusting whatever URL appears in tool output extends trust beyond that. It's an unnecessary surface, and search-hit content is the lowest-trust input we handle.

**Proposed fix.** Accept the URL form only if its origin matches a configured allow-list. Practical shape:

```ts
// New env on the muninn process (per-bot or global). Comma-separated.
const HUGINN_TRACE_ALLOWED_HOSTS = process.env.HUGINN_TRACE_ALLOWED_HOSTS
  ?? process.env.KNOWLEDGE_API_URL  // sensible default — same env Huginn uses
  ?? "";
```

`parseHuginnTracePointer` and `peelHuginnTraceChannel` validate the URL's origin against the allow-list before returning it as a `fetchUrl`. On mismatch: strip the pointer line from `text` (model still doesn't see it), return `fetchUrl: null`, log a warning. Tradeoff: loses the "self-contained, no-config" property that motivated emitting the URL form on the Huginn side, but only when an allow-list is set — unset means accept-anything (current behavior, opt-in tightening).

**Tests to add:**
- URL with allowed origin → fetched.
- URL with disallowed origin → `fetchUrl: null`, line stripped, warning logged.
- Multiple hosts in allow-list, mixed match.

## B. Missing test for non-2xx non-404

**File:** `src/ai/huginn-trace-pointer.test.ts:99–142`.

Current `fetchHuginnTrace` tests cover: 200 happy path, 404, network error (`ECONNREFUSED`), timeout. Missing: 5xx (e.g. 500, 503). The code handles it correctly (`if (!resp.ok) return null`), the contract just isn't pinned by a test.

**Proposed:** one new test, ~6 lines. Mock a 500 response, assert `fetchHuginnTrace` returns `null` and the warning is logged with status=500.

## C. Tighten URL regex to the trace-endpoint shape

**File:** `src/ai/huginn-trace-pointer.ts:38`.

```ts
const POINTER_RE =
  /\n+(?:huginn-trace-id: ([0-9a-f]{16})|huginn-trace-url: (https?:\/\/[^\s]+))\s*$/;
```

`(https?:\/\/[^\s]+)` admits any URL shape. With (A) in place, tighten to:

```ts
const POINTER_RE =
  /\n+(?:huginn-trace-id: ([0-9a-f]{16})|huginn-trace-url: (https?:\/\/\S+?\/api\/trace\/[0-9a-f]{16}))\s*$/;
```

Belt-and-suspenders alongside (A): a malformed or attacker-shaped URL never reaches `fetchHuginnTrace` at all. Also fixes the minor doc-vs-code drift in the file's comment ("Both forms are 16-hex"), which today is true for the id form but not enforced for the URL form.

**Tests to add:**
- URL pointing to a non-`/api/trace/<16hex>` path → no match.
- URL with a non-16-hex id at the end → no match.
- URL with valid shape but extra path segments → no match.

---

## Recommended bundle

All three in one PR. Rough cost:

- A: ~25 LOC + 3 tests + small env-doc note in `docs/handover-connector-tracing-parity.md`
- B: ~6 LOC of test
- C: ~2 LOC + 3 tests

Total ~40 LOC implementation, ~50 LOC tests. Single commit, single PR.

## Open question for the maintainer

Which config model do you want for (A)?

1. **Implicit:** reuse `KNOWLEDGE_API_URL`'s host as the only allowed origin. Zero new env. Simpler.
2. **Explicit allow-list:** new `HUGINN_TRACE_ALLOWED_HOSTS=host1,host2`. Falls back to `KNOWLEDGE_API_URL` if unset. More flexible (multi-Huginn deployments), one extra knob.
3. **Hybrid:** option 2 by default, with `HUGINN_TRACE_ALLOWED_HOSTS=*` as an explicit opt-out for "any host." Most explicit; smallest footgun.

Lean: (1) for now — single Huginn instance is the only deployment shape today. Promote to (2) only if a multi-Huginn config appears.

## Lower-priority nit (not in scope)

`peelHuginnTraceChannel` does not accept a `defaultBaseUrl` — so the bare-id form (`huginn-trace-id: <16hex>`) is silently lost through it. By design — Huginn now emits URL form — but if we ever want the id form to work end-to-end, the helper needs the parameter threaded through. Mention only.
