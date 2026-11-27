/**
 * Measure one Discuss page turn's stream (mimir plan
 * muninn-wiki-discuss-pane-room-and-stream, PR 2): when each `delta` arrived,
 * which tools ran and when, and which of the expected files the answer names.
 * The engine runs in process on this env's registry and bots, with the turn's
 * rows in a `_test` database (refused otherwise), so the live DB gets nothing.
 * The bot's research MCP server is the running muninn's (read-only wiki
 * tools), as on a pane turn, so `researchWikiTools` is on.
 *
 *   MUNINN_BOTS_DIR=<muninn>/bots DATABASE_URL=postgresql://…/muninn_test \
 *   bun --env-file=<muninn>/.env scripts/measure-discuss-stream.ts \
 *     --wiki melosys-kode-wiki --page plans/x.mdx --question "where else is MEL-1?" \
 *     --expect log.md --expect plans/y.mdx [--json out.json]
 *
 * Polling the DOM cannot tell a burst from a stream; the SSE events can.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    wiki: { type: "string" },
    page: { type: "string" },
    question: { type: "string" },
    expect: { type: "string", multiple: true, default: [] },
    json: { type: "string" },
  },
});
if (!values.wiki || !values.page || !values.question) {
  console.error("usage: --wiki <name> --page <relPath> --question <text> [--expect <relPath>]… [--json <file>]");
  process.exit(2);
}

const { loadConfig } = await import("../src/config.ts");
const { initDb, getDb, closeDb } = await import("../src/db/client.ts");
const { createDiscussEngine } = await import("../src/wiki/discuss-engine.ts");

const config = loadConfig();
const dbName = new URL(config.databaseUrl).pathname.slice(1);
if (!dbName.endsWith("_test")) {
  console.error(`refused: DATABASE_URL names "${dbName}", not a _test database`);
  process.exit(2);
}
initDb(config);
const USER = "measure-discuss-stream";
await getDb()`INSERT INTO users (id, username, platform) VALUES (${USER}, 'Measure', 'web') ON CONFLICT (id) DO NOTHING`;
// Every run a first turn: a live thread from an earlier run would hand the model its answer as history.
await getDb()`UPDATE threads SET closed_at = now() WHERE user_id = ${USER} AND kind = 'wiki' AND closed_at IS NULL`;

const engine = createDiscussEngine(config, { researchWikiTools: () => true, defaultUser: async () => USER });
const started = await engine.start({ role: "admin", body: { wiki: values.wiki, relPath: values.page, question: values.question } as never });
if (started.refused) {
  console.error(`refused: ${JSON.stringify(started)}`);
  await closeDb();
  process.exit(1);
}

type Ev = { ms: number; event: string; data: Record<string, unknown> };
const events: Ev[] = [];
const t0 = performance.now();
await started.run((event, data) => {
  events.push({ ms: Math.round(performance.now() - t0), event, data: (data ?? {}) as Record<string, unknown> });
});
await closeDb();

const deltas = events.filter((e) => e.event === "delta");
const tools = events.filter((e) => e.event === "tool");
const done = events.find((e) => e.event === "done");
const end = done?.ms ?? events.at(-1)?.ms ?? 0;
const answer = String(done?.data.answer ?? deltas.map((d) => String(d.data.text ?? "")).join(""));
const named = (values.expect as string[]).filter((p) => answer.includes(p));
/** A file named by its basename counts too: an answer may list a folder's files under the folder (27.11: `Q-3.csv` under `plans/melosys-8351-sql-resultat/`). */
const namedByFile = (values.expect as string[]).filter((p) => answer.includes(p.split("/").pop()!));
const first = deltas[0]?.ms ?? null;
const last = deltas.at(-1)?.ms ?? null;
const inLastSecond = deltas.filter((d) => d.ms >= end - 1000).length;
const chars = deltas.reduce((n, d) => n + String(d.data.text ?? "").length, 0);
const summary = {
  wiki: values.wiki,
  page: values.page,
  question: values.question,
  endState: done ? String(done.data.endState) : "none",
  totalMs: end,
  modelPhaseMs: events.find((e) => e.event === "status" && e.data.phase === "model")?.ms ?? null,
  tools: tools.map((t) => ({ ms: t.ms, name: String(t.data.name), input: String(t.data.input ?? "") })),
  deltas: { count: deltas.length, chars, firstMs: first, lastMs: last, spreadMs: first !== null && last !== null ? last - first : null, inLastSecond },
  named: { count: named.length, byFile: namedByFile.length, of: (values.expect as string[]).length, missing: (values.expect as string[]).filter((p) => !namedByFile.includes(p)) },
  deltaTimes: deltas.map((d) => [d.ms, String(d.data.text ?? "").length]),
};
console.log(JSON.stringify({ ...summary, deltaTimes: undefined }, null, 2));
console.log(`\nanswer:\n${answer}`);
if (values.json) await Bun.write(values.json, JSON.stringify({ ...summary, answer, events }, null, 2));
process.exit(done && done.data.endState === "done" ? 0 : 1);
