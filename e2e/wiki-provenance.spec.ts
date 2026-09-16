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

const SHAPE_REL = "shape.md";
const MERGESDOWN_REL = "merges-down.md";
const DAMAGED_REL = "damaged.md";
const PLAIN_REL = "plain.md";
const OTHER_REL = "other.md";
const MIXED_REL = "mixed.md";

/** How many pages the temp wiki holds — every "the whole wiki" assertion below. */
const ALL_PAGES = 6;

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

let server: ChildProcess | undefined;
let ledger: Server | undefined;
let root = "";
/** Every `ids=` query the stub was asked, so a test can prove the browser never
 *  reached the service itself and that a damaged page asked nothing. */
let asked: string[] = [];
/** The same, for the merges leg. */
let askedMerges: string[] = [];

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
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ids = url.searchParams.get("sessions") ?? url.searchParams.get("ids") ?? "";
    if (url.pathname === "/api/merges") {
      askedMerges.push(ids);
      // One page's session is the "merges leg is down" case; the facts leg for
      // that same id still answers, which is the split the footer exists for.
      if (ids.includes(MERGES_DOWN_ID)) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "merges unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          limit: 200,
          truncated: false,
          merges: [
            {
              sessionId: PRICED_ID,
              repo: "/Users/synthetic/source/muninn",
              prNumber: 553,
              url: "https://github.com/RuneLind/muninn/pull/553",
              subject: null,
              mergedAt: "2026-09-15T14:00:00.000Z",
              mergeOk: true,
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
            },
            {
              sessionId: PRICED_ID,
              repo: "/Users/synthetic/source/muninn",
              prNumber: 88,
              url: "https://github.com/RuneLind/muninn/pull/88",
              subject: null,
              mergedAt: "2026-09-15T16:00:00.000Z",
              mergeOk: false,
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname !== "/api/sessions-by-id") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected path", path: url.pathname }));
      return;
    }
    asked.push(ids);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        sessions: [
          {
            sessionId: PRICED_ID,
            provider: "claude-code",
            host: "macmini",
            title: "Wiki provenance — PR 4a",
            first: "2026-09-15T12:00:00.000Z",
            last: "2026-09-15T13:30:00.000Z",
            cost: 12.34,
            messages: 148,
          },
          {
            sessionId: MERGES_DOWN_ID,
            provider: "claude-code",
            host: "macmini",
            title: "A session whose merges cannot be listed",
            first: "2026-09-15T12:00:00.000Z",
            last: "2026-09-15T12:00:00.000Z",
            cost: 1.5,
            messages: 9,
          },
        ],
      }),
    );
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

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
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

    // `prs` rides the payload and renders NOTHING: the frontmatter PR row ships
    // with campaign 2, and a half-built control is worse than none. The chain's
    // merge rows DO carry github.com links, so the pin is on the two
    // coordinates only `prs:` could have produced — neither of which any merge
    // in the stub names.
    await expect(strip.locator('a[href*="/pull/1234"]')).toHaveCount(0);
    await expect(strip.locator('a[href*="/pull/543"]')).toHaveCount(0);
    await expect(page.locator('#wikiList a[href*="github.com"]')).toHaveCount(0);
    await expect(strip).not.toContainText("melosys-api");
    await expect(strip).not.toContainText("1234");
  });

  test("the chain lists both sessions — one priced with a drill-down, one bare", async ({ page }) => {
    await open_(page, SHAPE_REL);
    const rows = await openChain(page);
    // Two sessions and three merges, on one spine.
    await expect(rows).toHaveCount(5);

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
    const bare = rows.nth(4);
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
    const bare = rows.nth(4);
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
    await expect(page.locator(".wiki-chain-row")).toHaveCount(5);
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
    await expect(marks).toHaveCount(5);
    await expect(marks.nth(0)).toHaveAttribute("data-mark", "session");
    await expect(marks.nth(1)).toHaveAttribute("data-mark", "session");
    await expect(marks.nth(2)).toHaveAttribute("data-mark", "merge");
    await expect(marks.nth(4)).toHaveAttribute("data-mark", "merge");
    // A mark is a mark only if it says what it marks.
    await expect(marks.nth(2)).toHaveAttribute("title", /#553/);
  });

  test("the merge rows render in time order — linked, unlinked and unconfirmed", async ({ page }) => {
    await open_(page, SHAPE_REL);
    const rows = await openChain(page);
    const merges = page.locator(".wiki-chain-merge");
    await expect(merges).toHaveCount(3);

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
    await expect(rows.nth(4)).toHaveClass(/wiki-chain-bare/);
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
    await expect(page.locator(".wiki-chain-row")).toHaveCount(5);

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
    await expect(page.locator(".wiki-chain-row")).toHaveCount(5);
  });
});
