/**
 * /wiki reader — the provenance strip, the chain it opens and the Jira facet,
 * end to end.
 *
 * ONE surface under the title: a collapsed line (the Jira row plus one sentence
 * of cost and a mark per event) that opens in place into the chain — every
 * session that wrote the page and every PR those sessions merged, in time order.
 * Seven things only a real browser against a real server can answer, and almost
 * every one of them is a degrade:
 *
 *  1. **A priced session and a MISSING one, side by side.** The ledger stub
 *     prices one of the fixture's two sessions and omits the other, which is the
 *     only way to drive both the `missing` bare chip and the "over M of N" cost
 *     line at once. A unit test can build that payload; only this can prove the
 *     server produced it from a stamped page and the client rendered it.
 *  2. **A damaged frontmatter line must not read as an outage.** `damaged.md`'s
 *     one session ref is too long to BE a session id, so nothing is ever asked —
 *     and the strip must say so rather than "claude-usage unreachable", which is
 *     the exact sentence the server's own `asked` flag exists to prevent.
 *  3. **An unstamped page renders no strip at all** — the payload simply has no
 *     `provenance` key.
 *  4. **`?jira=` as URL state**, the `?project=` recipe: chip click → the param
 *     written in place, a reload restoring the active chip, an unknown key
 *     clearing itself and leaving the whole wiki.
 *  5. **A malformed `jira:` value is not a control.** `mixed.md` carries one the
 *     store keeps on the page's own row and `jiraCounts` shape-filters out of
 *     the facet map — the one state where the strip and the facet disagree about
 *     what a key is, and only a real listing produces it.
 *  6. **The empty state survives an open chain.** Two ANDed facets matching
 *     nothing, under a stamped page: "No pages match." is about the FILTER and
 *     the chain rows are about the OPEN PAGE, and neither may stand in for the
 *     other.
 *  7. **A merges leg that did not answer says so**, in one footer line, while
 *     the cost sentence — which is about the OTHER leg — does not move.
 *
 * The clipboard is the eighth: the session id is COPYABLE TEXT because the
 * browser cannot reach claude-usage at all (tailnet viewers, mixed content under
 * `tailscale serve`), so the copy button is the feature rather than a
 * convenience, and `navigator.clipboard` only works under granted permissions.
 *
 * No model calls and no writes: the whole feature is a read.
 *
 * ENV PREREQUISITE: a working `.env` (`DATABASE_URL` at minimum) at the repo
 * root — `src/index.ts` boots the full process and Bun auto-loads it in the
 * spawned child (cwd = repo root).
 *
 * SPAWN ENV: `e2eEnv()` keeps this muninn off Telegram/Slack and blanks the
 * instance-profile flags. Both `CLAUDE_USAGE_*` names are in that blank set, so
 * they are set AFTER it — a spec's own overrides go last, by contract.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-provenance");
const LEDGER_PORT = e2ePort("wiki-provenance/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-provenance";
/** The read-only wiki, registered at a root `WIKI_READONLY_ROOTS` names. */
const WIKI_RO = "e2e-provenance-ro";

/** The claude-usage address handed to the BROWSER. Nothing binds it, and nothing
 *  needs to — the client only ever builds an href from it. */
const PUBLIC_BASE = "https://usage.example.test";

/** The two ids the checked-in shape fixture stamps. */
const PRICED_ID = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const MISSING_ID = "ses_7f3a9b2c1d";

/** Long enough to fail `SESSION_ID_MAX_CHARS` (128), so it is refused BEFORE
 *  batching and the ledger is never asked at all. */
const DAMAGED_ID = "x".repeat(129);

/** The stub refuses `/api/merges` for this id and answers `/api/sessions-by-id`
 *  normally — the only way to drive "the facts leg worked and the merges leg did
 *  not" through a real page open. Synthetic, like every id in this file. */
const MERGES_DOWN_ID = "11111111-2222-3333-4444-555555555555";

/**
 * The handoff chain: A hands off to B, B hands off to a session the page never
 * stamps. Every id, title, host and figure below is INVENTED — this repo is
 * public, so a fixture copies the SHAPE of the ledger's answers and none of its
 * values.
 */
const CHAIN_A = "aaaaaaaa-1111-2222-3333-444444444444";
const CHAIN_B = "bbbbbbbb-1111-2222-3333-444444444444";
const CHAIN_GHOST = "cccccccc-1111-2222-3333-444444444444";
/** The session the shape fixture's `prs:` line leads to — a PR ghost. */
const PR_GHOST = "dddddddd-1111-2222-3333-444444444444";
/** The page the Stamp test writes to, and the ghost it stamps. */
const STAMP_HOST = "eeeeeeee-1111-2222-3333-444444444444";
const STAMP_GHOST = "ffffffff-1111-2222-3333-444444444444";

const SHAPE_REL = "shape.md";
const CHAIN_REL = "chain.md";
const STAMP_REL = "stampme.md";
const RO_REL = "readonly.md";
const MERGESDOWN_REL = "merges-down.md";
const DAMAGED_REL = "damaged.md";
const PLAIN_REL = "plain.md";
const OTHER_REL = "other.md";
const MIXED_REL = "mixed.md";

/** How many pages the temp wiki holds — every "the whole wiki" assertion below. */
const ALL_PAGES = 8;

const DAMAGED = [
  "---",
  "type: plan",
  "title: Damaged provenance",
  `sessions: [claude-code:${DAMAGED_ID}]`,
  "---",
  "",
  "# Damaged provenance",
  "",
  "One frontmatter entry that cannot be a session id.",
  "",
].join("\n");

const MERGES_DOWN = [
  "---",
  "type: plan",
  "title: Merges leg down",
  `sessions: [claude-code:${MERGES_DOWN_ID}]`,
  "---",
  "",
  "# Merges leg down",
  "",
  "The ledger prices this session and refuses to list its merges.",
  "",
].join("\n");

/** The acceptance-shaped page: two stamped sessions whose handoffs chain into a
 *  third the page never stamps. */
const CHAIN = [
  "---",
  "type: plan",
  "title: The handoff chain",
  `sessions: [claude-code:${CHAIN_A}, claude-code:${CHAIN_B}]`,
  "---",
  "",
  "# The handoff chain",
  "",
  "Two stamped sessions and one the ledger links through a handoff.",
  "",
].join("\n");

