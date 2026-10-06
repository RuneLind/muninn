/**
 * `fetchSummaryDoc` — what every drafter and gardener path reads a summary as.
 * A written-back fact-check block never reaches them (D6/D11).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchSummaryDoc } from "./summary-doc.ts";
import { buildSummaryFactcheckBlock, insertSummaryFactcheckBlock } from "../summaries/factcheck-block.ts";

const SUMMARY = "The video says 4 hours.\n\n## Key takeaways\n\n- Sleep.";
const BODY = insertSummaryFactcheckBlock(SUMMARY, buildSummaryFactcheckBlock("### ❌ Claim 1/1 — x\n\nSources say 7–9.", "2026-10-06"));
const RAW = `---\ndate: "2026-10-06"\nurl: "https://youtu.be/x"\n---\n\n${BODY}\n\n## Transcript\n\nSpeech.\n`;

let server: ReturnType<typeof Bun.serve>;
let rawServed = true;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.searchParams.get("raw") === "1") {
        return rawServed ? new Response(RAW, { headers: { "content-type": "text/markdown" } }) : new Response("no", { status: 404 });
      }
      // The cleaned JSON copy keeps the block too (huginn does not know it).
      return Response.json({ id: "health/x.md", url: "https://youtu.be/x", text: `[c > x]\n\n${BODY}\n\n## Transcript\n\nSpeech.` });
    },
  });
});
afterAll(() => server.stop(true));

describe("fetchSummaryDoc", () => {
  test("the source-file read carries no fact-check block", async () => {
    rawServed = true;
    const doc = await fetchSummaryDoc(`http://127.0.0.1:${server.port}`, "youtube-summaries", "health/x.md", 5_000);
    expect(String(doc.text).trim()).toBe(SUMMARY);
    expect(doc.text).not.toContain("factcheck");
  });

  test("the cleaned-copy fallback carries none either", async () => {
    rawServed = false;
    const doc = await fetchSummaryDoc(`http://127.0.0.1:${server.port}`, "youtube-summaries", "health/x.md", 5_000);
    expect(doc.text).not.toContain("factcheck");
    expect(doc.text).not.toContain("Fact check (");
    expect(doc.text).toContain("The video says 4 hours.");
  });
});
