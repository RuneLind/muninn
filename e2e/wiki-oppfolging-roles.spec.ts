/**
 * The «Oppfølging» block's viewer role in the two modes with no Entra session
 * (reader lenses PR 3, D30). The pod case — two colleagues in two groups — is
 * in `wiki-answers-nais.spec.ts`; this file holds three others:
 *
 *   - auth off: the viewer's roles are the groups holding `WIKI_ANSWER_OWNER`'s
 *     ident (`Test Eier (X100021)` is in `fag`), so the fag lane goes first and
 *     reads «til deg»; auth off is admin, so «Se som rolle» is offered.
 *   - `local` (`MUNINN_PROFILE=nais`, the loopback session at role `user`): the
 *     identity carries no NAV ident, so the viewer has no role — the lanes keep
 *     their authored order, none is marked, and there is no switch.
 *   - `bun run preview:role fag`'s env (`scripts/preview-role.ts`): the same
 *     `local`/`nais`/`user` shape with `MUNINN_LOCAL_IDENT` in a synthetic fag
 *     group, so the fag lane goes first and reads «til deg», `--lens overview`
 *     opens the page in Overview, there is no switch, and an answer with text
 *     is refused.
 *
 * What a unit test cannot see: the server's per-mode resolution reaching the
 * client, which orders and marks the lanes. Three muninns; no model calls; no DB
 * rows written. Synthetic names and `X1000NN`/`X9000NN` idents only.
 *
 * SPAWN ENV: `e2eEnv()` blanks the platform tokens and the instance-profile
 * flags (the `MUNINN_AUTH` family and `WIKI_ANSWER_*` included); each boot sets
 * back what it needs.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";
import { makePreviewBotsDir, previewRoleEnv, readRoleKeys } from "../scripts/preview-role.ts";
import { AUTHORED_ROLES, ROLE_PAGE, ROLE_READER_CONFIG, ROLE_REL } from "./oppfolging-fixture.ts";

const OFF_PORT = e2ePort("wiki-oppfolging-roles");
const OFF_BASE = `http://127.0.0.1:${OFF_PORT}`;
const LOCAL_PORT = e2ePort("wiki-oppfolging-roles/local");
const LOCAL_BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const PREVIEW_PORT = e2ePort("wiki-oppfolging-roles/preview");
const PREVIEW_BASE = `http://127.0.0.1:${PREVIEW_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-oppfolging";
const GROUPS = "fag=X100021;utvikler=X100022";
const MEMBERS = ["X100021", "X100022"];

// Two waiting lanes, utvikler's written first, and a settled «Oppfølging»
// block holding a fag lane: the pill follows the viewer's order, and the
// settled lane is never ordered or marked.
const TWO_WAITING_REL = "plans/to-venter.mdx";
const lanesMd = (lanes: [string, string][]) =>
  ["<NextMoves>", "", ...lanes.flatMap(([attrs, item]) => [`<Lane ${attrs}>`, "", `- ${item}`, "", "</Lane>", ""]), "</NextMoves>"];
const TWO_WAITING_PAGE = [
  "---",
  "title: To som venter",
  "---",
  "",
  ...lanesMd([
    ['kind="waiting" role="utvikler"', "Svar på kodespørsmålet."],
    ['kind="waiting" role="fag"', "Svar på fagspørsmålet."],
  ]),
  "",
  '<Historic since="v1">',
  "",
  ...lanesMd([['kind="you" role="fag"', "Gammelt steg."]]),
  "",
  "</Historic>",
  "",
].join("\n");
// The only role lane is settled: no «Se som rolle».
const HISTORIC_ONLY_REL = "plans/historisk.mdx";
const HISTORIC_ONLY_PAGE = [
  "---",
  "title: Bare historisk",
  "---",
  "",
  ...lanesMd([['kind="you" who="Du"', "Gjør det."]]),
  "",
  '<Historic since="v1">',
  "",
  ...lanesMd([['kind="waiting" role="fag"', "Gammelt."]]),
  "",
  "</Historic>",
  "",
].join("\n");
// The only role lane is blocked: never ordered or marked, so no «Se som rolle».
const BLOCKED_ONLY_REL = "plans/blokkert.mdx";
const BLOCKED_ONLY_PAGE = [
  "---",
  "title: Bare blokkert",
  "---",
  "",
  ...lanesMd([
    ['kind="you" who="Du"', "Gjør det."],
    ['kind="blocked" role="fag"', "Står fast."],
  ]),
  "",
].join("\n");

// D39: four cards right after the block leave no stub; two further down, past
// prose, leave one merged line. D35: every state-pill tone, in StatusRows and
// a CaseBoard, for the contrast case.
const STUB_REL = "plans/stubber.mdx";
const STUB_IDS = ["S1", "S2", "S3", "S4", "S5", "S6"];
const STUB_PAGE = [
  "---",
  "title: Stubber",
  'questions_to: ["fag"]',
  "---",
  "",
  "<StatusRows>",
  "",
  "- **Jira:** MEL-1 i prod · MEL-2 merget, ikke i prod · MEL-3 ikke opprettet · MEL-4 opprettet",
  "",
  "</StatusRows>",
  "",
  '<CaseBoard src="cases.yaml" />',
  "",
  "<NextMoves>",
  "",
  '<Lane kind="waiting" role="fag" since="07.10.2026">',
  "",
  ...STUB_IDS.map((id) => `- **${id}** — spørsmål ${id}?`),
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  ...STUB_IDS.slice(0, 4).flatMap((id) => [`<Question id="${id}" to="fag">`, "", `Spørsmål ${id}?`, "", "</Question>", ""]),
  "Mer bakgrunn.",
  "",
  ...STUB_IDS.slice(4).flatMap((id) => [`<Question id="${id}" to="fag">`, "", `Spørsmål ${id}?`, "", "</Question>", ""]),
  "<DecisionLog>",
  "",
  ...STUB_IDS.map((id) => `- **${id}** — åpent.`),
  "",
  "</DecisionLog>",
  "",
].join("\n");
const CASES_YAML = ["- id: A", "  status: hold", "- id: B", "  status: wait", "- id: C", "  status: wrong", "- id: D", "  status: ok", "- id: E", "  status: none", ""].join("\n");

const servers: ChildProcess[] = [];
let root = "";
let botsDir = "";

async function waitUp(url: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start: ${url}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(90_000);
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-oppfolging-roles-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, ROLE_REL), ROLE_PAGE, "utf8");
  await writeFile(path.join(root, ".wiki-reader.json"), ROLE_READER_CONFIG, "utf8");
  await writeFile(path.join(root, TWO_WAITING_REL), TWO_WAITING_PAGE, "utf8");
  await writeFile(path.join(root, HISTORIC_ONLY_REL), HISTORIC_ONLY_PAGE, "utf8");
  await writeFile(path.join(root, BLOCKED_ONLY_REL), BLOCKED_ONLY_PAGE, "utf8");
  await writeFile(path.join(root, STUB_REL), STUB_PAGE, "utf8");
  await writeFile(path.join(root, "plans", "cases.yaml"), CASES_YAML, "utf8");
  botsDir = makePreviewBotsDir();
  const common = {
    ...process.env,
    ...e2eEnv(),
    DATABASE_URL: TEST_DB,
    DASHBOARD_HOST: "127.0.0.1",
    SCHEDULER_ENABLED: "false",
    WIKI_EXTRA: `${WIKI}=${root}`,
    WIKI_ANSWER_WIKIS: WIKI,
    WIKI_ANSWER_GROUPS: GROUPS,
    MUNINN_BOTS_DIR: botsDir,
  };
  servers.push(
    spawn("bun", ["run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...common, DASHBOARD_PORT: String(OFF_PORT), WIKI_ANSWER_OWNER: "Test Eier (X100021)" },
      stdio: "ignore",
    }),
    spawn("bun", ["run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...common,
        DASHBOARD_PORT: String(LOCAL_PORT),
        MUNINN_PROFILE: "nais",
        MUNINN_AUTH: "local",
        MUNINN_LOCAL_TOKEN: "e2e-oppfolging-secret-not-real",
        MUNINN_LOCAL_USER: "e2e-oppfolging-reader",
        // An authenticating mode refuses to boot without an admin allowlist;
        // nobody in this file is on it.
        MUNINN_ADMIN_IDENTS: "X100099",
        MUNINN_ALLOWED_ORIGINS: LOCAL_BASE,
        WIKI_READONLY_ROOTS: root,
      },
      stdio: "ignore",
    }),
    spawn("bun", ["run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...e2eEnv(),
        // `--lens overview`, as the melosys-muninn pod sets `WIKI_DEFAULT_LENS`.
        ...previewRoleEnv({ role: "fag", wiki: WIKI, root, roleKeys: readRoleKeys(root), port: PREVIEW_PORT, botsDir, lens: "overview" }),
      },
      stdio: "ignore",
    }),
  );
  await Promise.all([
    waitUp(`${OFF_BASE}/api/wiki/pages?wiki=${WIKI}`),
    waitUp(`${LOCAL_BASE}/api/live`),
    waitUp(`${PREVIEW_BASE}/api/live`),
  ]);
});

test.afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  for (const d of [root, botsDir]) if (d) await rm(d, { recursive: true, force: true });
});

const lanes = (page: Page) => page.locator(".wiki-article .nm-compact > .nm-lanes > .nm-lane");
const laneRoles = (page: Page) => lanes(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.role ?? "-"));
const marks = (page: Page) =>
  lanes(page).evaluateAll((els) => els.map((e) => e.querySelector(":scope > .nm-head .nm-mine-mark")?.textContent ?? ""));
/** A token's computed colour, read off a probe on `body` (pin the token, not a literal). */
const token = (page: Page, name: string, prop: "color" | "backgroundColor" = "color") =>
  page.evaluate(
    ([n, p]) => {
      const probe = document.createElement("span");
      probe.style[p as "color"] = `var(${n})`;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe)[p as "color"];
      probe.remove();
      return c;
    },
    [name, prop] as const,
  );
