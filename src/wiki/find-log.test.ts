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
const ok = { wiki: "mimir", session: "s-1", q: "felles wiki", shown: "felles", opened: null, rows: { local: 3, everywhere: 4 } };

test("a body becomes a line with the server's time; opened and the Everywhere count may be null", () => {
  expect(findLogLine({ ...ok, opened: open }, NOW)).toEqual({ at: "2026-11-11T12:00:00.000Z", ...ok, opened: open });
  expect(findLogLine(ok, NOW)?.opened).toBeNull();
  expect(findLogLine({ ...ok, shown: "", rows: { local: 0, everywhere: null } }, NOW)).toMatchObject({ shown: "", rows: { local: 0, everywhere: null } });
});

test("a body that is not a line is refused", () => {
  for (const bad of [
    null,
    "x",
    { ...ok, q: "" },
    { ...ok, q: "a".repeat(201) },
    { ...ok, shown: 3 },
    { ...ok, shown: "a".repeat(201) },
    { ...ok, session: "" },
    { ...ok, session: "s".repeat(65) },
    { ...ok, wiki: 3 },
    { ...ok, rows: { local: -1, everywhere: 0 } },
    { ...ok, rows: { local: 1, everywhere: "0" } },
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
  const file = findLogPath(path.join(dir, "nested"));
  const line = findLogLine(ok, NOW)!;
  await appendFindLog(line, file);
  await appendFindLog({ ...line, q: "def" }, file);
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.q)).toEqual(["felles wiki", "def"]);
});

test("the route appends a valid line and answers 204; a non-JSON POST is 415, a bad body 400, a failed append 500", async () => {
  const app = new Hono();
  registerWikiFindEverywhereRoute(app, {} as Config);
  const got: FindLogLine[] = [];
  __setFindLogAppendForTest(async (l) => void got.push(l));
  try {
    const post = (body: string, type = "application/json") => app.request(FIND_LOG_PATH, { method: "POST", headers: { "content-type": type }, body });
    const body = JSON.stringify({ ...ok, opened: open });
    expect((await post(body)).status).toBe(204);
    expect(got.map((l) => [l.q, l.session, l.opened?.relPath])).toEqual([["felles wiki", "s-1", "plans/a.mdx"]]);
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

test("the palette sends every event with typed text of two characters or more, trimmed and capped, and never judges it", () => {
  const s = { wiki: "mimir", session: "s-1", local: 2, everywhere: null };
  expect(findLogBody("  felles  ", " fel ", null, s)).toEqual({ wiki: "mimir", session: "s-1", q: "felles", shown: "fel", opened: null, rows: { local: 2, everywhere: null } });
  expect(findLogBody("a", "a", null, s)).toBeNull();
  expect(findLogBody("   ", "felles", open, s)).toBeNull();
  expect(findLogBody("felles", "", null, { ...s, wiki: "" })).toBeNull();
  expect(findLogBody("x".repeat(300), "y".repeat(300), null, s)).toMatchObject({ q: "x".repeat(200), shown: "y".repeat(200) });
  // The same open twice is two lines: the reader of the file dedupes on session.
  expect(findLogBody("felles", "felles", open, s)).toEqual(findLogBody("felles", "felles", open, s));
  expect(findLogBody("felles", "felles", open, { ...s, everywhere: 4 })?.rows).toEqual({ local: 2, everywhere: 4 });
});
