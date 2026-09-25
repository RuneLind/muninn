/**
 * /wiki reader — Connections + Link, end to end (plan "Tracker links in the
 * wiki reader", PR 3).
 *
 * Three temp wikis in ONE muninn, invented pages and synthetic keys (project
 * `DEMO`, host `example.invalid`) because muninn is a public repo:
 *
 *   - `e2e-conn` declares a `trackers` block and is a stamp root, so its pages
 *     get Connections rows, status, coverage, cost, Draft plan and Link;
 *   - `e2e-conn-plain` declares none and carries one stamped `jira:` page — the
 *     control for the rule that a wiki with no tracker renders today's facet
 *     and strip chips, and no pills, no section and no Link;
 *   - `e2e-conn-ro` declares a tracker but is registered read-only
 *     (`WIKI_READONLY_ROOTS`) while still a stamp root: no Link, and the POST
 *     answers 403.
 *
 * ONE `node:http` stub plays huginn's `jira-issues` listing (with issue fields)
 * and claude-usage (`/api/jira` plus what the strip already calls). The stamper
 * is a stub shell script that does to the `jira:` line what the real CLI does
 * — append to an inline list, create the line, refuse a scalar — and prints the
 * CLI's one-line `--report`. No model call: the Draft plan dialog is opened,
 * never sent.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-tracker-connections");
const STUB_PORT = e2ePort("wiki-tracker-connections/stub");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-conn";
const WIKI_PLAIN = "e2e-conn-plain";
const WIKI_RO = "e2e-conn-ro";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const READER_CONFIG = JSON.stringify({
  typeMap: { plans: "plan" },
  trackers: [
    {
      id: "jira",
      projects: ["DEMO", "OTHER"],
      hosts: ["example.invalid"],
      frontmatterKeys: ["issue"],
      planTitle: "plan(er|en)?(?!\\p{L})",
      planTitleExclude: "testplan|review av",
      createdMarkers: ["opprettet", "created"],
      statusMap: { "Til Utvikle": "todo", Ferdig: "done", "Akseptanse test": "review" },
      // The ledger records mentions only for the projects it tracks; OTHER is not one.
      ledgerProjects: ["DEMO"],
    },
  ],
});

const url = (k: string) => `https://example.invalid/browse/${k}`;
const md = (fm: string[], body: string) => ["---", ...fm, SETTLED_CREATED_LINE, "---", "", body, ""].join("\n");

const ANCHOR = "archive/2026-01-10-rotaarsak.mdx";
const ANCHOR_LINE =
  "Status: ferdig 2026-01-05 · grunnlag: kjørt 22.09 (**12 rader**) · Jira opprettet: " +
  `[DEMO-101](${url("DEMO-101")}) (A1 grunnfeil), ` +
  `[DEMO-102](${url("DEMO-102")}) (A2 følgefeil) og ` +
  `[DEMO-103](${url("DEMO-103")}) (B) · neste steg: A2.`;
const INFERRED = "notes/inferred-only.md";
const SCALAR = "notes/scalar.md";
const STAMPED = "notes/stamped.md";
const EXPLAINER = "explainers/forklaring.html";
const STEM_PLAN = "plans/2026-01-11-demo-160-plan.md";
const ISSUE_PLAN = "plans/utrulling.md";
const PLAN_A = "plans/arbeidsplan.md";
const PLAN_B = "plans/kjoreplan.md";
const ORA = "notes/ora.md";
const LINKED = "notes/linked-only.md";

const PAGES: Record<string, string> = {
  [ANCHOR]: md(
    [
      "title: Hvorfor mangler radene metadata?",
      "tags: [demo-api, demo-120, demo-121]",
      "sessions: [claude-code:00000000-0000-4000-8000-000000000031]",
    ],
    `# Hvorfor mangler radene metadata?\n\n${ANCHOR_LINE}\n\nSe også DEMO-122 for bakgrunn.`,
  ),
  [INFERRED]: md(["title: DEMO-130 og DEMO-131 — notater (OTHER-7)"], "# Notater\n\nIngen proveniens her."),
  [SCALAR]: md(["title: Skalar", "tags: [demo-142]", "jira: DEMO-140 (kilde), ny sak under epic DEMO-141"], "# Skalar"),
  [STAMPED]: md(["title: Stemplet", "jira: [DEMO-180]"], "# Stemplet"),
  [STEM_PLAN]: md(["title: Utrulling av ny kø", "type: plan"], "# Plan\n\nIngen nøkkel i teksten."),
  [ISSUE_PLAN]: md(["title: Utrullingsplan", "type: plan", "issue: DEMO-170"], "# Utrullingsplan"),
  [PLAN_A]: md(["title: DEMO-101 — arbeidsplan", "type: plan"], "# Arbeidsplan"),
  [PLAN_B]: md(["title: Kjøreplan for utrulling", "type: plan", "tags: [demo-121]"], "# Kjøreplan"),
  [ORA]: md(["title: Fallgruve (ORA-01407) på SAK-4711", "tags: [demo-api]"], "# Fallgruve"),
  [LINKED]: md(["title: Lenket side"], `# Lenket side\n\nEpic: [DEMO-190](${url("DEMO-190")}).`),
  [EXPLAINER]:
    "<!doctype html><html><head><title>DEMO-150 forklart</title></head>" +
    `<body><a href="${url("DEMO-199")}">DEMO-199</a></body></html>`,
};

/** huginn's `jira-issues` listing, with issue fields. */
const ISSUES: Record<string, { title: string; status: string; updated: string }> = {
  "DEMO-101": { title: "Grunnfeilen", status: "Akseptanse test", updated: "2026-01-04T10:00:00.000+0100" },
  "DEMO-102": { title: "Følgefeilen", status: "Til Utvikle", updated: "2026-01-02T03:04:05.000+0100" },
  "DEMO-103": { title: "Opprydding", status: "Ferdig", updated: "2026-01-03T09:00:00.000+0100" },
  "DEMO-120": { title: "Tag en", status: "Ferdig", updated: "2025-12-01T09:00:00.000+0100" },
  "DEMO-121": { title: "Tag to", status: "Til Utvikle", updated: "2025-12-02T09:00:00.000+0100" },
  "DEMO-130": { title: "Notat en", status: "Til Utvikle", updated: "2025-11-01T09:00:00.000+0100" },
};

