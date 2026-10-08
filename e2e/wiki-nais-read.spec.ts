/**
 * The wiki READ slice as a team member sees it on the nais pod:
 * `MUNINN_PROFILE=nais`, `MUNINN_AUTH=local` at role `user`, and one wiki
 * registered read-only (`WIKI_EXTRA` + `WIKI_READONLY_ROOTS`), the shape of the
 * bucket mirror.
 *
 * What a unit test cannot see and this spec asserts: the page renders a
 * Norwegian `.mdx` — a `<Callout>` and a client-rendered mermaid SVG — in both
 * colour schemes, the browser makes NO request that answers 4xx/5xx (a control
 * or panel reaching a dropped route would, as Hono's 404 or the zone's 403),
 * logs no console error, and every visible interactive control in the reader
 * is on an explicit ALLOWLIST of read controls (`READER_CONTROLS`). The
 * allowlist is independent of the selector that hides the dropped controls, so
 * a control that selector forgot shows up here as unexpected.
 *
 * The fixture is built to make controls render: a `trackers` block (graph
 * mode, issue pills), a page with `jira:`/`sessions:`/`prs:` frontmatter (the
 * provenance strip), an `<Embed>` of a same-stem `.html` (an attachment), and a
 * series. `CLAUDE_USAGE_URL` and `KNOWLEDGE_API_URL` point at closed ports, so
 * the provenance and graph legs degrade and never reach a live service, and
 * `MUNINN_BOTS_DIR` is a temp dir holding one wiki-less bot, so no developer
 * bot or bot wiki joins the registry.
 *
 * A second muninn at role `admin` carries the zone rows for both roles, next
 * to a second, WRITABLE wiki that the read slice must not serve.
 *
 * The browser drives 127.0.0.1, which takes the loopback bypass: the pinned
 * identity at role `user` with no credential — exactly the role under test.
 * The zone rows go through a forwarding header plus the token instead, as a
 * request through the pod's proxy would. No model calls and nothing written.
 * The mermaid bundle loads from the CDN, as it does for every reader.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { FIND_EVERY_DEBOUNCE_MS } from "../src/dashboard/views/components/wiki-find-palette.ts";
import {
  HISTORIC_PILL_CLASS,
  LINE_REFS_TOGGLE_CLASS,
  MOVES_PILL_CLASS,
} from "../src/dashboard/views/components/wiki-report-blocks.ts";

const PORT = e2ePort("wiki-nais-read");
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PORT = e2ePort("wiki-nais-read/admin");
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;
const DEAD_HUGINN = `http://127.0.0.1:${e2ePort("wiki-nais-read/dead-huginn")}`;
const DEAD_LEDGER = `http://127.0.0.1:${e2ePort("wiki-nais-read/dead-ledger")}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "melosys-felles";
const WRITABLE = "felles-skrivbar";
const PAGE_REL = "plans/testside.mdx";
const SECRET = "e2e-wiki-nais-read-secret-not-real";

const READER_CONFIG = JSON.stringify({
  typeMap: { plans: "plan" },
  trackers: [{ id: "jira", projects: ["MELOSYS"], hosts: ["jira.example.invalid"] }],
});

const PAGE = [
  "---",
  "title: Testside for felles wiki",
  "tags: [test, melosys]",
  "jira: [MELOSYS-7790]",
  "sessions: [claude-code:0f0e2c1a-5b8e-4c33-9a51-2d8f1e7c9b10]",
  "prs: [navikt/melosys-api#123]",
  "series: felles",
  "series_label: Felles serie",
  "---",
  "",
  "# Testside for felles wiki",
  "",
  "Særnorske bokstaver: æ, ø og å. Blåbærsyltetøy på brødskiva.",
  "",
  '<Callout tone="info" title="Merk">',
  "Denne siden er speilet fra en bøtte og kan bare leses.",
  "</Callout>",
  "",
  "## Flyt",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Søknad mottatt] --> B{Gyldig?}",
  "  B -->|Ja| C[Vedtak fattet]",
  "  B -->|Nei| D[Avvist]",
  "```",
  "",
  "Se også [[annen-side]] og [MELOSYS-7790](https://jira.example.invalid/browse/MELOSYS-7790).",
  "",
  '<Embed src="./testside.html" height="200" title="Kart" />',
  "",
  // A pure line-ref group and a Historic block, so the reader's `line refs`
  // toggle and `↻ N historic` pill render and meet the allowlist below.
  "Vedtaket lagres (`Vedtak.kt:12`, `:40-44`).",
  "",
  '<Historic since="melosys-api#1" note="gammel flyt">',
  "",
  "Den gamle flyten.",
  "",
  "</Historic>",
  "",
  // A NextMoves block: the lane pills render (they carry the lane's own `who`),
  // while the /wiki ✋ chip and row flag — personal, "waiting on YOU" — do not.
  "<NextMoves>",
  "",
  '<Lane kind="you" who="Fag">',
  "",
  "- **Avklar regelen.**",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  // A CaseBoard and a DeltaTable read from files beside the page, and a run of
  // two Query cards, so the case links and the explorer's search box and
  // chips render and meet the allowlist below.
  '<CaseBoard src="testside-res/saker.yaml" />',
  "",
  '<DeltaTable src="testside-res/kjoringer.csv" better="lower" />',
  "",
  '<Query id="Q-1" question="Hvor mange saker?" answer="Tre." uses="8045, 8306">',
  "",
  "Telling per måned.",
  "",
  "</Query>",
  "",
  '<Query id="Q-2" question="Hvilke saker har avgift?" answer="To." uses="8306">',
  "",
  "Saker med avgift.",
  "",
  "</Query>",
  "",
  // The four list wrappers, so the DecisionLog id chips (in-page anchors)
  // render and meet the allowlist below.
  '<Tldr label="Kort fortalt">',
  "",
  "Fag har svart.",
  "",
  "</Tldr>",
  "",
  "<Timeline>",
  "",
  "- **2026-09-28** — Runde 1",
  "- **29.09:** Runde 2",
  "",
  "</Timeline>",
  "",
  // A <Question> card: WIKI_ANSWER_WIKIS is unset here, so it renders
  // read-only — no composer, no answers request (answer cards D7, D14).
  '<Question id="O1" choices="A|B">',
  "",
  "Skal blokken være på norsk?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Ikke-yrkesaktive betaler ikke.",
  "- ~~**D2**~~ — Flyttet.",
  "- **O1** — Språk i blokken?",
  "",
  "</DecisionLog>",
  "",
  "<RunChecklist>",
  "",
  "- [x] Simuler",
  // Prose around the span keeps the command inline: a one-span command is a
  // fence, and the fence Copy button is outside this allowlist's question.
  "  - Kommando: kjør `POST /run` én gang",
  "- [ ] Skarp kjøring",
  "",
  "</RunChecklist>",
  "",
].join("\n");
const CASES = "- id: MEL-1\n  status: hold\n  owner: Fag\n- id: MEL-2\n  status: ok\n";
const RUNS = "Teller,08.09,18.09\nKandidater,132,16\n";
const SECOND = ["---", "title: Andre del", "series: felles", "---", "", "# Andre del", "", "Del to av serien.", ""].join("\n");
const EXPLAINER = "<!doctype html><html><head><title>Kart</title></head><body><p>Innebygd kart.</p></body></html>";
const OTHER = ["---", "title: Annen side", "---", "", "# Annen side", "", "Lenker tilbake til [[testside]] og [[andre-del]].", ""].join("\n");

const servers: ChildProcess[] = [];
let root = "";
let writableRoot = "";
let botsDir = "";

function boot(port: number, role: "user" | "admin"): void {
  const base = `http://127.0.0.1:${port}`;
  servers.push(
    spawn("bun", ["run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...e2eEnv(),
        DASHBOARD_PORT: String(port),
        DASHBOARD_HOST: "127.0.0.1",
        SCHEDULER_ENABLED: "false",
        MUNINN_PROFILE: "nais",
        MUNINN_AUTH: "local",
        MUNINN_LOCAL_TOKEN: SECRET,
        MUNINN_LOCAL_USER: "e2e-nais-reader",
        MUNINN_LOCAL_ROLE: role,
        MUNINN_ADMIN_IDENTS: "A123456",
        MUNINN_ALLOWED_ORIGINS: base,
        // The writable wiki FIRST: a bare request would default to it if the
        // read slice served every registered wiki.
        WIKI_EXTRA: `${WRITABLE}=${writableRoot},${WIKI}=${root}`,
        WIKI_READONLY_ROOTS: root,
        KNOWLEDGE_API_URL: DEAD_HUGINN,
        CLAUDE_USAGE_URL: DEAD_LEDGER,
        MUNINN_BOTS_DIR: botsDir,
      },
      stdio: "ignore",
    }),
  );
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("nais muninn did not start on " + base);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(90_000);
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-nais-read-"));
  writableRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-nais-rw-"));
  // One wiki-less bot: muninn refuses to boot with none, and no developer
  // bot (or its wiki) under bots/ may join the registry.
  botsDir = await mkdtemp(path.join(tmpdir(), "muninn-e2e-nais-bots-"));
  await mkdir(path.join(botsDir, "e2e-nais-bot"));
  await writeFile(path.join(botsDir, "e2e-nais-bot", "CLAUDE.md"), "# throwaway e2e bot, no wiki\n", "utf8");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, ".wiki-reader.json"), READER_CONFIG, "utf8");
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(path.join(root, "plans/testside.html"), EXPLAINER, "utf8");
  await mkdir(path.join(root, "plans", "testside-res"), { recursive: true });
  await writeFile(path.join(root, "plans/testside-res/saker.yaml"), CASES, "utf8");
  await writeFile(path.join(root, "plans/testside-res/kjoringer.csv"), RUNS, "utf8");
  await writeFile(path.join(root, "plans/andre-del.mdx"), SECOND, "utf8");
  await writeFile(path.join(root, "annen-side.md"), OTHER, "utf8");
  await writeFile(path.join(writableRoot, "hemmelig.md"), "# Hemmelig\n\nSkal ikke vises.\n", "utf8");

  boot(PORT, "user");
  boot(ADMIN_PORT, "admin");
  await Promise.all([waitUp(BASE), waitUp(ADMIN_BASE)]);
});

test.afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (writableRoot) await rm(writableRoot, { recursive: true, force: true });
  if (botsDir) await rm(botsDir, { recursive: true, force: true });
});

/** Record every same-origin response that failed, and every console error. */
function watch(page: Page): { failed: string[]; errors: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.origin === BASE && res.status() >= 400) failed.push(`${res.status()} ${res.request().method()} ${u.pathname}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors };
}

/**
 * The interactive controls a reader may see under the read slice — each a READ
 * control (navigation, filters, view toggles, links into the reader or out to
 * the tracker). Deliberately NOT derived from `WIKI_READ_SLICE_HIDDEN_SELECTOR`:
 * a control that selector forgot must fail here, not pass by construction.
 */
const READER_CONTROLS = [
  // The rail: wiki picker, search, sort, facets, folds, pins (localStorage), resizer.
  "#wikiSelect",
  "#wikiSearch",
  "#wikiSort",
  "#wikiGroupFamilies",
  "#wikiFolder",
  ".wiki-chip",
  ".wiki-pin",
  ".wiki-group-fold",
  ".wiki-fold-chip",
  "#wikiRailResizer",
  // The breadcrumb: overview link, ⧉ Copy path, ⌖ Show in list, graph mode.
  "a.wiki-bc-wiki",
  "#wikiCopyPathBtn",
  "#wikiLocateBtn",
  "#wikiGraphToggle",
  // The start view's two tabs (Atlas is absent under the slice).
  '.wiki-tab[data-tab="hubs"]',
  '.wiki-tab[data-tab="timeline"]',
  // Graph mode (a `wiki-read` route): level, depth and the nodes, which open a
  // client-side card.
  "#wikiGraphLevel",
  "#wikiGraphDepth",
  "[data-graph-node]",
  "[data-graph-card-close]",
  "[data-graph-focus]",
  // The provenance strip: the Jira key narrows the list client-side, the line
  // opens the chain, ⧉ copies a session id, retry refetches the strip.
  "[data-prov-jira]",
  "[data-prov-toggle]",
  "[data-prov-retry]",
  "[data-sess-copy]",
  // Related work: the order toggle (localStorage) and the ▸ second hop, which
  // reads `/api/wiki/related` — a read-slice path.
  "[data-rel-order]",
  "[data-rel-hop]",
  // In-reader links, the embed's own tab (`/api/wiki/html`), and the rail tabs.
  "a.wiki-link",
  "a.embed-open",
  '.wiki-conn-tab[data-conntab="conn"]',
  ".wiki-pane-btn",
  // The report-block chrome: the line-ref toggle (localStorage) and the
  // historic pill (scrolls within the page).
  `.${LINE_REFS_TOGGLE_CLASS}`,
  `.${HISTORIC_PILL_CLASS}`,
  // The NextMoves lane pills (scroll within the page).
  `.${MOVES_PILL_CLASS}`,
  // CaseBoard row links and Query id links (in-page anchors), and the Query
  // explorer's search box and uses chips (client-side filters).
  "a.cb-id",
  "a.query-id",
  // DecisionLog id chips (in-page anchors), and a <Question> card's id chip,
  // which links its DecisionLog item.
  "a.dl-id",
  "a.q-id",
  ".qx-search",
  ".qx-chip",
  // Out to the tracker.
  'a[href^="https://"][target="_blank"]',
];

/** Every visible interactive element inside the reader that is on no allowlist
 *  entry, described well enough to decide whether to hide it or allow it. */
async function unexpectedControls(page: Page): Promise<string[]> {
  return page.evaluate((allow) => {
    const interactive = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
    const scope = document.querySelector(".wiki-layout") ?? document.body;
    return Array.from(scope.querySelectorAll<HTMLElement>(interactive))
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
      .filter((el) => !allow.some((sel) => el.matches(sel)))
      .map((el) => {
        const attrs = Array.from(el.attributes)
          .filter((a) => a.name !== "style")
          .map((a) => `${a.name}="${a.value.slice(0, 60)}"`)
          .join(" ");
        return `<${el.tagName.toLowerCase()} ${attrs}> ${(el.textContent ?? "").trim().slice(0, 40)}`;
      });
  }, READER_CONTROLS);
}

/** Every link or form target in the reader that names an `/api/` path outside
 *  the read slice. */
async function apiLinksOutsideSlice(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const slice = [
      "/api/wiki/pages",
      "/api/wiki/page",
      "/api/wiki/page/provenance",
      "/api/wiki/related",
      "/api/wiki/html",
      "/api/wiki/graph",
    ];
    return Array.from(document.querySelectorAll<HTMLElement>("a[href], iframe[src], form[action]"))
      .map((el) => el.getAttribute("href") ?? el.getAttribute("src") ?? el.getAttribute("action") ?? "")
      .filter((u) => {
        const p = new URL(u, location.href);
        return p.origin === location.origin && p.pathname.startsWith("/api/") && !slice.includes(p.pathname);
      });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`a role-user renders the page in ${scheme} — Callout, mermaid, no dead controls`, async ({ browser }, info) => {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    const seen = watch(page);
    const answerRequests: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/wiki/answers")) answerRequests.push(req.url());
    });

    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
    await expect(page.locator(".callout-info .callout-title")).toHaveText("Merk");
    await expect(page.locator("#articleWrap")).toContainText("Blåbærsyltetøy på brødskiva");
    await expect(page.locator("#articleWrap svg").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#articleWrap svg").first()).toContainText("Søknad mottatt");
    // The rail's own read surface is there…
    await expect(page.locator(".wiki-conn-tab.active")).toHaveText("Connections");
    // …and the Ask tab, which reaches /api/wiki/ask, is not.
    await expect(page.locator('[data-conntab="ask"]')).toBeHidden();
    // Let lazy loaders (Similar, coverage footer) fire if anything would.
    await page.waitForTimeout(1_500);

    // The attachment's frame and the provenance strip rendered, so their
    // controls were on screen for the allowlist check below.
    await expect(page.locator("#articleWrap iframe").first()).toBeVisible();
    await expect(page.locator("[data-prov-toggle]")).toBeVisible();
    await expect(page.locator(`.${LINE_REFS_TOGGLE_CLASS}`)).toBeVisible();
    await expect(page.locator(`.${HISTORIC_PILL_CLASS}`)).toBeVisible();
    await expect(page.locator(".wiki-article .nm-lane.nm-you")).toBeVisible();
    await expect(page.locator(`.${MOVES_PILL_CLASS}-you`)).toHaveText("✋ Fag · 1");
    // The file-backed blocks rendered from their files, and the explorer's
    // controls are on screen for the allowlist check.
    await expect(page.locator(".wiki-article .cb-row#case-mel-1 a.cb-id")).toBeVisible();
    await expect(page.locator(".wiki-article td.dt-delta.dt-good")).toHaveText("✓ -116 (-87.9%)");
    await expect(page.locator(".wiki-article .qx-search")).toBeVisible();
    await expect(page.locator(".wiki-article .qx-chip")).toHaveCount(2);
    // The list wrappers rendered, so the id chips are on screen too.
    await expect(page.locator(".wiki-article section.tldr .tldr-label")).toHaveText("Kort fortalt");
    await expect(page.locator(".wiki-article section.gtl .gtl-date")).toHaveText(["2026-09-28", "29.09"]);
    await expect(page.locator(".wiki-article .dl-item#d1 a.dl-id")).toBeVisible();
    await expect(page.locator(".wiki-article .dl-item.dl-dim#d2")).toBeVisible();
    await expect(page.locator(".wiki-article .rc-count")).toHaveText("1 av 2 steg");
    // The personal ✋ surfaces are absent on a shared instance: the page's row
    // in the rail carries no flag, and the status row offers no chip.
    await expect(page.locator(`.wiki-list-item[data-relpath="${PAGE_REL}"]`)).toBeVisible();
    await expect(page.locator(".wiki-moves-flag")).toHaveCount(0);
    await expect(page.locator("#statusChips [data-waiting]")).toHaveCount(0);
    // The <Question> card is read-only: WIKI_ANSWER_WIKIS is unset, so the
    // page carries no answers flag and the client asks for nothing.
    await expect(page.locator(".wiki-article section.question")).toHaveAttribute("data-wiki-answerable", "false");
    await expect(page.locator(".wiki-article .q-composer, .wiki-article .q-answers, .wiki-article .q-edit")).toHaveCount(0);
    expect(answerRequests).toEqual([]);
    expect(await unexpectedControls(page)).toEqual([]);
    expect(await apiLinksOutsideSlice(page)).toEqual([]);
    // Open the provenance chain: its rows carry controls of their own.
    await page.locator("[data-prov-toggle]").click();
    await expect(page.locator("#wikiProvChain")).toBeVisible();
    expect(await unexpectedControls(page)).toEqual([]);
    expect(seen.failed).toEqual([]);
    expect(seen.errors).toEqual([]);
    // The scheme actually applied: the body background follows it.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r = 0, g = 0, b = 0] = (bg.match(/\d+/g) ?? []).map(Number);
    const luminance = (r + g + b) / 3;
    expect(scheme === "dark" ? luminance < 100 : luminance > 150, `body background ${bg}`).toBe(true);

    await info.attach(`reader-${scheme}.png`, { body: await page.screenshot(), contentType: "image/png" });

    // Graph mode is in the slice on a tracker wiki: it answers, and its own
    // controls are read controls too.
    await page.locator("#wikiGraphToggle").click();
    await expect(page.locator("#wikiGraphToggle")).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-graph-node^="issue:"]').first().click();
    await page.waitForTimeout(1_000);
    const graphControls = await unexpectedControls(page);
    // Re-rooting refetches the graph: still inside the slice.
    await page.locator("[data-graph-focus]").first().click();
    await page.waitForTimeout(1_000);
    expect(seen.failed).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(graphControls).toEqual([]);
    await context.close();
  });
}

test("a role-user opens Related work's second hop — a read-slice GET, no page or attachment of the open one", async ({ page }) => {
  const seen = watch(page);
  const hops: number[] = [];
  page.on("response", (res) => {
    if (new URL(res.url()).pathname === "/api/wiki/related") hops.push(res.status());
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
  const row = page.locator(".wiki-conn-item.wiki-conn-related", { hasText: "Annen side" });
  await expect(row).toBeVisible();
  await row.locator("[data-rel-hop]").click();
  const hopRows = page.locator(".wiki-rel-hop-row");
  // `annen-side` links back to the open page and on to `andre-del`: the hop
  // holds `andre-del` and never the page that is open, nor its attachment.
  await expect(hopRows).toHaveText([/Andre del/]);
  const hopBody = page.locator('.wiki-rel-hop-body[data-rel-hop-for="annen-side.md"]');
  await expect(hopBody).toContainText("Related to Annen side");
  await expect(hopBody).not.toContainText("Testside");
  await expect(hopBody).not.toContainText("Kart");
  expect(hops).toEqual([200]);
  // The ▸ is a reader control; nothing in the open hop is an unexpected one.
  expect(await unexpectedControls(page)).toEqual([]);
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("the overview makes no request outside the read slice, and has no Atlas tab — even linked", async ({ page }) => {
  const seen = watch(page);
  const paths: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin === BASE) paths.push(u.pathname);
  });

  await page.goto(`${BASE}/wiki?wiki=${WIKI}&view=atlas`);
  await expect(page.locator(".wiki-tab.active")).toHaveText("Hubs");
  await expect(page.locator('.wiki-tab[data-tab="atlas"]')).toHaveCount(0);
  await page.waitForTimeout(1_500);

  expect(paths.filter((p) => p.startsWith("/api/wiki/") && p !== "/api/wiki/pages")).toEqual([]);
  expect(await unexpectedControls(page)).toEqual([]);
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("the find palette ranks locally and never asks for the Everywhere section", async ({ page }) => {
  const seen = watch(page);
  const paths: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin === BASE) paths.push(u.pathname);
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
  await expect(page.locator("#wikiList .wiki-list-item").first()).toBeVisible();
  await page.locator("body").press("/");
  await page.locator("#wikiFindInput").fill("annen side");
  await expect(page.locator("#wikiFindList .wiki-find-row").first()).toBeVisible();
  // Past the Everywhere debounce, with margin: a fetch would have been sent by
  // now. The request listener above is the assertion; the wait only bounds it.
  await page.waitForTimeout(FIND_EVERY_DEBOUNCE_MS * 3);
  expect(paths).not.toContain("/api/wiki/find-everywhere");
  await expect(page.locator("#wikiFindEvery")).toBeEmpty();
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("return-to-overview on a view=atlas overview pushes no history entry", async ({ page }) => {
  // Under the slice `view=atlas` boots Hubs, so that URL already denotes the
  // overview and `goToStart` must not push. The overview renders no breadcrumb,
  // so the test adds a wiki crumb and clicks it through the page's own click
  // delegate — the one route into `goToStart` where the tools flag decides.
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&view=atlas`);
  await expect(page.locator(".wiki-tab.active")).toHaveText("Hubs");
  const before = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.className = "wiki-bc-wiki";
    a.href = "#";
    a.textContent = "overview";
    document.body.appendChild(a);
  });
  await page.locator("a.wiki-bc-wiki").click();
  await expect(page.locator(".wiki-tab.active")).toHaveText("Hubs");
  expect(await page.evaluate(() => history.length)).toBe(before);
  expect(new URL(page.url()).searchParams.get("view")).toBe("atlas");
});

