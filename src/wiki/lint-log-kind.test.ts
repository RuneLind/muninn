import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../test/temp-dir.ts";
import { checkLogKinds, parseLogKinds } from "./lint-log-kind.ts";
import { lintWiki } from "./lint.ts";
import { buildWikiIndex } from "./store.ts";

const LOG = [
  "# Log",
  "",
  "## [2026-10-01] implementering | old entry, before since",
  "",
  "## [2026-11-12] update | fine",
  "## [2026-11-12] melosys-api | a repo name as the kind",
  "## [2026-11-13] no bar here",
  "",
  "## [2026-11-15]  ship  | padded kind is still ship",
  "## Not an entry",
].join("\n");

test("an entry on or after `since` with an unlisted kind or no bar is flagged; older entries are not", () => {
  const got = checkLogKinds(LOG, { kinds: ["update", "ship"], since: "2026-11-12" });
  expect(got.map((f) => [f.line, f.kind])).toEqual([
    [6, "melosys-api"],
    [7, "no bar here"],
  ]);
  expect(got[0]!.message).toBe('log kind "melosys-api" is not in .wiki-reader.json logKinds (update, ship)');
  expect(got[1]!.message).toContain('no "<kind> | <title>"');
});

test("without `since` every entry is checked", () => {
  expect(checkLogKinds(LOG, { kinds: ["update", "ship"] }).map((f) => f.line)).toEqual([3, 6, 7]);
});

test("parseLogKinds: absent is silent, a malformed block warns and is null, a bad entry or date warns and is dropped", () => {
  expect(parseLogKinds(undefined)).toEqual({ config: null, warnings: [] });
  expect(parseLogKinds(["update"]).config).toBeNull();
  expect(parseLogKinds(["update"]).warnings).toHaveLength(1);
  expect(parseLogKinds({ kinds: "update" }).config).toBeNull();
  expect(parseLogKinds({ kinds: [3, "Update"] }).config).toBeNull();
  expect(parseLogKinds({ kinds: ["update", "step-done", "Bad Kind"], since: "2026-11-12" })).toEqual({
    config: { kinds: ["update", "step-done"], since: "2026-11-12" },
    warnings: ['kinds entry "Bad Kind" is not a lower-case word (letters, digits, "-", "+") — dropping it'],
  });
  const badDay = parseLogKinds({ kinds: ["update"], since: "12.11.2026" });
  expect(badDay.config).toEqual({ kinds: ["update"] });
  expect(badDay.warnings).toHaveLength(1);
});

test("lintWiki reports log-kind on log.md only when the wiki declares logKinds", async () => {
  const root = await testTempDir(path.join(tmpdir(), "wiki-lint-log-kind-"));
  await Bun.write(path.join(root, "log.md"), LOG);
  await Bun.write(path.join(root, "a.md"), "---\ntitle: A\nupdated: 2026-11-01\n---\n\n# A\n\nBody.\n");
  const kinds = async () => (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => f.check === "log-kind").map((f) => `${f.relPath}:${f.line}:${f.detail}`);
  expect(await kinds()).toEqual([]);
  await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ logKinds: { kinds: ["update", "ship"], since: "2026-11-12" } }));
  expect(await kinds()).toEqual(["log.md:6:melosys-api", "log.md:7:no bar here"]);
});

test("a CRLF log is checked like an LF one", () => {
  expect(checkLogKinds("## [2026-11-12] bad | x\r\n## [2026-11-12] update | y\r\n", { kinds: ["update"] }).map((f) => [f.line, f.kind])).toEqual([[1, "bad"]]);
});

test("no fence rule: a stray ``` line, an inline ```code``` opener or a ~~~ line hides no later entry", () => {
  for (const opener of ["```", "```code``` in prose", "~~~", "````"]) {
    expect(checkLogKinds(`${opener}\n## [2026-11-12] bad | x\n`, { kinds: ["update"] }).map((f) => f.kind), opener).toEqual(["bad"]);
  }
});

test("a kind may carry Norwegian letters and a plus; upper case and spaces are still dropped", () => {
  const got = parseLogKinds({ kinds: ["spørring", "måling", "prod-kjøring", "review+implement", "Update", "two words", "+x"] });
  expect(got.config).toEqual({ kinds: ["spørring", "måling", "prod-kjøring", "review+implement"] });
  expect(got.warnings).toHaveLength(3);
  expect(checkLogKinds("## [2026-11-12] spørring | x\n", got.config!)).toEqual([]);
});
