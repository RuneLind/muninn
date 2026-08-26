import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  ZONE_DISPOSITIONS,
  chatPageUrls,
  extractSameOriginUrls,
  parseZoneInventory,
  type ZoneDisposition,
} from "./zone-inventory.ts";
import { decideZone, inPathList, OPEN_ZONE_PATHS, USER_ZONE_PATHS } from "./zones.ts";

const FIXTURE = "src/auth/chat-page-zone-inventory.txt";

const rows = parseZoneInventory(await readFile(FIXTURE, "utf8"));
const urls = await chatPageUrls();

describe("extractSameOriginUrls", () => {
  test("a regex flag right after a quote is NOT a URL", () => {
    // The measured false positive: `.replace(/"/g, "&quot;")` puts a `"`
    // immediately before `/g`, and the first version of this extractor
    // reported `/g` as a route on the chat page.
    expect(extractSameOriginUrls(`s.replace(/"/g, "&quot;").replace(/'/g, "&#39;")`)).toEqual([]);
  });

  test("it sees what a `fetch(` grep cannot", () => {
    const html = `<link rel="icon" href="/favicon.svg">
      new EventSource('/chat/events');
      new WebSocket('/chat/ws');
      fetch('/api/goals/' + encodeURIComponent(u));
      fetch(\`/api/jira/draft/\${id}/save\`, { method: 'POST' });
      <a href=/traces>t</a>`;
    expect(extractSameOriginUrls(html)).toEqual([
      "/api/goals/",
      "/api/jira/draft/",
      "/chat/events",
      "/chat/ws",
      "/favicon.svg",
      "/traces",
    ]);
    // NB the `/save` tail of the template literal is deliberately absent: a
    // `${…}` ends the run, and the PREFIX is what a zone entry is written
    // against. The real page contributes `/save` separately, from the
    // concatenated `+ '/save'` form — which is why fragments are a
    // disposition rather than something the extractor tries to reassemble.
  });
});

describe("the chat page zone inventory", () => {
  test("the derived URL set matches the checked-in fixture", () => {
    // Both directions named in the failure: a NEW url is unassigned work, a
    // REMOVED one is a stale row that would keep a zone entry alive for a
    // fetch nobody makes any more.
    const fixtureUrls = rows.map((r) => r.url).sort();
    expect(fixtureUrls).toEqual([...urls].sort());
  });

  test("every row carries a disposition from the vocabulary", () => {
    const bad = rows.filter((r) => !(ZONE_DISPOSITIONS as readonly string[]).includes(r.disposition));
    expect(bad.map((r) => `${r.url} | ${r.disposition ?? "(none)"}`)).toEqual([]);
  });

  test("every zone claim is CHECKED against decideZone at role `user`", () => {
    // Without this a row could quietly say `user-zone` about a path the model
    // refuses — the fixture would be green and the page would 403.
    const expectAllowed: Record<ZoneDisposition, boolean | null> = {
      open: true,
      "user-zone": true,
      "admin-zone": false,
      fragment: null,
      "not-a-url": null,
    };
    const wrong: string[] = [];
    for (const row of rows) {
      const want = expectAllowed[row.disposition];
      if (want === null) continue;
      const path = row.probe ?? row.url;
      // A prefix row without a probe cannot be checked at all: `/api/goals/`
      // is not itself a route. Demand one rather than skipping it.
      if (path.endsWith("/") && path !== "/") {
        wrong.push(`${row.url}: a prefix row needs a probe path`);
        continue;
      }
      const got = decideZone({ method: "GET", path, role: "user" });
      if (got.allowed !== want) wrong.push(`${row.url} (probe ${path}): says ${row.disposition}, model says ${got.reason}`);
      if (row.disposition === "open" && !inPathList(OPEN_ZONE_PATHS, path)) {
        wrong.push(`${row.url}: says open but is not in OPEN_ZONE_PATHS`);
      }
      if (row.disposition === "user-zone" && !inPathList(USER_ZONE_PATHS, path)) {
        wrong.push(`${row.url}: says user-zone but is not in USER_ZONE_PATHS`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a probe really probes the row it belongs to", () => {
    const stray = rows
      .filter((r) => r.probe !== undefined && !r.probe.startsWith(r.url))
      .map((r) => `${r.url} probed by unrelated ${r.probe}`);
    expect(stray).toEqual([]);
  });

  test("/api/events is not on the page at all, and is not in the user zone", () => {
    // Belt and braces with `zones.test.ts`: the chat page moved to
    // /chat/events in PR D, and a regression that put it back would show up
    // here as an unassigned row rather than as a working operator stream.
    expect(urls).not.toContain("/api/events");
    expect(inPathList(USER_ZONE_PATHS, "/api/events")).toBe(false);
  });
});