// ---- the zone rows, both roles, through the proxy path -------------------

/** A forwarding header takes a request out of the loopback bypass, so the
 *  token and `MUNINN_LOCAL_ROLE` decide the role — as through the pod's proxy. */
const VIA_PROXY = { "x-forwarded-for": "203.0.113.9", "x-muninn-token": SECRET };
const ZONE_REFUSAL = { error: "forbidden", reason: "admin-only route" };
const Q = `wiki=${WIKI}`;

/** All seven read-slice paths, each with parameters that make it answer 200. */
const READS = [
  `/wiki?${Q}`,
  `/api/wiki/pages?${Q}`,
  `/api/wiki/page?${Q}&relPath=${encodeURIComponent(PAGE_REL)}`,
  `/api/wiki/page/provenance?${Q}&relPath=${encodeURIComponent(PAGE_REL)}`,
  `/api/wiki/related?${Q}&relPath=annen-side.md&exclude=${encodeURIComponent(PAGE_REL)}`,
  `/api/wiki/html?${Q}&relPath=plans/testside.html`,
  `/api/wiki/graph?${Q}&scope=wiki&level=1&depth=0`,
];
const TOOL_GETS = [`/api/wiki/explain?${Q}`, `/api/wiki/ask?${Q}`, `/api/wiki/factcheck?${Q}`, `/api/wiki/similar?${Q}`];
const TOOL_POSTS = [
  "/api/wiki/provenance/stamp",
  "/api/wiki/series",
  "/api/wiki/share",
  "/api/wiki/remember",
  "/api/wiki/factcheck/append",
  "/api/wiki/ask/chat",
];