const pageUrl = (base: string) => `${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(ROLE_REL)}`;
const payloadUrl = (base: string) => `${base}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(ROLE_REL)}`;

test("auth off: the owner's group lane goes first and reads «til deg»; the admin switch is offered", async ({ page }) => {
  const res = await fetch(payloadUrl(OFF_BASE));
  const text = await res.text();
  expect((JSON.parse(text) as { reader: { roles: unknown } }).reader.roles).toEqual({
    keys: ["fag", "utvikler"],
    viewer: ["fag"],
    preview: true,
  });
  for (const ident of MEMBERS) expect(text).not.toContain(ident);

  await page.goto(pageUrl(OFF_BASE));
  await expect(lanes(page)).toHaveCount(4);
  await expect.poll(() => laneRoles(page)).toEqual(["fag", "utvikler", "-", "utvikler"]);
  expect(await marks(page)).toEqual(["til deg", "", "", ""]);
  await expect(page.locator(".wiki-article-head .wiki-role-view select")).toBeVisible();
});

test("local: no NAV ident, no role — authored order, no mark, no switch", async ({ page }) => {
  const res = await fetch(payloadUrl(LOCAL_BASE));
  expect(res.status).toBe(200);
  const text = await res.text();
  expect((JSON.parse(text) as { reader: { roles: unknown } }).reader.roles).toEqual({
    keys: ["fag", "utvikler"],
    viewer: [],
    preview: false,
  });
  for (const ident of MEMBERS) expect(text).not.toContain(ident);

  await page.goto(pageUrl(LOCAL_BASE));
  await expect(lanes(page)).toHaveCount(4);
  await expect.poll(() => laneRoles(page)).toEqual(AUTHORED_ROLES);
  expect(await marks(page)).toEqual(["", "", "", ""]);
  await expect(page.locator(".wiki-role-view")).toHaveCount(0);
});