/** The stub stamper — the real CLI's `jira:` behaviour, one report line. */
const STUB_STAMPER = [
  "#!/bin/bash",
  'key=""; file=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    --jira) key="$2"; shift 2;;',
  '    --file) file="$2"; shift 2;;',
  "    *) shift;;",
  "  esac",
  "done",
  'report() { printf \'{"outcome":"%s"%s,"path":"%s"}\\n\' "$1" "$2" "$file"; exit 0; }',
  '[ -f "$file" ] || report skipped \',"reason":"missing-file"\'',
  'if grep -q "^jira: \\[" "$file"; then',
  '  grep -q "^jira: \\[.*$key" "$file" && report unchanged \',"reason":"already-stamped"\'',
  '  sed -i.bak "s|^jira: \\[\\([^]]*\\)\\]|jira: [\\1, $key]|" "$file"',
  "elif grep -q '^jira:' \"$file\"; then",
  "  report skipped ',\"reason\":\"not-inline-list\"'",
  "else",
  '  sed -i.bak "1a\\\\',
  'jira: [$key]',
  '" "$file"',
  "fi",
  'rm -f "$file.bak"',
  "report written ''",
  "",
].join("\n");

let server: ChildProcess | undefined;
let stub: Server | undefined;
let root = "";
let plainRoot = "";
let roRoot = "";
let stampBin = "";
const jiraAsked: string[] = [];

async function writeWiki(pages: Record<string, string>, config?: string): Promise<string> {
  const r = await mkdtemp(path.join(tmpdir(), "muninn-e2e-conn-"));
  for (const [rel, body] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(r, rel)), { recursive: true });
    await writeFile(path.join(r, rel), body, "utf8");
  }
  if (config) await writeFile(path.join(r, ".wiki-reader.json"), config, "utf8");
  await settleWikiMtimes(r);
  return r;
}