async function probe(base: string, p: string, method: "GET" | "POST" = "GET") {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: method === "POST" ? { ...VIA_PROXY, "content-type": "application/json" } : VIA_PROXY,
    ...(method === "POST" ? { body: "{}" } : {}),
    redirect: "manual",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: res.status, body, text };
}

test.describe("zone rows under nais — role `user`", () => {
  test("all seven read-slice paths pass the zone and answer 200", async () => {
    for (const p of READS) {
      expect(`${p} → ${(await probe(BASE, p)).status}`).toBe(`${p} → 200`);
    }
  });

  test("a POST to a read-slice path is the zone's 403", async () => {
    for (const p of ["/api/wiki/pages", "/api/wiki/page"]) {
      const r = await probe(BASE, p, "POST");
      expect(`${p} → ${r.status}`).toBe(`${p} → 403`);
      expect(r.body).toEqual(ZONE_REFUSAL);
    }
  });

  test("Explain, Ask, Stamp and the wiki writes are the zone's 403", async () => {
    for (const p of TOOL_GETS) {
      const r = await probe(BASE, p);
      expect(`GET ${p} → ${r.status}`).toBe(`GET ${p} → 403`);
      expect(r.body).toEqual(ZONE_REFUSAL);
    }
    for (const p of TOOL_POSTS) {
      const r = await probe(BASE, p, "POST");
      expect(`POST ${p} → ${r.status}`).toBe(`POST ${p} → 403`);
      expect(r.body).toEqual(ZONE_REFUSAL);
    }
  });

  test("the writable wiki is not served, and the picker does not list it", async () => {
    const page = await probe(BASE, `/api/wiki/page?wiki=${WRITABLE}&name=hemmelig`);
    expect(page.status).toBe(404);
    const html = (await probe(BASE, "/wiki")).text;
    expect(html).toContain(WIKI);
    expect(html).not.toContain(WRITABLE);
  });
});

test.describe("zone rows under nais — role `admin`", () => {
  test("all seven read-slice paths answer 200", async () => {
    for (const p of READS) {
      expect(`${p} → ${(await probe(ADMIN_BASE, p)).status}`).toBe(`${p} → 200`);
    }
  });

  test("the tool routes pass the zone and meet no handler — absent, not denied", async () => {
    for (const p of TOOL_GETS) {
      const r = await probe(ADMIN_BASE, p);
      expect(`GET ${p} → ${r.status}`).toBe(`GET ${p} → 404`);
      expect(r.body).not.toEqual(ZONE_REFUSAL);
    }
    for (const p of TOOL_POSTS) {
      const r = await probe(ADMIN_BASE, p, "POST");
      expect(`POST ${p} → ${r.status}`).toBe(`POST ${p} → 404`);
    }
  });

  test("the writable wiki is not served to an admin either", async () => {
    expect((await probe(ADMIN_BASE, `/api/wiki/page?wiki=${WRITABLE}&name=hemmelig`)).status).toBe(404);
  });
});
