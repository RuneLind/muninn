import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { appendFindLog, findLogLine, findLogPath, type FindLogLine } from "./find-log.ts";
import { FIND_LOG_PATH, __setFindLogAppendForTest, registerWikiFindEverywhereRoute } from "../dashboard/routes/wiki-find-everywhere.ts";
import { findLogBody } from "../dashboard/views/components/wiki-find.ts";
import type { Config } from "../config.ts";
import { testTempDir } from "../test/temp-dir.ts";

const NOW = Date.UTC(2026, 10, 11, 12);
const open = { wiki: "mimir", relPath: "plans/a.mdx", rank: 2, section: "everywhere" as const };

test("a body becomes a line with the server's time; a dismissal has opened null", () => {
  expect(findLogLine({ wiki: "mimir", q: "felles wiki", opened: open, rows: { local: 3, everywhere: 4 } }, NOW)).toEqual({
    at: "2026-11-11T12:00:00.000Z",
    wiki: "mimir",
    q: "felles wiki",
    opened: open,
    rows: { local: 3, everywhere: 4 },
  });
  expect(findLogLine({ wiki: "mimir", q: "x y", opened: null, rows: { local: 0, everywhere: 0 } }, NOW)?.opened).toBeNull();
});

test("a body that is not a line is refused", () => {
  const ok = { wiki: "mimir", q: "abc", opened: null, rows: { local: 0, everywhere: 0 } };
  for (const bad of [
    null,
    "x",
    { ...ok, q: "" },
    { ...ok, q: "a".repeat(201) },
    { ...ok, wiki: 3 },
    { ...ok, rows: { local: -1, everywhere: 0 } },
    { ...ok, rows: undefined },
    { ...ok, opened: 5 },
    { ...ok, opened: { ...open, section: "rail" } },
    { ...ok, opened: { ...open, rank: 1.5 } },
  ]) {
    expect(findLogLine(bad, NOW), JSON.stringify(bad)).toBeNull();
  }
});

test("appendFindLog creates the folder and appends one JSON line per call", async () => {
  const dir = await testTempDir("find-log-");
  {
    const file = findLogPath(path.join(dir, "nested"));
    const line = findLogLine({ wiki: "mimir", q: "abc", opened: null, rows: { local: 0, everywhere: 0 } }, NOW)!;
    await appendFindLog(line, file);
    await appendFindLog({ ...line, q: "def" }, file);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.q)).toEqual(["abc", "def"]);
  }
});

test("the route appends a valid line and answers 204; a non-JSON POST is 415, a bad body 400, a failed append 500", async () => {
  const app = new Hono();
  registerWikiFindEverywhereRoute(app, {} as Config);
  const got: FindLogLine[] = [];
  __setFindLogAppendForTest(async (l) => void got.push(l));
  try {
    const post = (body: string, type = "application/json") => app.request(FIND_LOG_PATH, { method: "POST", headers: { "content-type": type }, body });
    const body = JSON.stringify({ wiki: "mimir", q: "abc", opened: open, rows: { local: 1, everywhere: 2 } });
    expect((await post(body)).status).toBe(204);
    expect(got.map((l) => [l.q, l.opened?.relPath])).toEqual([["abc", "plans/a.mdx"]]);
    expect((await post(body, "text/plain")).status).toBe(415);
    expect((await post("{")).status).toBe(400);
    expect((await post(JSON.stringify({ q: "abc" }))).status).toBe(400);
    expect(got).toHaveLength(1);
    __setFindLogAppendForTest(async () => {
      throw new Error("disk full");
    });
    const failed = await post(body);
    expect(failed.status).toBe(500);
    expect(failed.headers.get("content-type")).toContain("application/json");
  } finally {
    __setFindLogAppendForTest();
  }
});

test("the palette sends text of two characters or more, trimmed and capped", () => {
  const s = { wiki: "mimir", local: 2, everywhere: 1, opened: [] };
  expect(findLogBody("  felles  ", null, s)).toEqual({ wiki: "mimir", q: "felles", opened: null, rows: { local: 2, everywhere: 1 } });
  expect(findLogBody("a", null, s)).toBeNull();
  expect(findLogBody("   ", open, s)).toBeNull();
  expect(findLogBody("felles", null, { ...s, wiki: "" })).toBeNull();
  expect(findLogBody("x".repeat(300), null, s)?.q).toHaveLength(200);
  expect(findLogBody("felles", open, s)?.opened).toEqual(open);
});

test("one line per opened row and text in a palette session; a dismissal is a miss only if that text opened nothing", () => {
  const s = { wiki: "mimir", local: 2, everywhere: 1 };
  const prior = [{ q: "felles", wiki: open.wiki, relPath: open.relPath }];
  // The same row for the same text again: nothing.
  expect(findLogBody("felles", open, { ...s, opened: prior })).toBeNull();
  // Another row for that text: logged.
  expect(findLogBody("felles", { ...open, relPath: "plans/b.mdx" }, { ...s, opened: prior })?.opened?.relPath).toBe("plans/b.mdx");
  // The same row for other text: logged.
  expect(findLogBody("felles wiki", open, { ...s, opened: prior })?.q).toBe("felles wiki");
  // A dismissal of text that opened a row is no miss; of other text it is.
  expect(findLogBody("felles", null, { ...s, opened: prior })).toBeNull();
  expect(findLogBody("felles wiki", null, { ...s, opened: prior })?.opened).toBeNull();
});
