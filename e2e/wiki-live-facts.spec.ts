/**
 * Live chips in the /wiki reader (living facts PR 3b), over three temp wikis
 * of one synthetic page each: one with a `.wiki-facts.json`, one with none,
 * one with a malformed file. What a unit test cannot show: the real bundle
 * filling each server-rendered `span.fact-chip` from the page's `facts`, the
 * chip landing as the `<a>`'s next sibling with the href untouched, and no
 * chip text inside a home, a fence or inline code.
 *
 * Own muninn on its own port: the wikis are registered through `WIKI_EXTRA`,
 * which the shared 3011 server does not carry. No model calls, no DB rows.
 * ENV / SPAWN ENV: no `.env` is required — the spawn inherits `DATABASE_URL`
 * and `e2eEnv()` blanks the platform tokens and the instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";

const PORT = e2ePort("wiki-live-facts");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const NOW = new Date().toISOString();
const entry = (title: string, state: string, extra: Record<string, unknown> = {}) => ({
  title,
  state,
  isDraft: false,
  mergedAt: state === "MERGED" ? "2026-01-05T10:00:00Z" : null,
  inProd: null,
  firstProd: null,
  draftTag: null,
  checkedAt: NOW,
  ...extra,
});
const inProd = (tag: string) => ({ inProd: true, firstProd: { tag, publishedAt: "2026-01-06T12:00:00Z" } });
const FACTS = {
  version: 1,
  prs: {
    "acme/acme-api#101": entry("DEMO-11: first part", "MERGED", inProd("26.006.1")),
    "acme/acme-api#102": entry("DEMO-11 second part", "OPEN"),
    "acme/acme-api#103": entry("DEMO-12 api side", "MERGED", inProd("26.007.1")),
    "acme/acme-e2e#7": entry("DEMO-12 e2e test", "MERGED"),
    "acme/acme-web#210": entry("DEMO-16 shipped", "MERGED", inProd("26.008.1")),
    "acme/acme-web#211": entry("DEMO-16 first try", "CLOSED"),
    "acme/acme-api#104": entry("Old work", "OPEN", { checkedAt: "2026-01-01T08:00:00.000Z" }),
  },
  keys: {
    "DEMO-11": { prs: ["acme/acme-api#101", "acme/acme-api#102"] },
    "DEMO-12": { prs: ["acme/acme-api#103", "acme/acme-e2e#7"] },
    "DEMO-16": { prs: ["acme/acme-web#210", "acme/acme-web#211"] },
  },
};
const CONFIG = {
  language: "no",
  prGrammar: { owner: "acme", aliases: { api: "acme-api" }, noProd: ["acme-e2e"] },
  trackers: [{ id: "jira", projects: ["DEMO"], hosts: ["jira.example.invalid"] }],
};
const PAGE = [
  "---",
  "title: Chips",
  "repos: [acme-api]",
  "---",
  "",
  "# Chips",
  "",
  "Bare: PR #101 landed.",
  "",
  "Link: see [PR #101](https://github.com/acme/acme-api/pull/101) now.",
  "",
  "Keylink: [DEMO-11](https://jira.example.invalid/browse/DEMO-11) is the issue.",
  "",
  "Noprod: acme/acme-e2e#7 is the e2e test.",
  "",
  "Alias: api #102 is open.",
  "",
  "Keys: DEMO-12 and DEMO-16.",
  "",
  "Old: acme/acme-api#104.",
  "",
  "None: acme/acme-api#999.",
  "",
  "**Status:** acme/acme-api#103 i prod.",
  "",
  "Code: `acme/acme-api#103` inline.",
  "",
  "```",
  "acme/acme-api#103 DEMO-12",
  "```",
  "",
].join("\n");

let server: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-chips-"));
  const wikis = { facts: JSON.stringify(FACTS), nofacts: null, broken: JSON.stringify({ ...FACTS, version: 2 }) };
  for (const [name, facts] of Object.entries(wikis)) {
    const root = path.join(base, name);
    await mkdir(path.join(root, "plans"), { recursive: true });
    await writeFile(path.join(root, "plans/chips.md"), PAGE, "utf8");
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    if (facts !== null) await writeFile(path.join(root, ".wiki-facts.json"), facts, "utf8");
  }
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: Object.keys(wikis).map((n) => `e2e-chips-${n}=${path.join(base, n)}`).join(","),
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=e2e-chips-facts`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (base) await rm(base, { recursive: true, force: true });
});

async function open(page: Page, wiki: string): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent("plans/chips.md")}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
}

/** Each paragraph that holds a chip: its label word → its chips' text. */
const chipsByLine = (page: Page) =>
  page.locator(".wiki-article").evaluate((article) => {
    const out: Record<string, string[]> = {};
    for (const chip of Array.from(article.querySelectorAll<HTMLElement>(".fact-chip"))) {
      if (chip.hidden || !chip.textContent) continue;
      // The text before the chip, back to the paragraph's label word.
      let text = "";
      for (let n = chip.previousSibling; n; n = n.previousSibling) text = (n.textContent ?? "") + text;
      const label = /([A-Za-z]+):[^:]*$/.exec(text.split("\n").pop() ?? "")?.[1] ?? "?";
      (out[label] ??= []).push(chip.textContent);
    }
    return out;
  });