/** A page whose `prs:` line names a PR one unstamped session merged — the
 *  one-click Stamp case. `sessions_backfilled` is here so the Stamp can be seen
 *  retiring it. */
const STAMPME = [
  "---",
  "type: plan",
  "title: Stamp me",
  `sessions: [claude-code:${STAMP_HOST}]`,
  "sessions_backfilled: 2026-09-01",
  "prs: [acme/widget#777]",
  "---",
  "",
  "# Stamp me",
  "",
  "A page with a PR ghost to stamp.",
  "",
].join("\n");

const PLAIN = [
  "---",
  "type: note",
  "title: Plain page",
  "---",
  "",
  "# Plain page",
  "",
  "Nothing has stamped this page.",
  "",
].join("\n");

const OTHER = [
  "---",
  "type: plan",
  "title: Other issue",
  "jira: [MELOSYS-7790]",
  "---",
  "",
  "# Other issue",
  "",
  "A page serving a different issue, so the facet has two chips.",
  "",
].join("\n");

/**
 * The mixed-key page: one good key, one the store UPPER-CASES into a good key,
 * and one that cannot be a Jira key at all.
 *
 * `jiraCounts` shape-filters the listing's `jira` map while the store keeps every
 * value on the page's own row (`normalizeJiraKey` = trim + uppercase, nothing
 * else), so `not-a-key` reaches the strip as `NOT-A-KEY` and is the one value
 * the facet can never serve. Its own keys, deliberately not the two above: this
 * page must not move the other tests' chip counts.
 */
const MIXED = [
  "---",
  "type: plan",
  "title: Mixed keys",
  "jira: [MELOSYS-9001, melosys-9002, not-a-key]",
  // The ONE page carrying this tag, and it carries none of shape.md's keys — so
  // `?jira=MELOSYS-8045` AND `#mixedonly` is a pair of live controls that can
  // match nothing. (The type facet cannot do it: a `WIKI_EXTRA` wiki declares no
  // ontology, so every page here resolves to `note`.)
  "tags: [mixedonly]",
  "---",
  "",
  "# Mixed keys",
  "",
  "Two real keys and one that is not a key.",
  "",
].join("\n");

/**
 * The stub `WIKI_STAMP_BIN`.
 *
 * It does to the frontmatter exactly what the real CLI does — append the ref to
 * the `sessions:` flow list, retire `sessions_backfilled`, answer `unchanged`
 * when the ref is already there — and prints the same ONE-LINE `--report`, so
 * this spec needs no claude-usage checkout. What it proves is muninn's WIRING
 * and the re-render; the upsert rule itself is pinned by claude-usage's own
 * suite and by the shape fixture both repos check in.
 */
const STUB_STAMPER = [
  "#!/bin/bash",
  'ref=""; file=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    --session) ref="$2"; shift 2;;',
  '    --file) file="$2"; shift 2;;',
  '    *) shift;;',
  "  esac",
  "done",
  '[ -f "$file" ] || { printf \'{"outcome":"skipped","reason":"missing-file","path":"%s"}\\n\' "$file"; exit 0; }',
  'if grep -q -- "$ref" "$file"; then',
  '  printf \'{"outcome":"unchanged","reason":"already-stamped","path":"%s"}\\n\' "$file"',
  "  exit 0",
  "fi",
  // `&` is the whole match, so no capture group has to survive two levels of
  // escaping: the match stops before the `]`, and the replacement re-adds it.
  'sed -i.bak "s|^sessions: \\[[^]]*|&, $ref|" "$file"',
  'sed -i.bak "/^sessions_backfilled:/d" "$file"',
  'rm -f "$file.bak"',
  'printf \'{"outcome":"written","path":"%s"}\\n\' "$file"',
  "",
].join("\n");

let server: ChildProcess | undefined;
let ledger: Server | undefined;
let root = "";
/** Every `ids=` query the stub was asked, so a test can prove the browser never
 *  reached the service itself and that a damaged page asked nothing. */
let asked: string[] = [];
/** The same, for the merges leg. */
let askedMerges: string[] = [];
/** And for the two PR-3 legs, so a test can prove a cap was honoured. */
let askedHandoffs: string[] = [];
let askedPrs: string[] = [];
/** The read-only wiki's root, and the stub CLI `WIKI_STAMP_BIN` points at. */
let roRoot = "";
let stampBin = "";

const open_ = (page: import("@playwright/test").Page, rel: string) =>
  page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);

/**
 * claude-usage, as `src/wiki/session-ledger.ts` parses it: `{sessions: [...]}`
 * and `{merges: [...]}`, both keyed on the BARE id. `MISSING_ID` is deliberately
 * absent from the first answer — that is what makes the chip `missing` ("the
 * ledger answered and does not hold it") rather than `unresolved` ("nobody
 * asked").
 *
 * The three merge rows are the three shapes the row renderer has to tell apart,
 * and they are SYNTHETIC — invented numbers and stamps, never rows out of the
 * live ledger, because this repo is public.
 *
 * Every stamp is midday so the rendered date is the same in any plausible zone;
 * the spec pins `timezoneId` besides, so the hours below are exact rather than a
 * fact about the machine running the suite.
 */