test("preview:role fag: the fag lane first and «til deg», --lens overview opens Overview, no switch, no stored text", async ({ page }) => {
  const res = await fetch(payloadUrl(PREVIEW_BASE));
  expect(res.status).toBe(200);
  const text = await res.text();
  const payload = JSON.parse(text) as { reader: { roles: unknown; defaultLens: unknown } };
  expect(payload.reader.roles).toEqual({ keys: ["fag", "utvikler"], viewer: ["fag"], preview: false });
  expect(payload.reader.defaultLens).toBe("overview");
  for (const ident of ["X900001", "X900002"]) expect(text).not.toContain(ident);

  await page.goto(pageUrl(PREVIEW_BASE));
  await expect(lanes(page)).toHaveCount(4);
  await expect.poll(() => laneRoles(page)).toEqual(["fag", "utvikler", "-", "utvikler"]);
  expect(await marks(page)).toEqual(["til deg", "", "", ""]);
  await expect(page.locator(".wiki-article")).toHaveClass(/\blens-overview\b/);
  await expect(page.locator(".wiki-role-view")).toHaveCount(0);

  // Acceptance 10 (D36–D38): the fag viewer's waiting lane.
  const fag = lanes(page).first();
  await expect(fag.locator(".nm-ico")).toHaveText("⏳");
  await expect(fag.locator(".nm-ico")).toHaveAttribute("aria-hidden", "true");
  expect(await fag.locator(".nm-who").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--tone-warn"));
  const mark = fag.locator(".nm-mine-mark");
  expect(await mark.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await token(page, "--status-warning", "backgroundColor"));
  await expect(fag.locator(":scope > .nm-head > .nm-since")).toHaveText(/^stilt 07\.10(\.2026)? · \d+ d$/);
  await expect(fag.locator(".nm-cta-open")).toHaveText("Se og svar ▸");
  await expect(fag.locator(".nm-cta-close")).toBeHidden();
  await expect(fag.locator(".nm-peek .nm-qid")).toHaveText(["S1", "S2"]);
  // Once the answer client loads, the count follows the ids.
  await expect(fag.locator(".nm-prog")).toHaveText("· 0 av 2 besvart");
  // The other lanes keep their own actions.
  await expect(lanes(page).nth(1).locator(".nm-cta-open")).toHaveText("Se alle ▸");
  await expect(lanes(page).nth(3).locator(".nm-cta-open")).toHaveText("Se ▸");
  await fag.locator(":scope > .nm-head").click();
  await expect(fag.locator(".nm-cta-close")).toHaveText("Skjul ▴");
  await expect(fag.locator(".nm-cta-open")).toBeHidden();

  const post = await fetch(`${PREVIEW_BASE}/api/wiki/answers`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PREVIEW_BASE },
    body: JSON.stringify({ wiki: WIKI, relPath: ROLE_REL, questionId: "S1", choice: "A", body: "Svar fra forhåndsvisningen." }),
  });
  expect(post.status).toBe(503);
  expect(((await post.json()) as { code: string }).code).toBe("scanner_unavailable");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the «deg» mark and the role switch read at 4.5:1, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(pageUrl(OFF_BASE));
    await expect(lanes(page).first().locator(".nm-mine-mark")).toHaveText("til deg");
    await page.mouse.move(0, 0);
    expect(await paintedContrast(lanes(page).first().locator(".nm-mine-mark")), "mark").toBeGreaterThanOrEqual(4.5);
    expect(await paintedContrast(page.locator(".wiki-role-view")), "switch label").toBeGreaterThanOrEqual(4.5);
    expect(await paintedContrast(page.locator(".q-moved-link").first()), "moved link").toBeGreaterThanOrEqual(4.5);
  });

  test(`D35–D38: lane labels, marks, actions and every pill tone read at 4.5:1 against their tokens, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    // The admin switch views the page as fag, then as utvikler, for both marks.
    await page.goto(pageUrl(OFF_BASE));
    await expect(lanes(page)).toHaveCount(4);
    await page.mouse.move(0, 0);
    const byRole = (role: string, kind: string) => page.locator(`.wiki-article .nm-lane[data-role="${role}"][data-kind="${kind}"]`);
    const checks: [string, import("@playwright/test").Locator, string, "color" | "backgroundColor"][] = [
      ["waiting label", byRole("fag", "waiting").locator(".nm-who"), "--tone-warn", "color"],
      ["blocked label", byRole("utvikler", "blocked").locator(".nm-who"), "--tone-err", "color"],
      ["you label", byRole("utvikler", "you").locator(".nm-who"), "--accent-light", "color"],
      ["action", byRole("fag", "waiting").locator(".nm-cta"), "--accent-light", "color"],
      ["waiting mark fill", byRole("fag", "waiting").locator(".nm-mine-mark"), "--status-warning", "backgroundColor"],
    ];
    for (const [name, loc, tok, prop] of checks) {
      expect(await loc.evaluate((el, p) => getComputedStyle(el)[p as "color"], prop), `${name} token`).toBe(await token(page, tok, prop));
      expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    await page.locator(".wiki-article-head .wiki-role-view select").selectOption("utvikler");
    const youMark = byRole("utvikler", "you").locator(".nm-mine-mark");
    await expect(youMark).toHaveText("deg");
    expect(await youMark.evaluate((el) => getComputedStyle(el).backgroundColor), "you mark fill token").toBe(
      await token(page, "--accent-hover", "backgroundColor"),
    );
    expect(await paintedContrast(youMark), "you mark contrast").toBeGreaterThanOrEqual(4.5);

    // D35: the pill tones on their tints.
    await page.goto(`${OFF_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(STUB_REL)}`);
    await page.mouse.move(0, 0);
    const pills: [string, string][] = [
      [".sr-state.sr-good", "--tone-good"],
      [".sr-state.sr-warn", "--tone-warn"],
      [".sr-state.sr-muted", "--text-soft"],
      [".sr-state.sr-info", "--tone-info"],
      [".cb-pill.cb-hold", "--tone-warn"],
      [".cb-pill.cb-wait", "--tone-info"],
      [".cb-pill.cb-wrong", "--tone-err"],
      [".cb-pill.cb-ok", "--tone-good"],
    ];
    for (const [sel, tok] of pills) {
      const pill = page.locator(`.wiki-article ${sel}`).first();
      await expect(pill, sel).toBeVisible();
      expect(await pill.evaluate((el) => getComputedStyle(el).color), `${sel} token`).toBe(await token(page, tok));
      expect(await paintedContrast(pill), `${sel} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("D39: four cards right after the block leave no stub; two past prose leave one merged line", async ({ page }) => {
  await page.goto(`${OFF_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(STUB_REL)}`);
  await expect(page.locator(".wiki-article section.question")).toHaveCount(6);
  const links = page.locator(".wiki-article .q-moved-link");
  await expect(links).toHaveText(["Spørsmål S5 og S6 står under Oppfølging ↑"]);
  await expect(links).toHaveAttribute("href", "#nm-q-s5");
  const lane = page.locator('.wiki-article .nm-lane[data-role="fag"]');
  await links.click();
  await expect(lane).toHaveAttribute("open", "");
  await expect(lane.locator('section.question[data-question-id="S5"]')).toBeInViewport();
});

/** The lanes outside settled sections. */
const liveLanes = (page: Page) => page.locator(".wiki-article .nm-compact:not(section.historic .nm-compact) > .nm-lanes > .nm-lane");
const liveRoles = (page: Page) => liveLanes(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.role ?? "-"));

