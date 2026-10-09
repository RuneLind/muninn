/**
 * The GCS bucket mirror end to end: a muninn polling an in-process fake GCS
 * JSON API into a wiki root under the OS temp dir, registered read-only through
 * `WIKI_EXTRA` + `WIKI_READONLY_ROOTS`.
 *
 * What the unit tests cannot reach: that the boot wiring starts the loop, that a
 * changed poll busts the wiki index the READER reads (no `?refresh=1` anywhere
 * here — that is the point), and that a restart over an empty directory serves
 * the wiki again with no manual step. The page is synthetic Norwegian with a
 * mermaid block and a `<Callout>` (public repo: no live-corpus fixture).
 *
 * SPAWN ENV: `e2eEnv()`, then the mirror's own three variables, set explicitly.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-bucket-mirror");
const GCS_PORT = e2ePort("wiki-bucket-mirror/gcs");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "melosys-felles";
const REL = "plans/2026-09-29-felles-side.mdx";

const page = (marker: string) => [
  "---",
  "title: Felles side for teamet",
  "type: plan",
  "---",
  "",
  "# Felles side for teamet",
  "",
  `Denne siden er speilet fra bøtta. Versjon: ${marker}.`,
  "",
  '<Callout tone="info" title="Viktig for teamet">',
  "Sidene leses her, og skrives bare av kuratoren.",
  "</Callout>",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Kurator] --> B[Bøtte] --> C[Pod]",
  "```",
  "",
].join("\n");

/** The fake bucket: name → {generation, body}. Mutated by the tests. */
const objects = new Map<string, { generation: number; body: string }>();
let gcs: Server | undefined;
let server: ChildProcess | undefined;
let base = "";
let root = "";

function startGcs(): Promise<void> {
  gcs = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${GCS_PORT}`);
    const m = /^\/storage\/v1\/b\/felles\/o(?:\/(.+))?$/.exec(url.pathname);
    if (!m) { res.writeHead(404).end("no bucket"); return; }
    if (!m[1]) {
      const items = [...objects].map(([name, o]) => ({
        name, generation: String(o.generation), size: String(Buffer.byteLength(o.body)),
      }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items }));
      return;
    }
    const o = objects.get(decodeURIComponent(m[1]));
    if (!o || url.searchParams.get("generation") !== String(o.generation)) { res.writeHead(404).end("gone"); return; }
    res.writeHead(200).end(o.body);
  });
  return new Promise((resolve) => gcs!.listen(GCS_PORT, "127.0.0.1", resolve));
}

async function startMuninn(): Promise<void> {
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
      WIKI_READONLY_ROOTS: root,
      WIKI_BUCKET_MIRRORS: `gs://felles=${root}`,
      WIKI_BUCKET_MIRROR_INTERVAL_MS: "1000",
      WIKI_BUCKET_MIRROR_GCS_BASE: `http://127.0.0.1:${GCS_PORT}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function stopMuninn(): Promise<void> {
  const s = server;
  server = undefined;
  if (!s || s.exitCode !== null) return;
  await new Promise<void>((resolve) => { s.once("exit", () => resolve()); s.kill("SIGTERM"); });
}

async function pageRelPaths(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
  if (!res.ok) return [];
  return ((await res.json()) as { pages: { relPath: string }[] }).pages.map((p) => p.relPath);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-mirror-"));
  root = path.join(base, "wikis", WIKI);
  objects.set(REL, { generation: 1, body: page("første") });
  await startGcs();
  await startMuninn();
});

test.afterAll(async () => {
  await stopMuninn();
  await new Promise<void>((r) => (gcs ? gcs.close(() => r()) : r()));
  if (base) await rm(base, { recursive: true, force: true });
});

test("a page uploaded to the bucket renders in the reader after one poll", async ({ page: p }) => {
  await expect.poll(pageRelPaths, { timeout: 15_000 }).toEqual([REL]);
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(p.locator(".wiki-article")).toContainText("Versjon: første");
  await expect(p.locator(".wiki-article .callout")).toContainText("Viktig for teamet");
  await expect(p.locator(".wiki-article svg").first()).toBeVisible({ timeout: 15_000 });
});

test("a changed generation updates the page with no manual refresh", async () => {
  objects.set(REL, { generation: 2, body: page("andre") });
  await expect.poll(async () => {
    const res = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    return res.ok ? ((await res.json()) as { html: string }).html.includes("Versjon: andre") : false;
  }, { timeout: 15_000 }).toBe(true);
});

test("a Query's CSV and SQL in a subfolder beside the page reach the reader", async () => {
  const side = "plans/2026-10-08-data-side.mdx";
  const csv = "plans/data-side-sql-resultat/Q-1.csv";
  const sql = "plans/data-side-sql-resultat/Q-1.sql";
  objects.set(side, {
    generation: 1,
    body: '# Data\n\n<Query id="Q-1" question="Hvor mange?" answer="To." csv="data-side-sql-resultat/Q-1.csv" sql="data-side-sql-resultat/Q-1.sql" />\n',
  });
  objects.set(csv, { generation: 1, body: "status,antall\nSPEILET_RAD,42\n" });
  objects.set(sql, { generation: 1, body: "select status, count(*) from speilet_tabell;\n" });
  const html = async () => {
    const res = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(side)}`);
    return res.ok ? ((await res.json()) as { html: string }).html : "";
  };
  await expect.poll(html, { timeout: 15_000 }).toContain("SPEILET_RAD");
  expect(await html()).toContain("speilet_tabell");
  for (const n of [side, csv, sql]) objects.delete(n);
  await expect.poll(pageRelPaths, { timeout: 15_000 }).toEqual([REL]);
  await expect.poll(async () => (await readdir(path.join(root, "plans"))).sort(), { timeout: 15_000 })
    .toEqual([path.basename(REL)]);
});

test("a deleted object disappears after the next poll", async () => {
  objects.set("archive/ekstra.md", { generation: 1, body: "# Ekstra\n\nMidlertidig.\n" });
  await expect.poll(async () => (await pageRelPaths()).sort(), { timeout: 15_000 })
    .toEqual(["archive/ekstra.md", REL]);
  objects.delete("archive/ekstra.md");
  await expect.poll(pageRelPaths, { timeout: 15_000 }).toEqual([REL]);
  expect((await readdir(root)).includes("archive")).toBe(false);
});

test("a restart over an empty directory serves the wiki again", async () => {
  await stopMuninn();
  await rm(root, { recursive: true, force: true });
  await startMuninn();
  await expect.poll(pageRelPaths, { timeout: 15_000 }).toEqual([REL]);
});