function startLedger(): Promise<Server> {
  /** Every session the stub knows, keyed on the BARE id. */
  const FACTS: Record<string, Record<string, unknown>> = {
    [PRICED_ID]: {
      provider: "claude-code",
      host: "macmini",
      title: "Wiki provenance — PR 4a",
      first: "2026-09-15T12:00:00.000Z",
      last: "2026-09-15T13:30:00.000Z",
      cost: 12.34,
      messages: 148,
    },
    [MERGES_DOWN_ID]: {
      provider: "claude-code",
      host: "macmini",
      title: "A session whose merges cannot be listed",
      first: "2026-09-15T12:00:00.000Z",
      last: "2026-09-15T12:00:00.000Z",
      cost: 1.5,
      messages: 9,
    },
    // The ledger spells Claude Code `claude`; the frontmatter spells it
    // `claude-code`. These three exercise the mapping on a stamped ref, on a
    // ghost glyph and on a Stamp ref at once.
    [CHAIN_A]: {
      provider: "claude",
      host: "workshop",
      title: "First leg of the chain",
      first: "2026-09-15T09:00:00.000Z",
      last: "2026-09-15T11:00:00.000Z",
      cost: 21,
      messages: 60,
      model: "claude-sonnet-4-5-20250929",
      delegatedCost: 5.5,
    },
    [CHAIN_B]: {
      provider: "claude",
      host: "workshop",
      title: "Second leg of the chain",
      first: "2026-09-15T14:00:00.000Z",
      last: "2026-09-15T16:00:00.000Z",
      cost: 30,
      messages: 90,
      model: "claude-opus-5",
      delegatedCost: 8.25,
    },
    [CHAIN_GHOST]: {
      provider: "claude",
      host: "workshop",
      title: "The session nobody stamped",
      first: "2026-09-15T18:00:00.000Z",
      last: "2026-09-15T20:00:00.000Z",
      cost: 44,
      messages: 120,
      model: "claude-opus-5",
      delegatedCost: 12,
    },
    [PR_GHOST]: {
      provider: "claude",
      host: "workshop",
      title: "The session that merged #543",
      first: "2026-09-15T18:00:00.000Z",
      last: "2026-09-15T18:30:00.000Z",
      cost: 7,
      messages: 20,
    },
    [STAMP_HOST]: {
      provider: "claude",
      host: "workshop",
      title: "The stamped session",
      first: "2026-09-15T08:00:00.000Z",
      last: "2026-09-15T08:30:00.000Z",
      cost: 3,
      messages: 11,
    },
    [STAMP_GHOST]: {
      provider: "claude",
      host: "workshop",
      title: "The session that merged #777",
      first: "2026-09-15T09:00:00.000Z",
      last: "2026-09-15T09:30:00.000Z",
      cost: 9,
      messages: 30,
    },
  };

  /**
   * Every merge row the stub holds. The three PRICED_ID rows are the three
   * shapes a merge row has to tell apart (linked / unlinked / unconfirmed); the
   * rest carry the gate block, whose four spellings are what PR 3 renders.
   */
  const MERGES: Record<string, unknown>[] = [
    {
      sessionId: PRICED_ID,
      repo: "/Users/synthetic/source/muninn",
      prNumber: 553,
      url: "https://github.com/RuneLind/muninn/pull/553",
      subject: null,
      mergedAt: "2026-09-15T14:00:00.000Z",
      mergeOk: true,
      gate: null,
      preStandardization: false,
    },
    {
      // No `repoUrls` entry upstream ⇒ no coordinate, so this row
      // renders unlinked with the checkout's basename as its hover.
      sessionId: PRICED_ID,
      repo: "/Users/synthetic/source/side-project",
      prNumber: 77,
      url: null,
      subject: null,
      mergedAt: "2026-09-15T15:00:00.000Z",
      mergeOk: true,
      gate: { matched: false },
      preStandardization: false,
    },
    {
      sessionId: PRICED_ID,
      repo: "/Users/synthetic/source/muninn",
      prNumber: 88,
      url: "https://github.com/RuneLind/muninn/pull/88",
      subject: null,
      mergedAt: "2026-09-15T16:00:00.000Z",
      mergeOk: false,
      gate: { matched: true, gated: false, gatedBy: null, gates: {} },
      preStandardization: true,
    },
    {
      // The shape fixture's own `prs:` coordinate, merged by a session the page
      // never stamped — the PR ghost.
      sessionId: PR_GHOST,
      repo: "/Users/synthetic/source/muninn",
      prNumber: 543,
      url: "https://github.com/RuneLind/muninn/pull/543",
      subject: null,
      mergedAt: "2026-09-15T19:00:00.000Z",
      mergeOk: true,
      gate: { matched: true, gated: true, gatedBy: "gate", gates: { "gate-review-floor": {} } },
      preStandardization: false,
    },
    {
      sessionId: CHAIN_B,
      repo: "/Users/synthetic/source/muninn",
      prNumber: 321,
      url: "https://github.com/RuneLind/muninn/pull/321",
      subject: null,
      mergedAt: "2026-09-15T15:30:00.000Z",
      mergeOk: true,
      gate: { matched: true, gated: false, gatedBy: null, gates: {} },
      preStandardization: false,
    },
    {
      // Reachable ONLY under the ghost's own id — the whole reason leg 6 exists.
      sessionId: CHAIN_GHOST,
      repo: "/Users/synthetic/source/muninn",
      prNumber: 322,
      url: "https://github.com/RuneLind/muninn/pull/322",
      subject: null,
      mergedAt: "2026-09-15T19:30:00.000Z",
      mergeOk: true,
      gate: {
        matched: true,
        gated: true,
        gatedBy: "gate",
        gates: { "gate-review-floor": {}, "gate-split-check": {} },
      },
      preStandardization: false,
    },
    {
      sessionId: STAMP_GHOST,
      repo: "/Users/synthetic/source/muninn",
      prNumber: 777,
      url: "https://github.com/acme/widget/pull/777",
      subject: null,
      mergedAt: "2026-09-15T09:15:00.000Z",
      mergeOk: true,
      gate: { matched: true, gated: true, gatedBy: "gate", gates: { "gate-review-floor": {} } },
      preStandardization: false,
    },
  ];

  /** Who ran whose handoff. One hop each, which is all the reader reads. */
  const RAN_BY: Record<string, { sessionId: string; at: string; host: string }[]> = {
    [CHAIN_A]: [{ sessionId: CHAIN_B, at: "2026-09-15T13:45:00.000Z", host: "workshop" }],
    [CHAIN_B]: [{ sessionId: CHAIN_GHOST, at: "2026-09-15T17:45:00.000Z", host: "workshop" }],
  };

  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/session-handoff") {
      const id = url.searchParams.get("id") ?? "";
      askedHandoffs.push(id);
      const runs = RAN_BY[id];
      // `available: false` with no `ranBy` is the ORDINARY answer — most
      // sessions never ran the skill — and must not read as a failed leg.
      return json(200, runs ? { available: true, handoff: "…", ranBy: runs } : { available: false, reason: "no-handoff" });
    }
    if (url.pathname === "/api/merges") {
      const prs = url.searchParams.get("prs");
      const ids = url.searchParams.get("sessions") ?? "";
      const envelope = {
        limit: 200,
        truncated: false,
        rulesStandardizedDate: "2026-07-30",
        rulesStandardized: "2026-07-29T22:00:00.000Z",
      };
      if (prs !== null) {
        askedPrs.push(prs);
        const wanted = prs.split(",");
        const rows = MERGES.filter((m) =>
          wanted.includes(`RuneLind/muninn#${m.prNumber}`) || wanted.includes(`acme/widget#${m.prNumber}`),
        );
        return json(200, { ...envelope, unmapped: [], merges: rows });
      }
      askedMerges.push(ids);
      // One page's session is the "merges leg is down" case; the facts leg for
      // that same id still answers, which is the split the footer exists for.
      if (ids.includes(MERGES_DOWN_ID)) return json(503, { error: "merges unavailable" });
      const wanted = new Set(ids.split(","));
      return json(200, { ...envelope, merges: MERGES.filter((m) => wanted.has(m.sessionId as string)) });
    }
    if (url.pathname !== "/api/sessions-by-id") {
      return json(404, { error: "unexpected path", path: url.pathname });
    }
    const ids = url.searchParams.get("ids") ?? "";
    asked.push(ids);
    // MISSING_ID is deliberately absent from FACTS — that is what makes its chip
    // `missing` ("the ledger answered and does not hold it") rather than
    // `unresolved` ("nobody asked").
    return json(200, {
      sessions: ids
        .split(",")
        .filter((id) => FACTS[id])
        .map((id) => ({ sessionId: id, ...FACTS[id] })),
    });
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
}

