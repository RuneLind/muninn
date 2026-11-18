/**
 * `POST /api/wiki/discuss/handoff` on a temp wiki registered through the
 * registry memo: the refusal ladder, the opt-in, and the prompt it answers.
 * The browser half is `e2e/wiki-discuss-handoff.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { registerWikiDiscussHandoffRoute, WIKI_DISCUSS_HANDOFF_PATH, type DiscussHandoffDeps } from "./wiki-discuss-handoff.ts";

let dir = "";
let on = "";
let off = "";

const PLAN = [
  "---",
  "title: Ferry timetable",
  "plan_status: in-flight",
  "---",
  "",
  "# Ferry timetable",
  "",
  "## Brief",
  "",
  "Kari Nordmann keeps the **winter** timetable in `ferry.yaml`.",
  "",
  "## Design",
  "",
  "- The summer route adds a stop at Example Island.",
  "- The night route is unchanged.",
  "",
].join("\n");

function appWith(role?: "user" | "admin", deps: DiscussHandoffDeps = {}): Hono {
  const app = new Hono();
  if (role) app.use(async (c, next) => { c.set("role" as never, role as never); await next(); });
  registerWikiDiscussHandoffRoute(app, { profile: "default", dashboardPort: 4321 } as Config, { roots: () => [on], env: {}, ...deps });
  return app;
}

const post = (app: Hono, body: unknown, type = "application/json") =>
  app.request(WIKI_DISCUSS_HANDOFF_PATH, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

beforeAll(async () => {
  dir = await testTempDir(path.join(tmpdir(), "muninn-discuss-handoff-"));
  on = path.join(dir, "on");
  off = path.join(dir, "off");
  await Bun.write(path.join(on, ".wiki-reader.json"), JSON.stringify({ discuss: { handoff: true } }));
  await Bun.write(path.join(on, "plans", "ferry.mdx"), PLAN);
  await Bun.write(path.join(on, "notes", "plain.md"), "---\ntitle: Plain\n---\n\n# Plain\n\nA short note.\n");
  await Bun.write(path.join(off, "plans", "ferry.mdx"), PLAN);
  __setWikiRegistryForTest([
    { name: "on", root: on, source: "extra" },
    { name: "off", root: off, source: "extra" },
  ]);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

describe("refusals", () => {
  test("a non-admin viewer gets 403 before anything is read", async () => {
    const res = await post(appWith("user"), { wiki: "on", relPath: "plans/ferry.mdx", question: "q" });
    expect(res.status).toBe(403);
  });
  test("a non-JSON POST gets 415", async () => {
    const res = await post(appWith(), { wiki: "on", relPath: "plans/ferry.mdx", question: "q" }, "text/plain");
    expect(res.status).toBe(415);
  });
  test("a body without a question or relPath, or with a bad count, gets 400", async () => {
    expect((await post(appWith(), { wiki: "on", relPath: "plans/ferry.mdx" })).status).toBe(400);
    expect((await post(appWith(), { wiki: "on", question: "q" })).status).toBe(400);
    expect((await post(appWith(), { wiki: "on", relPath: "plans/ferry.mdx", question: "q", occurrence: -1 })).status).toBe(400);
    expect((await post(appWith(), { wiki: "on", relPath: "plans/ferry.mdx", question: "q", total: "2" })).status).toBe(400);
  });
  test("an unknown page is 404, and a wiki without discuss.handoff is 404 off", async () => {
    expect((await post(appWith(), { wiki: "on", relPath: "plans/none.mdx", question: "q" })).status).toBe(404);
    const res = await post(appWith(), { wiki: "off", relPath: "plans/ferry.mdx", question: "q" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason?: string }).reason).toBe("off");
  });
});

describe("the prompt", () => {
  test("a passage: the absolute path, its own line, the passage, the question and the card command", async () => {
    const res = await post(appWith(), {
      wiki: "on",
      relPath: "plans/ferry.mdx",
      question: "Which stops does it add?",
      selection: "The summer route adds a stop at Example Island.",
      heading: "Design",
      total: 1,
      occurrence: 0,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt: string; chars: number; location: { fromLine: number; toLine: number; found: string } };
    expect(body.location).toMatchObject({ found: "one", fromLine: 14, toLine: 14 });
    expect(body.prompt).toContain(`Page: ${path.join(on, "plans/ferry.mdx")}`);
    expect(body.prompt).toContain("Passage (line 14, Ferry timetable › Design):");
    expect(body.prompt).toContain("> The summer route adds a stop at Example Island.");
    expect(body.prompt).toContain("Question: Which stops does it add?");
    expect(body.prompt).toContain("bun --no-env-file ~/.claude/skills/plan-card/plan-card.ts");
    expect(body.chars).toBe(body.prompt.length);
  });
  test("PLAN_CARD_BIN names the script when set; a page outside plan-card's roots gets no card command", async () => {
    const withBin = await post(appWith(undefined, { env: { PLAN_CARD_BIN: "/opt/plan-card/plan-card.ts" } }), { wiki: "on", relPath: "plans/ferry.mdx", question: "q" });
    expect(((await withBin.json()) as { prompt: string }).prompt).toContain("bun --no-env-file /opt/plan-card/plan-card.ts ");
    const noRoot = await post(appWith(undefined, { roots: () => [] }), { wiki: "on", relPath: "plans/ferry.mdx", question: "q" });
    expect(((await noRoot.json()) as { prompt: string }).prompt).not.toContain("plan-card");
  });
  test("the whole page: the path, no line range, and no card command on a page without plan_status", async () => {
    const res = await post(appWith(), { wiki: "on", relPath: "notes/plain.md", question: "What is this note for?" });
    const body = (await res.json()) as { prompt: string; location: unknown };
    expect(body.location).toBeNull();
    expect(body.prompt).toContain(path.join(on, "notes/plain.md"));
    expect(body.prompt).toContain("Question about the whole page: What is this note for?");
    expect(body.prompt).not.toMatch(/\blines? \d/);
    expect(body.prompt).not.toContain("plan-card");
  });
});
