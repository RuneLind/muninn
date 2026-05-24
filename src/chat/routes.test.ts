import { test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { createChatRoutes, researchStageForPrompt } from "./routes.ts";

// The /specs endpoints persist the domain layer of a spec as a first-class
// artifact (Phase 0). They mirror /reports and share the path-traversal guards.
// Frontmatter enrichment is best-effort (DB call, try/caught) so these run
// without a DB — content with no leading `---` block is saved verbatim.

const tmpDirs: string[] = [];
async function appWithBot() {
  const dir = await mkdtemp(join(tmpdir(), "muninn-spec-test-"));
  tmpDirs.push(dir);
  const bot = { name: "testbot", dir } as unknown as BotConfig;
  const app = createChatRoutes([bot], {} as unknown as Config);
  return { app, dir };
}
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

const jsonPost = (content: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content }),
});

const jsonPostWith = (payload: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

// Phase 5: the Investigate / Deep prompt markers drive the dev_run research_stage
// (server-authoritative) so the chat keys affordances off run state, not a count.
test("researchStageForPrompt maps the analysis-phase markers, ignores the rest", () => {
  expect(researchStageForPrompt("<!-- prompt:investigate -->find the code")).toBe("investigation");
  expect(researchStageForPrompt("<!-- prompt:deepAnalysis -->verify")).toBe("deep");
  // Other research markers + ordinary chat must not move the stage.
  expect(researchStageForPrompt("<!-- prompt:specDomain -->draft the spec")).toBeNull();
  expect(researchStageForPrompt("<!-- research:jira -->analyze")).toBeNull();
  expect(researchStageForPrompt("just a normal message")).toBeNull();
  // Marker must be at the start (mirrors the client's button prefix).
  expect(researchStageForPrompt("noise <!-- prompt:investigate -->")).toBeNull();
});

test("spec round-trip: POST saves, GET returns, HEAD reports existence", async () => {
  const { app, dir } = await appWithBot();
  const body = "# Domain spec\n\nForretningsregel: …";

  const post = await app.request("/specs/testbot/user_1/MELOSYS-123", jsonPost(body));
  expect(post.status).toBe(201);
  expect((await post.json()).path).toBe("specs/user_1/MELOSYS-123.md");
  expect(await readFile(join(dir, "specs", "user_1", "MELOSYS-123.md"), "utf8")).toBe(body);

  const get = await app.request("/specs/testbot/user_1/MELOSYS-123");
  expect(get.status).toBe(200);
  expect((await get.json()).content).toBe(body);

  expect((await app.request("/specs/testbot/user_1/MELOSYS-123", { method: "HEAD" })).status).toBe(200);
  expect((await app.request("/specs/testbot/user_1/MELOSYS-999", { method: "HEAD" })).status).toBe(404);
});

test("spec accepts the synthetic research-<8hex> issue key (chat-started research)", async () => {
  const { app } = await appWithBot();
  const post = await app.request("/specs/testbot/user_1/research-abcd1234", jsonPost("x"));
  expect(post.status).toBe(201);
});

test("spec rejects path-traversal-ish issueKey / userId and unknown bot", async () => {
  const { app } = await appWithBot();
  // lowercase / non-Jira-non-synthetic issue key
  expect((await app.request("/specs/testbot/user_1/lowercase-1", jsonPost("x"))).status).toBe(400);
  // userId with a space (decoded from %20) fails VALID_USER_ID
  expect((await app.request("/specs/testbot/bad%20id/MELOSYS-1", jsonPost("x"))).status).toBe(400);
  // unknown bot
  expect((await app.request("/specs/nope/user_1/MELOSYS-1", jsonPost("x"))).status).toBe(404);
  // missing content
  const noContent = await app.request("/specs/testbot/user_1/MELOSYS-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(noContent.status).toBe(400);
});

test("GET / HEAD report 404 for a spec that does not exist", async () => {
  const { app } = await appWithBot();
  expect((await app.request("/specs/testbot/user_1/MELOSYS-404")).status).toBe(404);
  expect((await app.request("/specs/testbot/user_1/MELOSYS-404", { method: "HEAD" })).status).toBe(404);
});

test("spec POST accepts an optional dev_run status and saves regardless of the DB", async () => {
  // The dev_run link is best-effort (try/caught) — with no DB initialized here
  // the save must still succeed and write the file. (The link itself is covered
  // by linkSpecToDevRun in the db test group.)
  const { app, dir } = await appWithBot();
  const post = await app.request(
    "/specs/testbot/user_1/MELOSYS-200",
    jsonPostWith({ content: "domain spec", status: "spec_approved" }),
  );
  expect(post.status).toBe(201);
  expect(await readFile(join(dir, "specs", "user_1", "MELOSYS-200.md"), "utf8")).toBe("domain spec");
});

test("spec POST rejects an unknown status before writing the file", async () => {
  const { app, dir } = await appWithBot();
  const post = await app.request(
    "/specs/testbot/user_1/MELOSYS-201",
    jsonPostWith({ content: "x", status: "bogus" }),
  );
  expect(post.status).toBe(400);
  // file must NOT have been written
  await expect(readFile(join(dir, "specs", "user_1", "MELOSYS-201.md"), "utf8")).rejects.toBeDefined();
});