/** Open the chain under the title and return its rows. Collapsed is the default,
 *  so every row assertion presses the line first — which is itself the check
 *  that the disclosure works. */
async function openChain(page: import("@playwright/test").Page) {
  const line = page.locator(".wiki-prov-line");
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await line.click();
  await expect(line).toHaveAttribute("aria-expanded", "true");
  return page.locator(".wiki-chain-row");
}

test.beforeAll(async () => {
  ledger = await startLedger();
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-prov-"));
  // READ the checked-in shape fixture rather than pasting its bytes: it is the
  // contract both repos pin, and a copy here would go stale silently.
  const shape = await readFile(path.join(REPO_ROOT, "src/wiki/__fixtures__/wiki-stamp-shape.md"), "utf8");
  await writeFile(path.join(root, SHAPE_REL), shape, "utf8");
  await writeFile(path.join(root, DAMAGED_REL), DAMAGED, "utf8");
  await writeFile(path.join(root, PLAIN_REL), PLAIN, "utf8");
  await writeFile(path.join(root, OTHER_REL), OTHER, "utf8");
  await writeFile(path.join(root, MIXED_REL), MIXED, "utf8");
  await writeFile(path.join(root, MERGESDOWN_REL), MERGES_DOWN, "utf8");
  await writeFile(path.join(root, CHAIN_REL), CHAIN, "utf8");
  await writeFile(path.join(root, STAMP_REL), STAMPME, "utf8");

  // A SECOND wiki, registered read-only through `WIKI_READONLY_ROOTS` while
  // still inside `WIKI_STAMP_ROOTS` — the mini's exact shape, and the one case
  // that proves the read-only half of `stampable` is load-bearing.
  roRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-prov-ro-"));
  await writeFile(path.join(roRoot, RO_REL), STAMPME, "utf8");

  // The stub stamper: it does what the real CLI does to the four frontmatter
  // lines and prints the same one-line `--report`, so the spec needs no
  // claude-usage checkout. The retirement RULE is pinned by claude-usage's own
  // suite; what this proves is muninn's wiring and the re-render.
  stampBin = path.join(root, "..", `e2e-wiki-stamp-${process.pid}.sh`);
  await writeFile(stampBin, STUB_STAMPER, { mode: 0o755 });

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${WIKI_RO}=${roRoot}`,
      WIKI_READONLY_ROOTS: roRoot,
      // The stamper. `WIKI_STAMP_BUN` is bash because the stub is a shell
      // script; production runs the CLI's `.ts` source through bun.
      WIKI_STAMP_BIN: stampBin,
      WIKI_STAMP_ROOTS: `${root}:${roRoot}`,
      WIKI_STAMP_BUN: "/bin/bash",
      // AFTER `e2eEnv()`: both names are in `AMBIENT_INSTANCE_ENV`, so the blank
      // set would otherwise unset exactly what this spec is about.
      CLAUDE_USAGE_URL: `http://127.0.0.1:${LEDGER_PORT}`,
      CLAUDE_USAGE_PUBLIC_URL: PUBLIC_BASE,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  if (roRoot) await rm(roRoot, { recursive: true, force: true });
  if (stampBin) await rm(stampBin, { force: true });
});

// Every rendered stamp below is exact rather than a regex, which needs the
// browser's zone pinned: the renderer formats in the VIEWER's zone, so an
// assertion on an hour is otherwise a fact about the machine — Oslo on this
// laptop, UTC on a CI runner.
test.use({ timezoneId: "UTC" });

