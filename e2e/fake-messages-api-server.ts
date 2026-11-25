/**
 * The fake Anthropic Messages API (`src/test/fake-messages-api.ts`) as a
 * process of its own, for a spec: Playwright runs specs under Node, and the
 * fake is a `Bun.serve`. Run with `bun`; prints `FAKE_API_URL=<url>` once it
 * listens, then answers every request with `FAKE_API_CHUNKS` (a JSON array of
 * text chunks) streamed `FAKE_API_DELAY_MS` apart, until killed. Opt-in:
 * `FAKE_API_TOOL_FIRST` (a tool call before the text) and `FAKE_API_REQUESTS=1`
 * (the received request bodies at `FAKE_API_REQUESTS_URL`).
 */
import { startFakeMessagesApi } from "../src/test/fake-messages-api.ts";

const chunks = JSON.parse(process.env.FAKE_API_CHUNKS ?? '["PAGE-SUMMARY: fetched."]') as string[];
const delayMs = Number(process.env.FAKE_API_DELAY_MS ?? "0");
// `FAKE_API_TOOL_FIRST`: tool_use blocks a request with no assistant message yet is answered with.
const toolFirst = process.env.FAKE_API_TOOL_FIRST ? (JSON.parse(process.env.FAKE_API_TOOL_FIRST) as { name: string; input: Record<string, unknown> }[]) : undefined;
const api = startFakeMessagesApi({ reply: { chunks, delayMs, ...(toolFirst ? { toolFirst } : {}) } });
process.stdout.write(`FAKE_API_URL=${api.url}\n`);
// `FAKE_API_REQUESTS=1`: every request body received so far, as JSON, for a spec that asserts what a turn sent.
if (process.env.FAKE_API_REQUESTS === "1") {
  const dump = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(api.requests) });
  process.stdout.write(`FAKE_API_REQUESTS_URL=http://127.0.0.1:${dump.port}\n`);
}
setInterval(() => {}, 1 << 30);