test.beforeAll(async () => {
  root = await writeWiki(PAGES, READER_CONFIG);
  plainRoot = await writeWiki({ [STAMPED]: PAGES[STAMPED]!, [INFERRED]: PAGES[INFERRED]! });
  roRoot = await writeWiki({ [INFERRED]: PAGES[INFERRED]! }, READER_CONFIG);
  stampBin = path.join(root, "..", `e2e-conn-stamp-${process.pid}.sh`);
  await writeFile(stampBin, STUB_STAMPER, { mode: 0o755 });

  stub = createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${STUB_PORT}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === "/api/collection/jira-issues/documents") {
      const withFields = u.searchParams.get("include_issue_fields") === "true";
      return json(200, {
        documents: Object.entries(ISSUES).map(([key, f]) => ({
          id: `${key}_${f.title.replace(/\s+/g, "_")}.md`,
          url: url(key),
          ...(withFields ? { title: f.title, status: f.status, updated: f.updated } : {}),
        })),
      });
    }
    if (u.pathname === "/api/jira") {
      const key = u.searchParams.get("key") ?? "";
      jiraAsked.push(key);
      return json(200, { key, sessions: [{}, {}, {}], totalCost: 4.5, costedSessions: 3, truncated: false, limit: 2000 });
    }
    if (u.pathname === "/api/sessions-by-id") {
      const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      return json(200, { sessions: ids.map((sessionId) => ({ sessionId, missing: true })), limit: 200, truncated: false });
    }
    if (u.pathname === "/api/merges") return json(200, { merges: [], truncated: false, limit: 200 });
    if (u.pathname === "/api/session-handoff") return json(404, { error: "no such session" });
    json(404, { error: "not stubbed" });
  });
  await new Promise<void>((r) => stub!.listen(STUB_PORT, "127.0.0.1", r));

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: `http://127.0.0.1:${STUB_PORT}`,
      WIKI_EXTRA: `${WIKI}=${root},${WIKI_PLAIN}=${plainRoot},${WIKI_RO}=${roRoot}`,
      WIKI_READONLY_ROOTS: roRoot,
      // AFTER `e2eEnv()`, which blanks every one of these.
      WIKI_STAMP_BIN: stampBin,
      WIKI_STAMP_ROOTS: `${root}:${roRoot}`,
      WIKI_STAMP_BUN: "/bin/bash",
      CLAUDE_USAGE_URL: `http://127.0.0.1:${STUB_PORT}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
  for (const r of [root, plainRoot, roRoot]) if (r) await rm(r, { recursive: true, force: true });
  if (stampBin) await rm(stampBin, { force: true });
});

async function openPage(page: Page, wiki: string, rel: string): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article-head h1")).toBeVisible();
}

const section = (page: Page) => page.locator("#wikiConnIssues");
const issueRow = (page: Page, key: string) => page.locator(`#wikiConnIssues .wiki-issue-row[data-issue-row="${key}"]`);
/** The deferred rows have landed: a status pill is only in them. */
const deferred = (page: Page, key: string) => expect(issueRow(page, key).locator(".wiki-issue-status")).toBeVisible();