test("a settled lane is never ordered or marked, in the real view or «Se som rolle»", async ({ page }) => {
  await page.goto(`${OFF_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(TWO_WAITING_REL)}`);
  await expect(liveLanes(page)).toHaveCount(2);
  await expect.poll(() => liveRoles(page)).toEqual(["fag", "utvikler"]);
  const settled = page.locator(".wiki-article section.historic .nm-lane");
  await expect(settled).toHaveCount(1);
  await expect(settled.locator(".nm-mine-mark")).toHaveCount(0);
  await expect(settled).not.toHaveClass(/nm-mine/);
  await page.locator(".wiki-article-head .wiki-role-view select").selectOption("fag");
  await expect(settled.locator(".nm-mine-mark")).toHaveCount(0);
});

test("the waiting pill names the viewer's lane, and «Se som rolle» re-derives it", async ({ page }) => {
  await page.goto(`${OFF_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(TWO_WAITING_REL)}`);
  await expect.poll(() => liveRoles(page)).toEqual(["fag", "utvikler"]);
  const pill = page.locator(".wiki-article-head .wiki-moves-pill-waiting");
  await expect(pill).toHaveText("⏳ Venter på fag · 2");
  const select = page.locator(".wiki-article-head .wiki-role-view select");
  await select.selectOption("utvikler");
  await expect.poll(() => liveRoles(page)).toEqual(["utvikler", "fag"]);
  await expect(pill).toHaveText("⏳ Venter på utvikler · 2");
  await expect(page.locator(".wiki-article-head .wiki-moves-pill-waiting")).toHaveCount(1);
  await select.selectOption("");
  await expect(pill).toHaveText("⏳ Venter på fag · 2");
});

test("a page whose only role lane is settled offers no «Se som rolle»", async ({ page }) => {
  await page.goto(`${OFF_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(HISTORIC_ONLY_REL)}`);
  await expect(liveLanes(page)).toHaveCount(1);
  await expect(page.locator(".wiki-article-head .wiki-moves-pill-you")).toHaveCount(1);
  await expect(page.locator(".wiki-role-view")).toHaveCount(0);
});

test("a page whose only role lane is blocked offers no «Se som rolle»", async ({ page }) => {
  await page.goto(`${OFF_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(BLOCKED_ONLY_REL)}`);
  await expect(liveLanes(page)).toHaveCount(2);
  await expect(page.locator('.wiki-article .nm-lane[data-role="fag"]')).toHaveCount(1);
  await expect(page.locator(".wiki-article-head .wiki-moves-pill-you")).toHaveCount(1);
  await expect(page.locator(".wiki-role-view")).toHaveCount(0);
});
