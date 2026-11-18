/**
 * `POST /api/wiki/discuss/handoff` on a temp wiki registered through the
 * registry memo: the refusal ladder and its order, the bounds, the opt-in, the
 * log, and the prompt it answers. The browser half is
 * `e2e/wiki-discuss-handoff.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { HANDOFF_BODY_MAX, HANDOFF_CONTEXT_MAX, HANDOFF_QUESTION_MAX, HANDOFF_SELECTION_MAX } from "../../wiki/discuss-bounds.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { registerWikiDiscussHandoffRoute, WIKI_DISCUSS_HANDOFF_PATH, type DiscussHandoffDeps } from "./wiki-discuss-handoff.ts";
import { resolveScopedPage } from "./wiki-read-scope.ts";

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

/** What the logger was called with, and how often the page resolver ran. */
interface Spy {
  logs: unknown[][];
  resolves: number;
}

function appWith(role?: "user" | "admin", deps: DiscussHandoffDeps = {}, spy?: Spy): Hono {
  const app = new Hono();
  if (role) app.use(async (c, next) => { c.set("role" as never, role as never); await next(); });
  registerWikiDiscussHandoffRoute(app, { profile: "default", dashboardPort: 4321 } as Config, {
    roots: () => [on],
    env: {},
    ...(spy
      ? {
          log: { info: (...a: unknown[]) => spy.logs.push(a), error: (...a: unknown[]) => spy.logs.push(a) },
          resolvePage: (...a: Parameters<typeof resolveScopedPage>) => {
            spy.resolves++;
            return resolveScopedPage(...a);
          },
        }
      : {}),
    ...deps,
  });
  return app;
}

const post = (app: Hono, body: unknown, type = "application/json") =>
  app.request(WIKI_DISCUSS_HANDOFF_PATH, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });

const PAGE = { wiki: "on", relPath: "plans/ferry.mdx" };
/** The bullet as the reader shows it, with the context the client reads. */
const PASSAGE = {
  selection: "The summer route adds a stop at Example Island.",
  before: "timetable in ferry.yaml. Design",
  after: "The night route is unchanged.",
  atEnd: true,
  heading: "Design",
};

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