test.describe("Wiki reader: provenance", () => {
  test("the strip shows the Jira key and one honest line of cost", async ({ page }) => {
    await open_(page, SHAPE_REL);
    const strip = page.locator(".wiki-prov-strip");
    await expect(strip).toBeVisible();

    // The Jira link is built from the key, always, and opens in a new tab.
    const jiraLink = strip.locator(".wiki-prov-jira-link");
    await expect(jiraLink).toHaveAttribute(
      "href",
      "https://nav.atlassian.net/browse/MELOSYS-8045",
    );
    await expect(jiraLink).toHaveAttribute("target", "_blank");
    await expect(jiraLink).toHaveAttribute("rel", /noopener/);
    await expect(strip.locator(".wiki-prov-jira-key")).toHaveText("MELOSYS-8045");

    // The cost sentence, and it is the "over M of N" form because the ledger
    // held one of the two sessions. `toContainText`, not `toHaveText`: the
    // fixture also carries `sessions_backfilled`, whose tail is asserted next.
    const cost = strip.locator(".wiki-prov-cost");
    await expect(cost).toContainText(
      "the 2 sessions that wrote this page cost $12.34 in total over 1 of 2",
    );
    await expect(cost).toContainText("· inferred from history 2026-10-14");
    // The degrade sentences must NOT be here — this ledger answered.
    await expect(cost).not.toContainText("unreachable");

    // The frontmatter `prs:` list still renders NO row of its own. What it does
    // is feed `?prs=` — so #543 appears only because the LEDGER reported a merge
    // for it, as a merge row on the chain, while #1234 (which the ledger holds
    // nothing for) leaves no trace at all.
    await expect(strip.locator('a[href*="/pull/1234"]')).toHaveCount(0);
    await expect(strip).not.toContainText("melosys-api");
    await expect(strip).not.toContainText("1234");
    await expect(page.locator('#wikiList a[href*="github.com"]')).toHaveCount(0);
    // The one #543 link is a MERGE row, inside the chain, not a `prs:` chip.
    await expect(strip.locator('.wiki-chain-merge a[href*="/pull/543"]')).toHaveCount(1);
    await expect(strip.locator('a[href*="/pull/543"]')).toHaveCount(1);
  });

  test("the chain lists both sessions — one priced with a drill-down, one bare", async ({ page }) => {
    await open_(page, SHAPE_REL);
    const rows = await openChain(page);
    // Two stamped sessions, three of their merges, the PR ghost `?prs=` found
    // and the merge it made — one spine, seven rows.
    await expect(rows).toHaveCount(7);

    const priced = rows.nth(0);
    await expect(priced).not.toHaveClass(/wiki-chain-bare/);
    await expect(priced.locator(".wiki-chain-glyph")).toHaveText("◆");
    await expect(priced.locator(".wiki-chain-glyph")).toHaveAttribute("title", "claude-code");
    // `first → last`, formatted from the ledger's ISO stamps.
    await expect(priced.locator(".wiki-chain-when")).toHaveText("09-15 12:00 → 09-15 13:30");
    await expect(priced.locator(".wiki-chain-host")).toHaveText("· macmini");
    await expect(priced.locator(".wiki-chain-title")).toHaveText("Wiki provenance — PR 4a");
    await expect(priced.locator(".wiki-chain-cost")).toHaveText("$12.34");
    await expect(priced.locator(".wiki-chain-id")).toHaveText(PRICED_ID);
    // The message count is a hover on the row, never a column.
    await expect(priced).toHaveAttribute("title", "148 messages");
    await expect(priced.locator(".wiki-chain-link")).toHaveAttribute(
      "href",
      `${PUBLIC_BASE}/#/session/${PRICED_ID}`,
    );

    // The ledger ANSWERED and does not hold the second id: no money, no title,
    // its own sentence — and NO drill-down, since a link to a session the
    // service does not have is a dead end. Dateless, so it sorts LAST, after
    // every merge.
    const bare = rows.nth(6);
    await expect(bare).toHaveClass(/wiki-chain-bare/);
    await expect(bare.locator(".wiki-chain-reason")).toHaveText(
      "not in the ledger — reaped, or from another host",
    );
    await expect(bare.locator(".wiki-chain-id")).toHaveText(MISSING_ID);
    await expect(bare.locator(".wiki-chain-cost")).toHaveCount(0);
    await expect(bare.locator(".wiki-chain-link")).toHaveCount(0);

    // Both ids really were asked about, bare (the `provider:` prefix is
    // muninn's, and a prefixed id comes back missing for every real session) —
    // and BOTH legs got the same pair.
    expect(asked.some((q) => q.includes(PRICED_ID) && q.includes(MISSING_ID))).toBe(true);
    expect(askedMerges.some((q) => q.includes(PRICED_ID) && q.includes(MISSING_ID))).toBe(true);
  });

  test("the ⧉ button puts the bare session id on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open_(page, SHAPE_REL);
    const rows = await openChain(page);
    const bare = rows.nth(6);
    await bare.locator(".wiki-chain-copy").click();
    // The id ALONE — it is what a search for this session takes, and the reader
    // cannot reach the service to look it up any other way.
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(MISSING_ID);
    // The button reports the result in place; that flash is the only feedback a
    // clipboard write can give.
    await expect(bare.locator(".wiki-chain-copy")).toHaveText("✓");
  });

  test("a damaged session ref reads as damage, never as an outage", async ({ page }) => {
    const before = asked.length;
    const beforeMerges = askedMerges.length;
    await open_(page, DAMAGED_REL);
    const cost = page.locator(".wiki-prov-strip .wiki-prov-cost");
    await expect(cost).toHaveText("1 session ref — none could be looked up");
    // The sentence this whole flag exists to prevent.
    await expect(cost).not.toContainText("unreachable");
    await expect(cost).not.toContainText("no claude-usage on this host");
    // One invalid chip, with its own reason and no money.
    const rows = await openChain(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(".wiki-chain-reason")).toHaveText(
      "not a session id — frontmatter damage",
    );
    await expect(rows.first().locator(".wiki-chain-cost")).toHaveCount(0);
    // And nothing was asked of EITHER leg: the id was refused before batching,
    // which is the whole reason the page must not blame the service — and the
    // merges footer is absent for the same reason.
    expect(asked.length).toBe(before);
    expect(askedMerges.length).toBe(beforeMerges);
    await expect(page.locator(".wiki-chain-note")).toHaveCount(0);
  });

  test("an unstamped page renders no strip at all", async ({ page }) => {
    await open_(page, PLAIN_REL);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Plain page");
    await expect(page.locator(".wiki-prov-strip")).toHaveCount(0);
    await expect(page.locator(".wiki-prov-line")).toHaveCount(0);
    await expect(page.locator(".wiki-chain-row")).toHaveCount(0);
  });

  test("navigating from a stamped page to an unstamped one takes the chain with it", async ({ page }) => {
    await open_(page, SHAPE_REL);
    await openChain(page);
    await expect(page.locator(".wiki-chain-row")).toHaveCount(7);
    // The stale-state trap: an OPEN chain is the state most likely to survive a
    // navigation, since the strip is re-rendered from a payload the next page
    // does not have.
    await page.locator(`.wiki-list-item[data-relpath="${PLAIN_REL}"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Plain page");
    await expect(page.locator(".wiki-chain-row")).toHaveCount(0);
    await expect(page.locator(".wiki-prov-line")).toHaveCount(0);
  });

  test("the chain is collapsed until the line is pressed, and closes again", async ({ page }) => {
    await open_(page, SHAPE_REL);
    const line = page.locator(".wiki-prov-line");
    const chain = page.locator(".wiki-prov-chain");
    // Rendered, and hidden: the rows exist in the DOM but nothing is on screen.
    await expect(line).toHaveAttribute("aria-expanded", "false");
    await expect(chain).toBeHidden();
    await expect(line).toHaveAttribute("aria-controls", "wikiProvChain");

    await line.click();
    await expect(chain).toBeVisible();
    await expect(line).toHaveAttribute("aria-expanded", "true");

    await line.click();
    await expect(chain).toBeHidden();
    await expect(line).toHaveAttribute("aria-expanded", "false");
  });

  test("the line carries one mark per session and one per merge, rings first", async ({ page }) => {
    await open_(page, SHAPE_REL);
    const marks = page.locator(".wiki-prov-marks .wiki-prov-mark");
    // Two stamped sessions, one DASHED ghost ring, four merges — one per event,
    // in the order the kinds render: sessions, ghosts, merges.
    await expect(marks).toHaveCount(7);
    await expect(marks.nth(0)).toHaveAttribute("data-mark", "session");
    await expect(marks.nth(1)).toHaveAttribute("data-mark", "session");
    await expect(marks.nth(2)).toHaveAttribute("data-mark", "ghost");
    await expect(marks.nth(3)).toHaveAttribute("data-mark", "merge");
    await expect(marks.nth(6)).toHaveAttribute("data-mark", "merge");
    // A mark is a mark only if it says what it marks.
    await expect(marks.nth(3)).toHaveAttribute("title", /#553/);
    await expect(marks.nth(2)).toHaveAttribute("title", /linked by the ledger/);
  });

  test("the merge rows render in time order — linked, unlinked and unconfirmed", async ({ page }) => {
    await open_(page, SHAPE_REL);
    const rows = await openChain(page);
    const merges = page.locator(".wiki-chain-merge");
    await expect(merges).toHaveCount(4);

    // 1. A repo the ledger could resolve: the coordinate, linked.
    const linked = merges.nth(0);
    await expect(linked.locator(".wiki-chain-pr")).toHaveText("RuneLind/muninn #553");
    await expect(linked.locator("a.wiki-chain-pr")).toHaveAttribute(
      "href",
      "https://github.com/RuneLind/muninn/pull/553",
    );
    await expect(linked.locator(".wiki-chain-when")).toHaveText("merged 09-15 14:00");
    await expect(linked.locator(".wiki-chain-unconfirmed")).toHaveCount(0);

    // 2. A repo it could not: the number alone, the checkout's basename as the
    //    hover, and NO link — a guessed coordinate is the worst output here.
    const unlinked = merges.nth(1);
    await expect(unlinked.locator(".wiki-chain-pr")).toHaveText("#77");
    await expect(unlinked.locator("a")).toHaveCount(0);
    await expect(unlinked.locator(".wiki-chain-pr")).toHaveAttribute("title", "side-project");
    await expect(unlinked).not.toContainText("/Users/");

    // 3. `mergeOk: false` is QUALIFIED, never dropped.
    const unconfirmed = merges.nth(2);
    await expect(unconfirmed.locator(".wiki-chain-pr")).toHaveText("RuneLind/muninn #88");
    await expect(unconfirmed.locator(".wiki-chain-unconfirmed")).toHaveText("merge unconfirmed");

    // And they sit BETWEEN the priced session and the dateless bare one.
    await expect(rows.nth(0)).toHaveClass(/wiki-chain-session/);
    await expect(rows.nth(6)).toHaveClass(/wiki-chain-bare/);
  });

  test("a merges leg that did not answer says so, and the cost sentence does not move", async ({ page }) => {
    await open_(page, MERGESDOWN_REL);
    // The FACTS leg answered, so the money is exactly what it priced.
    await expect(page.locator(".wiki-prov-cost")).toHaveText(
      "the 1 session that wrote this page cost $1.50 in total",
    );
    const rows = await openChain(page);
    await expect(rows).toHaveCount(1);
    await expect(page.locator(".wiki-chain-merge")).toHaveCount(0);
    await expect(page.locator(".wiki-chain-note")).toHaveText(
      "merges not shown: claude-usage did not answer",
    );
  });

  test("the Jira facet filters the list and round-trips through the URL", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(ALL_PAGES);
    // The facet lives inside the Filters disclosure, closed until a filter is
    // set — the `project` row's own placement.
    await page.locator("#wikiFilters summary").click();
    const chips = page.locator("#jiraChips .wiki-chip");
    await expect(chips.filter({ hasText: "MELOSYS-8045" })).toHaveText("MELOSYS-8045 1");
    await expect(chips.filter({ hasText: "MELOSYS-7790" })).toHaveText("MELOSYS-7790 1");

    await chips.filter({ hasText: "MELOSYS-8045" }).click();
    // The list is exactly the page serving that issue…
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);
    await expect(page.locator(`.wiki-list-item[data-relpath="${SHAPE_REL}"]`)).toHaveCount(1);
    // …and the filter is in the address bar, so it can be shared.
    await expect.poll(() => new URL(page.url()).searchParams.get("jira")).toBe("MELOSYS-8045");

    // A reload of that URL restores the chip as active — the boot adopt.
    await page.reload();
    await expect(page.locator('#jiraChips .wiki-chip[data-jira="MELOSYS-8045"]')).toHaveClass(
      /active/,
    );
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);

    // Re-clicking the active chip clears it, the chip-row convention, and the
    // param goes with it. (The active filter auto-opened the disclosure, so the
    // chip is on screen without a second summary click.)
    await expect(page.locator("#wikiFilters")).toHaveAttribute("open", "");
    await page.locator('#jiraChips .wiki-chip[data-jira="MELOSYS-8045"]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(ALL_PAGES);
    await expect.poll(() => new URL(page.url()).searchParams.get("jira")).toBeNull();
  });

  test("a key this wiki does not know opens the whole wiki and drops the param", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&jira=NOPE`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(ALL_PAGES);
    // No filter survived, so nothing auto-opened the stack — open it by hand to
    // see that the row is there and nothing in it is highlighted.
    await page.locator("#wikiFilters summary").click();
    await expect(page.locator("#jiraChips .wiki-chip.active")).toHaveText("All issues");
    await expect.poll(() => new URL(page.url()).searchParams.get("jira")).toBeNull();
  });

  test("the strip's Jira key sets the facet", async ({ page }) => {
    await open_(page, SHAPE_REL);
    await page.locator(".wiki-prov-jira-key").click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);
    await expect.poll(() => new URL(page.url()).searchParams.get("jira")).toBe("MELOSYS-8045");
    // Written IN PLACE: the article being read must survive a chip click.
    await expect.poll(() => new URL(page.url()).searchParams.get("relPath")).toBe(SHAPE_REL);
  });

  /**
   * The strip may only offer a filter the facet can serve.
   *
   * The store keeps every frontmatter value on the page's own row (uppercased,
   * nothing else) while the listing's `jira` map is shape-filtered, so a
   * malformed key used to render as a live button whose click set a filter
   * `resolveJiraParam` drops: the list narrowed, the facet chip rendered
   * `NOT-A-KEY 0` beside it, every link built while it was live carried a dead
   * param, a reload silently lost it, and the ↗ opened a browse URL for a
   * non-key.
   */
  test("a malformed Jira key on the page is text, not a filter", async ({ page }) => {
    await open_(page, MIXED_REL);
    const strip = page.locator(".wiki-prov-strip");
    await expect(strip).toBeVisible();

    // The two real keys are controls — `melosys-9002` included, which the store
    // normalized on the way in.
    const keys = strip.locator("[data-prov-jira]");
    await expect(keys).toHaveCount(2);
    await expect(keys.nth(0)).toHaveText("MELOSYS-9001");
    await expect(keys.nth(1)).toHaveText("MELOSYS-9002");

    // The third is SHOWN — it is really on the page, and hiding it would hide
    // the frontmatter damage — but it is neither a filter nor a Jira link.
    await expect(strip).toContainText("NOT-A-KEY");
    await expect(strip.locator('[data-prov-jira="NOT-A-KEY"]')).toHaveCount(0);
    await expect(strip.locator('a[href*="NOT-A-KEY"]')).toHaveCount(0);
    await expect(strip.locator(".wiki-prov-jira-inert")).toHaveCount(1);
    // It is not even a button, so there is nothing to press.
    await expect(strip.locator("button")).toHaveCount(2);

    // And the working key's count IS the rows its click leaves.
    await keys.nth(0).click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);
    await expect(page.locator(`.wiki-list-item[data-relpath="${MIXED_REL}"]`)).toHaveCount(1);
    await expect.poll(() => new URL(page.url()).searchParams.get("jira")).toBe("MELOSYS-9001");
    await expect(page.locator('#jiraChips .wiki-chip[data-jira="MELOSYS-9001"]')).toHaveText(
      "MELOSYS-9001 1",
    );
  });

  /**
   * "No pages match." is about the FILTER; the Sessions block is about the OPEN
   * PAGE. Composing them into one buffer made the empty state the `||` fallback
   * of a string the Sessions block had already filled, so a stamped page
   * answered a facet matching nothing with session rows and no answer at all.
   *
   * Two ANDed facets are what produce zero rows from live controls: `shape.md` is
   * the only page carrying MELOSYS-8045, and `mixed.md` is the only page tagged
   * `mixedonly`, so the intersection is empty. Jira FIRST — the tag row counts
   * within the domain/type scope and not within the Jira one, so its chip is
   * there either way, while a Jira row scoped to nothing would hide itself.
   * Deliberately not the TYPE facet: a `WIKI_EXTRA` wiki declares no ontology,
   * so every page here resolves to `note` and that chip narrows nothing.
   */
  test("a facet matching nothing says so, even with the chain open", async ({
    page,
  }) => {
    await open_(page, SHAPE_REL);
    await openChain(page);
    await expect(page.locator(".wiki-chain-row")).toHaveCount(7);

    await page.locator(".wiki-prov-jira-key").click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);
    await page.locator('#tagChips .wiki-chip[data-tag="mixedonly"]').click();

    await expect(page.locator(".wiki-list-item")).toHaveCount(0);
    // Scoped to the list: `.wiki-conn-empty` is the shared empty-row class and
    // the Connections panel renders its own, hidden, siblings.
    const empty = page.locator("#wikiList .wiki-conn-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText("No pages match.");
    // The open page's chain is still there — it was never the answer to the
    // filter, and dropping it would be the opposite defect.
    await expect(page.locator(".wiki-chain-row")).toHaveCount(7);
  });

  // ── PR 3: handoffs, ghosts, gates and the Stamp ──────────────────────────

  test("the handoff chain renders three sessions, two handoff lines and two gated merges", async ({
    page,
  }) => {
    await open_(page, CHAIN_REL);
    // The cost sentence is about the STAMPED sessions only — a ghost is a link,
    // never a denominator — and the ghost rides a hint of its own after it.
    await expect(page.locator(".wiki-prov-cost")).toHaveText(
      "the 2 sessions that wrote this page cost $51.00 in total",
    );
    await expect(page.locator(".wiki-prov-ghost-hint")).toHaveText(
      "the ledger links 1 more session through a handoff — $44.00",
    );
    // Two rings, one dashed ring, two squares.
    const marks = page.locator(".wiki-prov-marks .wiki-prov-mark");
    await expect(marks).toHaveCount(5);
    await expect(marks.nth(2)).toHaveAttribute("data-mark", "ghost");

    const rows = await openChain(page);
    // A(09:00) → handoff(13:45) → B(14:00) → #321(15:30) → handoff(17:45) →
    // ghost(18:00) → #322(19:30). Time order, one spine.
    await expect(rows).toHaveCount(7);
    await expect(page.locator(".wiki-chain-handoff")).toHaveCount(2);
    await expect(rows.nth(1)).toHaveClass(/wiki-chain-handoff/);
    await expect(rows.nth(1).locator(".wiki-chain-when")).toHaveText(
      "handoff · 09-15 13:45 · workshop",
    );
    await expect(rows.nth(1)).toHaveAttribute("title", `${CHAIN_A} → ${CHAIN_B}`);

    // The model reads short with the raw id on the hover, and the delegated
    // slice sits after the total.
    await expect(rows.nth(0).locator(".wiki-chain-model")).toHaveText("· claude-sonnet-4-5");
    await expect(rows.nth(0).locator(".wiki-chain-model")).toHaveAttribute(
      "title",
      "claude-sonnet-4-5-20250929",
    );
    await expect(rows.nth(0).locator(".wiki-chain-delegated")).toHaveText("· $5.50 delegated");

    // The gate verdicts: one merge stated none, the other stated both.
    const merges = page.locator(".wiki-chain-merge");
    await expect(merges).toHaveCount(2);
    await expect(merges.nth(0).locator(".wiki-chain-gate")).toHaveText("no gate line");
    await expect(merges.nth(1).locator(".wiki-chain-gate")).toHaveText(
      "✓ review floor + split check",
    );

    // The ghost itself: amber, its evidence named, and — since the ledger's
    // `claude` maps to the prefix the stamper writes — a glyph and a Stamp.
    const ghost = rows.nth(5);
    await expect(ghost).toHaveClass(/wiki-chain-ghost/);
    await expect(ghost.locator(".wiki-chain-glyph")).toHaveText("◆");
    await expect(ghost.locator(".wiki-chain-reason")).toHaveText(
      "ran this session's handoff — may not have touched this page",
    );
    await expect(ghost.locator(".wiki-chain-id")).toHaveText(CHAIN_GHOST);
  });

  test("a handoff ghost's first click asks for a confirmation", async ({ page }) => {
    await open_(page, CHAIN_REL);
    const rows = await openChain(page);
    const btn = rows.nth(5).locator(".wiki-chain-stamp");
    await expect(btn).toHaveText("Stamp");
    await btn.click();
    // Nothing was written: the label is the whole first step.
    await expect(btn).toHaveText("Confirm: this session wrote the page");
    await expect(rows.nth(5)).toHaveClass(/wiki-chain-ghost/);
    const after = await readFile(path.join(root, CHAIN_REL), "utf8");
    expect(after).not.toContain(CHAIN_GHOST);
  });

  test("the shape fixture finds its ghost through `prs:`", async ({ page }) => {
    const before = askedPrs.length;
    await open_(page, SHAPE_REL);
    const rows = await openChain(page);
    expect(askedPrs.length).toBeGreaterThan(before);
    // The page's own two coordinates were the query.
    expect(askedPrs[askedPrs.length - 1]).toContain("RuneLind/muninn#543");

    const ghost = rows.nth(4);
    await expect(ghost).toHaveClass(/wiki-chain-ghost/);
    await expect(ghost.locator(".wiki-chain-reason")).toHaveText(
      "merged #543 — this page does not stamp it",
    );
    // Real evidence, so the Stamp is ONE click — no confirm attribute.
    const btn = ghost.locator(".wiki-chain-stamp");
    await expect(btn).toHaveAttribute("data-prov-stamp", `claude-code:${PR_GHOST}`);
    await expect(btn).not.toHaveAttribute("data-prov-stamp-confirm", /.*/);
    // A pre-standardization merge says so instead of reading as ungated.
    await expect(page.locator(".wiki-chain-merge").nth(2).locator(".wiki-chain-gate")).toHaveText(
      "no gate data before 2026-07-30",
    );
    // ...and a row the join did not match says THAT, never nothing.
    await expect(page.locator(".wiki-chain-merge").nth(1).locator(".wiki-chain-gate")).toHaveText(
      "gate not matched",
    );
  });

  test("Stamp writes the frontmatter through the CLI and the row turns solid", async ({ page }) => {
    await open_(page, STAMP_REL);
    // Before: one stamped session, one PR ghost, and the backfilled tail.
    await expect(page.locator(".wiki-prov-cost")).toContainText(
      "· inferred from history 2026-09-01",
    );
    const rows = await openChain(page);
    await expect(rows.filter({ hasText: STAMP_GHOST })).toHaveClass(/wiki-chain-ghost/);

    await page.locator(".wiki-chain-stamp").click();

    // After: the ghost is a stamped session, the cost sentence counts two, and
    // the CLI retired `sessions_backfilled` so the tail is gone. The strip
    // redraws from the route's own re-resolved payload — no second page load.
    await expect(page.locator(".wiki-prov-cost")).toHaveText(
      "the 2 sessions that wrote this page cost $12.00 in total",
    );
    await expect(page.locator(".wiki-prov-cost")).not.toContainText("inferred from history");
    await expect(page.locator(".wiki-chain-ghost")).toHaveCount(0);
    // The chain the reader had open is still open after the redraw.
    await expect(page.locator(".wiki-prov-chain")).toBeVisible();

    const after = await readFile(path.join(root, STAMP_REL), "utf8");
    expect(after).toContain(`claude-code:${STAMP_GHOST}`);
    expect(after).not.toContain("sessions_backfilled");
  });

  test("a read-only ROOT offers no Stamp and refuses the POST", async ({ page, request }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_RO}&relPath=${encodeURIComponent(RO_REL)}`);
    const rows = await openChain(page);
    // The ghost is there — provenance is a READ, and the mini serves it in full.
    await expect(rows.filter({ hasText: STAMP_GHOST })).toHaveClass(/wiki-chain-ghost/);
    // ...and there is no button on it, because `stampable` is false.
    await expect(page.locator(".wiki-chain-stamp")).toHaveCount(0);

    const res = await request.post(`${BASE}/api/wiki/provenance/stamp`, {
      data: { wiki: WIKI_RO, relPath: RO_REL, ref: `claude-code:${STAMP_GHOST}` },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toContain("WIKI_READONLY_ROOTS");
    const after = await readFile(path.join(roRoot, RO_REL), "utf8");
    expect(after).not.toContain(STAMP_GHOST);
  });
});