test.describe("Wiki reader: live chips", () => {
  test("each form gets its chip with live state; homes, code and refs with no entry get none", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await open(page, "e2e-chips-facts");
    await expect(page.locator(".wiki-article .fact-chip").first()).not.toBeEmpty();
    expect(await chipsByLine(page)).toEqual({
      Bare: ["merget · i prod 26.006.1 · i dag"],
      Link: ["merget · i prod 26.006.1 · i dag"],
      Keylink: ["1 av 2 i prod · i dag"],
      // A merged PR in a noProd repo: the state alone.
      Noprod: ["merget · i dag"],
      Alias: ["åpen · i dag"],
      // DEMO-12's other PR is in a noProd repo; DEMO-16's other PR is closed unmerged.
      Keys: ["i prod · i dag", "i prod · i dag"],
      Old: [expect.stringMatching(/^åpen · \d+ d$/) as unknown as string],
    });
    // The old entry dims; a fresh one does not.
    await expect(page.locator('.fact-chip[data-live-fact="acme/acme-api#104"]')).toHaveClass(/fact-chip-dim/);
    await expect(page.locator('.fact-chip[data-live-fact="acme/acme-api#102"]')).not.toHaveClass(/fact-chip-dim/);
    // The home, inline code, the fence and the ref with no entry: no chip.
    await expect(page.locator('.fact-chip[data-live-fact="acme/acme-api#103"]')).toHaveCount(0);
    await expect(page.locator('.fact-chip[data-live-fact="acme/acme-api#999"]')).toHaveCount(0);
    await expect(page.locator(".wiki-article pre .fact-chip, .wiki-article code .fact-chip")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a link gives exactly one chip, as the <a>'s next sibling, none inside, the href unchanged", async ({ page }) => {
    await open(page, "e2e-chips-facts");
    await expect(page.locator(".wiki-article .fact-chip").first()).not.toBeEmpty();
    const links = await page.locator(".wiki-article a[target=_blank]").evaluateAll((as) =>
      as.map((a) => ({
        href: a.getAttribute("href"),
        inside: a.querySelectorAll(".fact-chip").length,
        next: (a.nextSibling as Element | null)?.getAttribute?.("data-live-fact") ?? null,
        after: (a.nextSibling?.nextSibling as Element | null)?.classList?.contains("fact-chip") ?? false,
      })),
    );
    expect(links).toEqual([
      { href: "https://github.com/acme/acme-api/pull/101", inside: 0, next: "acme/acme-api#101", after: false },
      { href: "https://jira.example.invalid/browse/DEMO-11", inside: 0, next: "DEMO-11", after: false },
    ]);
    // The bare `PR #101` gets exactly one chip too.
    expect(await page.locator('.wiki-article .fact-chip[data-live-fact="acme/acme-api#101"]').count()).toBe(2);
  });

  test("a wiki with no facts file, and one with a malformed file: no chip, page opens", async ({ page }) => {
    for (const wiki of ["e2e-chips-nofacts", "e2e-chips-broken"]) {
      await open(page, wiki);
      await expect(page.locator(".wiki-article")).toContainText("Bare: PR #101 landed.");
      await expect(page.locator(".wiki-article .fact-chip")).toHaveCount(0);
    }
  });
});
