/**
 * Drive Discuss's wiki agent (`POST /api/wiki/discuss`) from a shell: post a
 * page reference, an optional selection and a question, print the stream.
 *
 *   # against a running muninn (its dashboard port):
 *   bun scripts/wiki-discuss.ts --url http://127.0.0.1:3010 \
 *     --wiki mimir --page plans/x.mdx --selection "R2, behind." --question "…"
 *
 *   # in process: builds an app holding only this route, on this process's
 *   # env (registry, bots, DB). It starts no bot and no server.
 *   bun --env-file=<muninn>/.env scripts/wiki-discuss.ts --in-process …
 *
 * Flags: `--before`/`--after`/`--heading` (the text around the selection, as
 * the reader would send it), `--discussion <id>` to continue one, `--memories`
 * to count `memories` rows before and after the turn (in process only: it
 * counts the database `DATABASE_URL` names), `--quiet` to print only the
 * summary, `--json` to print every event as it came.
 * Exits 1 when the turn did not end `done`.
 */
import { parseArgs } from "node:util";
import { Hono } from "hono";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "in-process": { type: "boolean", default: false },
    wiki: { type: "string" },
    page: { type: "string" },
    question: { type: "string" },
    selection: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    heading: { type: "string" },
    discussion: { type: "string" },
    memories: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

if (!values.page || !values.question || (!values.url && !values["in-process"])) {
  console.error("usage: (--url <muninn> | --in-process) --wiki <name> --page <relPath> --question <text> [--selection <text>] [--before <text>] [--after <text>] [--heading <text>] [--discussion <id>] [--memories] [--quiet] [--json]");
  process.exit(2);
}

const body: Record<string, unknown> = { wiki: values.wiki, relPath: values.page, question: values.question };
if (values.selection !== undefined) body.selection = values.selection;
if (values.before !== undefined) body.before = values.before;
if (values.after !== undefined) body.after = values.after;
if (values.heading !== undefined) body.heading = values.heading;
if (values.discussion !== undefined) body.discussionId = values.discussion;

let fetcher: (req: Request) => Promise<Response> | Response;
let countMemories: (() => Promise<number>) | null = null;
let shutdown = async () => {};
if (values["in-process"]) {
  const { loadConfig } = await import("../src/config.ts");
  const { initDb, getDb, closeDb } = await import("../src/db/client.ts");
  const { registerWikiDiscussRoute } = await import("../src/dashboard/routes/wiki-discuss.ts");
  const config = loadConfig();
  initDb(config);
  const db = new URL(config.databaseUrl).pathname.slice(1);
  console.error(`in process: database ${db}`);
  if (values.memories) countMemories = async () => Number((await getDb()`SELECT count(*)::int AS n FROM memories`)[0]!.n);
  const app = new Hono();
  registerWikiDiscussRoute(app, config);
  fetcher = (req) => app.fetch(req);
  shutdown = () => closeDb();
} else {
  if (values.memories) console.error("--memories counts in process only; ignored");
  fetcher = (req) => fetch(req);
}

const before = countMemories ? await countMemories() : null;
const base = values.url ?? "http://in-process";
const res = await fetcher(new Request(`${base}/api/wiki/discuss`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
  console.log(`refused: ${res.status} ${await res.text()}`);
  await shutdown();
  process.exit(1);
}

let endState = "none";
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = "";
const out = (s: string) => {
  if (!values.quiet) process.stdout.write(s);
};
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let sep: number;
  while ((sep = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
    const dataLine = frame
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("\n");
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(dataLine || "{}");
    } catch {
      data = { raw: dataLine };
    }
    if (values.json) {
      console.log(`${event} ${JSON.stringify(data)}`);
      if (event === "done" || event === "app_error") endState = String(data.endState ?? "error");
      continue;
    }
    switch (event) {
      case "turn":
        console.log(`[turn ${data.turnId} · discussion ${data.discussionId} · #${data.seq} · location ${JSON.stringify(data.location)}]`);
        break;
      case "status":
        if (!values.quiet) console.log(`[${data.phase}${data.read ? ` ${JSON.stringify(data.read)}` : ""}]`);
        break;
      case "tool":
        out(`\n[tool ${data.name} ${data.input}]\n`);
        break;
      case "delta":
        out(String(data.text ?? ""));
        break;
      case "done": {
        endState = String(data.endState);
        const calls = (data.toolCalls as { name: string; input: string }[]) ?? [];
        console.log(`\n\n[done · ${data.durationMs} ms · $${data.costUsd} · ${calls.length} tool calls · edit ${data.proposedEdit ? "yes" : "no"}]`);
        for (const c of calls) console.log(`  ${c.name} ${c.input}`);
        if (values.quiet) console.log(String(data.answer));
        if (data.proposedEdit) console.log(`[proposed edit] ${JSON.stringify(data.proposedEdit)}`);
        break;
      }
      case "app_error":
        endState = String(data.endState ?? "error");
        console.log(`\n[app_error ${data.endState}: ${data.message}]`);
        break;
      case "end":
        break;
    }
  }
}

if (countMemories) {
  const after = await countMemories();
  console.log(`[memories rows: before ${before}, after ${after}, new ${after - before!}]`);
}
await shutdown();
process.exit(endState === "done" ? 0 : 1);