describe("refusals, in order", () => {
  test("a non-admin viewer gets 403, before the page is resolved", async () => {
    const spy: Spy = { logs: [], resolves: 0 };
    const res = await post(appWith("user", {}, spy), { ...PAGE, question: "q" });
    expect(res.status).toBe(403);
    expect(spy.resolves).toBe(0);
    // Before the content type, too.
    expect((await post(appWith("user", {}, spy), "x", "text/plain")).status).toBe(403);
  });
  test("a non-JSON POST gets 415, before the page is resolved", async () => {
    const spy: Spy = { logs: [], resolves: 0 };
    expect((await post(appWith(undefined, {}, spy), { ...PAGE, question: "q" }, "text/plain")).status).toBe(415);
    expect(spy.resolves).toBe(0);
  });
  test("a body over the bound gets 413 without being parsed", async () => {
    const spy: Spy = { logs: [], resolves: 0 };
    const res = await post(appWith(undefined, {}, spy), { ...PAGE, question: "q", selection: "x".repeat(HANDOFF_BODY_MAX) });
    expect(res.status).toBe(413);
    expect(spy.resolves).toBe(0);
  });
  test("a body without a question or relPath, or with a bad field, gets 400 before the page is resolved", async () => {
    const spy: Spy = { logs: [], resolves: 0 };
    const app = appWith(undefined, {}, spy);
    expect((await post(app, PAGE)).status).toBe(400);
    expect((await post(app, { wiki: "on", question: "q" })).status).toBe(400);
    expect((await post(app, { ...PAGE, question: "q", atStart: "yes" })).status).toBe(400);
    expect((await post(app, { ...PAGE, question: "q", edge: "elsewhere" })).status).toBe(400);
    expect((await post(app, { ...PAGE, question: "q", before: 3 })).status).toBe(400);
    expect((await post(app, "{not json")).status).toBe(400);
    expect(spy.resolves).toBe(0);
  });
  test("finding 9: a question past the bound says it is too long, not that it is missing", async () => {
    const res = await post(appWith(), { ...PAGE, question: "q".repeat(HANDOFF_QUESTION_MAX + 1) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(`question is too long (at most ${HANDOFF_QUESTION_MAX} characters)`);
    expect((await post(appWith(), { ...PAGE, question: "q".repeat(HANDOFF_QUESTION_MAX) })).status).toBe(200);
  });
  test("finding 9: the selection's bound is the client's and the pack's; past it the route refuses, at it the route answers", async () => {
    const over = await post(appWith(), { ...PAGE, question: "q", selection: "x".repeat(HANDOFF_SELECTION_MAX + 1) });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toBe(`selection is too long (at most ${HANDOFF_SELECTION_MAX} characters)`);
    expect((await post(appWith(), { ...PAGE, question: "q", selection: "x".repeat(HANDOFF_SELECTION_MAX) })).status).toBe(200);
    expect((await post(appWith(), { ...PAGE, question: "q", before: "x".repeat(HANDOFF_CONTEXT_MAX + 1) })).status).toBe(400);
  });
  test("finding 9: a blank selection is refused, never read as a whole-page question", async () => {
    const res = await post(appWith(), { ...PAGE, question: "q", selection: "   \n " });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("selection is empty");
  });
  test("an unknown page is 404, and a wiki without discuss.handoff is 404 off", async () => {
    expect((await post(appWith(), { wiki: "on", relPath: "plans/none.mdx", question: "q" })).status).toBe(404);
    const res = await post(appWith(), { wiki: "off", relPath: "plans/ferry.mdx", question: "q" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason?: string }).reason).toBe("off");
  });
});

describe("the prompt", () => {
  test("a passage: the absolute path, its own line, the passage, the card command and the question", async () => {
    const res = await post(appWith(), { ...PAGE, question: "Which stops does it add?", ...PASSAGE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt: string; chars: number; location: { fromLine: number; toLine: number; found: string } };
    expect(body.location).toMatchObject({ found: "exact", reason: null, fromLine: 14, toLine: 14 });
    expect(body.prompt).toContain(`Page: ${path.join(on, "plans/ferry.mdx")}`);
    expect(body.prompt).toContain("Passage (line 14, Ferry timetable › Design):");
    expect(body.prompt).toContain("> The summer route adds a stop at Example Island.");
    expect(body.prompt.endsWith("Question: Which stops does it add?")).toBe(true);
    expect(body.prompt).toContain("bun --no-env-file ~/.claude/skills/plan-card/plan-card.ts");
    expect(body.chars).toBe(body.prompt.length);
  });
  test("a passage the client saw start in reader-added text goes to the section", async () => {
    const res = await post(appWith(), { ...PAGE, question: "q", ...PASSAGE, edge: "added" });
    const body = (await res.json()) as { prompt: string; location: { found: string; reason: string } };
    expect(body.location).toMatchObject({ found: "section", reason: "added" });
    expect(body.prompt).toContain("Passage (not placed exactly: it starts or ends in text the reader adds; it is in the section «Design», lines 12–15");
  });
  test("PLAN_CARD_BIN names the script when set; a page outside plan-card's roots gets no card command", async () => {
    const withBin = await post(appWith(undefined, { env: { PLAN_CARD_BIN: "/opt/plan-card/plan-card.ts" } }), { ...PAGE, question: "q" });
    expect(((await withBin.json()) as { prompt: string }).prompt).toContain("bun --no-env-file /opt/plan-card/plan-card.ts ");
    const noRoot = await post(appWith(undefined, { roots: () => [] }), { ...PAGE, question: "q" });
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

describe("the log", () => {
  test("one line per handoff with the wiki, the page and how it was found, never the question, the passage or its context", async () => {
    const spy: Spy = { logs: [], resolves: 0 };
    const question = "Which stops does the zzquestionzz route add?";
    const res = await post(appWith(undefined, {}, spy), { ...PAGE, question, ...PASSAGE, before: "zzbeforezz " + PASSAGE.before });
    expect(res.status).toBe(200);
    expect(spy.logs.length).toBe(1);
    const [msg, props] = spy.logs[0] as [string, Record<string, unknown>];
    expect(msg).toBe("discuss handoff on {wiki} {relPath}: {found}");
    expect(props).toMatchObject({ wiki: "on", relPath: "plans/ferry.mdx", found: "exact", fromLine: 14, toLine: 14, card: true });
    const logged = JSON.stringify(spy.logs);
    expect(logged).not.toContain("zzquestionzz");
    expect(logged).not.toContain("Example Island");
    expect(logged).not.toContain("zzbeforezz");
    expect(logged).not.toContain("night route");
  });
});