test.describe("Wiki reader: Connections + Link", () => {
  test("3: the anchor page lists created here ×3, tag ×2, and the body key on the mention line", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR);
    for (const key of ["DEMO-101", "DEMO-102", "DEMO-103"]) {
      await expect(issueRow(page, key).locator(".wiki-issue-rel")).toHaveText("created here");
    }
    for (const key of ["DEMO-120", "DEMO-121"]) {
      await expect(issueRow(page, key).locator(".wiki-issue-rel")).toHaveText("tag");
    }
    await expect(section(page).locator(".wiki-issue-mentions")).toContainText("DEMO-122");
    await expect(issueRow(page, "DEMO-122")).toHaveCount(0);
    // The section sits above the mini-graph, which draws the issue keys too.
    const order = await page.locator("#connBody").evaluate((el) =>
      Array.from(el.children).map((c) => c.id || c.className),
    );
    expect(order.indexOf("wikiConnIssues")).toBeLessThan(order.findIndex((c) => String(c).includes("wiki-mini-graph")));
    await expect(page.locator('.wiki-mini-graph [data-mini-issue="DEMO-101"]')).toHaveCount(1);
  });

  test("4: a mapped status renders in its category, with the raw text and Jira's date on hover", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR);
    await deferred(page, "DEMO-102");
    const pill = issueRow(page, "DEMO-102").locator(".wiki-issue-status");
    await expect(pill).toHaveText("Til Utvikle");
    await expect(pill).toHaveAttribute("data-status-cat", "todo");
    await expect(pill).toHaveAttribute("title", "Jira last updated 2026-01-02, as of huginn's last capture");
    await expect(issueRow(page, "DEMO-101").locator(".wiki-issue-status")).toHaveAttribute("data-status-cat", "review");
    // The strip draws its chips from the same rows: inferred keys dashed.
    await expect(page.locator(".wiki-prov-strip .wiki-prov-jira.inferred")).toHaveCount(5);
  });

  test("cost: priced for a tracked project, `not tracked` outside it, and the ledger asked per key", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR);
    await deferred(page, "DEMO-101");
    await expect(issueRow(page, "DEMO-101").locator(".wiki-issue-ledger")).toHaveText("3 sessions mention it · $4.50");
    expect(jiraAsked).toContain("DEMO-101");
    await openPage(page, WIKI, INFERRED);
    await expect(issueRow(page, "OTHER-7").locator(".wiki-issue-ledger")).toHaveText("not tracked");
    expect(jiraAsked).not.toContain("OTHER-7");
  });

  test("5: a plan-titled page covers its key; a todo created key offers Draft plan, a done one does not", async ({ page }) => {
    await openPage(page, WIKI, ANCHOR);
    await deferred(page, "DEMO-102");
    await expect(issueRow(page, "DEMO-101").locator(".wiki-issue-cover")).toContainText("plan: DEMO-101 — arbeidsplan");
    await expect(issueRow(page, "DEMO-101").locator("[data-draft-plan]")).toHaveCount(0);
    await expect(issueRow(page, "DEMO-103").locator("[data-draft-plan]")).toHaveCount(0);
    const draft = issueRow(page, "DEMO-102").locator("[data-draft-plan]");
    await expect(draft).toBeVisible();
    await draft.click();
    const dialog = page.locator("#wikiChatOpt");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-chat-q]").first()).toHaveText("Draft a plan for DEMO-102");
    await expect(page.locator("#wikiChatOptQ")).toHaveValue("");
  });

  test("6: a markdown page and an .html page with inferred keys and no provenance lines render the section", async ({ page }) => {
    await openPage(page, WIKI, INFERRED);
    await expect(issueRow(page, "DEMO-130")).toBeVisible();
    await openPage(page, WIKI, EXPLAINER);
    await expect(issueRow(page, "DEMO-150")).toBeVisible();
    await expect(issueRow(page, "DEMO-150").locator(".wiki-issue-rel")).toHaveText("title");
    // 7: the .html page gets rows but no Link.
    await expect(section(page).locator("[data-issue-link]")).toHaveCount(0);
  });

  test("7: Link writes `jira: [KEY]`, the row turns solid, and a repeat answers `unchanged` 200", async ({ page }) => {
    await openPage(page, WIKI, INFERRED);
    await deferred(page, "DEMO-130");
    await expect(issueRow(page, "DEMO-130")).toHaveClass(/inferred/);
    await issueRow(page, "DEMO-130").locator("[data-issue-link]").click();
    await expect(issueRow(page, "DEMO-130")).toHaveClass(/stamped/);
    await expect(issueRow(page, "DEMO-130").locator("[data-issue-link]")).toHaveCount(0);
    expect(await readFile(path.join(root, INFERRED), "utf8")).toMatch(/^jira: \[DEMO-130\]$/m);
    const again = await page.request.post(`${BASE}/api/wiki/provenance/stamp`, {
      headers: { "content-type": "application/json" },
      data: { wiki: WIKI, relPath: INFERRED, tracker: "jira", key: "DEMO-130" },
    });
    expect(again.status()).toBe(200);
    expect((await again.json()).outcome).toBe("unchanged");
    await page.reload();
    await expect(issueRow(page, "DEMO-130")).toHaveClass(/stamped/);
  });

  test("7: the scalar page shows the not-inline-list state", async ({ page }) => {
    await openPage(page, WIKI, SCALAR);
    await deferred(page, "DEMO-142");
    await issueRow(page, "DEMO-142").locator("[data-issue-link]").click();
    const msg = issueRow(page, "DEMO-142").locator('[data-issue-state="not-inline-list"]');
    await expect(msg).toContainText("is not an inline");
    await expect(issueRow(page, "DEMO-142")).toHaveClass(/inferred/);
  });

  test("7: Linking a tag key on a plan page flips it to covered in the redrawn row", async ({ page }) => {
    await openPage(page, WIKI, PLAN_B);
    await deferred(page, "DEMO-121");
    await expect(issueRow(page, "DEMO-121").locator(".wiki-issue-cover")).toHaveText("no plan");
    await issueRow(page, "DEMO-121").locator("[data-issue-link]").click();
    await expect(issueRow(page, "DEMO-121").locator(".wiki-issue-cover")).toHaveText("this page is the plan");
    await expect(issueRow(page, "DEMO-121")).toHaveClass(/stamped/);
  });

  test("7: the read-only shape offers no Link and answers 403", async ({ page }) => {
    await openPage(page, WIKI_RO, INFERRED);
    await expect(issueRow(page, "DEMO-130")).toBeVisible();
    await deferred(page, "DEMO-130");
    await expect(section(page).locator("[data-issue-link], [data-issue-link-all]")).toHaveCount(0);
    const res = await page.request.post(`${BASE}/api/wiki/provenance/stamp`, {
      headers: { "content-type": "application/json" },
      data: { wiki: WIKI_RO, relPath: INFERRED, tracker: "jira", key: "DEMO-130" },
    });
    expect(res.status()).toBe(403);
  });

  test("8: a wiki with no trackers block keeps today's facet and strip chips, and shows no pills, section or Link", async ({ page }) => {
    await openPage(page, WIKI_PLAIN, STAMPED);
    await expect(page.locator('.wiki-prov-strip [data-prov-jira="DEMO-180"]')).toBeVisible();
    await expect(page.locator(".wiki-prov-strip .wiki-prov-jira.inferred")).toHaveCount(0);
    await expect(page.locator("#jiraChips [data-jira=\"DEMO-180\"]")).toHaveCount(1);
    await expect(section(page)).toHaveCount(0);
    await expect(page.locator(".wiki-issue-pill")).toHaveCount(0);
    await expect(page.locator("[data-issue-link], [data-mini-issue]")).toHaveCount(0);
    await openPage(page, WIKI_PLAIN, INFERRED);
    await expect(page.locator(".wiki-prov-strip")).toHaveCount(0);
    await expect(section(page)).toHaveCount(0);
  });

  test("11: the stem-only and issue:-only plans show stem and declared, each covered; ORA and SAK nowhere", async ({ page }) => {
    await openPage(page, WIKI, STEM_PLAN);
    await expect(issueRow(page, "DEMO-160").locator(".wiki-issue-rel")).toHaveText("file name");
    await expect(issueRow(page, "DEMO-160").locator(".wiki-issue-cover")).toHaveText("this page is the plan");
    await openPage(page, WIKI, ISSUE_PLAN);
    await expect(issueRow(page, "DEMO-170").locator(".wiki-issue-rel")).toHaveText("declared");
    await expect(issueRow(page, "DEMO-170").locator(".wiki-issue-cover")).toHaveText("this page is the plan");
    await openPage(page, WIKI, ORA);
    await expect(section(page)).toHaveCount(0);
    for (const bad of ["ORA-01407", "SAK-4711"]) {
      await expect(page.locator(`[data-issue-key="${bad}"], [data-issue-row="${bad}"], #jiraChips [data-jira="${bad}"]`)).toHaveCount(0);
    }
  });

  test("the link-only page shows its key on the also-linked line with a Link that promotes it", async ({ page }) => {
    await openPage(page, WIKI, LINKED);
    const also = section(page).locator(".wiki-issue-also");
    await expect(also).toContainText("DEMO-190");
    await expect(also.locator('[data-issue-link="DEMO-190"]')).toBeVisible();
  });
});
