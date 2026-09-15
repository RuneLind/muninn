/**
 * /wiki reader — the provenance strip, the rail's Sessions section and the Jira
 * facet, end to end.
 *
 * Placement C: the strip under the title is the SUMMARY (the Jira row plus one
 * line of cost), the rail panel is the DETAIL (one row per session). Four things
 * only a real browser against a real server can answer, and every one of them is
 * a degrade:
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
 *  3. **An unstamped page renders byte-identically to before.** No strip, no
 *     Sessions section — the payload simply has no `provenance` key.
 *  4. **`?jira=` as URL state**, the `?project=` recipe: chip click → the param
 *     written in place, a reload restoring the active chip, an unknown key
 *     clearing itself and leaving the whole wiki.
 *
 * The clipboard is the fifth: the session id is COPYABLE TEXT because the
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

const SHAPE_REL = "shape.md";
const DAMAGED_REL = "damaged.md";
const PLAIN_REL = "plain.md";
const OTHER_REL = "other.md";

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

let server: ChildProcess | undefined;
let ledger: Server | undefined;
let root = "";
/** Every `ids=` query the stub was asked, so a test can prove the browser never
 *  reached the service itself and that a damaged page asked nothing. */
let asked: string[] = [];

const open_ = (page: import("@playwright/test").Page, rel: string) =>
  page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);

/**
 * claude-usage, as `src/wiki/session-ledger.ts` parses it: `{sessions: [...]}`
 * keyed on the BARE id. `MISSING_ID` is deliberately absent from the answer —
 * that is what makes the chip `missing` ("the ledger answered and does not hold
 * it") rather than `unresolved` ("nobody asked").
 */
function startLedger(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/sessions-by-id") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected path", path: url.pathname }));
      return;
    }
    asked.push(url.searchParams.get("ids") ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        sessions: [
          {
            sessionId: PRICED_ID,
            provider: "claude-code",
            host: "macmini",
            title: "Wiki provenance — PR 4a",
            first: "2026-09-15",
            last: "2026-09-15",
            cost: 12.34,
            messages: 148,
          },
        ],
      }),
    );
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
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

    // `prs` rides the payload and renders NOTHING: the PR row ships with
    // campaign 2, and a half-built control is worse than none.
    await expect(strip).not.toContainText("melosys-api");
    await expect(strip).not.toContainText("1234");
  });

  test("the rail lists both sessions — one priced with a drill-down, one bare", async ({ page }) => {
    await open_(page, SHAPE_REL);
    await expect(page.locator('.wiki-list-sec[data-section="sessions"]')).toBeVisible();
    const rows = page.locator(".wiki-sess-row");
    await expect(rows).toHaveCount(2);

    const priced = rows.nth(0);
    await expect(priced).not.toHaveClass(/wiki-sess-bare/);
    await expect(priced.locator(".wiki-sess-glyph")).toHaveText("◆");
    await expect(priced.locator(".wiki-sess-glyph")).toHaveAttribute("title", "claude-code");
    await expect(priced.locator(".wiki-sess-date")).toHaveText("2026-09-15");
    await expect(priced.locator(".wiki-sess-host")).toHaveText("macmini");
    await expect(priced.locator(".wiki-sess-title")).toHaveText("Wiki provenance — PR 4a");
    await expect(priced.locator(".wiki-sess-cost")).toHaveText("$12.34");
    await expect(priced.locator(".wiki-sess-id")).toHaveText(PRICED_ID);
    await expect(priced.locator(".wiki-sess-link")).toHaveAttribute(
      "href",
      `${PUBLIC_BASE}/#/session/${PRICED_ID}`,
    );

    // The ledger ANSWERED and does not hold the second id: no money, no title,
    // its own sentence — and NO drill-down, since a link to a session the
    // service does not have is a dead end.
    const bare = rows.nth(1);
    await expect(bare).toHaveClass(/wiki-sess-bare/);
    await expect(bare.locator(".wiki-sess-reason")).toHaveText(
      "not in the ledger — reaped, or from another host",
    );
    await expect(bare.locator(".wiki-sess-id")).toHaveText(MISSING_ID);
    await expect(bare.locator(".wiki-sess-cost")).toHaveCount(0);
    await expect(bare.locator(".wiki-sess-link")).toHaveCount(0);

    // Both ids really were asked about, bare (the `provider:` prefix is
    // muninn's, and a prefixed id comes back missing for every real session).
    expect(asked.some((q) => q.includes(PRICED_ID) && q.includes(MISSING_ID))).toBe(true);
  });

  test("the ⧉ button puts the bare session id on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open_(page, SHAPE_REL);
    const bare = page.locator(".wiki-sess-row").nth(1);
    await bare.locator(".wiki-sess-copy").click();
    // The id ALONE — it is what a search for this session takes, and the reader
    // cannot reach the service to look it up any other way.
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(MISSING_ID);
    // The button reports the result in place; that flash is the only feedback a
    // clipboard write can give.
    await expect(bare.locator(".wiki-sess-copy")).toHaveText("✓");
  });

  test("a damaged session ref reads as damage, never as an outage", async ({ page }) => {
    const before = asked.length;
    await open_(page, DAMAGED_REL);
    const cost = page.locator(".wiki-prov-strip .wiki-prov-cost");
    await expect(cost).toHaveText("1 session ref — none could be looked up");
    // The sentence this whole flag exists to prevent.
    await expect(cost).not.toContainText("unreachable");
    await expect(cost).not.toContainText("no claude-usage on this host");
    // One invalid chip, with its own reason and no money.
    const rows = page.locator(".wiki-sess-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(".wiki-sess-reason")).toHaveText(
      "not a session id — frontmatter damage",
    );
    await expect(rows.first().locator(".wiki-sess-cost")).toHaveCount(0);
    // And nothing was asked: the id was refused before batching, which is the
    // whole reason the page must not blame the service.
    expect(asked.length).toBe(before);
  });

  test("an unstamped page renders no strip and no Sessions section", async ({ page }) => {
    await open_(page, PLAIN_REL);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Plain page");
    await expect(page.locator(".wiki-prov-strip")).toHaveCount(0);
    await expect(page.locator('.wiki-list-sec[data-section="sessions"]')).toHaveCount(0);
    await expect(page.locator(".wiki-sess-row")).toHaveCount(0);
  });

  test("navigating from a stamped page to an unstamped one drops the rail rows", async ({ page }) => {
    await open_(page, SHAPE_REL);
    await expect(page.locator(".wiki-sess-row")).toHaveCount(2);
    // The stale-state trap: the rail repaints on every listing refresh and
    // keystroke, long after the response that filled it.
    await page.locator(`.wiki-list-item[data-relpath="${PLAIN_REL}"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Plain page");
    await expect(page.locator(".wiki-sess-row")).toHaveCount(0);
  });

  test("the Jira facet filters the list and round-trips through the URL", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);
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
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);
    await expect.poll(() => new URL(page.url()).searchParams.get("jira")).toBeNull();
  });

  test("a key this wiki does not know opens the whole wiki and drops the param", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&jira=NOPE`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);
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
});
